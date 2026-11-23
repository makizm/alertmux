import { createApp } from './app.ts';
import { bus } from './bus.ts';
import { loadConfig } from './config.ts';

const app = createApp(loadConfig());

// Mirror system events to stdout as JSON lines so container log collectors get them too.
bus.on('event', (e) => console.log(JSON.stringify({ ts: new Date(e.at).toISOString(), level: e.level, type: e.type, msg: e.message })));

await app.start();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.store.addEvent('info', 'shutdown', `Received ${signal}, shutting down`);
  await app.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
