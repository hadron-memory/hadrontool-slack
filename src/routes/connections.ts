/**
 * Connection lifecycle — internal plane (bearer-gated).
 *
 * Registration is the whole "OAuth" story for a Socket Mode install: the
 * org admin installed the Hadron Slack app into the workspace and holds the
 * bot token (xoxb-…) + app-level token (xapp-…); core forwards
 * `{botToken, appToken}` here already-authorized. The tool validates both
 * live (auth.test for the bot token, apps.connections.open for the app
 * token), derives the workspace + bot identity — BOTH bot ids, see the
 * spec 043 loop-prevention note — stores the tokens encrypted under its own
 * key, and returns the identity. Core stores only that identity — the
 * tokens never appear in any response or log.
 *
 * Idempotent registration (#4, tool half of hadron-server#4829): core may send
 * an opaque `registrationKey` it derives from (App, credentials). A retry
 * after a lost response re-derives it and gets the registration it created
 * back (200, same body as the 201). Anyone else, including a legacy row with
 * no key, keeps the 400, which names no connection id.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { encryptToken } from '../crypto.js';
import type { Db } from '../db.js';
import { ConnectionNotFoundError, ValidationError, mapSlackError } from '../errors.js';
import { logInfo } from '../logger.js';
import { SlackApiError, type SlackProvider } from '../providers/webapi/types.js';
import { respondWithError } from './respond.js';

const createSchema = z.object({
  botToken: z.string().min(1),
  appToken: z.string().min(1),
  /**
   * Opaque idempotency key: 16-128 printable ASCII characters, derived by the
   * caller from its own identity. A retry that reproduces it adopts the
   * registration it created. Printable ASCII only, so no two distinct accepted
   * keys can hash to the same bytes (a lone surrogate encodes like U+FFFD).
   * The refusal text never echoes the value.
   */
  registrationKey: z
    .string({ error: 'must be a string' })
    .regex(/^[\x20-\x7e]{16,128}$/, 'must be 16-128 printable ASCII characters')
    .optional(),
});

/** Digest stored for a key: the key itself is never persisted. */
function keyDigest(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** The per-install advisory-lock key: one registration at a time per workspace install. */
export function installLockKey(teamId: string, botUserId: string): string {
  return `slack-register:${teamId}:${botUserId}`;
}

/** The per-key advisory-lock key: one registration at a time per registration key, across installs. */
export function keyLockKey(digest: string): string {
  return `slack-register-key:${digest}`;
}

/** Constant-time digest equality; a NULL stored digest (legacy row) or no supplied key never matches. */
function sameKey(stored: string | null, supplied: string | undefined): boolean {
  if (!stored || supplied === undefined) return false;
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(keyDigest(supplied), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Slack error codes that mean the CALLER's token input is bad at registration time. */
const REGISTRATION_TOKEN_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired']);

/** Build the /connections router over injected db + provider. */
export function connectionsRouter(db: Db, provider: SlackProvider): Router {
  const router = Router();

  // Register a workspace install: validate both tokens live, encrypt, store.
  router.post('/', async (req, res) => {
    try {
      const input = createSchema.parse(req.body ?? {});

      let me;
      try {
        me = await provider.authTest(input.botToken);
      } catch (err) {
        // At registration a dead token is a CALLER input problem, not a
        // connection-state problem — connection_unauthorized would be
        // misleading before a connection exists.
        if (err instanceof SlackApiError && REGISTRATION_TOKEN_ERRORS.has(err.slackError)) {
          throw new ValidationError('botToken', 'Slack rejected the bot token (check the xoxb- value)');
        }
        throw mapSlackError(err);
      }
      const botId = me.botId;
      if (!botId) {
        throw new ValidationError('botToken', 'the token does not belong to a bot user');
      }

      try {
        await provider.connectionsOpen(input.appToken);
      } catch (err) {
        if (err instanceof SlackApiError && err.httpStatus < 500 && err.httpStatus !== 0) {
          throw new ValidationError('appToken', `Slack rejected the app-level token (${err.slackError}) — it needs the connections:write scope`);
        }
        throw mapSlackError(err);
      }

      // One active connection per workspace install: a second registration
      // would start a competing Socket Mode client for the same app+team. The
      // check and the insert run under a per-install advisory lock so
      // concurrent retries of one registration converge on one row. A keyed
      // registration also takes a per-key lock, so two DIFFERENT installs
      // racing with one key cannot both insert it. Lock order is always
      // install then key, so no two registrations wait on each other in a cycle.
      const digest = input.registrationKey === undefined ? null : keyDigest(input.registrationKey);
      const outcome = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${installLockKey(me.teamId, me.botUserId)}))`;
        if (digest !== null) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${keyLockKey(digest)}))`;
        }
        const existing = await tx.connection.findFirst({
          where: { teamId: me.teamId, botUserId: me.botUserId, deletedAt: null },
        });
        if (existing) {
          // Adopted only by the caller that proves it created the row: the stored
          // digest equals the supplied key's. A different key, a legacy NULL-key
          // row and a keyless caller all keep the 400, which never names the
          // other holder's connection id. Adoption returns the row as stored and
          // does not re-store the tokens: core derives the key from (App, bot
          // token, app token), so a retry with rotated tokens carries a different
          // key and is refused, never adopted with stale tokens.
          if (sameKey(existing.registrationKeyHash, input.registrationKey)) {
            return { created: false as const, connection: existing };
          }
          throw new ValidationError('botToken', `a connection for ${me.teamName} already exists`);
        }
        // Adoption needs the install match AND the key: a key already held by an
        // active connection of ANOTHER install is refused, never adopted and never
        // re-used, and the refusal names neither install.
        if (digest !== null) {
          const elsewhere = await tx.connection.findFirst({
            where: { registrationKeyHash: digest, deletedAt: null },
            select: { id: true },
          });
          if (elsewhere) {
            throw new ValidationError('registrationKey', 'the registration key belongs to another workspace install');
          }
        }
        const connection = await tx.connection.create({
          data: {
            teamId: me.teamId,
            teamName: me.teamName,
            botUserId: me.botUserId,
            botId,
            botTokenEnc: encryptToken(input.botToken),
            appTokenEnc: encryptToken(input.appToken),
            registrationKeyHash: digest,
          },
        });
        return { created: true as const, connection };
      });
      const { connection } = outcome;
      logInfo(`connection ${outcome.created ? 'created' : 'adopted'} for workspace ${connection.teamName} (${connection.id})`);
      res.status(outcome.created ? 201 : 200).json({
        id: connection.id,
        provider: connection.provider,
        teamId: connection.teamId,
        teamName: connection.teamName,
        botUserId: connection.botUserId,
        botId: connection.botId,
        status: connection.status,
      });
    } catch (err) {
      respondWithError(res, err, 'create connection');
    }
  });

  // Connection identity + socket state.
  router.get('/:id', async (req, res) => {
    try {
      const connection = await db.connection.findUnique({ where: { id: req.params.id } });
      if (!connection || connection.deletedAt) throw new ConnectionNotFoundError();
      res.json({
        id: connection.id,
        provider: connection.provider,
        teamId: connection.teamId,
        teamName: connection.teamName,
        botUserId: connection.botUserId,
        botId: connection.botId,
        status: connection.status,
        lastError: connection.lastError,
        socketEnabled: connection.socketEnabled,
      });
    } catch (err) {
      respondWithError(res, err, 'get connection');
    }
  });

  // Disconnect: soft-delete; the socket loop stops itself on its next reconcile. A REPEAT delete of a connection this tool held is a
  // success (core's durable teardown retries until it hears one, hadron-server#4847, cor:int:030:03 clause 3); an id the tool
  // NEVER held stays 404. The soft-delete is ONE guarded write (only where deletedAt is still null), so two concurrent first
  // deletes cannot overwrite each other's deletedAt; a count of 0 then looks the row up to tell already-deleted from never-held.
  // A future purge of old rows must keep a tombstone for the id, or a repeat delete after the purge would read as never-held.
  router.delete('/:id', async (req, res) => {
    try {
      const { count } = await db.connection.updateMany({ where: { id: req.params.id, deletedAt: null }, data: { deletedAt: new Date() } });
      if (count === 0 && !(await db.connection.findUnique({ where: { id: req.params.id }, select: { id: true } }))) {
        throw new ConnectionNotFoundError();
      }
      res.json({ deleted: true });
    } catch (err) {
      respondWithError(res, err, 'delete connection');
    }
  });

  return router;
}
