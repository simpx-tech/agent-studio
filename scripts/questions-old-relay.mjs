// Disposable protocol fixture: older relays strip unknown question fields on save.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export async function questionRelay(workspace) {
  const token = randomUUID() + randomUUID();
  const instanceId = '66a9db9c-e7d7-43ba-9888-cce2bf27c73a';
  let saved = structuredClone(workspace),
    revision = 0;
  const dropped = new Map();
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    const send = (status, body) => {
      response.writeHead(status);
      response.end(JSON.stringify(body));
    };
    if (request.headers.authorization !== `Bearer ${token}`)
      return send(401, { error: 'Unauthorized' });
    if (request.url === '/v1/state') {
      if (request.method === 'PUT') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const update = JSON.parse(Buffer.concat(chunks).toString());
        if (update.revision !== revision)
          return send(409, { instanceId, revision, workspace: saved });
        saved = update.workspace;
        for (const chat of saved.conversations)
          for (const message of chat.messages) {
            if (message.questions?.length)
              dropped.set(message.runId, (dropped.get(message.runId) ?? 0) + 1);
            delete message.questions;
          }
        revision++;
      }
      return send(200, { instanceId, revision, workspace: saved });
    }
    if (request.url === '/v1/heartbeat' || request.url === '/v1/jobs') return send(200, []);
    send(404, { error: 'Not found' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(14997, '127.0.0.1', resolve);
  });
  return { url: 'http://127.0.0.1:14997', token, dropped };
}
