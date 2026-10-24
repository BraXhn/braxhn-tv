// Startar en riktig server mot testsamlingen (samma sätt som test/integration.test.js) och skapar
// administratör, filmbibliotek och skanning. Används av conformance-testet och macOS-jobbet.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PW = 'Testlösen-2026!';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** root: arbetsmapp (config, transcode, logg), media: mapp med Filmer/ */
export async function startServer({ root, media, port = 18000 + Math.floor(Math.random() * 20000), env = {} }) {
  const base = `http://127.0.0.1:${port}`;
  const logFile = path.join(root, 'server.log');
  const log = fs.openSync(logFile, 'a');
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: String(port), HTTPS_PORT: String(port + 1), CONFIG_DIR: path.join(root, 'config'), MEDIA_ROOT: media,
      TRANSCODE_DIR: path.join(root, 'tc'), MAX_TRANSCODES: '32', MAX_TRANSCODES_USER: '32', BOOK_METADATA: '0', ...env },
    stdio: ['ignore', log, log]
  });
  let cookie = '';
  async function req(p, { method = 'GET', body, headers = {}, auth = true, raw = false } = {}) {
    const h = { ...headers };
    if (auth && cookie && !h.authorization) h.cookie = cookie;
    if (body) h['content-type'] = 'application/json';
    const r = await fetch(p.startsWith('http') ? p : base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc && /kt=/.test(sc) && !/Max-Age=0/.test(sc)) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, data: !raw && ct.includes('json') ? JSON.parse(buf.toString() || 'null') : buf };
  }
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { await fetch(base + '/api/health'); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('servern startade inte – se ' + logFile);
  const stop = () => new Promise(r => { if (proc.exitCode != null) return r(); proc.once('exit', r); proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), 3000).unref(); });

  /** Första kontot, filmbiblioteket och en fullständig skanning */
  async function setup() {
    let r = await req('/api/setup', { method: 'POST', body: { name: 'admin', password: PW } });
    if (r.status !== 200) throw new Error('setup: ' + JSON.stringify(r.data));
    r = await req('/api/libraries', { method: 'POST', body: { name: 'Filmer', type: 'movie', path: path.join(media, 'Filmer') } });
    if (r.status !== 200) throw new Error('bibliotek: ' + JSON.stringify(r.data));
    for (let i = 0; i < 600; i++) {
      await sleep(500);
      const s = (await req('/api/scan')).data;
      if (!s.running && !s.analysis?.running && s.last) break;
    }
    const items = (await req('/api/libraries/1/items')).data.items;
    return items;
  }
  /** Apptoken (Bearer) – playback-svaret får då kortlivade mediatoken i alla URL:er (som apparna, AVPlayer) */
  async function appToken() {
    const r = await req('/api/login', { method: 'POST', body: { name: 'admin', password: PW, app: true }, auth: false });
    return r.data.token;
  }
  return { base, req, stop, setup, appToken, logFile, proc };
}
