// Platshållarfärg för bilder (som Jellyfins BlurHash, men en enda färg): medelfärgen av affisch, bakgrund och
// miniatyr sparas i items.poster_color/backdrop_color/thumb_color ('#rrggbb'; '' = gick inte att läsa, NULL = inte
// uträknad). Listsvaren skickar den (ph/phBackdrop/phThumb) och webben färgar kortet med den medan bilden laddas.
// Färgen räknas fram strax efter att en bild sparats (forget + kick) och i bakgrunden för befintliga bibliotek –
// en ffmpeg åt gången (16 bilder per körning), med paus mellan körningarna, så att uppspelning och skanning aldrig får vänta.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { lowPriority } from './util.js';
import { all, run, tx, IMAGES } from './db.js';

export const TYPES = ['poster', 'backdrop', 'thumb'];
const COL = { poster: 'poster_color', backdrop: 'backdrop_color', thumb: 'thumb_color' };
const BATCH = 40, PER_RUN = 16, PAUSE_MS = 100;

const hex = (b, o) => '#' + [b[o], b[o + 1], b[o + 2]].map(v => v.toString(16).padStart(2, '0')).join('');
/**
 * Medelfärgen av flera bilder i en ffmpeg-körning: varje bild skalas till en bildpunkt (area = medelvärde av
 * alla bildpunkter) och de ställs bredvid varandra, så att utdata blir 3 byte per bild i samma ordning.
 * Går körningen inte (en trasig fil) görs bilderna en och en. Svar: '#rrggbb' eller null per fil.
 */
export function averageColors(files) {
  if (!files.length) return Promise.resolve([]);
  const n = files.length;
  const graph = files.map((_, i) => `[${i}:v]scale=1:1:flags=area,format=rgb24[c${i}]`).join(';')
    + ';' + (n > 1 ? files.map((_, i) => `[c${i}]`).join('') + `hstack=inputs=${n}[o]` : '[c0]null[o]');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file',
    ...files.flatMap(f => ['-i', f]), '-filter_complex', graph, '-map', '[o]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
  return new Promise((resolve) => {
    lowPriority(execFile('ffmpeg', args, { encoding: 'buffer', timeout: 15000 + n * 2000, maxBuffer: 3 * n + 1024 }, async (e, out) => {
      if (!e && out?.length >= 3 * n) return resolve(files.map((_, i) => hex(out, i * 3)));
      if (n === 1) return resolve([null]);
      const res = [];
      for (const f of files) res.push((await averageColors([f]))[0]);
      resolve(res);
    }));
  });
}
/** Medelfärgen av en bild som '#rrggbb', null vid fel */
export const averageColor = async (file) => (await averageColors([file]))[0];

/** Bilden har bytts eller tagits bort: färgen räknas om (types = de som ändrats) */
export function forget(id, types = TYPES) {
  for (const t of types) if (COL[t]) run(`UPDATE items SET ${COL[t]}=NULL WHERE id=?`, id);
  kick();
}

// Bakgrundsjobbet: rader med bild men utan färg, i omgångar tills inget återstår
let running = false, again = false, timer = null;
async function work() {
  if (running) { again = true; return; }
  running = true;
  try {
    for (;;) {
      again = false;
      const rows = all(`SELECT id, poster, backdrop, thumb, poster_color, backdrop_color, thumb_color FROM items
        WHERE (poster=1 AND poster_color IS NULL) OR (backdrop=1 AND backdrop_color IS NULL) OR (thumb=1 AND thumb_color IS NULL)
        ORDER BY kind='episode', id DESC LIMIT ?`, BATCH);
      if (!rows.length) { if (again) continue; break; }
      // Upp till PER_RUN bilder per ffmpeg-körning (att starta ffmpeg kostar mer än att läsa en affisch)
      const todo = [];
      for (const r of rows) for (const t of TYPES) if (r[t] && r[COL[t]] == null) todo.push({ id: r.id, t, f: path.join(IMAGES, `${r.id}-${t}.jpg`) });
      for (let k = 0; k < todo.length; k += PER_RUN) {
        const part = todo.slice(k, k + PER_RUN), have = part.filter(x => fs.existsSync(x.f));
        const got = await averageColors(have.map(x => x.f));
        have.forEach((x, i) => { x.c = got[i]; });
        // '' = försökt men ingen färg (saknad/trasig fil) – försöks igen när bilden byts (forget)
        tx(() => { for (const x of part) run(`UPDATE items SET ${COL[x.t]}=? WHERE id=? AND ${COL[x.t]} IS NULL`, x.c || '', x.id); });
        await new Promise(res => setTimeout(res, PAUSE_MS));
      }
    }
  } catch (e) { console.warn('[bildfärg]', e.message); }
  finally { running = false; }
}
/** Startar bakgrundsjobbet om en stund (flera ändringar i rad ger en körning) */
export function kick(ms = 2000) {
  if (timer) return;
  timer = setTimeout(() => { timer = null; work(); }, ms);
  timer.unref?.();
}
/** För tester: kör jobbet tills det är klart */
export async function fillAll() { await work(); while (running) await new Promise(r => setTimeout(r, 20)); }
