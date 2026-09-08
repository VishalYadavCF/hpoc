// A local endpoint for the seeded `demo.echo` tool, so the tool path can be exercised
// without reaching the internet. Not part of the application.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 4001);
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    console.log(`${req.method} ${req.url} auth=${(req.headers.authorization ?? '').slice(0, 24)}...`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ echoed: safeJson(body), tenant: req.headers['x-tenant-ref'] ?? null }));
  });
}).listen(port, () => console.log(`tool target on :${port}`));

const safeJson = (s) => { try { return JSON.parse(s); } catch { return s; } };
