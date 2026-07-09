import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests always run against the dedicated test DB, regardless of .env —
    // same posture as hadron-server's vitest config.
    env: {
      DATABASE_URL: 'postgresql://holger@localhost:5432/hadrontool_slack_test',
      NODE_ENV: 'test',
      TOKEN_ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      SLACK_TOOL_TOKEN: 'test-tool-token',
      // Set so the persist-ack path is live in tests (the forwarder itself
      // is always injected as a fake — no HTTP leaves the suite).
      CORE_EVENTS_URL: 'http://core.test/internal/slack-events',
      // No pacing gaps in tests — the pacer's queueing is tested explicitly.
      SLACK_SEND_GAP_MS: '0',
      SLACK_HISTORY_GAP_MS: '0',
    },
    // DB-backed route tests share tables; run files sequentially.
    fileParallelism: false,
  },
});
