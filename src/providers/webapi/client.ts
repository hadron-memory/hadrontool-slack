/**
 * Production SlackProvider over the plain Web API — raw fetch for the
 * request/response methods. Every call is `POST {base}/{method}` with a
 * bearer token and a JSON body; Slack answers HTTP 200 with
 * `{ok: true, …}` or `{ok: false, error}` (rate limits: HTTP 429 +
 * Retry-After header).
 *
 * Failures throw SlackApiError with the envelope attached; mapping to the
 * typed public catalog happens in src/errors.ts — nothing Slack-shaped
 * leaks past the ops layer. The stateful Socket Mode lifecycle is NOT here
 * (spec 043 decision 3 delegates it to @slack/socket-mode; see
 * src/jobs/socket.ts).
 */
import { config } from '../../config.js';
import {
  type HistoryPage,
  type HistoryParams,
  type PostEphemeralParams,
  type PostMessageParams,
  type PostedMessage,
  type RawSlackMessage,
  type RespondUrlPayload,
  SlackApiError,
  type SlackAuthInfo,
  type SlackChannelInfo,
  type SlackProvider,
  type SlackUserInfo,
  type UpdateMessageParams,
} from './types.js';

/** Default per-call HTTP timeout. */
const CALL_TIMEOUT_MS = 15_000;

/** Call one Web API method; unwrap the envelope or throw SlackApiError. */
async function call<T extends Record<string, unknown>>(
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.slackApiBase}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure / timeout — transient by default.
    throw new SlackApiError(0, `network failure calling ${method}: ${String(err)}`);
  }
  // Classify rate limits from the STATUS + header, BEFORE reading the body: a
  // 429 can arrive with an empty or non-JSON body, and parsing it first would
  // mask the rate limit as a generic network failure (provider_unavailable),
  // dropping the retryAfter and the channel backoff.
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? '30');
    throw new SlackApiError(429, 'ratelimited', Number.isNaN(retryAfter) ? 30 : retryAfter);
  }
  let body: ({ ok: boolean; error?: string } & T) | undefined;
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    // Non-JSON body on a non-429 response — transient by default.
    throw new SlackApiError(0, `non-JSON body from ${method} (${res.status}): ${String(err)}`);
  }
  if (!body || body.ok !== true) {
    throw new SlackApiError(res.status, body?.error ?? `Web API ${method} failed (${res.status})`);
  }
  return body;
}

export const slackProvider: SlackProvider = {
  async authTest(botToken): Promise<SlackAuthInfo> {
    const r = await call<{ team_id: string; team: string; user_id: string; bot_id?: string }>(botToken, 'auth.test', {});
    return {
      teamId: r.team_id,
      teamName: r.team,
      botUserId: r.user_id,
      botId: r.bot_id ?? null,
    };
  },

  async connectionsOpen(appToken): Promise<string> {
    const r = await call<{ url: string }>(appToken, 'apps.connections.open', {});
    return r.url;
  },

  async postMessage(botToken, params: PostMessageParams): Promise<PostedMessage> {
    const r = await call<{ channel: string; ts: string }>(botToken, 'chat.postMessage', { ...params });
    return { channel: r.channel, ts: r.ts };
  },

  async postEphemeral(botToken, params: PostEphemeralParams): Promise<{ ts: string }> {
    const r = await call<{ message_ts: string }>(botToken, 'chat.postEphemeral', { ...params });
    return { ts: r.message_ts };
  },

  async updateMessage(botToken, params: UpdateMessageParams): Promise<PostedMessage> {
    const r = await call<{ channel: string; ts: string }>(botToken, 'chat.update', { ...params });
    return { channel: r.channel, ts: r.ts };
  },

  async respondUrl(responseUrl, payload: RespondUrlPayload): Promise<void> {
    // response_url is a webhook, not a Web API method: the URL itself is the
    // credential and the success body is plain "ok".
    let res: Response;
    try {
      res = await fetch(responseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SlackApiError(0, `network failure calling response_url: ${String(err)}`);
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '30');
      throw new SlackApiError(429, 'ratelimited', Number.isNaN(retryAfter) ? 30 : retryAfter);
    }
    if (!res.ok) {
      // Expired/invalid response_url answers 404 "Expired url"-style bodies.
      throw new SlackApiError(res.status, res.status === 404 ? 'response_url_expired' : `response_url failed (${res.status})`);
    }
  },

  async usersInfo(botToken, slackUserId): Promise<SlackUserInfo> {
    const r = await call<{
      user: {
        id: string;
        is_bot?: boolean;
        profile?: { display_name?: string; real_name?: string; email?: string };
        real_name?: string;
        name?: string;
      };
    }>(botToken, 'users.info', { user: slackUserId });
    const u = r.user;
    return {
      slackUserId: u.id,
      displayName: u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || u.id,
      realName: u.profile?.real_name ?? u.real_name ?? null,
      email: u.profile?.email ?? null,
      isBot: u.is_bot ?? false,
    };
  },

  async conversationsInfo(botToken, channelId): Promise<SlackChannelInfo> {
    const r = await call<{
      channel: { id: string; name?: string; is_private?: boolean; is_member?: boolean };
    }>(botToken, 'conversations.info', { channel: channelId });
    return {
      channelId: r.channel.id,
      name: r.channel.name ?? null,
      isPrivate: r.channel.is_private ?? false,
      isMember: r.channel.is_member ?? false,
    };
  },

  async history(botToken, params: HistoryParams): Promise<HistoryPage> {
    const { thread_ts, ...rest } = params;
    const method = thread_ts ? 'conversations.replies' : 'conversations.history';
    const r = await call<{
      messages?: RawSlackMessage[];
      response_metadata?: { next_cursor?: string };
    }>(botToken, method, thread_ts ? { ...rest, ts: thread_ts } : rest);
    return {
      messages: r.messages ?? [],
      nextCursor: r.response_metadata?.next_cursor || null,
    };
  },
};
