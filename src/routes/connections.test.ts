/**
 * Connection-plane tests: the real HTTP surface + real test DB over the
 * fake provider — only Slack is simulated.
 */
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { db } from '../db.js';
import { SlackApiError } from '../providers/webapi/types.js';
import { authInfo, fakeProvider, resetDb } from '../test/fakes.js';

const AUTH = { Authorization: 'Bearer test-tool-token' };

beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

describe('POST /connections', () => {
  it('registers a workspace: validates both tokens, returns BOTH bot ids, stores no plaintext', async () => {
    const provider = fakeProvider();
    const app = createApp(db, provider);

    const res = await request(app)
      .post('/connections')
      .set(AUTH)
      .send({ botToken: 'xoxb-live', appToken: 'xapp-live' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      provider: 'slack',
      teamId: 'T0001',
      teamName: 'Acme',
      botUserId: 'U0BOT',
      botId: 'B0BOT',
      status: 'ACTIVE',
    });
    // Both tokens validated live.
    expect(provider.calls.map(([m]) => m)).toEqual(['authTest', 'connectionsOpen']);
    // Stored encrypted — the raw tokens appear nowhere in the row.
    const row = await db.connection.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.botTokenEnc).not.toContain('xoxb-live');
    expect(row.appTokenEnc).not.toContain('xapp-live');
    expect(JSON.stringify(res.body)).not.toContain('xoxb-live');
  });

  it('rejects a bot token Slack refuses as a validation error, not connection_unauthorized', async () => {
    const provider = fakeProvider({ failWith: { methods: ['authTest'], error: new SlackApiError(200, 'invalid_auth') } });
    const app = createApp(db, provider);

    const res = await request(app).post('/connections').set(AUTH).send({ botToken: 'xoxb-bad', appToken: 'xapp-x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.field).toBe('botToken');
  });

  it('rejects a token that is not a bot user (auth.test without bot_id)', async () => {
    const provider = fakeProvider({ me: authInfo({ botId: null }) });
    const app = createApp(db, provider);

    const res = await request(app).post('/connections').set(AUTH).send({ botToken: 'xoxp-user', appToken: 'xapp-x' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('botToken');
  });

  it('rejects a dead app-level token', async () => {
    const provider = fakeProvider({
      failWith: { methods: ['connectionsOpen'], error: new SlackApiError(200, 'invalid_auth') },
    });
    const app = createApp(db, provider);

    const res = await request(app).post('/connections').set(AUTH).send({ botToken: 'xoxb-x', appToken: 'xapp-bad' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('appToken');
  });

  it('refuses a second registration for the same workspace install', async () => {
    const app = createApp(db, fakeProvider());
    await request(app).post('/connections').set(AUTH).send({ botToken: 'xoxb-a', appToken: 'xapp-a' });
    const res = await request(app).post('/connections').set(AUTH).send({ botToken: 'xoxb-b', appToken: 'xapp-b' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toMatch(/already exists/);
  });

  it('requires the bearer token', async () => {
    const app = createApp(db, fakeProvider());
    const res = await request(app).post('/connections').send({ botToken: 'x', appToken: 'y' });
    expect(res.status).toBe(401);
  });
});

describe('GET/DELETE /connections/:id', () => {
  it('returns identity + socket state, then soft-deletes', async () => {
    const app = createApp(db, fakeProvider());
    const created = await request(app).post('/connections').set(AUTH).send({ botToken: 'xoxb-a', appToken: 'xapp-a' });

    const got = await request(app).get(`/connections/${created.body.id}`).set(AUTH);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ botUserId: 'U0BOT', botId: 'B0BOT', socketEnabled: true });

    const del = await request(app).delete(`/connections/${created.body.id}`).set(AUTH);
    expect(del.body.deleted).toBe(true);

    const gone = await request(app).get(`/connections/${created.body.id}`).set(AUTH);
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe('connection_not_found');
  });
});
