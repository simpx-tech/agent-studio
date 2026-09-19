// Local-only synthetic MCP/OAuth server for real CLI verification. No real accounts.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
const output = resolve('artifacts/mcp-management');
mkdirSync(output, { recursive: true });
let origin;
const codes = new Map();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  const send = (status, value, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(value));
  };
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
    return send(200, {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ['tools'],
      bearer_methods_supported: ['header'],
    });
  if (url.pathname.startsWith('/.well-known/'))
    return send(200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: ['tools'],
    });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100000) return send(413, {});
  }
  if (url.pathname === '/register') {
    const input = JSON.parse(body);
    return send(201, {
      ...input,
      client_id: 'synthetic-client',
      client_secret: 'synthetic-secret',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  }
  if (url.pathname === '/authorize') {
    const redirect = new URL(url.searchParams.get('redirect_uri'));
    if (!['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)) return send(400, {});
    const code = crypto.randomUUID();
    codes.set(code, true);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { location: redirect.href });
    return res.end();
  }
  if (url.pathname === '/token') {
    const input = new URLSearchParams(body);
    if (!codes.delete(input.get('code'))) return send(400, { error: 'invalid_grant' });
    return send(200, {
      access_token: 'synthetic-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'tools',
    });
  }
  if (url.pathname !== '/mcp') return send(404, {});
  if (req.headers.authorization !== 'Bearer synthetic-access-token')
    return send(
      401,
      {},
      {
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="tools"`,
      },
    );
  if (req.method !== 'POST') return send(405, {});
  const request = JSON.parse(body);
  appendFileSync(`${output}/methods.jsonl`, JSON.stringify({ method: request.method }) + '\n');
  if (request.id === undefined) {
    res.writeHead(202);
    return res.end();
  }
  let result = {};
  if (request.method === 'initialize')
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'qa-oauth', version: '1' },
    };
  if (request.method === 'tools/list') result = { tools: [] };
  if (request.method === 'resources/list') result = { resources: [] };
  if (request.method === 'resources/templates/list') result = { resourceTemplates: [] };
  send(200, { jsonrpc: '2.0', id: request.id, result });
});
server.listen(0, '127.0.0.1', () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(`${output}/fixture.json`, JSON.stringify({ origin }));
  console.log(`Synthetic MCP OAuth fixture listening at ${origin}`);
});
