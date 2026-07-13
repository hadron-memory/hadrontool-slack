/**
 * The persist-before-ack event inbox (spec 043 decision 5, PR #594 Codex
 * review).
 *
 * WHY IT EXISTS: Slack never redelivers an acked Socket Mode envelope, and
 * the 3-second ack deadline rules out forward-before-ack. So the socket
 * worker writes the normalized event HERE first, acks, and this drainer
 * delivers rows to core with bounded retries — the durable buffer that
 * Telegram's 24h getUpdates queue gave hadrontool-telegram for free.
 * Delivered rows are deleted; rows that exhaust their retries are marked
 * DEAD and kept for inspection (one poison event can't wedge the stream).
 *
 * Ordering: rows drain oldest-first PER CONNECTION, and a failed delivery
 * stops that connection's drain for the cycle — command/interaction order
 * is preserved within a connection. Delivery is at-least-once (a crash
 * between core's 2xx and the row delete redelivers); core consumers dedupe
 * on (connectionId, envelopeId).
 */
import type { Db } from './../db.js';
import type { EventForwarder, SlackEvent } from '../events/forwarder.js';
import { logError, logInfo } from '../logger.js';

/** Failed delivery attempts before a row is dead-lettered. */
export const DEAD_LETTER_AFTER = 10;

/** Pause between drain cycles. */
const DRAIN_INTERVAL_MS = 1_000;

/** Rows fetched per drain cycle. */
const DRAIN_BATCH = 100;

/**
 * Persist a normalized event before its envelope is acked. Returns false
 * when the (connectionId, envelopeId) pair already exists — an envelope
 * redelivery — which callers treat as "already persisted, safe to ack".
 */
export async function persistEvent(db: Db, event: SlackEvent): Promise<boolean> {
  try {
    await db.eventInbox.create({
      data: {
        connectionId: event.connectionId,
        envelopeId: event.envelopeId,
        eventJson: JSON.stringify(event),
      },
    });
    return true;
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'P2002') return false;
    throw err;
  }
}

/**
 * One drain cycle: deliver PENDING rows oldest-first, per-connection
 * ordered. Returns the number of rows successfully delivered.
 */
export async function drainInboxOnce(db: Db, forward: EventForwarder): Promise<number> {
  const rows = await db.eventInbox.findMany({
    where: { status: 'PENDING' },
    // Order by the monotonic sequence, NOT createdAt: tied timestamps would
    // otherwise let two rows in one connection reorder, and a failed
    // delivery could then stall the wrong one — breaking per-connection
    // ordering (spec 043 decision 5).
    orderBy: { seq: 'asc' },
    take: DRAIN_BATCH,
  });

  let delivered = 0;
  const stalled = new Set<string>();
  for (const row of rows) {
    if (stalled.has(row.connectionId)) continue; // preserve per-connection order

    let ok = false;
    let failure = 'core delivery failed';
    try {
      ok = await forward(JSON.parse(row.eventJson) as SlackEvent);
    } catch (err) {
      failure = String(err);
    }

    if (ok) {
      await db.eventInbox.delete({ where: { id: row.id } }).catch(() => {});
      delivered++;
      continue;
    }

    const attempts = row.attempts + 1;
    if (attempts >= DEAD_LETTER_AFTER) {
      // Abandoning the row unblocks the connection's stream immediately —
      // the telegram poller's dead-letter-then-continue semantics.
      logError(
        `DEAD-LETTER: giving up on inbox event ${row.envelopeId} for connection ${row.connectionId} after ${attempts} attempts: ${row.eventJson}`,
      );
      await db.eventInbox
        .update({ where: { id: row.id }, data: { attempts, status: 'DEAD', lastError: failure } })
        .catch(() => {});
    } else {
      stalled.add(row.connectionId);
      await db.eventInbox
        .update({ where: { id: row.id }, data: { attempts, lastError: failure } })
        .catch(() => {});
    }
  }
  return delivered;
}

/** Start the drain loop; returns a stop handle. */
export function startInboxDrainer(db: Db, forward: EventForwarder): { stop: () => void } {
  let stopped = false;
  let draining = false;

  const timer = setInterval(() => {
    if (stopped || draining) return;
    draining = true;
    drainInboxOnce(db, forward)
      .catch((err) => logError('inbox drain cycle failed', err))
      .finally(() => {
        draining = false;
      });
  }, DRAIN_INTERVAL_MS);

  logInfo('inbox drainer started');
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
