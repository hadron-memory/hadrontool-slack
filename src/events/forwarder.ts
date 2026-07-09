/**
 * Event plane, tool → core (spec 043): normalized Slack events are POSTed
 * to hadron-server's internal ingress over HTTP now, designed so the
 * transport can wrap behind a NATS subject later without touching callers.
 *
 * DELIVERY CONTRACT: the forwarder returns `true` only when the event is
 * durably with core (2xx) or deliberately unconfigured (CORE_EVENTS_URL
 * unset ⇒ logged + dropped BY CHOICE). Unlike the telegram poller there is
 * no provider-side cursor to hold back — Slack's 3s ack deadline forces
 * persist-ack-forward — so durability lives in the EventInbox
 * (src/jobs/inbox.ts): the drainer deletes a row only on `true` and
 * dead-letters after bounded retries. Delivery to core is at-least-once;
 * core consumers dedupe on (connectionId, envelopeId).
 */
import { config } from '../config.js';
import { logError, logInfo } from '../logger.js';
import type { SlackMessage } from '../ops/index.js';

/** A slash command (`/hadron …`). Not threaded — Slack slash commands carry no thread_ts. */
export interface SlackCommandEvent {
  event: 'slack.command';
  connectionId: string;
  teamId: string;
  channelId: string;
  slackUserId: string;
  /** The slash command itself, e.g. "/hadron". */
  command: string;
  /** Everything after the command, verbatim. */
  text: string;
  responseUrl: string;
  triggerId: string;
  envelopeId: string;
}

/** A Block Kit interaction — the clicked choice `value` returns verbatim. */
export interface SlackInteractionEvent {
  event: 'slack.interaction';
  connectionId: string;
  teamId: string;
  channelId: string;
  slackUserId: string;
  /** The choice's opaque value (core round-trips its own signed state here). */
  value: string;
  responseUrl: string;
  /** ts of the message the interaction came from (the picker message). */
  messageTs: string;
  envelopeId: string;
}

/**
 * A channel message — the bridge inbound. Bot messages are forwarded TOO,
 * carrying `from.botId`, so core can filter deliberately (Slack bots see
 * their own and other bots' sends — spec 043 decision 8; the Telegram
 * "bots never see bots" rule does not transfer).
 */
export interface SlackMessageReceivedEvent {
  event: 'slack.message.received';
  connectionId: string;
  teamId: string;
  channelId: string;
  threadTs: string | null;
  from: SlackMessage['from'];
  ts: string;
  text: string;
  envelopeId: string;
}

/**
 * Socket connectivity gap — emitted on every (re)connect. Core answers by
 * sweeping the connection's enabled bindings via /ops/get-history from each
 * binding's lastMirroredTs (idempotent by deterministic locs). Socket Mode
 * has no server-side queue, so this event IS the durability story for
 * bridge messages missed while disconnected.
 */
export interface SlackGapEvent {
  event: 'slack.gap';
  connectionId: string;
  /** ISO time the socket dropped; null when unknown (process start). */
  disconnectedAt: string | null;
  reconnectedAt: string;
  envelopeId: string;
}

export type SlackEvent = SlackCommandEvent | SlackInteractionEvent | SlackMessageReceivedEvent | SlackGapEvent;

/** Signature of the forwarder — injectable for tests. Returns delivery success. */
export type EventForwarder = (event: SlackEvent) => Promise<boolean>;

/** Production forwarder: POST to core with the events bearer token. */
export const forwardEventToCore: EventForwarder = async (event) => {
  if (!config.coreEventsUrl) {
    // Unconfigured consumer is deliberate (dev, staged rollout) — dropping
    // is correct, and the inbox never persists in this mode (src/jobs/socket.ts).
    logInfo(`event ${event.event} for connection ${event.connectionId} dropped (CORE_EVENTS_URL unset)`);
    return true;
  }
  try {
    const res = await fetch(config.coreEventsUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.coreEventsToken ? { authorization: `Bearer ${config.coreEventsToken}` } : {}),
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logError(`core event ingress returned ${res.status} for ${event.event} (connection ${event.connectionId})`);
      return false;
    }
    return true;
  } catch (err) {
    logError(`failed to deliver ${event.event} for connection ${event.connectionId} to core`, err);
    return false;
  }
};
