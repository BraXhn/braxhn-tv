// "Det här har hänt" (server/recap.js): sammanfattningen inför en serie (seriesidan) eller ett avsnitt (spelaren).
// Behörighet: serien och avsnitten måste vara tillåtna för profilen (allowedFor – åldersgräns och bibliotek), bara
// avsnitt profilen sett ingår (spoilergränsen gäller även när en annan profils sammanfattning delas) och profiler med
// familjefiltret på får bara en sammanfattning utan svordomar (tystad). En okänd eller otillåten titel ger 404.
// Strömmen (spellistan och segmenten) är vanlig HLS bakom inloggningen – kakan räcker för <video>/hls.js.
import fs from 'node:fs';
import path from 'node:path';
import { send, fail, streamFile } from '../util.js';
import * as R from '../recap.js';
import { route, user } from '../http/router.js';
import { allowedFor, screenBlock } from '../http/context.js';

R.init();
const allowed = (c) => (it) => allowedFor(c.user.id, it);
/** Planen för titeln c.p.id, eller null (404 skickat) när titeln inte finns eller inte är tillåten */
function planOf(c) {
  const p = /^\d+$/.test(c.p.id) ? R.planFor(c.user.id, +c.p.id) : null;
  if (!p || !allowedFor(c.user.id, p.show) || (p.target && !allowedFor(c.user.id, p.target))) { fail(c.res, 404, 'Finns inte'); return null; }
  return p;
}

// Vad sammanfattningen skulle visa och om den finns (state none | pending | ready | failed), offer = spelaren erbjuder den
route('GET', '/api/items/:id/recap', user, (c) => {
  const p = planOf(c); if (!p) return;
  send(c.res, 200, R.out(p, p.key ? R.byKey(p.key) : null));
});
// Gör sammanfattningen (eller ger den som redan finns): 202 medan den görs
route('POST', '/api/items/:id/recap', user, (c) => {
  const p = planOf(c); if (!p) return;
  if (p.reason) return send(c.res, 409, { ...R.out(p, null), error: p.reason });
  if (screenBlock(c)) return;
  const r = R.ensure(p);
  send(c.res, r.state === 1 ? 200 : 202, R.out(p, r));
});

// Spellistan och segmenten
const FILE = /^(index\.m3u8|t\.ts|c\d{1,2}\.ts)$/;
route('GET', '/api/recaps/:rid/:file', user, (c) => {
  const r = /^\d+$/.test(c.p.rid) && FILE.test(c.p.file) ? R.byId(+c.p.rid) : null;
  if (!r || r.state !== 1 || !R.visibleTo(c.user.id, r, allowed(c))) return fail(c.res, 404, 'Finns inte');
  if (c.p.file === 'index.m3u8' && screenBlock(c)) return;
  const f = path.join(R.dirOf(r.id), c.p.file);
  let st; try { st = fs.statSync(f); } catch { return fail(c.res, 404, 'Finns inte'); }
  if (c.p.file === 'index.m3u8') R.touch(r.id);
  streamFile(c.req, c.res, f, st.size, { 'Content-Type': c.p.file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', 'Cache-Control': 'private, max-age=3600' });
});
