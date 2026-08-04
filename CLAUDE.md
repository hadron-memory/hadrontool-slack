# Agent dev guide — hadrontool-slack

Standalone Hadron capability tool for Slack (Socket Mode). Fourth
application of the capability-tool pattern (pdf → ms-exchange → telegram →
slack); when in doubt, mirror hadrontool-telegram — the two repos
deliberately share structure, posture, and idioms.

## The three load-bearing invariants

1. **Hadron-blind** (042 decision 6 / 043 decision 5): this tool never
   touches core's tables or API. Tool→core = the events forwarder only;
   core→tool = `/ops/*` only. When an op needs Hadron context, core passes
   it in the request — *invert, don't query*.
2. **Persist → ack → forward** (src/jobs/socket.ts + inbox.ts): Slack never
   redelivers an acked envelope, so the normalized event is written to the
   `EventInbox` BEFORE the ack; the drainer delivers with bounded retries +
   dead-letter. A persist failure leaves the envelope unacked (Slack
   redelivers; the `(connectionId, envelopeId)` unique key dedupes). Never
   ack-then-hope. NB: this is the OPPOSITE cursor discipline from
   telegram's poller — there the durable buffer is Telegram's server-side
   queue; here it is our own table.
3. **Never ack an undelivered send** (src/ops + src/pacing.ts): send ops
   are synchronous; the pacer absorbs ≤5s inline and otherwise returns
   provider_rate_limited — durable retry is core's job, keyed by
   idempotencyKey. get-history has its own per-connection lane (the
   gap-backfill sweep would trip Slack's per-method budget otherwise).

## Commands

```bash
npm run dev            # tsx watch (needs .env; createdb hadrontool_slack + npm run db:push once)
npm test               # vitest vs hadrontool_slack_test (createdb + npm run db:test-setup once)
npm run typecheck      # prisma generate + tsc --noEmit
```

Tests run the real Express app + real Postgres over the fake provider +
fake socket factory in `src/test/fakes.ts` — no Slack credentials, no
network.

## Where things live

- Spec/plan: `hadron-server/specs/043-slack-integration/plan.md`; decision
  node `hrn:node:hadronmemory.com:hadron-server:reference:hadrontool-slack`.
- Error codes are a PUBLIC contract (core's slackClient passes them through
  verbatim) — add codes, never change meanings (src/errors.ts).
- The normalized message shape is shared by the get-history op AND the
  event plane (`normalizeRawMessage` in src/ops/index.ts) — keep them one
  type.
- Slack issues a bot TWO ids: `bot_id` ("B…", on bot message events) and
  the bot user id ("U…", from auth.test). The connection stores BOTH; core's
  loop filter matches either. Don't "simplify" this to one column.
- The neutral → Block Kit translation lives ONLY in `renderBlocks`
  (src/ops/index.ts); the Slack app manifest is checked in as manifest.yml.
