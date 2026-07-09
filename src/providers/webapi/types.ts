/**
 * Provider-layer types + the injectable SlackProvider interface.
 *
 * The ops layer (src/ops), the socket worker, and routes depend only on this
 * interface; tests inject a fake, and src/providers/webapi/client.ts is the
 * production implementation over the plain Web API (raw fetch for the
 * request/response methods — the 042-decision-5 posture; the stateful Socket
 * Mode lifecycle is the part delegated to @slack/socket-mode, per spec 043
 * decision 3).
 */

/** auth.test identity for a bot token. */
export interface SlackAuthInfo {
  teamId: string;
  teamName: string;
  /** The bot's Slack USER id ("U…") — the sender on messages it posts. */
  botUserId: string;
  /**
   * The bot's BOT id ("B…") — what bot message events carry as `bot_id`.
   * Absent when the token is not a bot token (registration rejects that).
   */
  botId: string | null;
}

/** users.info subset. */
export interface SlackUserInfo {
  slackUserId: string;
  displayName: string;
  realName: string | null;
  email: string | null;
  isBot: boolean;
}

/** conversations.info subset — the bridge enable-time check reads isMember. */
export interface SlackChannelInfo {
  channelId: string;
  name: string | null;
  isPrivate: boolean;
  isMember: boolean;
}

/** A raw message as conversations.history / .replies returns it (subset). */
export interface RawSlackMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  subtype?: string;
}

/** chat.postMessage / chat.update result subset. */
export interface PostedMessage {
  channel: string;
  ts: string;
}

/** chat.postMessage parameters (the v1 subset; blocks built by the ops layer). */
export interface PostMessageParams {
  channel: string;
  text: string;
  blocks?: Record<string, unknown>[];
  thread_ts?: string;
  /** chat:write.customize overrides — the bridge's per-agent identity. */
  username?: string;
  icon_url?: string;
}

/** chat.postEphemeral parameters. */
export interface PostEphemeralParams {
  channel: string;
  user: string;
  text: string;
  blocks?: Record<string, unknown>[];
  thread_ts?: string;
}

/** chat.update parameters. */
export interface UpdateMessageParams {
  channel: string;
  ts: string;
  text: string;
  blocks?: Record<string, unknown>[];
}

/** conversations.history / .replies parameters. */
export interface HistoryParams {
  channel: string;
  oldest?: string;
  latest?: string;
  cursor?: string;
  limit?: number;
  /** When set, reads the THREAD via conversations.replies instead. */
  thread_ts?: string;
}

/** History page. */
export interface HistoryPage {
  messages: RawSlackMessage[];
  nextCursor: string | null;
}

/** response_url payload (slash-command / interaction replies). */
export interface RespondUrlPayload {
  text: string;
  blocks?: Record<string, unknown>[];
  response_type?: 'ephemeral' | 'in_channel';
  replace_original?: boolean;
}

/**
 * A Web API failure, thrown by the client with Slack's error envelope
 * attached so src/errors.ts can map it to the typed catalog. Slack failures
 * usually arrive as HTTP 200 + `{ok: false, error}`; `retryAfter` carries
 * the Retry-After header on HTTP 429s.
 */
export class SlackApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly slackError: string,
    public readonly retryAfter?: number,
  ) {
    super(`Slack API ${httpStatus}: ${slackError}`);
  }
}

/**
 * Everything the tool needs from Slack's request/response surface. One
 * method per Web API method; every method takes the connection's decrypted
 * token (bot token unless noted). The stateful Socket Mode connection lives
 * behind the separate SocketFactory (src/jobs/socket.ts).
 */
export interface SlackProvider {
  /** Validate a bot token + fetch the workspace/bot identity. Used at registration and by the get-me op. */
  authTest(botToken: string): Promise<SlackAuthInfo>;
  /** Validate an APP-level token by opening (and discarding) a socket URL. */
  connectionsOpen(appToken: string): Promise<string>;
  postMessage(botToken: string, params: PostMessageParams): Promise<PostedMessage>;
  postEphemeral(botToken: string, params: PostEphemeralParams): Promise<{ ts: string }>;
  updateMessage(botToken: string, params: UpdateMessageParams): Promise<PostedMessage>;
  /** POST to a slash-command / interaction response_url (no token — the URL is the credential). */
  respondUrl(responseUrl: string, payload: RespondUrlPayload): Promise<void>;
  usersInfo(botToken: string, slackUserId: string): Promise<SlackUserInfo>;
  conversationsInfo(botToken: string, channelId: string): Promise<SlackChannelInfo>;
  history(botToken: string, params: HistoryParams): Promise<HistoryPage>;
}
