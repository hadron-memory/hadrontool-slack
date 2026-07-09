/**
 * Test doubles: an in-memory SlackProvider fake with call recording, a fake
 * SocketFactory, and fixture builders. Route + worker tests run the real
 * Express app / handlers + real test DB over these fakes — only Slack is
 * simulated.
 */
import { encryptToken } from '../crypto.js';
import type { Db } from '../db.js';
import type { SocketFactory, SocketHandlers } from '../jobs/socket.js';
import type {
  HistoryPage,
  RawSlackMessage,
  SlackAuthInfo,
  SlackProvider,
} from '../providers/webapi/types.js';

/** Wipe every table in FK-safe order — the one cleanup list all test files share. */
export async function resetDb(db: Db): Promise<void> {
  await db.eventInbox.deleteMany();
  await db.idempotencyRecord.deleteMany();
  await db.connection.deleteMany();
}

/** The fake's workspace/bot identity (auth.test). */
export function authInfo(overrides: Partial<SlackAuthInfo> = {}): SlackAuthInfo {
  return {
    teamId: 'T0001',
    teamName: 'Acme',
    botUserId: 'U0BOT',
    botId: 'B0BOT',
    ...overrides,
  };
}

/** Build a plausible raw history message (a human channel message by default). */
export function rawMessage(overrides: Partial<RawSlackMessage> = {}): RawSlackMessage {
  return {
    ts: '1783000000.000100',
    user: 'U0HUMAN',
    text: 'hello there',
    ...overrides,
  };
}

export interface FakeProviderOptions {
  /** auth.test result override. */
  me?: SlackAuthInfo;
  /** When set, the named methods throw this error. */
  failWith?: { methods: string[]; error: unknown };
  /** get-history page (defaults to one human message, no cursor). */
  historyPage?: HistoryPage;
}

/**
 * A recording fake provider. `calls` collects [method, args] tuples so tests
 * assert both HTTP behavior and what reached "Slack".
 */
export function fakeProvider(options: FakeProviderOptions = {}): SlackProvider & {
  calls: [string, unknown[]][];
} {
  const calls: [string, unknown[]][] = [];
  let tsCounter = 9000;

  /** Record a call; throw if configured to fail. */
  function record(method: string, args: unknown[]): void {
    calls.push([method, args]);
    if (options.failWith?.methods.includes(method)) throw options.failWith.error;
  }

  const me = options.me ?? authInfo();

  return {
    calls,

    async authTest(botToken) {
      record('authTest', [botToken]);
      return me;
    },

    async connectionsOpen(appToken) {
      record('connectionsOpen', [appToken]);
      return 'wss://fake.socket/link';
    },

    async postMessage(botToken, params) {
      record('postMessage', [botToken, params]);
      return { channel: params.channel, ts: `1783000${tsCounter++}.000200` };
    },

    async postEphemeral(botToken, params) {
      record('postEphemeral', [botToken, params]);
      return { ts: `1783000${tsCounter++}.000300` };
    },

    async updateMessage(botToken, params) {
      record('updateMessage', [botToken, params]);
      return { channel: params.channel, ts: params.ts };
    },

    async respondUrl(responseUrl, payload) {
      record('respondUrl', [responseUrl, payload]);
    },

    async usersInfo(botToken, slackUserId) {
      record('usersInfo', [botToken, slackUserId]);
      return {
        slackUserId,
        displayName: 'Raghvind',
        realName: 'Raghvind Kumar',
        email: 'raghvind@example.com',
        isBot: false,
      };
    },

    async conversationsInfo(botToken, channelId) {
      record('conversationsInfo', [botToken, channelId]);
      return { channelId, name: 'eng-team', isPrivate: false, isMember: true };
    },

    async history(botToken, params) {
      record('history', [botToken, params]);
      return options.historyPage ?? { messages: [rawMessage()], nextCursor: null };
    },
  };
}

/** Create an ACTIVE connection row directly (tests bypass the HTTP plane). */
export async function createConnection(
  db: Db,
  overrides: Partial<{ teamId: string; botUserId: string; botId: string }> = {},
): Promise<{ id: string; teamId: string; botUserId: string; botId: string }> {
  const connection = await db.connection.create({
    data: {
      teamId: overrides.teamId ?? 'T0001',
      teamName: 'Acme',
      botUserId: overrides.botUserId ?? 'U0BOT',
      botId: overrides.botId ?? 'B0BOT',
      // Real ciphertexts under the test key — withConnection and the socket
      // worker decrypt these before calling the (fake) provider.
      botTokenEnc: encryptToken('xoxb-test-token'),
      appTokenEnc: encryptToken('xapp-test-token'),
    },
  });
  return connection;
}

/**
 * A fake SocketFactory: records started sockets and exposes their handlers
 * so tests can push envelopes / lifecycle transitions.
 */
export function fakeSocketFactory(): SocketFactory & {
  sockets: { appToken: string; handlers: SocketHandlers; stopped: boolean }[];
} {
  const sockets: { appToken: string; handlers: SocketHandlers; stopped: boolean }[] = [];
  const factory = (async (appToken: string, handlers: SocketHandlers) => {
    const entry = { appToken, handlers, stopped: false };
    sockets.push(entry);
    return {
      stop: async () => {
        entry.stopped = true;
      },
    };
  }) as SocketFactory & { sockets: typeof sockets };
  factory.sockets = sockets;
  return factory;
}
