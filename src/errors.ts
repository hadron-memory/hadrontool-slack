/**
 * Typed error catalog — the spec 043 contract, following the spec 002 shape.
 *
 * Codes are the PUBLIC surface: hadron-server's slackClient passes them
 * through to GraphQL `extensions.code` / MCP errors verbatim, so their
 * meanings must stay stable. New codes may be added; existing ones never
 * change meaning.
 */
import { SlackApiError } from './providers/webapi/types.js';

/** Base class: every tool error carries a stable `code` + HTTP status. */
export abstract class SlackToolError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  /** JSON body shape every error response uses. */
  toBody(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extraFields() };
  }

  protected extraFields(): Record<string, unknown> {
    return {};
  }
}

/** connectionId unknown OR soft-deleted — indistinguishable by design (anti-enumeration). */
export class ConnectionNotFoundError extends SlackToolError {
  readonly code = 'connection_not_found';
  readonly httpStatus = 404;
  constructor() {
    super('This Slack connection no longer exists.');
  }
}

/** Connection exists but its tokens are dead (app uninstalled / token revoked). */
export class ConnectionUnauthorizedError extends SlackToolError {
  readonly code = 'connection_unauthorized';
  readonly httpStatus = 403;
  constructor() {
    super('The Slack tokens are no longer valid; the workspace must be re-registered.');
  }
}

/** The channel id does not exist (or is not visible to this bot). */
export class ChannelNotFoundError extends SlackToolError {
  readonly code = 'channel_not_found';
  readonly httpStatus = 404;
  constructor(public channelId: string) {
    super('The channel is no longer available.');
  }
  protected extraFields() {
    return { channelId: this.channelId };
  }
}

/**
 * The channel exists but the bot cannot act in it: not invited, or the
 * channel is archived. Distinct from connection_unauthorized — the TOKENS
 * are fine, the CHANNEL relationship is not. The bridge's enable-time
 * membership check exists to surface this before binding, not after.
 */
export class NotInChannelError extends SlackToolError {
  readonly code = 'not_in_channel';
  readonly httpStatus = 403;
  constructor(public detail: string) {
    super(`The bot cannot act in this channel: ${detail}`);
  }
  protected extraFields() {
    return { detail: this.detail };
  }
}

/** Provider 429 — caller should retry after the indicated delay. */
export class ProviderRateLimitedError extends SlackToolError {
  readonly code = 'provider_rate_limited';
  readonly httpStatus = 429;
  constructor(public retryAfterSeconds: number) {
    super('Slack is rate-limiting; retry shortly.');
  }
  protected extraFields() {
    return { retryAfterSeconds: this.retryAfterSeconds };
  }
}

/** Provider 5xx / network failure — transient, caller may retry with backoff. */
export class ProviderUnavailableError extends SlackToolError {
  readonly code = 'provider_unavailable';
  readonly httpStatus = 502;
  constructor() {
    super('Slack is temporarily unavailable.');
  }
}

/** A message/user/thread id does not exist (or is not visible to this bot). */
export class NotFoundError extends SlackToolError {
  readonly code = 'not_found';
  readonly httpStatus = 404;
  constructor(
    public resource: 'channel' | 'message' | 'user' | 'thread',
    public id: string,
  ) {
    super(`The ${resource} is no longer available.`);
  }
  protected extraFields() {
    return { resource: this.resource, id: this.id };
  }
}

/** Input failed schema or semantic validation. */
export class ValidationError extends SlackToolError {
  readonly code = 'validation_error';
  readonly httpStatus = 400;
  constructor(
    public field: string,
    public reason: string,
  ) {
    super(`This request couldn't be processed: ${reason}`);
  }
  protected extraFields() {
    return { field: this.field, reason: this.reason };
  }
}

/**
 * Build a ValidationError from a zod failure — the ONE place the
 * first-issue/path-join convention lives; `field`/`reason` are part of the
 * stable public error contract, so every plane must flatten identically.
 */
export function validationFromZod(err: { issues: { path: PropertyKey[]; message: string }[] }): ValidationError {
  const issue = err.issues[0];
  return new ValidationError(issue?.path.map(String).join('.') || 'input', issue?.message ?? 'invalid input');
}

/** Optional hint improving not_found error payloads. */
export type ResourceHint = { resource: 'channel' | 'message' | 'user' | 'thread'; id: string } | undefined;

/** Slack `error` codes that mean the TOKEN is dead (workspace-level failure). */
const AUTH_DEAD_CODES = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired']);

/** Slack `error` codes that mean a referenced entity is gone. */
const NOT_FOUND_CODES: Record<string, 'message' | 'user' | 'thread'> = {
  message_not_found: 'message',
  cant_update_message: 'message',
  user_not_found: 'user',
  thread_not_found: 'thread',
};

/**
 * Map a raw Web API / fetch failure to a typed SlackToolError. Anything
 * already typed passes through; unknown shapes become provider_unavailable
 * (transient by default — never pretend success).
 *
 * Web API error taxonomy: failures usually arrive as HTTP 200 with
 * `{ok: false, error: '<code>'}`; rate limits as HTTP 429 + Retry-After.
 * Token-dead codes mark the connection-level failure; `channel_not_found` /
 * `not_in_channel` / `is_archived` are CHANNEL relationships — the token
 * itself is fine.
 */
export function mapSlackError(err: unknown, resourceHint?: ResourceHint): SlackToolError {
  if (err instanceof SlackToolError) return err;
  if (!(err instanceof SlackApiError)) return new ProviderUnavailableError();

  if (err.httpStatus === 429 || err.slackError === 'ratelimited' || err.slackError === 'rate_limited') {
    return new ProviderRateLimitedError(err.retryAfter && err.retryAfter > 0 ? err.retryAfter : 30);
  }
  if (AUTH_DEAD_CODES.has(err.slackError)) return new ConnectionUnauthorizedError();
  if (err.slackError === 'channel_not_found') {
    return new ChannelNotFoundError(resourceHint?.resource === 'channel' ? resourceHint.id : 'unknown');
  }
  if (err.slackError === 'not_in_channel' || err.slackError === 'is_archived') {
    return new NotInChannelError(err.slackError);
  }
  const notFound = NOT_FOUND_CODES[err.slackError];
  if (notFound) return new NotFoundError(notFound, resourceHint?.id ?? 'unknown');
  if (err.httpStatus >= 500 || err.httpStatus === 0) return new ProviderUnavailableError();
  // Everything else (missing_scope, invalid_blocks, invalid_arguments, …) is
  // a request problem; surface Slack's code verbatim as the reason.
  return new ValidationError('request', err.slackError);
}
