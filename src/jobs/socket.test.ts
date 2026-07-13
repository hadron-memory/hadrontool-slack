/**
 * Socket worker + inbox tests: envelope normalization, the persist-ack
 * contract (the spec 043 durability invariant), the drainer's ordering and
 * dead-letter behavior, and the reconciler over a fake socket factory.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db.js';
import type { SlackEvent } from '../events/forwarder.js';
import { DEAD_LETTER_AFTER, drainInboxOnce, persistEvent } from './inbox.js';
import { eventForEnvelope, gapEvent, handleEnvelope, startSocketWorker } from './socket.js';
import { createConnection, fakeSocketFactory, resetDb } from '../test/fakes.js';

const IDENTITY = { id: 'conn1', teamId: 'T0001' };

beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

describe('eventForEnvelope', () => {
  it('normalizes a slash command', () => {
    const event = eventForEnvelope(IDENTITY, 'slash_commands', 'env1', {
      command: '/hadron',
      text: 'find quarterly report',
      channel_id: 'C0123',
      user_id: 'U0HUMAN',
      team_id: 'T0001',
      response_url: 'https://hooks.slack.test/r/1',
      trigger_id: 'trig1',
    });
    expect(event).toMatchObject({
      event: 'slack.command',
      connectionId: 'conn1',
      channelId: 'C0123',
      slackUserId: 'U0HUMAN',
      command: '/hadron',
      text: 'find quarterly report',
      envelopeId: 'env1',
    });
  });

  it('normalizes a button click and a static-select pick identically (value verbatim)', () => {
    const base = {
      type: 'block_actions',
      team: { id: 'T0001' },
      user: { id: 'U0HUMAN' },
      channel: { id: 'C0123' },
      container: { message_ts: '1783.42' },
      response_url: 'https://hooks.slack.test/r/2',
    };
    const button = eventForEnvelope(IDENTITY, 'interactive', 'env2', {
      ...base,
      actions: [{ value: 'task:signed-ref' }],
    });
    const select = eventForEnvelope(IDENTITY, 'interactive', 'env3', {
      ...base,
      actions: [{ selected_option: { value: 'task:signed-ref' } }],
    });
    expect(button).toMatchObject({ event: 'slack.interaction', value: 'task:signed-ref', messageTs: '1783.42' });
    expect(select).toMatchObject({ event: 'slack.interaction', value: 'task:signed-ref' });
  });

  it('normalizes channel messages, keeps bot messages (with botId), maps thread_ts', () => {
    const human = eventForEnvelope(IDENTITY, 'events_api', 'env4', {
      team_id: 'T0001',
      event: { type: 'message', channel: 'C0123', user: 'U0HUMAN', text: 'hello', ts: '1783.1', thread_ts: '1783.0' },
    });
    expect(human).toMatchObject({
      event: 'slack.message.received',
      threadTs: '1783.0',
      from: { slackUserId: 'U0HUMAN', botId: null },
    });

    // Bot messages are FORWARDED, carrying botId — core's loop filter is
    // deliberate (spec 043 decision 8), not the tool's.
    const bot = eventForEnvelope(IDENTITY, 'events_api', 'env5', {
      event: { type: 'message', subtype: 'bot_message', channel: 'C0123', bot_id: 'B0BOT', username: 'Hadron', text: 'echo', ts: '1783.2' },
    });
    expect(bot).toMatchObject({ from: { botId: 'B0BOT', slackUserId: null, displayName: 'Hadron' } });

    // A root message's thread_ts equals its ts — normalized to null.
    const root = eventForEnvelope(IDENTITY, 'events_api', 'env6', {
      event: { type: 'message', channel: 'C0123', user: 'U0HUMAN', text: 'root', ts: '1783.3', thread_ts: '1783.3' },
    });
    expect(root).toMatchObject({ threadTs: null });
  });

  it('skips non-mirrored subtypes and non-message events', () => {
    expect(
      eventForEnvelope(IDENTITY, 'events_api', 'e', {
        event: { type: 'message', subtype: 'message_changed', channel: 'C1', ts: '1.1' },
      }),
    ).toBeNull();
    expect(eventForEnvelope(IDENTITY, 'events_api', 'e', { event: { type: 'reaction_added' } })).toBeNull();
  });
});

describe('handleEnvelope — the persist-ack contract', () => {
  it('persists BEFORE acking, and the row carries the normalized event', async () => {
    const connection = await createConnection(db);
    const order: string[] = [];
    const ack = async () => {
      // Ack must come AFTER the row is durable.
      const rows = await db.eventInbox.count();
      order.push(`ack(rows=${rows})`);
    };

    const outcome = await handleEnvelope(db, { id: connection.id, teamId: connection.teamId }, 'slash_commands', 'env1', {
      command: '/hadron',
      text: 'help',
      channel_id: 'C0123',
      user_id: 'U0HUMAN',
      response_url: 'https://hooks.slack.test/r/1',
    }, ack);

    expect(outcome).toBe('persisted');
    expect(order).toEqual(['ack(rows=1)']);
    const row = await db.eventInbox.findFirstOrThrow();
    expect(row.envelopeId).toBe('env1');
    expect(JSON.parse(row.eventJson)).toMatchObject({ event: 'slack.command', text: 'help' });
  });

  it('acks a redelivered envelope without duplicating the row', async () => {
    const connection = await createConnection(db);
    const identity = { id: connection.id, teamId: connection.teamId };
    const body = {
      command: '/hadron',
      text: 'help',
      channel_id: 'C0123',
      user_id: 'U0HUMAN',
      response_url: 'https://hooks.slack.test/r/1',
    };
    let acks = 0;
    const ack = async () => {
      acks++;
    };

    await handleEnvelope(db, identity, 'slash_commands', 'env1', body, ack);
    const second = await handleEnvelope(db, identity, 'slash_commands', 'env1', body, ack);

    expect(second).toBe('duplicate');
    expect(acks).toBe(2);
    expect(await db.eventInbox.count()).toBe(1);
  });

  it('acks-and-skips envelopes that normalize to nothing', async () => {
    const connection = await createConnection(db);
    let acked = false;
    const outcome = await handleEnvelope(
      db,
      { id: connection.id, teamId: connection.teamId },
      'events_api',
      'env9',
      { event: { type: 'reaction_added' } },
      async () => {
        acked = true;
      },
    );
    expect(outcome).toBe('skipped');
    expect(acked).toBe(true);
    expect(await db.eventInbox.count()).toBe(0);
  });
});

describe('drainInboxOnce', () => {
  function commandEvent(connectionId: string, envelopeId: string): SlackEvent {
    return {
      event: 'slack.command',
      connectionId,
      teamId: 'T0001',
      channelId: 'C0123',
      slackUserId: 'U0HUMAN',
      command: '/hadron',
      text: envelopeId,
      responseUrl: 'https://hooks.slack.test/r/1',
      triggerId: '',
      envelopeId,
    };
  }

  it('delivers oldest-first and deletes delivered rows', async () => {
    const connection = await createConnection(db);
    await persistEvent(db, commandEvent(connection.id, 'e1'));
    await persistEvent(db, commandEvent(connection.id, 'e2'));

    const seen: string[] = [];
    const delivered = await drainInboxOnce(db, async (event) => {
      seen.push(event.envelopeId);
      return true;
    });

    expect(delivered).toBe(2);
    expect(seen).toEqual(['e1', 'e2']);
    expect(await db.eventInbox.count()).toBe(0);
  });

  it('a failed delivery stalls THAT connection (order preserved) but not others', async () => {
    const c1 = await createConnection(db, { teamId: 'T0001' });
    const c2 = await createConnection(db, { teamId: 'T0002', botUserId: 'U0BOT2', botId: 'B0BOT2' });
    await persistEvent(db, commandEvent(c1.id, 'c1-first'));
    await persistEvent(db, commandEvent(c1.id, 'c1-second'));
    await persistEvent(db, commandEvent(c2.id, 'c2-first'));

    const seen: string[] = [];
    await drainInboxOnce(db, async (event) => {
      seen.push(event.envelopeId);
      return !event.envelopeId.startsWith('c1'); // c1 delivery is down
    });

    // c1-second never attempted (order preserved); c2 unaffected.
    expect(seen).toEqual(['c1-first', 'c2-first']);
    const remaining = await db.eventInbox.findMany({ orderBy: { seq: 'asc' } });
    expect(remaining.map((r) => r.envelopeId)).toEqual(['c1-first', 'c1-second']);
    expect(remaining[0]!.attempts).toBe(1);
    expect(remaining[1]!.attempts).toBe(0);
  });

  it('dead-letters a poison event after bounded retries instead of wedging the stream', async () => {
    const connection = await createConnection(db);
    await persistEvent(db, commandEvent(connection.id, 'poison'));
    await persistEvent(db, commandEvent(connection.id, 'after'));

    for (let i = 0; i < DEAD_LETTER_AFTER; i++) {
      await drainInboxOnce(db, async (event) => event.envelopeId !== 'poison');
    }

    const rows = await db.eventInbox.findMany();
    // Poison is DEAD (kept for inspection); the event behind it delivered.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ envelopeId: 'poison', status: 'DEAD' });
  });
});

describe('startSocketWorker', () => {
  it('starts one socket per active connection, persists a gap event on connect, stops deleted ones', async () => {
    const connection = await createConnection(db);
    const factory = fakeSocketFactory();
    const worker = startSocketWorker(db, async () => true, factory);

    // The reconciler runs immediately; give its async start a beat.
    await new Promise((r) => setTimeout(r, 50));
    expect(factory.sockets).toHaveLength(1);
    expect(factory.sockets[0]!.appToken).toBe('xapp-test-token');

    // A (re)connect persists a slack.gap event for core's backfill sweep.
    factory.sockets[0]!.handlers.onConnected();
    await new Promise((r) => setTimeout(r, 50));
    const gap = await db.eventInbox.findFirstOrThrow();
    expect(JSON.parse(gap.eventJson)).toMatchObject({ event: 'slack.gap', connectionId: connection.id });

    await worker.stop();
    expect(factory.sockets[0]!.stopped).toBe(true);
  });

  it('gapEvent carries the disconnect window', () => {
    const disconnected = new Date('2026-07-09T10:00:00Z');
    const reconnected = new Date('2026-07-09T10:05:00Z');
    expect(gapEvent('conn1', disconnected, reconnected)).toMatchObject({
      event: 'slack.gap',
      disconnectedAt: '2026-07-09T10:00:00.000Z',
      reconnectedAt: '2026-07-09T10:05:00.000Z',
    });
  });
});
