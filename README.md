# hadrontool-slack

Slack tool for the Hadron platform — a standalone capability tool that
**owns the Slack provider relationship**: workspace tokens, message
operations, and Socket Mode event intake. It exposes a **provider-neutral**
operations surface over HTTP; `hadron-server` stays the front door
(identity, authorization, bindings, command dispatch, the chat bridge) and
calls this service with already-authorized requests.

The tool is **Hadron-blind** (the standing capability-tool boundary, spec
042 decision 6 / spec 043 decision 5): no core tables, no core API.
Tool→core is the normalized events ingress only; core→tool is `/ops/*`
only. When an op needs Hadron context, core passes it in the request.

Design + decision record: `hadron-server/specs/043-slack-integration/plan.md`
and `hrn:node:hadronmemory.com::hadron-server::reference:hadrontool-slack`.
Pattern precedent: hadrontool-telegram (spec 042) — fourth application of
the pattern (pdf → ms-exchange → telegram → slack).

## Surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/ops/<operation>` | Provider-neutral message operations (spec 043 names) |
| `POST` | `/connections` | Register a workspace install (`{botToken, appToken}` — both validated live) |
| `GET` | `/connections/:id` | Connection identity + socket state |
| `DELETE` | `/connections/:id` | Soft-delete (the socket stops on the next reconcile) |
| `GET` | `/info` | Capabilities (`commands`, `bridge`) + operation/event lists |
| `GET` | `/healthz` / `/readyz` | Liveness / readiness (readiness checks the DB) |

All routes require `Authorization: Bearer $SLACK_TOOL_TOKEN`; in production
the service refuses to start without it. **There is no public route** — v1
uses Socket Mode (outbound WebSocket), so nothing needs Traefik/DNS
exposure.

### Operations (v1)

`send-message`, `respond`, `update-message`, `get-user-info`,
`get-channel-info`, `get-history`, `get-me`.

Messages use the **neutral rich shape** (spec 043 decision 7): `text`
(mrkdwn subset) plus optional `choices[] = [{value, label}]` and optional
`sender: {displayName, avatarUrl?}`. The TOOL renders Block Kit (buttons ≤5
choices, a static select beyond) and `chat:write.customize` sender
overrides — core never emits blocks. A clicked choice's `value` returns
verbatim in the `slack.interaction` event, so core round-trips its own
opaque state.

Mutating operations accept an optional `idempotencyKey` — a replayed key
returns the stored response without touching Slack. **Send operations are
synchronous**: a 2xx means Slack confirmed; the tool paces per-channel
(~1 msg/s) and absorbs short waits inline, but on saturation returns
`provider_rate_limited` + `retryAfterSeconds` — durable retry belongs to
the caller (core's sweep worker), which replays with the same idempotency
key. Errors use the typed catalog (`connection_not_found`,
`connection_unauthorized`, `channel_not_found`, `not_in_channel`,
`provider_rate_limited`, `not_found`, `validation_error`, …) as
`{ "error": "<code>", … }`.

```bash
curl -sS -X POST http://hadrontool-slack:8080/ops/send-message \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $SLACK_TOOL_TOKEN" \
  -d '{"connectionId":"…","channelId":"C0123","text":"inbox summary ready"}'
```

### Events (tool → core)

One Socket Mode client per active connection turns envelopes into
normalized events — `slack.command` (the `/hadron` slash command),
`slack.interaction` (a clicked choice), `slack.message.received` (the
bridge inbound; bot messages included, carrying `from.botId`, so core's
loop filter is deliberate), and `slack.gap` (emitted on every (re)connect;
core answers with a paced `get-history` backfill) — POSTed to
`CORE_EVENTS_URL` with `CORE_EVENTS_TOKEN`.

**Delivery semantics** (the spec-043 invariant): Slack requires an envelope
ack within ~3s and never redelivers an acked envelope, so the order is
**persist → ack → forward**. The normalized event lands in the `EventInbox`
table first, the envelope is acked, and a drainer delivers rows to core
with bounded retries + dead-lettering — the durable buffer Telegram's 24h
server-side queue gave hadrontool-telegram for free. Delivery is
at-least-once; core consumers dedupe on `(connectionId, envelopeId)`.
`CORE_EVENTS_URL` unset ⇒ events are logged + dropped without inbox
writes — an unconfigured consumer is deliberate, not an outage.

## Security

- **Bearer token** gate on every route; required in production.
- **Workspace tokens** (bot `xoxb-…` + app-level `xapp-…`) are
  AES-256-GCM-encrypted at rest under this tool's own
  `TOKEN_ENCRYPTION_KEY` (never core's key) and appear in no response, log
  line, or event.
- **No authorization logic here**: hadron-server authorizes every request
  *before* calling this tool — the tool never re-implements grants, and it
  cannot reach Hadron data at all.

## The Slack app

One Slack app, N workspace installs (spec 043 decision 1). The manifest is
checked in as [manifest.yml](manifest.yml) — create the app from it, mint
an app-level token with `connections:write`, install to the workspace, and
register both tokens via `POST /connections`.

## Development

```bash
npm install
cp .env.example .env           # fill in what you need; see comments
createdb hadrontool_slack && npm run db:push
npm run dev                    # tsx watch on src/index.ts

npm test                       # vitest — requires the test DB once:
createdb hadrontool_slack_test && npm run db:test-setup
```

Tests run the real HTTP surface + real Postgres over a fake Slack provider
and a fake socket factory — no Slack credentials needed.

## Configuration

See [.env.example](.env.example). Key vars: `SLACK_TOOL_TOKEN`,
`DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `CORE_EVENTS_URL` /
`CORE_EVENTS_TOKEN`, `SLACK_SEND_GAP_MS`, `SLACK_HISTORY_GAP_MS`,
`DISABLE_SOCKET_WORKER`, `SLACK_API_BASE`.
