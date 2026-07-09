/**
 * Per-channel send pacing (spec 043): Slack allows roughly 1 msg/s per
 * channel on chat.postMessage; the tool paces and absorbs SHORT waits inside
 * the request, but NEVER holds a request long or acks an undelivered
 * message — on saturation the op returns provider_rate_limited + retryAfter,
 * and durable retry belongs to core's sweep worker (which holds the cursor
 * and replays with the same idempotencyKey).
 *
 * get-history gets its own per-CONNECTION lane (spec 043, PR #594 review):
 * conversations.history has a tight per-method budget and the gap-backfill
 * sweep calls it once per binding on reconnect — the pacer is what keeps a
 * many-binding reconnect from tripping Slack's limits.
 *
 * State is deliberately in-memory: it is pacing, not a delivery queue —
 * nothing is lost on restart because nothing undelivered was ever acked.
 */
import { config } from './config.js';
import { ProviderRateLimitedError } from './errors.js';

/** Longest a request is held for pacing before we bounce to the caller. */
const MAX_INLINE_WAIT_MS = 5_000;

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Earliest next-send time per pacing lane. */
const nextFreeAt = new Map<string, number>();

/** Periodically drop stale entries so the map can't grow unboundedly. */
const SWEEP_INTERVAL_MS = 60_000;
let lastSweep = 0;
function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, at] of nextFreeAt) {
    if (at <= now) nextFreeAt.delete(key);
  }
}

/**
 * Reserve a slot on a pacing lane: waits out a short gap inline, or throws
 * provider_rate_limited when the projected wait exceeds the inline budget.
 * The slot is consumed on reservation — two concurrent sends on one lane
 * serialize (or the later one bounces), never both fire at once.
 */
async function reserveSlot(key: string, gap: number): Promise<void> {
  if (gap <= 0) return; // pacing disabled (tests)
  const now = Date.now();
  sweep(now);
  const at = Math.max(now, nextFreeAt.get(key) ?? 0);
  const wait = at - now;
  if (wait > MAX_INLINE_WAIT_MS) {
    throw new ProviderRateLimitedError(Math.ceil(wait / 1000));
  }
  nextFreeAt.set(key, at + gap);
  if (wait > 0) await sleep(wait);
}

/** Reserve a send slot for a channel (~1 msg/s per channel). */
export function reserveSendSlot(connectionId: string, channelId: string): Promise<void> {
  return reserveSlot(`${connectionId}:${channelId}`, config.sendGapMs);
}

/** Reserve a history slot for a connection (the gap-backfill lane). */
export function reserveHistorySlot(connectionId: string): Promise<void> {
  return reserveSlot(`${connectionId}:__history__`, config.historyGapMs);
}

/**
 * Record a provider 429 for a channel so subsequent sends back off without
 * hitting Slack again before `retryAfterSeconds` has passed.
 */
export function recordProviderBackoff(connectionId: string, channelId: string, retryAfterSeconds: number): void {
  const key = `${connectionId}:${channelId}`;
  const until = Date.now() + retryAfterSeconds * 1000;
  nextFreeAt.set(key, Math.max(nextFreeAt.get(key) ?? 0, until));
}
