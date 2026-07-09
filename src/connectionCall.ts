/**
 * The ONE lifecycle wrapper for every Web API call made on behalf of a
 * connection — used by the ops plane and the socket worker alike, so the
 * invariants can't drift per plane:
 *
 *  1. load the ACTIVE connection (typed connection_not_found /
 *     connection_unauthorized; a stored ERROR status short-circuits),
 *  2. decrypt the bot token with the tool's key,
 *  3. run the provider call,
 *  4. map provider failures to the typed catalog, marking the connection
 *     ERROR on connection_unauthorized (dead token) so later calls
 *     short-circuit until the workspace is re-registered.
 *
 * Like the telegram sibling and simpler than ms-exchange: Slack workspace
 * tokens are static until revoked — no refresh-token rotation to persist.
 */
import { decryptToken } from './crypto.js';
import type { Db } from './db.js';
import {
  ConnectionNotFoundError,
  ConnectionUnauthorizedError,
  mapSlackError,
  type ResourceHint,
} from './errors.js';

/** Run a provider call for a connection with the full lifecycle above. */
export async function withConnection<T>(
  db: Db,
  connectionId: string,
  resourceHint: ResourceHint,
  fn: (botToken: string) => Promise<T>,
): Promise<T> {
  const connection = await db.connection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.deletedAt) throw new ConnectionNotFoundError();
  if (connection.status === 'ERROR') throw new ConnectionUnauthorizedError();
  const botToken = decryptToken(connection.botTokenEnc);

  try {
    return await fn(botToken);
  } catch (err) {
    const mapped = mapSlackError(err, resourceHint);
    if (mapped instanceof ConnectionUnauthorizedError) {
      await db.connection
        .update({
          where: { id: connectionId },
          data: { status: 'ERROR', lastError: 'Slack token invalid — re-register the workspace' },
        })
        .catch(() => {});
    }
    throw mapped;
  }
}
