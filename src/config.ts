/**
 * Environment configuration, validated once at import time.
 *
 * Posture (mirrors hadrontool-telegram / -ms-exchange): fail LOUD at boot in
 * production for anything the service cannot safely run without; degrade
 * gracefully in development. There are no provider app credentials here —
 * Slack's credentials are the per-connection workspace tokens (bot xoxb- +
 * app-level xapp-), which arrive via POST /connections and live encrypted in
 * this tool's own database.
 */
import 'dotenv/config';

/** True when NODE_ENV is production. */
export const isProduction = process.env.NODE_ENV === 'production';

/** True under vitest (NODE_ENV=test pinned by vitest.config.ts). */
export const isTest = process.env.NODE_ENV === 'test';

/** Read an env var, trimmed; empty string counts as unset. */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v === '' ? undefined : v;
}

/** Read a required-in-production env var; throws at boot when missing there. */
function required(name: string): string | undefined {
  const v = env(name);
  if (!v && isProduction) {
    throw new Error(`${name} is required in production — refusing to start`);
  }
  return v;
}

export const config = {
  port: Number(env('PORT') ?? 8080),

  /** Bearer token gating /ops/* and /connections*. Required in production. */
  toolToken: required('SLACK_TOOL_TOKEN'),

  /** 32-byte hex key for AES-256-GCM workspace-token encryption at rest. */
  tokenEncryptionKey: required('TOKEN_ENCRYPTION_KEY'),

  /** hadron-server's internal event ingress; unset ⇒ events logged + dropped. */
  coreEventsUrl: env('CORE_EVENTS_URL'),
  coreEventsToken: env('CORE_EVENTS_TOKEN'),

  /** Web API origin — overridable for tests. */
  slackApiBase: (env('SLACK_API_BASE') ?? 'https://slack.com/api').replace(/\/+$/, ''),

  /** Socket worker kill switch (ops plane still serves). */
  disableSocketWorker: env('DISABLE_SOCKET_WORKER') === 'true',

  /** Minimum gap between sends to the same channel (ms). */
  sendGapMs: Number(env('SLACK_SEND_GAP_MS') ?? 1000),

  /**
   * Minimum gap between get-history calls on the same connection (ms) —
   * conversations.history is one of Slack's tighter-budget methods, and the
   * gap-backfill sweep hits it once per binding on reconnect (spec 043,
   * PR #594 review).
   */
  historyGapMs: Number(env('SLACK_HISTORY_GAP_MS') ?? 1200),

  maxBodySize: env('MAX_BODY_SIZE') ?? '1mb',
} as const;

// Key-shape check runs at boot, not first use — a bad key must not surface
// as a decrypt failure mid-request.
if (config.tokenEncryptionKey && !/^[0-9a-fA-F]{64}$/.test(config.tokenEncryptionKey)) {
  throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes) — refusing to start');
}
