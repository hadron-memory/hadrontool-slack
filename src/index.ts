/**
 * Boot: env validation (config.ts import throws on production misconfig),
 * HTTP server, and the Socket Mode worker (which owns the inbox drainer).
 */
import { createApp } from './app.js';
import { config, isTest } from './config.js';
import { db } from './db.js';
import { forwardEventToCore } from './events/forwarder.js';
import { startSocketWorker } from './jobs/socket.js';
import { logInfo } from './logger.js';
import { slackProvider } from './providers/webapi/client.js';

const app = createApp(db, slackProvider);

app.listen(config.port, () => {
  logInfo(`hadrontool-slack listening on :${config.port}`);
  if (!config.coreEventsUrl) {
    logInfo('CORE_EVENTS_URL not set — inbound Slack events will be logged and dropped');
  }
});

if (!config.disableSocketWorker && !isTest) {
  startSocketWorker(db, forwardEventToCore);
} else {
  logInfo('socket worker disabled');
}
