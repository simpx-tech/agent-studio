import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { windowsInstallerName, windowsInstallerUrl } from '../src/lib/installation.ts';

// Only this named public package is exposed. Keep installers in a dedicated
// directory outside the frontend build, service-worker cache and private data.
export function serveDownloads(req: IncomingMessage, res: ServerResponse, directory?: string) {
  const path = (req.url ?? '').split('?')[0];
  if (!path.startsWith('/downloads/')) return false;
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (!['GET', 'HEAD'].includes(req.method ?? '')) {
    res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end();
    return true;
  }
  const file = directory ? join(directory, windowsInstallerName) : undefined;
  const size = (() => {
    try {
      const info = file && lstatSync(file);
      return info && info.isFile() && info.size > 0 ? info.size : undefined;
    } catch {
      return undefined;
    }
  })();
  if (path === '/downloads/manifest.json') {
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ windows: size !== undefined }));
  } else if (path === windowsInstallerUrl && file && size !== undefined) {
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${windowsInstallerName}"`,
      'Content-Length': size,
    });
    if (req.method === 'HEAD') res.end();
    else {
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    }
  } else res.writeHead(404, headers).end();
  return true;
}
