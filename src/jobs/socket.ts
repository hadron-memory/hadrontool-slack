/**
 * The Socket Mode worker — one socket client per active connection.
 *
 * DELIVERY SEMANTICS (spec 043 decision 5, hardened by the PR #594 review):
 * Slack requires an envelope ack within ~3s and NEVER redelivers an acked
 * envelope, so the order is **persist → ack → forward**: the normalized
 * event lands in the EventInbox first, then the envelope is acked, then the
 * drainer (src/jobs/inbox.ts) delivers it to core. A persist failure leaves
 * the envelope UNACKED — Slack redelivers it — and a duplicate redelivery
 * hits the (connectionId, envelopeId) unique key and just acks.
 *
 * The stateful WebSocket lifecycle (envelopes, acks, reconnects, ping) is
 * @slack/socket-mode's job (spec 043 decision 3); this module owns
 * normalization + the persist-ack contract, and is tested over an injected
 * SocketFactory fake. Connectivity gaps become slack.gap events on every
 * (re)connect — Socket Mode has no server-side queue, so core's get-history
 * backfill is the bridge's durability story.
 *
 * The worker is Hadron-blind like everything here: it normalizes envelopes
 * and persists them for the forwarder; core owns bindings, users, and chat
 * nodes.
 */
import { SocketModeClient } from '@slack/socket-mode';
import { config } from '../config.js';
import { decryptToken } from '../crypto.js';
import type { Db } from '../db.js';
import type { EventForwarder, SlackEvent } from '../events/forwarder.js';
import { logError, logInfo } from '../logger.js';
import { persistEvent, startInboxDrainer } from './inbox.js';

/** How often the reconciler diffs running sockets against the connections table. */
const RECONCILE_INTERVAL_MS = 15_000;

/** Envelope types the worker consumes. */
export type EnvelopeType = 'slash_commands' | 'interactive' | 'events_api';

/** What the worker needs from a live socket — injectable for tests. */
export interface SocketHandlers {
  onEnvelope(type: EnvelopeType, envelopeId: string, body: Record<string, unknown>, ack: () => Promise<void>): Promise<void>;
  onConnected(): void;
  onDisconnected(): void;
}

/** A running socket client. */
export interface SocketHandle {
  stop(): Promise<void>;
}

/** Builds a live socket for an app token — production wraps @slack/socket-mode. */
export type SocketFactory = (appToken: string, handlers: SocketHandlers) => Promise<SocketHandle>;

/** The connection identity fields normalization needs. */
export interface ConnectionIdentity {
  id: string;
  teamId: string;
}

/** Envelope-body subset for slash commands. */
interface SlashCommandBody {
  command?: string;
  text?: string;
  channel_id?: string;
  user_id?: string;
  team_id?: string;
  response_url?: string;
  trigger_id?: string;
}

/** Envelope-body subset for block_actions interactions. */
interface InteractiveBody {
  type?: string;
  team?: { id?: string };
  user?: { id?: string };
  channel?: { id?: string };
  container?: { message_ts?: string };
  response_url?: string;
  actions?: { value?: string; selected_option?: { value?: string } }[];
}

/** Envelope-body subset for Events API message events. */
interface EventsApiBody {
  team_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    channel?: string;
    user?: string;
    bot_id?: string;
    username?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
  };
}

/** Message subtypes the bridge mirrors; everything else (joins, edits, deletes) is skipped in v1. */
const MIRRORED_SUBTYPES = new Set([undefined, 'bot_message', 'thread_broadcast']);

/**
 * Normalize one envelope to its event, or null when it needs no delivery
 * (non-message Events API payloads, edited/deleted/system messages in v1,
 * malformed bodies). Bot messages ARE forwarded, carrying `from.botId` —
 * core's loop filter is deliberate, not structural (spec 043 decision 8).
 */
export function eventForEnvelope(
  connection: ConnectionIdentity,
  type: EnvelopeType,
  envelopeId: string,
  body: Record<string, unknown>,
): SlackEvent | null {
  if (type === 'slash_commands') {
    const b = body as SlashCommandBody;
    if (!b.command || !b.channel_id || !b.user_id || !b.response_url) return null;
    return {
      event: 'slack.command',
      connectionId: connection.id,
      teamId: b.team_id ?? connection.teamId,
      channelId: b.channel_id,
      slackUserId: b.user_id,
      command: b.command,
      text: b.text ?? '',
      responseUrl: b.response_url,
      triggerId: b.trigger_id ?? '',
      envelopeId,
    };
  }

  if (type === 'interactive') {
    const b = body as InteractiveBody;
    if (b.type !== 'block_actions') return null;
    const action = b.actions?.[0];
    const value = action?.value ?? action?.selected_option?.value;
    if (!value || !b.user?.id || !b.response_url) return null;
    return {
      event: 'slack.interaction',
      connectionId: connection.id,
      teamId: b.team?.id ?? connection.teamId,
      channelId: b.channel?.id ?? '',
      slackUserId: b.user.id,
      value,
      responseUrl: b.response_url,
      messageTs: b.container?.message_ts ?? '',
      envelopeId,
    };
  }

  // events_api — the bridge inbound.
  const b = body as EventsApiBody;
  const ev = b.event;
  if (!ev || ev.type !== 'message' || !ev.channel || !ev.ts) return null;
  if (!MIRRORED_SUBTYPES.has(ev.subtype)) return null;
  return {
    event: 'slack.message.received',
    connectionId: connection.id,
    teamId: b.team_id ?? connection.teamId,
    channelId: ev.channel,
    threadTs: ev.thread_ts && ev.thread_ts !== ev.ts ? ev.thread_ts : null,
    from: {
      slackUserId: ev.user ?? null,
      botId: ev.bot_id ?? null,
      displayName: ev.username ?? null,
    },
    ts: ev.ts,
    text: ev.text ?? '',
    envelopeId,
  };
}

/** Build the slack.gap event for a (re)connect. */
export function gapEvent(connectionId: string, disconnectedAt: Date | null, reconnectedAt: Date): SlackEvent {
  return {
    event: 'slack.gap',
    connectionId,
    disconnectedAt: disconnectedAt ? disconnectedAt.toISOString() : null,
    reconnectedAt: reconnectedAt.toISOString(),
    envelopeId: `gap:${reconnectedAt.getTime()}`,
  };
}

/**
 * Handle one envelope with the persist-ack contract. Exported for tests.
 * Returns 'persisted' | 'duplicate' | 'skipped' | 'dropped' | 'failed'.
 */
export async function handleEnvelope(
  db: Db,
  connection: ConnectionIdentity,
  type: EnvelopeType,
  envelopeId: string,
  body: Record<string, unknown>,
  ack: () => Promise<void>,
): Promise<'persisted' | 'duplicate' | 'skipped' | 'dropped' | 'failed'> {
  const event = eventForEnvelope(connection, type, envelopeId, body);
  if (!event) {
    await ack();
    return 'skipped';
  }
  if (!config.coreEventsUrl) {
    // Unconfigured consumer is deliberate — log + drop, no inbox writes.
    logInfo(`event ${event.event} for connection ${connection.id} dropped (CORE_EVENTS_URL unset)`);
    await ack();
    return 'dropped';
  }
  let fresh: boolean;
  try {
    fresh = await persistEvent(db, event);
  } catch (err) {
    // NOT acked — Slack redelivers the envelope; the unique key dedupes.
    logError(`failed to persist envelope ${envelopeId} for connection ${connection.id} (leaving unacked)`, err);
    return 'failed';
  }
  await ack();
  return fresh ? 'persisted' : 'duplicate';
}

/** Production SocketFactory over @slack/socket-mode (spec 043 decision 3). */
export const socketModeFactory: SocketFactory = async (appToken, handlers) => {
  const client = new SocketModeClient({
    appToken,
    clientOptions: { slackApiUrl: `${config.slackApiBase}/` },
  });

  const envelopeTypes: EnvelopeType[] = ['slash_commands', 'interactive', 'events_api'];
  for (const type of envelopeTypes) {
    client.on(type, (args: { envelope_id?: string; body?: Record<string, unknown>; ack: (r?: unknown) => Promise<void> }) => {
      void handlers
        .onEnvelope(type, args.envelope_id ?? '', args.body ?? {}, () => args.ack())
        .catch((err) => logError(`envelope handler crashed (${type})`, err));
    });
  }
  client.on('connected', () => handlers.onConnected());
  client.on('disconnected', () => handlers.onDisconnected());

  await client.start();
  return {
    stop: async () => {
      await client.disconnect();
    },
  };
};

/**
 * Start the worker: a reconciler tick keeps one socket per active
 * connection (new connections picked up within RECONCILE_INTERVAL_MS;
 * deleted/disabled ones are stopped on the next tick). A dead app token
 * marks the connection ERROR so the reconciler stops retrying it until
 * re-registration.
 */
export function startSocketWorker(
  db: Db,
  forward: EventForwarder,
  factory: SocketFactory = socketModeFactory,
): { stop: () => Promise<void> } {
  const running = new Map<string, SocketHandle>();
  const starting = new Set<string>();
  let stopped = false;

  async function startOne(connectionId: string): Promise<void> {
    const connection = await db.connection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.deletedAt || connection.status !== 'ACTIVE' || !connection.socketEnabled) return;

    const identity: ConnectionIdentity = { id: connection.id, teamId: connection.teamId };
    let disconnectedAt: Date | null = null;

    const handlers: SocketHandlers = {
      onEnvelope: async (type, envelopeId, body, ack) => {
        await handleEnvelope(db, identity, type, envelopeId, body, ack);
      },
      onConnected: () => {
        logInfo(`socket connected for connection ${connection.id}`);
        // Every (re)connect is a potential gap — core sweeps from its own
        // cursor, so a no-gap sweep is cheap and idempotent.
        const event = gapEvent(connection.id, disconnectedAt, new Date());
        disconnectedAt = null;
        if (!config.coreEventsUrl) return;
        persistEvent(db, event).catch((err) => logError(`failed to persist gap event for connection ${connection.id}`, err));
      },
      onDisconnected: () => {
        if (!disconnectedAt) disconnectedAt = new Date();
        logInfo(`socket disconnected for connection ${connection.id}`);
      },
    };

    try {
      const appToken = decryptToken(connection.appTokenEnc);
      const handle = await factory(appToken, handlers);
      running.set(connectionId, handle);
    } catch (err) {
      logError(`failed to start socket for connection ${connectionId}`, err);
      // An invalid app token would loop forever — mark ERROR so the
      // reconciler skips it until the workspace is re-registered.
      const message = String(err);
      if (/invalid_auth|token_revoked|account_inactive|forbidden/i.test(message)) {
        await db.connection
          .update({ where: { id: connectionId }, data: { status: 'ERROR', lastError: 'app token invalid — re-register the workspace' } })
          .catch(() => {});
      }
    }
  }

  async function reconcile(): Promise<void> {
    const connections = await db.connection.findMany({
      where: { deletedAt: null, status: 'ACTIVE', socketEnabled: true },
      select: { id: true },
    });
    const wanted = new Set(connections.map((c) => c.id));

    for (const id of wanted) {
      if (!running.has(id) && !starting.has(id) && !stopped) {
        starting.add(id);
        void startOne(id).finally(() => starting.delete(id));
      }
    }
    for (const [id, handle] of running) {
      if (!wanted.has(id)) {
        running.delete(id);
        void handle.stop().catch((err) => logError(`failed to stop socket for connection ${id}`, err));
      }
    }
  }

  const timer = setInterval(() => {
    void reconcile().catch((err) => logError('socket reconciler failed', err));
  }, RECONCILE_INTERVAL_MS);
  void reconcile().catch((err) => logError('socket reconciler failed', err));
  const drainer = startInboxDrainer(db, forward);
  logInfo('socket worker started');

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      drainer.stop();
      await Promise.all([...running.values()].map((h) => h.stop().catch(() => {})));
      running.clear();
    },
  };
}
