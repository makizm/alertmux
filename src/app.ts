import type { AddressInfo } from 'node:net';
import type { Config } from './config.ts';
import { Store } from './db.ts';
import { DestinationRegistry } from './destinations/index.ts';
import { createHttpServer } from './http/server.ts';
import { Relay } from './relay/queue.ts';
import { SecretBox } from './secrets.ts';
import { SmtpListener } from './smtp/listener.ts';

/** Wire up storage, relay worker, SMTP listener and admin HTTP server. */
export function createApp(config: Config, opts: { fetch?: typeof fetch; dbFile?: string } = {}) {
  const store = new Store(config.dataDir, new SecretBox(config.secretKey), config.smtpPort, opts.dbFile);
  const registry = new DestinationRegistry(store, opts.fetch);
  const relay = new Relay(store, registry);
  const listener = new SmtpListener(store, relay);
  const http = createHttpServer(config, { store, registry, relay, listener });

  return {
    store, registry, relay, listener, http,
    async start() {
      await new Promise<void>((resolve) => http.listen(config.httpPort, config.httpHost, resolve));
      const port = (http.address() as AddressInfo).port;
      store.addEvent('info', 'http.started', `Admin UI on http://${config.httpHost}:${port}`);
      relay.start();
      await listener.apply(store.getSettings().smtp);
      return { httpPort: port };
    },
    async stop() {
      http.close();
      http.closeAllConnections();
      await listener.stop();
      await relay.stop();
      store.close();
    },
  };
}
