// Local UI preview only: no MCP client, workspace access, credentials or upload host emulation.
// Run npm run build first. This deliberately reports ChatGPT APIs as unavailable.
import { createServer } from 'node:http';
import { renderFileWidget } from '../dist/src/file-widget.js';

const html = renderFileWidget();
const server = createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method) || request.url !== '/') {
    response.writeHead(404); response.end(); return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  response.end(request.method === 'HEAD' ? undefined : html);
});
server.listen(0, '127.0.0.1', () => {
  console.log(`File widget preview: http://127.0.0.1:${server.address().port}/`);
  console.log('Visual preview only. Real ChatGPT upload/attachment is unverified. Ctrl+C closes this preview.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
