// Uppspelningsvakten: spelar ett fast antal filer i riktig Chrome med webbappens spelare och provar det familjen
// märker – start från början, Fortsätt titta mitt i, spolning framåt och bakåt (inom och utanför bufferten), byte av
// kvalitet och tillbaka till Original, byte av ljudspår och undertext, paus och fortsätt. Körs före varje stabil
// utgåva (.github/workflows/docker-publish.yml) och lokalt:
//
//   npm run vakt [-- --ut=fil.json] [--jamfor=förra.json] [--filer=stangd,oppen]
//
// Fel (vakten faller, slutkod 1): ingen bild inom 30 s (fastnade), bilden står still efteråt, avkodningsfel,
// filmen går vidare under paus, undertexten visas inte. Långsamt (över VAKT_GRANS_MS, standard 3000 ms), tappade
// bildrutor och väntan på buffert medan filmen spelar ger bara varningar med siffror – en belastad maskin ska inte
// fälla en utgåva. Tiderna skrivs som JSON (standard vakt-resultat.json) och kan jämföras med en tidigare körning.
// Slutkod 2: vakten kunde inte köras (Chrome, Playwright eller ffmpeg saknas).
//
// Filerna skapas med ffmpeg och cachas (test/media/sources.mjs). Tid till bild mäts med requestVideoFrameCallback
// från handlingen (klick på Spela, spolning, byte i menyn) till första visade bildruta på rätt ställe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generate, linkLibrary } from './media/sources.mjs';
import { startServer } from './media/server.mjs';
import { freePort } from './helpers/port.js';
import { CHROME, chromium, launchChrome, loginPage, installProbes } from './helpers/chrome.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const GRANS = Number(process.env.VAKT_GRANS_MS) || 3000;
const OUT = path.resolve(arg('ut') || path.join(REPO, 'vakt-resultat.json'));
// 240 s: hls.js buffrar upp till 120 s framåt på en lätt ström (maxMaxBufferLength) – spolningen till 200 s ska
// hamna utanför bufferten
const FPS = 24, DUR = 240;

// ---------- filerna ----------
const V = ['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=${FPS}:d=${DUR}`];
const A = (f = 300) => ['-f', 'lavfi', '-i', `sine=f=${f}:r=48000:d=${DUR},volume=0.5`];
const x264 = (params) => ['-c:v', 'libx264', '-preset', 'superfast', '-bf', '2', '-x264-params', params, '-pix_fmt', 'yuv420p'];
// Undertext bredvid filen med en replik var femte sekund – vid bytet ska en replik synas var filmen än står
const srtTime = (t) => `00:${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')},${String(Math.round(t % 1 * 1000)).padStart(3, '0')}`;
const denseSrt = () => Array.from({ length: DUR / 5 }, (_, i) => `${i + 1}\n${srtTime(i * 5)} --> ${srtTime(i * 5 + 4.8)}\nReplik ${i + 1}\n`).join('\n');
export const FILER = [
  // vantat: läget när filmen startar (från början, mitt i) i en Chrome utan HEVC; hevc: med HEVC-avkodning
  { id: 'stangd', namn: 'stängd GOP, spelas direkt (H.264, AAC, MP4)', ext: '.mp4', dur: DUR, vantat: { start: 'direct', mitt: 'direct' },
    args: () => [...V, ...A(), '-map', '0', '-map', '1', ...x264('keyint=48:min-keyint=48:scenecut=0'), '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart'] },
  // Som i test/open-gop-seek.test.js: B-pyramid, servern tar bort bilderna före nyckelbilden (ra=, server/tslead.js)
  { id: 'oppen', namn: 'öppen GOP där ra räcker (MKV, AC-3)', ext: '.mkv', dur: DUR, vantat: { start: 'remux', mitt: 'remux' },
    args: () => [...V, ...A(), '-map', '0', '-map', '1', ...x264('keyint=48:min-keyint=4:open-gop=1:b-pyramid=normal:scenecut=0:b-adapt=0'), '-c:a', 'ac3'] },
  // Utan B-pyramid: Chrome kan inte börja avkoda mitt i – servern omkodar vid Fortsätt titta (server/opengop.js)
  { id: 'oppen-tc', namn: 'öppen GOP som måste omkodas mitt i (MKV, AC-3)', ext: '.mkv', dur: DUR, vantat: { start: 'remux', mitt: 'transcode' },
    args: () => [...V, ...A(), '-map', '0', '-map', '1', ...x264('keyint=48:min-keyint=4:open-gop=1:b-pyramid=none:scenecut=0:b-adapt=0'), '-c:a', 'ac3'] },
  // HEVC remuxas till fMP4 där webbläsaren kan avkoda HEVC – annars omkodas bilden till H.264
  { id: 'hevc', namn: 'HEVC (MKV, E-AC-3)', ext: '.mkv', dur: DUR, vantat: { start: 'transcode', mitt: 'transcode' }, hevc: { start: 'remux', mitt: 'remux', fmt: 'fmp4' },
    args: () => [...V, ...A(), '-map', '0', '-map', '1', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:keyint=48:min-keyint=48', '-pix_fmt', 'yuv420p',
      '-c:a', 'eac3', '-ac', '2'] },
  { id: 'omkodas', namn: 'H.264 10 bitar – kodas alltid om (MKV)', ext: '.mkv', dur: DUR, vantat: { start: 'transcode', mitt: 'transcode' },
    args: () => [...V, ...A(), '-map', '0', '-map', '1', '-c:v', 'libx264', '-preset', 'superfast', '-g', '48', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', '-ac', '2'] },
  { id: 'sprak', namn: 'två ljudspråk och undertexter (MKV, AC-3, SRT)', ext: '.mkv', dur: DUR, vantat: { start: 'remux', mitt: 'remux' },
    args: (f) => [...V, ...A(300), ...A(500), '-i', f.srt, '-map', '0', '-map', '1', '-map', '2', '-map', '3', ...x264('keyint=48:min-keyint=48:scenecut=0'),
      '-c:a', 'ac3', '-ac', '2', '-c:s', 'srt', '-metadata:s:a:0', 'language=swe', '-metadata:s:a:1', 'language=eng', '-metadata:s:s:0', 'language=eng'],
    extras: { '.sv.srt': denseSrt } }
];

// ---------- ett fall i sidan ----------
// c.kind: start | paus | spola | kvalitet | ljud | undertext. Ger tid till första bild på rätt ställe, hur bilden rör
// sig efteråt och vad som hände under tiden (fel, waiting, bildrutor, lägen).
async function runCase(c) {
  const v = () => document.querySelector('#vid');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const inBuf = (t) => { const x = v(); if (!x) return false; for (let i = 0; i < x.buffered.length; i++) if (t >= x.buffered.start(i) && t < x.buffered.end(i) - 0.5) return true; return false; };
  const select = (sel, pick) => { const s = document.querySelector(sel); if (!s) return null; const o = pick([...s.options].filter(o => o.value !== s.value)); if (!o) return null; s.value = o.value; s.dispatchEvent(new Event('change')); return o.textContent; };
  const q0 = window.__quality(), e0 = window.__errors, w0 = window.__waiting, m0 = window.__modes.length, l0 = window.__errlog.length;
  const out = { note: '' };
  let lo, hi, t0;
  if (c.kind === 'start') {
    t0 = performance.now(); window.__L.play(c.id, c.at); lo = Math.max(0, c.at - 1.5); hi = c.at + 8;
  } else if (c.kind === 'paus') {
    const w = performance.now();
    while (v().currentTime < 3 && performance.now() - w < 20000) await sleep(50);
    v().pause(); await sleep(300); const p0 = v().currentTime; await sleep(1200);
    out.drift = +(v().currentTime - p0).toFixed(2);
    t0 = performance.now(); v().play(); lo = p0 - 0.3; hi = p0 + 5;
  } else if (c.kind === 'spola') {
    let to = c.to;
    if (c.rel != null) {
      // Inom bufferten: vänta tills det finns nog buffrat framför (högst 20 s)
      const w = performance.now();
      while (!inBuf(v().currentTime + Math.max(c.rel, 0) + 2) && performance.now() - w < 20000) await sleep(50);
      to = Math.max(0.5, v().currentTime + c.rel);
    }
    out.to = +to.toFixed(1); out.buffrad = inBuf(to); out.felFore = window.__errors - e0;
    t0 = performance.now(); v().currentTime = to; lo = to - 0.6; hi = to + 6;
  } else {
    const pos = v().currentTime;
    // Byte av kvalitet och ljud laddar en ny ström: räkna bara bilder efter att den kopplats in (loadstart) –
    // den gamla strömmen visar bilder på rätt ställe tills dess
    let loaded = c.kind === 'undertext';
    const onLs = (e) => { if (e.target?.id === 'vid') loaded = true; };
    document.addEventListener('loadstart', onLs, true);
    t0 = performance.now();
    const label = c.kind === 'kvalitet' ? select('#pq', (os) => c.value ? os.find(o => o.value === c.value) : os.filter(o => /^\d+$/.test(o.value)).at(-1))
      : c.kind === 'ljud' ? select('#pa', (os) => os[0])
        : select('#ps', (os) => os.find(o => /\(fil\)|\(file\)/i.test(o.textContent)) || os.find(o => o.value));
    if (label == null) document.removeEventListener('loadstart', onLs, true);
    if (label == null) return { skip: c.kind === 'ljud' ? 'ett ljudspår' : c.kind === 'undertext' ? 'inga undertexter' : 'inget annat kvalitetssteg' };
    out.val = label.trim(); lo = pos - 3; hi = pos + 8;
    while (!loaded && performance.now() - t0 < 30000) await sleep(5);
    document.removeEventListener('loadstart', onLs, true);
    if (!loaded) return { ...out, ms: null, state: 'ingen ny ström efter bytet: ' + window.__state(), errors: window.__errors - e0, modes: window.__modes.slice(Math.max(0, m0 - 1)), errlog: [] };
  }
  const f = await window.__frame((t) => t >= lo && t < hi, 30000);
  out.ms = f.ms == null ? null : Math.round(performance.now() - t0); out.at = f.at == null ? null : +f.at.toFixed(2);
  if (f.ms == null) { out.state = f.state; }
  else {
    const w1 = window.__waiting, mv = await window.__moves(2000);
    out.frames = mv.frames; out.played = +mv.played.toFixed(2); out.paused = mv.paused; out.waitingPlaying = window.__waiting - w1;
    if (c.kind === 'undertext') {
      const w = performance.now();
      while (!document.querySelector('#subtxt')?.textContent.trim() && performance.now() - w < 6000) await sleep(100);
      out.subtext = document.querySelector('#subtxt')?.textContent.trim() || '';
    }
  }
  const q1 = window.__quality();
  Object.assign(out, { errors: window.__errors - e0, waiting: window.__waiting - w0, dropped: q1.dropped - q0.dropped, decoded: q1.total - q0.total,
    errlog: window.__errlog.slice(l0), modes: window.__modes.slice(Math.max(0, m0 - 1)), mode: window.__V.P?.pb?.mode || null, fmt: /fmt=fmp4/.test(window.__V.P?.pb?.url || '') ? 'fmp4' : 'ts',
    label: document.querySelector('#pmode')?.textContent || '' });
  return out;
}

// Ordningen i en spelning: varje fall utgår från läget efter det förra
const SESSION = [
  ['start från början', { kind: 'start', at: 0 }],
  ['paus och fortsätt', { kind: 'paus' }],
  ['spola framåt i bufferten', { kind: 'spola', rel: 8 }],
  ['spola bakåt i bufferten', { kind: 'spola', rel: -5 }],
  ['spola framåt utanför bufferten', { kind: 'spola', to: 200 }],
  ['spola bakåt utanför bufferten', { kind: 'spola', to: 20 }],
  ['byt kvalitet', { kind: 'kvalitet' }],
  ['tillbaka till Original', { kind: 'kvalitet', value: 'orig' }],
  ['byt ljudspår', { kind: 'ljud' }],
  ['byt undertext', { kind: 'undertext' }]
];
const RESUME_AT = 61;

// Kända fel: syns som varningar ("känt fel") i stället för att fälla vakten, tills de är rättade. Syns felet inte
// längre säger vakten till – ta då bort raden. Bara fel vars text matchar fel räknas som kända.
export const KANDA = [];

/** Fel (vakten faller) och varningar för ett fall. exp: väntat läge vid start ({ start, mitt, fmt }) */
function judge(name, c, r, exp) {
  const fel = [], varn = [];
  if (r.skip) return { fel, varn };
  if (c.kind === 'start' && r.ms != null) {
    const want = exp[c.at > 0 ? 'mitt' : 'start'];
    if (r.modes.join() !== want) fel.push(`läget blev ${r.modes.join(' → ')}, väntat ${want}`);
    else if (exp.fmt && r.fmt !== exp.fmt) fel.push(`segmenten blev ${r.fmt}, väntat ${exp.fmt}`);
  }
  if (r.ms == null) fel.push(`fastnade: ingen bild inom 30 s (${r.state})`);
  else {
    if (r.frames < 2 * FPS * 0.5 || r.played < 1 || r.paused) fel.push(`bilden står still efteråt (${r.frames} bildrutor, ${r.played} s på 2 s${r.paused ? ', pausad' : ''})`);
    if (r.ms > GRANS) varn.push(`långsamt: ${(r.ms / 1000).toFixed(2)} s till bild (gräns ${(GRANS / 1000).toFixed(1)} s)`);
    if (r.waitingPlaying > 0) varn.push(`väntade på bufferten ${r.waitingPlaying} gång(er) medan filmen spelade`);
  }
  if (r.errors > 0) fel.push(`${r.errors} avkodningsfel (${r.errlog.join('; ')}; lägen ${r.modes.join(' → ')})`);
  if (c.kind === 'paus' && r.drift > 0.3) fel.push(`filmen gick vidare ${r.drift} s under pausen`);
  if (c.kind === 'undertext' && r.ms != null && !r.subtext) fel.push(`undertexten "${r.val}" visades inte`);
  if (r.decoded > 0 && r.dropped > r.decoded * 0.05) varn.push(`${r.dropped} av ${r.decoded} bildrutor tappades`);
  if (c.kind === 'spola' && r.buffrad !== /i bufferten/.test(name)) r.note = `${r.to} s låg ${r.buffrad ? '' : 'inte '}i bufferten`;
  return { fel, varn };
}

const sek = (ms) => ms == null ? '   –  ' : (ms / 1000).toFixed(2).padStart(5) + ' s';

async function main() {
  const filter = arg('filer')?.split(',');
  const files = FILER.filter(f => !filter || filter.includes(f.id));
  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  const missing = !CHROME ? 'Google Chrome saknas (sätt CHROME_BIN)' : !chromium ? 'Playwright saknas (sätt PLAYWRIGHT till playwright/index.mjs)' : !hasFfmpeg ? 'ffmpeg saknas' : null;
  if (missing) { console.error(`Uppspelningsvakten kan inte köras: ${missing}.`); process.exit(2); }

  const t0 = Date.now();
  console.log(`Uppspelningsvakten: ${files.length} filer, gräns för varning ${GRANS} ms`);
  const srcs = await generate({ sources: files, ids: files.map(f => f.id), concurrency: 2, log: (m) => console.log('  ' + m) });
  for (const s of srcs) if (s.skip) { console.error(`${s.id}: ${s.skip}`); process.exit(2); }
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-vakt-'));
  linkLibrary(srcs, path.join(ROOT, 'media', 'Filmer'));
  let srv, browser;
  const report = { datum: new Date().toISOString(), version: JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'))).version,
    commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO }).stdout?.toString().trim() || null,
    maskin: { cpu: os.cpus()[0]?.model, kärnor: os.cpus().length, last: os.loadavg().map(x => +x.toFixed(2)) }, gransMs: GRANS, filer: [] };
  let nFel = 0, nVarn = 0;
  try {
    srv = await startServer({ root: ROOT, media: path.join(ROOT, 'media'), port: await freePort(), env: { NODE_ENV: 'test', TMDB_API_KEY: '', WATCH_FILES: '0', HWACCEL: 'none' } });
    await srv.setup();
    const items = (await srv.req('/api/libraries/1/items')).data.items;
    for (const s of srcs) s.item = items.find(x => x.title === s.title);
    // Öppen GOP-provet (server/opengop.js) körs efter indexeringen – vänta på svaret för filen som måste omkodas
    const tc = srcs.find(s => s.id === 'oppen-tc');
    if (tc) { const w = Date.now(); while (Date.now() - w < 60000 && (await srv.req(`/api/items/${tc.item.id}/playback?info=1&mse=1&start=${RESUME_AT}`)).data.mode !== 'transcode') await new Promise(r => setTimeout(r, 500)); }
    browser = await launchChrome();
    report.chrome = browser.version();
    let caps = null;
    report.ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version']).stdout.toString().split('\n')[0];
    console.log(`Chrome ${report.chrome}, ${report.ffmpeg}`);
    for (const s of srcs) {
      const fil = { id: s.id, namn: s.namn, fall: [] };
      report.filer.push(fil);
      console.log(`\n${s.namn}`);
      if (!s.item) { fil.fall.push({ namn: 'indexering', fel: ['filen kom inte med i biblioteket'] }); nFel++; console.log('  ✗ filen kom inte med i biblioteket'); continue; }
      const sessions = [[['Fortsätt titta mitt i', { kind: 'start', at: RESUME_AT }]], SESSION];
      for (const list of sessions) {
        // Ny sida för varje spelning: inget minne från förra (som en ny flik)
        const { p, close } = await loginPage(browser, srv.base);
        try {
          await installProbes(p);
          caps ??= report.caps = await p.evaluate(() => ({ hevc: MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"') }));
          let stuck = false;
          for (const [name, c] of list) {
            let r;
            if (stuck) r = { skip: 'förra fallet fastnade' };
            else try { r = await p.evaluate(runCase, { ...c, id: s.item.id }); } catch (e) { r = { ms: null, state: 'fel i provet: ' + e.message.split('\n')[0], errors: 0, modes: [] }; }
            let { fel, varn } = judge(name, c, r, (caps.hevc && s.hevc) || s.vantat);
            const known = KANDA.find(k => k.filer.includes(s.id) && k.fall.includes(name));
            const kanda = known ? fel.filter(x => known.fel.test(x)) : [];
            if (kanda.length) { fel = fel.filter(x => !kanda.includes(x)); varn = [...varn, ...kanda.map(x => `känt fel: ${x} – ${known.varfor}`)]; }
            r.kant = known ? kanda.length > 0 : undefined;
            if (r.ms === null) stuck = true;
            nFel += fel.length; nVarn += varn.length;
            fil.fall.push({ namn: name, ...r, fel, varningar: varn });
            const mark = r.skip ? '–' : fel.length ? '✗' : varn.length ? '!' : '✓';
            const extra = r.skip ? `hoppas över: ${r.skip}` : `${r.mode || ''}${r.fmt === 'fmp4' ? ' fMP4' : ''}${r.val ? ` (${r.val})` : ''}  ${r.frames ?? '–'} bildrutor/2 s, tappade ${r.dropped ?? 0}, waiting ${r.waiting ?? 0}, fel ${r.errors ?? 0}`;
            console.log(`  ${mark} ${name.padEnd(32)} ${r.skip ? '      ' : sek(r.ms)}  ${extra}`);
            for (const x of fel) console.log(`      FEL: ${x}`);
            for (const x of varn) console.log(`      varning: ${x}`);
            if (r.note) console.log(`      obs: ${r.note}`);
          }
        } finally { await close(); }
      }
    }
  } finally {
    await browser?.close(); await srv?.stop();
    if (nFel && srv) { try { report.serverlogg = fs.readFileSync(srv.logFile, 'utf8').split('\n').slice(-40); } catch {} }
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
  // Kända fel som inte syntes alls (i någon av filerna och fallen) är kanske rättade
  for (const k of KANDA) {
    const seen = report.filer.some(f => k.filer.includes(f.id) && f.fall.some(c => k.fall.includes(c.namn) && c.kant));
    const ran = report.filer.some(f => k.filer.includes(f.id) && f.fall.some(c => k.fall.includes(c.namn) && !c.skip));
    if (ran && !seen) console.log(`\nobs: det kända felet syntes inte (${k.filer.join(', ')}: ${k.fall.join(', ')}) – är det rättat? Ta bort det ur KANDA i test/vakt.mjs.`);
  }
  report.sekunder = Math.round((Date.now() - t0) / 1000);
  report.fel = nFel; report.varningar = nVarn;
  const old = arg('jamfor') && JSON.parse(fs.readFileSync(arg('jamfor'), 'utf8'));
  if (old) {
    // Jämförelse med en tidigare körning: tydligt långsammare (50 % och minst 0,5 s) ger en varning
    console.log(`\nJämfört med ${arg('jamfor')} (${old.version}, ${old.datum}):`);
    for (const f of report.filer) for (const c of f.fall) {
      const o = old.filer?.find(x => x.id === f.id)?.fall?.find(x => x.namn === c.namn);
      if (o?.ms != null && c.ms != null && c.ms > o.ms * 1.5 && c.ms - o.ms > 500) {
        const m = `${f.id}, ${c.namn}: ${sek(o.ms).trim()} → ${sek(c.ms).trim()}`;
        (c.varningar ||= []).push('långsammare än förra körningen: ' + m); nVarn++; report.varningar++;
        console.log('  varning: ' + m);
      }
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
  const sum = `${nFel ? `Uppspelningsvakten FÖLL: ${nFel} fel` : 'Uppspelningsvakten: allt spelade'}, ${nVarn} varningar, ${report.sekunder} s. Tiderna: ${OUT}`;
  console.log('\n' + sum);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = report.filer.flatMap(f => f.fall.map(c => `| ${f.id} | ${c.namn} | ${c.skip ? 'hoppas över' : sek(c.ms).trim()} | ${c.mode || ''} | ${[...(c.fel || []).map(x => '**FEL:** ' + x), ...(c.varningar || [])].join('<br>')} |`));
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Uppspelningsvakt\n\n${sum}\n\n| Fil | Fall | Tid till bild | Läge | Anmärkning |\n|---|---|---|---|---|\n${rows.join('\n')}\n`);
  }
  process.exit(nFel ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
