/**
 * Provider-neutral operations — the spec 043 contract surface, following the
 * spec 002 shape. hadron-server's slackClient calls POST /ops/<name>;
 * nothing Slack-shaped leaks out of this layer. The normalized SlackMessage
 * shape is shared by the get-history op AND the event plane (the 042
 * one-type rule), so the pull and push surfaces cannot drift apart silently.
 *
 * v1 operations: send-message, respond, update-message, get-user-info,
 * get-channel-info, get-history, get-me. The neutral rich shape is
 * `text` (mrkdwn subset) + optional `choices[]` + optional `sender` — the
 * TOOL renders Block Kit (spec 043 decision 7); core never emits blocks.
 *
 * Every operation's input is validated ONCE against its single schema
 * (defineOp parses before the handler runs), then executed through
 * withConnection (src/connectionCall.ts) — the shared load/decrypt/error-map
 * lifecycle. Send-class operations reserve a pacing slot first and are
 * SYNCHRONOUS: a 2xx response means Slack confirmed delivery (the tool
 * never acks an undelivered message).
 */
import { createHash } from 'crypto';
import { z } from 'zod';
import { withConnection } from '../connectionCall.js';
import type { Db } from '../db.js';
import {
  ProviderRateLimitedError,
  ProviderUnavailableError,
  SlackToolError,
  ValidationError,
  mapSlackError,
  validationFromZod,
} from '../errors.js';
import { logError } from '../logger.js';
import { recordProviderBackoff, reserveHistorySlot, reserveSendSlot } from '../pacing.js';
import type { RawSlackMessage, SlackProvider } from '../providers/webapi/types.js';

/**
 * Provider-neutral message shape — identical to the event plane's
 * `slack.message.received` fields (src/events/forwarder.ts builds events
 * through normalizeRawMessage too).
 */
export interface SlackMessage {
  ts: string;
  channelId: string;
  threadTs: string | null;
  from: { slackUserId: string | null; botId: string | null; displayName: string | null };
  text: string;
  sentAt: string;
}

/** Slack `ts` ("1712345678.000123", seconds.micros) → ISO timestamp. */
export function tsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  return new Date(Number.isNaN(seconds) ? 0 : seconds * 1000).toISOString();
}

/** Normalize a raw history/event message to the neutral shape. */
export function normalizeRawMessage(channelId: string, m: RawSlackMessage): SlackMessage {
  return {
    ts: m.ts,
    channelId,
    threadTs: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null,
    from: {
      slackUserId: m.user ?? null,
      botId: m.bot_id ?? null,
      displayName: m.username ?? null,
    },
    text: m.text ?? '',
    sentAt: tsToIso(m.ts),
  };
}

/** One neutral choice — rendered as a Block Kit button / select option. */
const choiceSchema = z.object({
  /** Opaque value round-tripped verbatim into the slack.interaction event. */
  value: z.string().min(1).max(2000),
  label: z.string().min(1).max(75),
});
export type Choice = z.infer<typeof choiceSchema>;

/** Neutral sender identity — rendered via chat:write.customize. */
const senderSchema = z.object({
  displayName: z.string().min(1).max(80),
  avatarUrl: z.string().url().optional(),
});

/** Block Kit action_id every choice element carries — the socket worker
 * recognizes it when normalizing interaction envelopes. */
export const CHOICE_ACTION_ID = 'hadron_choice';

/** Buttons up to this many choices; a static select beyond. */
const MAX_BUTTON_CHOICES = 5;

/**
 * Render the neutral shape to Block Kit: one mrkdwn section, plus an
 * actions block (≤5 buttons) or a static select for longer choice lists.
 * This is the ONE place neutral → Block Kit translation lives.
 */
export function renderBlocks(text: string, choices?: Choice[]): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [
    { type: 'section', text: { type: 'mrkdwn', text } },
  ];
  if (!choices?.length) return blocks;
  if (choices.length <= MAX_BUTTON_CHOICES) {
    blocks.push({
      type: 'actions',
      elements: choices.map((c, i) => ({
        type: 'button',
        action_id: `${CHOICE_ACTION_ID}_${i}`,
        text: { type: 'plain_text', text: c.label, emoji: true },
        value: c.value,
      })),
    });
  } else {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'static_select',
          action_id: CHOICE_ACTION_ID,
          placeholder: { type: 'plain_text', text: 'Choose…', emoji: true },
          options: choices.map((c) => ({
            text: { type: 'plain_text', text: c.label, emoji: true },
            value: c.value,
          })),
        },
      ],
    });
  }
  return blocks;
}

/** One operation: the single input schema + the handler over parsed input. */
export interface OperationDef {
  mutating: boolean;
  schema: z.ZodType;
  run(db: Db, provider: SlackProvider, input: Record<string, unknown>): Promise<unknown>;
}

/**
 * Define an operation with ONE schema: defineOp parses the raw input against
 * it and hands the handler the typed result — there is no second, shadow
 * schema inside the handler to drift from the declared contract.
 */
function defineOp<S extends z.ZodType>(
  mutating: boolean,
  schema: S,
  handler: (db: Db, provider: SlackProvider, input: z.infer<S>) => Promise<unknown>,
): OperationDef {
  return {
    mutating,
    schema,
    run: (db, provider, raw) => handler(db, provider, schema.parse(raw)),
  };
}

const connectionIdSchema = z.object({ connectionId: z.string().min(1) });
const channelRefSchema = connectionIdSchema.extend({ channelId: z.string().min(1) });

const sendMessageSchema = channelRefSchema.extend({
  /** chat.postMessage caps text well above this; 4000 keeps blocks valid — chunking is the CALLER's concern. */
  text: z.string().min(1).max(4000),
  threadTs: z.string().optional(),
  choices: z.array(choiceSchema).min(1).max(25).optional(),
  sender: senderSchema.optional(),
  /** When set, posts an EPHEMERAL message visible only to this user. */
  ephemeralUserId: z.string().optional(),
});

/**
 * Slack response_urls are ALWAYS `https://hooks.slack.com/...`. The respond
 * op is the one place the tool POSTs to a caller-supplied URL, so pin the
 * host: without this, a caller (or a forged/replayed value) could turn the op
 * into an SSRF vector against internal services or the cloud metadata
 * endpoint. Add hosts here if Slack ever serves response_urls elsewhere.
 */
const RESPONSE_URL_HOSTS = new Set(['hooks.slack.com']);
function isSlackResponseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && RESPONSE_URL_HOSTS.has(url.hostname);
}

const respondSchema = connectionIdSchema.extend({
  responseUrl: z
    .string()
    .url()
    .refine(isSlackResponseUrl, { message: 'responseUrl must be an https hooks.slack.com URL' }),
  text: z.string().min(1).max(4000),
  choices: z.array(choiceSchema).min(1).max(25).optional(),
  replaceOriginal: z.boolean().optional(),
  /** Default ephemeral (Slack's response_url default); true ⇒ visible to the channel. */
  inChannel: z.boolean().optional(),
});

const updateMessageSchema = channelRefSchema.extend({
  ts: z.string().min(1),
  text: z.string().min(1).max(4000),
  choices: z.array(choiceSchema).min(1).max(25).optional(),
});

const getUserInfoSchema = connectionIdSchema.extend({ slackUserId: z.string().min(1) });

const getHistorySchema = channelRefSchema.extend({
  /** Slack ts lower bound (exclusive-ish per Slack semantics) — the gap-backfill cursor. */
  oldest: z.string().optional(),
  latest: z.string().optional(),
  threadTs: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

/**
 * Run a send-class provider call with pacing: reserve the per-channel slot,
 * record any provider 429 as channel backoff, and rethrow typed.
 */
async function pacedSend<T>(connectionId: string, channelId: string, fn: () => Promise<T>): Promise<T> {
  await reserveSendSlot(connectionId, channelId);
  try {
    return await fn();
  } catch (err) {
    const mapped = mapSlackError(err, { resource: 'channel', id: channelId });
    if (mapped instanceof ProviderRateLimitedError) {
      recordProviderBackoff(connectionId, channelId, mapped.retryAfterSeconds);
    }
    throw mapped;
  }
}

/** The v1 operation registry, keyed by spec 043 operation name. */
export const OPERATIONS: Record<string, OperationDef> = {
  'send-message': defineOp(true, sendMessageSchema, async (db, provider, input) => {
    const blocks = renderBlocks(input.text, input.choices);
    const posted = await withConnection(db, input.connectionId, { resource: 'channel', id: input.channelId }, (token) =>
      pacedSend(input.connectionId, input.channelId, async () => {
        if (input.ephemeralUserId) {
          const r = await provider.postEphemeral(token, {
            channel: input.channelId,
            user: input.ephemeralUserId,
            text: input.text,
            blocks,
            ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
          });
          return { channel: input.channelId, ts: r.ts };
        }
        return provider.postMessage(token, {
          channel: input.channelId,
          text: input.text,
          blocks,
          ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
          ...(input.sender ? { username: input.sender.displayName } : {}),
          ...(input.sender?.avatarUrl ? { icon_url: input.sender.avatarUrl } : {}),
        });
      }),
    );
    return { channelId: posted.channel, ts: posted.ts };
  }),

  respond: defineOp(true, respondSchema, async (db, provider, input) => {
    // The connection lookup validates the caller's reference and keeps the
    // op contract uniform, even though the response_url itself is the
    // credential Slack checks.
    await withConnection(db, input.connectionId, undefined, async () => {
      await provider.respondUrl(input.responseUrl, {
        text: input.text,
        blocks: renderBlocks(input.text, input.choices),
        ...(input.replaceOriginal != null ? { replace_original: input.replaceOriginal } : {}),
        response_type: input.inChannel ? 'in_channel' : 'ephemeral',
      });
    });
    return { responded: true };
  }),

  'update-message': defineOp(true, updateMessageSchema, async (db, provider, input) => {
    const posted = await withConnection(db, input.connectionId, { resource: 'message', id: input.ts }, (token) =>
      pacedSend(input.connectionId, input.channelId, () =>
        provider.updateMessage(token, {
          channel: input.channelId,
          ts: input.ts,
          text: input.text,
          blocks: renderBlocks(input.text, input.choices),
        }),
      ),
    );
    return { channelId: posted.channel, ts: posted.ts };
  }),

  'get-user-info': defineOp(false, getUserInfoSchema, async (db, provider, input) => {
    const user = await withConnection(db, input.connectionId, { resource: 'user', id: input.slackUserId }, (token) =>
      provider.usersInfo(token, input.slackUserId),
    );
    return { user };
  }),

  // The bridge's enable-time check: core refuses to enable a ChatBinding
  // unless isMember is true (re-checked on the sweep's error path — the bot
  // can be kicked after binding).
  'get-channel-info': defineOp(false, channelRefSchema, async (db, provider, input) => {
    const channel = await withConnection(db, input.connectionId, { resource: 'channel', id: input.channelId }, (token) =>
      provider.conversationsInfo(token, input.channelId),
    );
    return { channel };
  }),

  // The gap-recovery backfill (spec 043): paced per CONNECTION — a reconnect
  // sweeps one binding at a time and this lane keeps conversations.history
  // under Slack's per-method budget.
  'get-history': defineOp(false, getHistorySchema, async (db, provider, input) => {
    await reserveHistorySlot(input.connectionId);
    const page = await withConnection(db, input.connectionId, { resource: 'channel', id: input.channelId }, (token) =>
      provider.history(token, {
        channel: input.channelId,
        ...(input.oldest ? { oldest: input.oldest } : {}),
        ...(input.latest ? { latest: input.latest } : {}),
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: input.limit ?? 100,
      }),
    );
    return {
      messages: page.messages
        .filter((m) => !m.subtype || m.subtype === 'bot_message' || m.subtype === 'thread_broadcast')
        .map((m) => normalizeRawMessage(input.channelId, m)),
      nextCursor: page.nextCursor,
    };
  }),

  // Live workspace/bot identity — auth.test against the stored token.
  'get-me': defineOp(false, connectionIdSchema, async (db, provider, input) => {
    const me = await withConnection(db, input.connectionId, undefined, (token) => provider.authTest(token));
    return { bot: me };
  }),
};

/** Recursively key-sort a value so semantically equal inputs hash equal. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, canonical(val)]),
    );
  }
  return v;
}

/** Stable SHA-256 of an operation input for idempotency-payload matching. Exported for tests. */
export function hashInput(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

/** Prisma unique-violation check (P2002) — anything else is a real DB error. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/**
 * How long a reservation may sit in-flight (responseJson null) before a
 * retry treats it as ABANDONED and reclaims it. Comfortably above the
 * longest a single op can legitimately run (≤5s inline pacing wait + a 15s
 * provider timeout), so a genuinely in-flight request is never reclaimed.
 */
const STALE_RESERVATION_MS = 2 * 60 * 1000;

/** Attempts to durably store a completed idempotency response before giving up. */
const COMPLETION_STORE_ATTEMPTS = 3;

/** Sleep helper for the completion-store backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Persist the completed response onto its reservation, with a bounded retry.
 *
 * The provider mutation has ALREADY succeeded by the time we get here, so a
 * lost write is the dangerous case: it leaves the key stuck in-flight forever
 * and a later retry can never replay the confirmed mutation. A transient DB
 * blip is absorbed by the retry; if the write still cannot land, we surface a
 * provider_unavailable (never a false success) and leave the reservation for
 * the stale-reclaim path — a retry after STALE_RESERVATION_MS re-executes
 * rather than hanging on "still in flight" indefinitely.
 */
async function storeCompletedResponse(db: Db, key: string, result: unknown): Promise<void> {
  // `?? null`: JSON.stringify(undefined) is `undefined`, which Prisma OMITS
  // from the update — the row would stay responseJson=NULL (in-flight)
  // forever. Serialize an undefined result to the JSON literal "null".
  const responseJson = JSON.stringify(result ?? null);
  let lastErr: unknown;
  for (let attempt = 0; attempt < COMPLETION_STORE_ATTEMPTS; attempt++) {
    try {
      await db.idempotencyRecord.update({ where: { key }, data: { responseJson } });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < COMPLETION_STORE_ATTEMPTS - 1) await sleep(50 * (attempt + 1));
    }
  }
  logError(
    `idempotency: mutation succeeded but could not record its result for key ${key} after ${COMPLETION_STORE_ATTEMPTS} attempts (reservation left for stale-reclaim)`,
    lastErr,
  );
  throw new ProviderUnavailableError();
}

/**
 * Execute an operation by name with reservation-based idempotency: a
 * mutating call carrying an `idempotencyKey` first INSERTS an in-flight
 * reservation (unique key), so a concurrent duplicate cannot also execute
 * the provider mutation — it sees the reservation and is told to retry. A
 * completed key replays the stored response; a key reused with a different
 * operation or payload is rejected instead of leaking the stored response.
 */
export async function runOperation(
  db: Db,
  provider: SlackProvider,
  name: string,
  input: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ result: unknown; replayed: boolean }> {
  const op = OPERATIONS[name];
  if (!op) throw new ValidationError('operation', `unknown operation "${name}"`);

  const useIdempotency = Boolean(idempotencyKey) && op.mutating;
  const requestHash = useIdempotency ? hashInput(input) : '';

  if (useIdempotency) {
    try {
      await db.idempotencyRecord.create({
        data: { key: idempotencyKey!, operation: name, requestHash, responseJson: null },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await db.idempotencyRecord.findUnique({ where: { key: idempotencyKey! } });
      if (!existing) throw new ValidationError('idempotencyKey', 'key state changed concurrently — retry');
      if (existing.operation !== name || existing.requestHash !== requestHash) {
        throw new ValidationError('idempotencyKey', 'key was already used for a different request');
      }
      if (existing.responseJson != null) {
        return { result: JSON.parse(existing.responseJson), replayed: true };
      }
      // Reservation exists but carries no response: either a genuinely
      // in-flight duplicate, or an ABANDONED reservation whose original
      // request crashed / lost its completion write. A fresh one is still
      // running (retry shortly); a stale one is reclaimed and re-executed
      // below, so a lost completion self-heals instead of poisoning the key
      // forever. Re-execution may re-run the provider mutation — the
      // at-least-once tradeoff a caller accepts by retrying with the key.
      const ageMs = Date.now() - existing.createdAt.getTime();
      if (ageMs < STALE_RESERVATION_MS) {
        throw new ValidationError('idempotencyKey', 'a request with this key is still in flight — retry shortly');
      }
      // Claim the stale reservation ATOMICALLY: a conditional update that
      // matches only while the row still carries the createdAt we observed
      // (and no response). Under two concurrent reclaimers exactly one gets
      // count===1 and re-executes; the loser sees count===0 (someone else
      // bumped the clock or completed it) and backs off — so the
      // "concurrent duplicate cannot also execute" guarantee holds even on
      // the reclaim path. DB errors propagate (never swallowed).
      const claim = await db.idempotencyRecord.updateMany({
        where: { key: idempotencyKey!, responseJson: null, createdAt: existing.createdAt },
        data: { createdAt: new Date() },
      });
      if (claim.count !== 1) {
        throw new ValidationError('idempotencyKey', 'a request with this key is still in flight — retry shortly');
      }
      // Won the claim — fall through to re-execute.
    }
  }

  let result: unknown;
  try {
    result = await op.run(db, provider, input);
  } catch (err) {
    // Release the reservation so the caller's retry can execute.
    if (useIdempotency) {
      await db.idempotencyRecord.delete({ where: { key: idempotencyKey! } }).catch(() => {});
    }
    if (err instanceof z.ZodError) throw validationFromZod(err);
    if (err instanceof SlackToolError) throw err;
    throw mapSlackError(err);
  }

  if (useIdempotency) {
    await storeCompletedResponse(db, idempotencyKey!, result);
  }
  return { result, replayed: false };
}
