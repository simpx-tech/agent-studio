import { resolve } from 'node:path';
import { createRelay } from './server.ts';
const token = process.env.AGENT_STUDIO_RELAY_TOKEN ?? '';
const host = process.env.AGENT_STUDIO_RELAY_HOST ?? '127.0.0.1';
const port = Number(process.env.AGENT_STUDIO_RELAY_PORT ?? 4317);
const server = createRelay({
  token,
  directory: resolve(process.env.AGENT_STUDIO_RELAY_DATA ?? '.relay-data'),
  webDirectory: resolve(process.env.AGENT_STUDIO_WEB_DIR ?? 'build'),
});
server.listen(port, host, () =>
  process.stdout.write(
    `Agent Studio relay listening on ${host}:${port}. Pairing key is supplied through the environment.\n`,
  ),
);
