/**
 * Connection-plane tests: the real HTTP surface + real test DB over the
 * fake provider — only Slack is simulated.
 */
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('POST /connections registrationKey (#4, tool half of hadron-server#4829)', () => {
  const KEY = 'k'.repeat(32);
  const OTHER = 'z'.repeat(32);
  const post = (app: ReturnType<typeof createApp>, body: Record<string, unknown>) =>
    request(app).post('/connections').set(AUTH).send({ botToken: 'xoxb-1', appToken: 'xapp-1', ...body });

  it('the same key twice returns the one connection (200, same body as 201) and leaves one row', async () => {
    const app = createApp(db, fakeProvider());
    const first = await post(app, { registrationKey: KEY });
    const second = await post(app, { registrationKey: KEY });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await db.connection.count({ where: { deletedAt: null } })).toBe(1);
  });

  it('a different key is refused with 400, and the refusal names no connection id', async () => {
    const app = createApp(db, fakeProvider());
    const first = await post(app, { registrationKey: KEY });
    const res = await post(app, { registrationKey: OTHER });
    expect(res.status).toBe(400);
    expect(res.body.reason).toContain('already exists');
    expect(JSON.stringify(res.body)).not.toContain(first.body.id);
    expect(await db.connection.count({ where: { deletedAt: null } })).toBe(1);
  });

  it('a legacy row with no key is refused for a keyed caller, without its id', async () => {
    const app = createApp(db, fakeProvider());
    const legacy = await post(app, {});
    const res = await post(app, { registrationKey: KEY });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(legacy.body.id);
    expect(await db.connection.count({ where: { deletedAt: null } })).toBe(1);
  });

  it('a keyless caller is refused against a keyed row, without its id (no key: unchanged)', async () => {
    const app = createApp(db, fakeProvider());
    const keyed = await post(app, { registrationKey: KEY });
    const res = await post(app, {});
    expect(res.status).toBe(400);
    expect(res.body.reason).toContain('already exists');
    expect(JSON.stringify(res.body)).not.toContain(keyed.body.id);
  });

  it('the same key presented for a DIFFERENT workspace install is a refusal, not an adoption', async () => {
    const first = await post(createApp(db, fakeProvider()), { registrationKey: KEY });
    expect(first.status).toBe(201);
    // Another workspace (team) ...
    const otherTeam = await post(createApp(db, fakeProvider({ me: authInfo({ teamId: 'T0002', teamName: 'Globex' }) })), {
      registrationKey: KEY,
    });
    // ... and another bot in the same workspace.
    const otherBot = await post(createApp(db, fakeProvider({ me: authInfo({ botUserId: 'U0BOT2', botId: 'B0BOT2' }) })), {
      registrationKey: KEY,
    });
    for (const res of [otherTeam, otherBot]) {
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('registrationKey');
      expect(JSON.stringify(res.body)).not.toContain(first.body.id);
      expect(JSON.stringify(res.body)).not.toContain('Acme');
    }
    expect(await db.connection.count()).toBe(1);
  });

  it('the same key on a different install that already has its own row is refused, and neither row is returned', async () => {
    const a = await post(createApp(db, fakeProvider()), { registrationKey: KEY });
    const bApp = createApp(db, fakeProvider({ me: authInfo({ teamId: 'T0002', teamName: 'Globex' }) }));
    const b = await post(bApp, { registrationKey: OTHER });
    const res = await post(bApp, { registrationKey: KEY });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(a.body.id);
    expect(JSON.stringify(res.body)).not.toContain(b.body.id);
  });

  it('never adopts a deleted connection: the same key after teardown registers a new one', async () => {
    const app = createApp(db, fakeProvider());
    const first = await post(app, { registrationKey: KEY });
    await request(app).delete(`/connections/${first.body.id}`).set(AUTH);
    const again = await post(app, { registrationKey: KEY });
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(first.body.id);
    const old = await db.connection.findUnique({ where: { id: first.body.id } });
    expect(old!.deletedAt).not.toBeNull();
  });

  it('the key appears in no response, no log line and not at rest; only its digest is stored', async () => {
    const lines: string[] = [];
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')].map((s) =>
      s.mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' '))),
    );
    const BAD = 'q'.repeat(200);
    try {
      const app = createApp(db, fakeProvider());
      const bodies = [
        (await post(app, { registrationKey: KEY })).body,
        (await post(app, { registrationKey: KEY })).body,
        (await post(app, { registrationKey: OTHER })).body,
        (await post(app, { registrationKey: BAD })).body,
        (await post(createApp(db, fakeProvider({ me: authInfo({ teamId: 'T0002' }) })), { registrationKey: KEY })).body,
      ];
      const leak = new RegExp(`${KEY}|${OTHER}|${BAD}`);
      for (const b of bodies) expect(JSON.stringify(b)).not.toMatch(leak);
      expect(lines.join('\n')).not.toMatch(leak);
      const row = await db.connection.findFirst({ where: { deletedAt: null } });
      expect(Object.values(row!).map(String).join('|')).not.toContain(KEY);
      expect(row!.registrationKeyHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('a key outside 16-128 printable ASCII characters (or not a string) is a 400 that does not echo it', async () => {
    const app = createApp(db, fakeProvider());
    const bads: unknown[] = ['x'.repeat(15), 'x'.repeat(129), '', 42, null, 'x'.repeat(20) + 'é', 'x'.repeat(20) + '\n', 'x'.repeat(20) + '�'];
    for (const bad of bads) {
      const res = await post(app, { registrationKey: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.field).toBe('registrationKey');
      if (typeof bad === 'string' && bad.length > 0) expect(JSON.stringify(res.body)).not.toContain(bad);
    }
    expect(await db.connection.count()).toBe(0);
    expect((await post(app, { registrationKey: ' '.repeat(8) + '~'.repeat(8) })).status).toBe(201);
    expect((await post(createApp(db, fakeProvider({ me: authInfo({ teamId: 'T0003' }) })), { registrationKey: 'x'.repeat(128) })).status).toBe(201);
  });

  it('concurrent registrations with the same key converge on one row', async () => {
    const app = createApp(db, fakeProvider());
    const results = await Promise.all(Array.from({ length: 12 }, () => post(app, { registrationKey: KEY })));
    expect(results.map((r) => r.status).sort()).toEqual([...Array(11).fill(200), 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await db.connection.count({ where: { deletedAt: null } })).toBe(1);
  });
});

describe('registration is serialized per workspace install (advisory lock)', () => {
  it('a registration waits while another transaction holds the install lock, then proceeds', async () => {
    const app = createApp(db, fakeProvider());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    const holder = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'slack-register:T0001:U0BOT'}))`;
        locked();
        await gate;
      },
      { timeout: 10_000 },
    );
    await held;
    let done = false;
    const pending = request(app)
      .post('/connections')
      .set(AUTH)
      .send({ botToken: 'xoxb-1', appToken: 'xapp-1' })
      .then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    release();
    await holder;
    expect((await pending).status).toBe(201);
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
