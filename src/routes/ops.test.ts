/**
 * Operations-plane tests: the real HTTP surface + real test DB over the
 * fake provider. Covers the neutral-shape → Block Kit rendering, the
 * customize-send identity, idempotency, and the typed error mapping.
 */
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { db } from '../db.js';
import { CHOICE_ACTION_ID } from '../ops/index.js';
import type { PostMessageParams } from '../providers/webapi/types.js';
import { SlackApiError } from '../providers/webapi/types.js';
import { createConnection, fakeProvider, rawMessage, resetDb } from '../test/fakes.js';

const AUTH = { Authorization: 'Bearer test-tool-token' };

beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

describe('POST /ops/send-message', () => {
  it('posts to the channel and returns the confirmed ts (synchronous send)', async () => {
    const provider = fakeProvider();
    const app = createApp(db, provider);
    const connection = await createConnection(db);

    const res = await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({ connectionId: connection.id, channelId: 'C0123', text: 'inbox summary ready' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, replayed: false, channelId: 'C0123' });
    expect(res.body.ts).toMatch(/^\d+\.\d+$/);
    const [method, args] = provider.calls[0]!;
    expect(method).toBe('postMessage');
    expect((args[1] as PostMessageParams).text).toBe('inbox summary ready');
  });

  it('renders choices as Block Kit buttons (≤5) with the choice action id', async () => {
    const provider = fakeProvider();
    const app = createApp(db, provider);
    const connection = await createConnection(db);

    await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({
        connectionId: connection.id,
        channelId: 'C0123',
        text: 'Pick a task:',
        choices: [
          { value: 'task:1', label: 'Weekly report' },
          { value: 'task:2', label: 'Inbox sweep' },
        ],
      });

    const params = provider.calls[0]![1][1] as PostMessageParams;
    const actions = params.blocks!.find((b) => b.type === 'actions') as { elements: Record<string, unknown>[] };
    expect(actions.elements).toHaveLength(2);
    expect(actions.elements[0]).toMatchObject({ type: 'button', value: 'task:1', action_id: `${CHOICE_ACTION_ID}_0` });
  });

  it('renders >5 choices as a static select', async () => {
    const provider = fakeProvider();
    const app = createApp(db, provider);
    const connection = await createConnection(db);

    const choices = Array.from({ length: 7 }, (_, i) => ({ value: `t:${i}`, label: `Task ${i}` }));
    await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({ connectionId: connection.id, channelId: 'C0123', text: 'Pick:', choices });

    const params = provider.calls[0]![1][1] as PostMessageParams;
    const actions = params.blocks!.find((b) => b.type === 'actions') as { elements: { type: string; options: unknown[] }[] };
    expect(actions.elements[0]!.type).toBe('static_select');
    expect(actions.elements[0]!.options).toHaveLength(7);
  });

  it('maps sender to chat:write.customize username/icon_url — the per-agent identity', async () => {
    const provider = fakeProvider();
    const app = createApp(db, provider);
    const connection = await createConnection(db);

    await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({
        connectionId: connection.id,
        channelId: 'C0123',
        text: 'from iris',
        sender: { displayName: 'Iris', avatarUrl: 'https://example.com/iris.png' },
      });

    const params = provider.calls[0]![1][1] as PostMessageParams;
    expect(params.username).toBe('Iris');
    expect(params.icon_url).toBe('https://example.com/iris.png');
  });

  it('posts ephemerally when ephemeralUserId is set', async () => {
    const provider = fakeProvider();
    const app = createApp(db, provider);
    const connection = await createConnection(db);

    const res = await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({ connectionId: connection.id, channelId: 'C0123', text: 'link your account', ephemeralUserId: 'U0HUMAN' });

    expect(res.status).toBe(200);
    expect(provider.calls[0]![0]).toBe('postEphemeral');
  });

  it('replays an idempotency key without touching Slack again', async () => {
    const provider = fakeProvider();
    const app = createApp(db, provider);
    const connection = await createConnection(db);
    const body = { connectionId: connection.id, channelId: 'C0123', text: 'once', idempotencyKey: 'run-42' };

    const first = await request(app).post('/ops/send-message').set(AUTH).send(body);
    const second = await request(app).post('/ops/send-message').set(AUTH).send(body);

    expect(first.body.replayed).toBe(false);
    expect(second.body.replayed).toBe(true);
    expect(second.body.ts).toBe(first.body.ts);
    expect(provider.calls.filter(([m]) => m === 'postMessage')).toHaveLength(1);
  });

  it('rejects an idempotency key reused with a different payload', async () => {
    const app = createApp(db, fakeProvider());
    const connection = await createConnection(db);

    await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({ connectionId: connection.id, channelId: 'C0123', text: 'one', idempotencyKey: 'k1' });
    const res = await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({ connectionId: connection.id, channelId: 'C0123', text: 'DIFFERENT', idempotencyKey: 'k1' });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe('idempotencyKey');
  });

  it('returns provider_rate_limited + retryAfterSeconds on a Slack 429', async () => {
    const provider = fakeProvider({
      failWith: { methods: ['postMessage'], error: new SlackApiError(429, 'ratelimited', 7) },
    });
    const app = createApp(db, provider);
    const connection = await createConnection(db);

    const res = await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({ connectionId: connection.id, channelId: 'C0123', text: 'x' });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'provider_rate_limited', retryAfterSeconds: 7 });
  });

  it('maps channel_not_found and marks nothing ERROR (channel problem ≠ token problem)', async () => {
    const provider = fakeProvider({
      failWith: { methods: ['postMessage'], error: new SlackApiError(200, 'channel_not_found') },
    });
    const app = createApp(db, provider);
    const connection = await createConnection(db);

    const res = await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({ connectionId: connection.id, channelId: 'C0404', text: 'x' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('channel_not_found');
    const row = await db.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.status).toBe('ACTIVE');
  });

  it('marks the connection ERROR on a dead token, and short-circuits afterward', async () => {
    const provider = fakeProvider({
      failWith: { methods: ['postMessage'], error: new SlackApiError(200, 'token_revoked') },
    });
    const app = createApp(db, provider);
    const connection = await createConnection(db);

    const res = await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({ connectionId: connection.id, channelId: 'C0123', text: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('connection_unauthorized');

    const row = await db.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.status).toBe('ERROR');

    // Subsequent calls short-circuit without reaching Slack.
    const callsBefore = provider.calls.length;
    const again = await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({ connectionId: connection.id, channelId: 'C0123', text: 'x' });
    expect(again.status).toBe(403);
    expect(provider.calls.length).toBe(callsBefore);
  });
});

describe('POST /ops/respond', () => {
  it('posts to the response_url with ephemeral default and rendered blocks', async () => {
    const provider = fakeProvider();
    const app = createApp(db, provider);
    const connection = await createConnection(db);

    const res = await request(app)
      .post('/ops/respond')
      .set(AUTH)
      .send({
        connectionId: connection.id,
        responseUrl: 'https://hooks.slack.test/respond/abc',
        text: 'top hits: …',
      });

    expect(res.status).toBe(200);
    const [method, args] = provider.calls[0]!;
    expect(method).toBe('respondUrl');
    expect(args[0]).toBe('https://hooks.slack.test/respond/abc');
    expect(args[1]).toMatchObject({ response_type: 'ephemeral', text: 'top hits: …' });
  });
});

describe('read ops', () => {
  it('update-message, get-user-info, get-channel-info, get-me round-trip', async () => {
    const provider = fakeProvider();
    const app = createApp(db, provider);
    const connection = await createConnection(db);

    const upd = await request(app)
      .post('/ops/update-message')
      .set(AUTH)
      .send({ connectionId: connection.id, channelId: 'C0123', ts: '1783.1', text: 'running task — run 7' });
    expect(upd.body).toMatchObject({ ok: true, ts: '1783.1' });

    const user = await request(app).post('/ops/get-user-info').set(AUTH).send({ connectionId: connection.id, slackUserId: 'U0HUMAN' });
    expect(user.body.user).toMatchObject({ slackUserId: 'U0HUMAN', displayName: 'Raghvind' });

    const chan = await request(app).post('/ops/get-channel-info').set(AUTH).send({ connectionId: connection.id, channelId: 'C0123' });
    expect(chan.body.channel).toMatchObject({ channelId: 'C0123', isMember: true });

    const me = await request(app).post('/ops/get-me').set(AUTH).send({ connectionId: connection.id });
    expect(me.body.bot).toMatchObject({ botUserId: 'U0BOT', botId: 'B0BOT' });
  });

  it('get-history normalizes messages, filters non-mirrored subtypes, and uses replies for threads', async () => {
    const provider = fakeProvider({
      historyPage: {
        messages: [
          rawMessage({ ts: '1783000001.000100', user: 'U0HUMAN', text: 'hi' }),
          rawMessage({ ts: '1783000002.000100', bot_id: 'B0OTHER', user: undefined, username: 'Iris', subtype: 'bot_message', text: 'from a bot' }),
          rawMessage({ ts: '1783000003.000100', subtype: 'channel_join', text: 'joined' }),
        ],
        nextCursor: 'cur2',
      },
    });
    const app = createApp(db, provider);
    const connection = await createConnection(db);

    const res = await request(app)
      .post('/ops/get-history')
      .set(AUTH)
      .send({ connectionId: connection.id, channelId: 'C0123', oldest: '1783000000.000000' });

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2); // channel_join filtered
    expect(res.body.messages[0]).toMatchObject({
      ts: '1783000001.000100',
      channelId: 'C0123',
      from: { slackUserId: 'U0HUMAN', botId: null },
    });
    expect(res.body.messages[1].from).toMatchObject({ botId: 'B0OTHER', displayName: 'Iris' });
    expect(res.body.nextCursor).toBe('cur2');

    // Thread reads go through conversations.replies (thread_ts param).
    await request(app)
      .post('/ops/get-history')
      .set(AUTH)
      .send({ connectionId: connection.id, channelId: 'C0123', threadTs: '1783000001.000100' });
    const lastArgs = provider.calls.at(-1)![1][1] as { thread_ts?: string };
    expect(lastArgs.thread_ts).toBe('1783000001.000100');
  });
});

describe('operation routing', () => {
  it('404s an unknown operation with the operation list', async () => {
    const app = createApp(db, fakeProvider());
    const res = await request(app).post('/ops/launch-missiles').set(AUTH).send({});
    expect(res.status).toBe(404);
    expect(res.body.operations).toContain('send-message');
  });

  it('404s an unknown connection uniformly (anti-enumeration)', async () => {
    const app = createApp(db, fakeProvider());
    const res = await request(app).post('/ops/get-me').set(AUTH).send({ connectionId: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('connection_not_found');
  });
});
