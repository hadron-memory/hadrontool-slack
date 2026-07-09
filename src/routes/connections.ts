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
 */
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
});

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
      if (!me.botId) {
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
      // would start a competing Socket Mode client for the same app+team.
      const existing = await db.connection.findFirst({
        where: { teamId: me.teamId, botUserId: me.botUserId, deletedAt: null },
      });
      if (existing) {
        throw new ValidationError('botToken', `a connection for ${me.teamName} already exists (${existing.id})`);
      }

      const connection = await db.connection.create({
        data: {
          teamId: me.teamId,
          teamName: me.teamName,
          botUserId: me.botUserId,
          botId: me.botId,
          botTokenEnc: encryptToken(input.botToken),
          appTokenEnc: encryptToken(input.appToken),
        },
      });
      logInfo(`connection created for workspace ${connection.teamName} (${connection.id})`);
      res.status(201).json({
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

  // Disconnect: soft-delete; the socket loop stops itself on its next reconcile.
  router.delete('/:id', async (req, res) => {
    try {
      const connection = await db.connection.findUnique({ where: { id: req.params.id } });
      if (!connection || connection.deletedAt) throw new ConnectionNotFoundError();
      await db.connection.update({ where: { id: connection.id }, data: { deletedAt: new Date() } });
      res.json({ deleted: true });
    } catch (err) {
      respondWithError(res, err, 'delete connection');
    }
  });

  return router;
}
