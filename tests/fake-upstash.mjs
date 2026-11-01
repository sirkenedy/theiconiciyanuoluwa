// In-memory stand-in for Upstash's REST pipeline (GET, SET NX/EX, INCR, EXPIRE, HGET/HMGET/HINCRBY, SADD/SMEMBERS, DEL), for the
// career API tests. `node tests/fake-upstash.mjs 4329` serves it; tests can also import startFakeUpstash().
import { createServer } from 'node:http';

export const FAKE_TOKEN = 'test-token';

export function startFakeUpstash(port = 0) {
  const kv = new Map();
  const hashes = new Map();
  const sets = new Map();
  const run = ([cmd, key, ...args]) => {
    switch (cmd.toUpperCase()) {
      case 'GET': return kv.get(key) ?? null;
      case 'SET': {
        const nx = args.some((a) => String(a).toUpperCase() === 'NX');
        if (nx && kv.has(key)) return null;
        kv.set(key, String(args[0]));
        return 'OK';
      }
      case 'INCRBY': {
        const n = Number(kv.get(key) ?? 0) + Number(args[0]);
        kv.set(key, String(n));
        return n;
      }
      case 'INCR': {
        const n = Number(kv.get(key) ?? 0) + 1;
        kv.set(key, String(n));
        return n;
      }
      case 'EXPIRE': return 1;
      case 'DEL': return [key, ...args].reduce((n, k) => n + (kv.delete(k) || hashes.delete(k) || sets.delete(k) ? 1 : 0), 0);
      case 'HMGET': return args.map((f) => hashes.get(key)?.get(f) ?? null);
      case 'HGET': return hashes.get(key)?.get(args[0]) ?? null;
      case 'SADD': {
        const set = sets.get(key) ?? new Set();
        sets.set(key, set);
        return args.reduce((n, v) => n + (set.has(v) ? 0 : (set.add(v), 1)), 0);
      }
      case 'SMEMBERS': return [...(sets.get(key) ?? [])];
      case 'HINCRBY': {
        const h = hashes.get(key) ?? new Map();
        hashes.set(key, h);
        const n = Number(h.get(args[0]) ?? 0) + Number(args[1]);
        h.set(args[0], String(n));
        return n;
      }
      default: throw new Error(`fake upstash: unsupported ${cmd}`);
    }
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/__reset') {
        kv.clear();
        hashes.clear();
        sets.clear();
        return res.writeHead(204).end();
      }
      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}` || req.url !== '/pipeline') return res.writeHead(401).end();
      try {
        const out = JSON.parse(body).map((c) => ({ result: run(c.map(String)) }));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ error: String(e) }]));
      }
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, kv, sets, url: `http://localhost:${server.address().port}` })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startFakeUpstash(Number(process.argv[2]) || 4329);
  console.log(`fake upstash on ${url}`);
}
