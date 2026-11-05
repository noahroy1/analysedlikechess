// Catches the trial's POSTed report: writes each one to reports/<time>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'reports');
mkdirSync(dir, { recursive: true });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST' };

createServer((req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.method !== 'POST') return res.writeHead(405, cors).end();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, body);
    console.log(`report -> ${file}`);
    res.writeHead(200, cors).end('ok');
  });
}).listen(8790, '0.0.0.0', () => console.log('listening on :8790'));
