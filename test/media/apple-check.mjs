// macOS-jobbet i testsamlingen: servern skapar HLS för de viktigaste källorna och Apples egna verktyg
// kontrollerar resultatet – mediastreamvalidator (om det finns), AVFoundation (AVPlayerCheck.swift, samma
// HLS-spelare och avkodare som iPhone/Apple TV) och WebKit via Playwright (webbspelaren med Safaris egen HLS).
//
//   node test/media/apple-check.mjs --out <mapp> [--avplayer <avcheck-binär>] [--webkit <mapp med playwright>]
//
// Avslutas med kod 1 om ett obligatoriskt fall misslyckas. Allt sparas i <mapp> (spellistor, resultat, serverlogg).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { generate, linkLibrary } from './sources.mjs';
import { startServer, PW } from './server.mjs';
import { parseMaster } from './hlscheck.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const OUT = path.resolve(arg('--out') || 'apple-check');
fs.mkdirSync(OUT, { recursive: true });
const sh = (cmd, args, opts = {}) => new Promise((ok) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let out = '';
  p.stdout.on('data', c => { out += c; process.stdout.write(c); });
  p.stderr.on('data', c => { out += c; process.stderr.write(c); });
  const timer = opts.timeout ? setTimeout(() => p.kill('SIGKILL'), opts.timeout) : null;
  p.on('close', (code) => { if (timer) clearTimeout(timer); ok({ code, out }); });
  p.on('error', (e) => ok({ code: -1, out: e.message }));
});

const SAFARI = 'c=mp4&v=h264,hevc&a=aac,mp3,ac3,eac3&nhls=1';
const IOS_APP = 'c=mp4&v=h264,hevc&a=aac,ac3,eac3,mp3,flac,alac&hdr=1&dv=0&nhls=1';
const TV_APP = 'c=mp4&v=h264,hevc&a=aac,ac3,eac3,mp3,flac,alac&hdr=1&dv=0';
// required: false = underlag (resultatet visas men stoppar inte jobbet)
const CASES = [
  { name: 'HEVC HDR10 fMP4-remux (PQ, E-AC-3)', src: 'hevc-hdr10', q: SAFARI + '&hdr=1' },
  { name: 'HLG fMP4-remux', src: 'hevc-hlg', q: SAFARI + '&hdr=1&force=hls' },
  { name: 'Dolby Vision 8.1 fMP4-remux (hvc1)', src: 'dv81', q: SAFARI + '&hdr=1&force=hls' },
  { name: 'HEVC 8 bit fMP4-remux, E-AC-3 orört', src: 'hevc-8', q: SAFARI + '&hdr=1' },
  { name: 'H.264 High 10 → omkodad H.264', src: 'h264-hi10', q: SAFARI + '&hdr=0' },
  { name: 'HDR10 → tonmappad H.264 (SDR-skärm)', src: 'hevc-hdr10', q: SAFARI + '&hdr=0' },
  { name: 'H.264 TS-remux, AC-3 → AAC (iOS-appen)', src: 'h264-mkv-opengop', q: IOS_APP },
  { name: 'H.264 TS-remux med AC-3 orört (tvOS-appen)', src: 'h264-mkv-opengop', q: TV_APP, required: false },
  { name: 'DTS 5.1 → AAC i TS', src: 'scope-dts', q: SAFARI + '&hdr=0' },
  { name: 'Utanför hemmet: ABR-master', src: 'h264-mp4', q: SAFARI + '&hdr=0&bw=2500', remote: true },
  { name: 'Omkodning 360p', src: 'h264-mp4', q: SAFARI + '&hdr=0&force=transcode&q=360' },
  { name: 'PGS inbränd (iOS-appen)', src: 'h264-mkv-opengop', q: IOS_APP + '&sub=e4' }
];
// Webbspelaren i WebKit: källa och förväntat läge (HEVC-remux om WebKit anger HEVC, annars omkodning)
const WEB = [{ name: 'Webbspelaren: HEVC (remux om WebKit klarar HEVC)', src: 'hevc-8' }, { name: 'Webbspelaren: H.264 High 10 (omkodning)', src: 'h264-hi10', mode: 'transcode' }];

const results = [];
const root = path.join(OUT, 'server');
fs.mkdirSync(root, { recursive: true });
const sources = linkLibrary(await generate({ ids: [...new Set([...CASES, ...WEB].map(c => c.src))], log: console.log }), path.join(root, 'media', 'Filmer'));
const srv = await startServer({ root, media: path.join(root, 'media') });
let exitCode = 0;
try {
  const list = await srv.setup();
  const idOf = (src) => list.find(i => i.title === sources.find(s => s.id === src)?.title)?.id;
  const token = await srv.appToken();
  // ---- strömmarna (med mediatoken i URL:en, som apparna) ----
  const cases = [];
  for (const c of CASES) {
    const id = idOf(c.src);
    if (!id) { results.push({ tool: 'server', name: c.name, ok: false, detail: `källan ${c.src} saknas` }); continue; }
    const r = await srv.req(`/api/items/${id}/playback?${c.q}`, { auth: false, headers: { authorization: 'Bearer ' + token, ...(c.remote ? { 'x-forwarded-for': '81.2.3.4' } : {}) } });
    if (r.status !== 200 || r.data.mode === 'direct') { results.push({ tool: 'server', name: c.name, ok: false, detail: `playback ${r.status} ${r.data.mode || JSON.stringify(r.data)}` }); continue; }
    const url = srv.base + r.data.url;
    const dir = path.join(OUT, 'hls', c.name.replace(/[^\wåäöÅÄÖ.-]+/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    const master = (await srv.req(url, { auth: false, raw: true })).data.toString();
    fs.writeFileSync(path.join(dir, 'master.m3u8'), master);
    fs.writeFileSync(path.join(dir, 'playback.json'), JSON.stringify(r.data, null, 2));
    const v = parseMaster(master).variants[0];
    if (v) fs.writeFileSync(path.join(dir, 'variant.m3u8'), (await srv.req(new URL(v.uri, url).href, { auth: false, raw: true })).data);
    cases.push({ name: c.name, url, required: c.required !== false, mode: r.data.mode, reasons: r.data.reasons });
    console.log(`[fall] ${c.name}: ${r.data.mode} – ${r.data.reasons.join(', ')}`);
  }
  fs.writeFileSync(path.join(OUT, 'fall.json'), JSON.stringify(cases, null, 2));

  // ---- mediastreamvalidator (Apples HLS-verktyg; finns bara om de installerats på maskinen) ----
  if (spawnSync('sh', ['-c', 'command -v mediastreamvalidator']).status === 0) {
    const vd = path.join(OUT, 'mediastreamvalidator');
    fs.mkdirSync(vd, { recursive: true });
    for (const c of cases) {
      const json = path.join(vd, c.name.replace(/[^\w.-]+/g, '_') + '.json');
      const r = await sh('mediastreamvalidator', ['-O', json, c.url], { timeout: 10 * 60e3 });
      fs.writeFileSync(json.replace(/\.json$/, '.txt'), r.out);
      const mustFix = (r.out.match(/must fix/gi) || []).length;
      // Utan STRICT är det underlag: rapporten sparas men stoppar inte jobbet
      results.push({ tool: 'mediastreamvalidator', name: c.name, ok: r.code === 0 && !mustFix, required: process.env.APPLE_VALIDATOR_STRICT === '1' && c.required, detail: `kod ${r.code}, ${mustFix} "must fix"` });
      if (spawnSync('sh', ['-c', 'command -v hlsreport']).status === 0) await sh('hlsreport', ['-o', json.replace(/\.json$/, '.html'), json]);
    }
  } else results.push({ tool: 'mediastreamvalidator', name: 'finns inte på maskinen', ok: true, required: false, detail: 'HTTP Live Streaming Tools kräver Apple-ID – AVFoundation används i stället' });

  // ---- AVFoundation (AVPlayer) ----
  const av = arg('--avplayer');
  if (av) {
    const res = path.join(OUT, 'avplayer.json');
    const r = await sh(av, [path.join(OUT, 'fall.json'), res], { timeout: 40 * 60e3 });
    let rows = [];
    try { rows = JSON.parse(fs.readFileSync(res, 'utf8')); } catch { results.push({ tool: 'AVPlayer', name: 'körningen', ok: false, required: true, detail: `avslutades med ${r.code} utan resultat` }); }
    for (const x of rows) results.push({ tool: 'AVPlayer', name: x.name, ok: x.ok, required: x.required, detail: `${x.status}, ${x.played.toFixed(1)} s + ${x.seekPlayed.toFixed(1)} s efter spolning, ${x.frames} bilder, ${x.size} ${x.codecs.join(' ')}${x.error ? ' – ' + x.error : ''}${x.errorLog.length ? ' – ' + x.errorLog.join('; ') : ''}` });
  }

  // ---- WebKit (Playwright): webbspelaren ----
  const pwDir = arg('--webkit');
  if (pwDir) {
    const { webkit } = createRequire(path.join(path.resolve(pwDir), 'package.json'))('playwright');
    const browser = await webkit.launch();
    const ctx = await browser.newContext({ baseURL: srv.base });
    const login = await ctx.request.post('/api/login', { data: { name: 'admin', password: PW } });
    if (!login.ok()) throw new Error('inloggning i WebKit misslyckades: ' + login.status());
    for (const w of WEB) {
      const page = await ctx.newPage();
      const logs = [];
      page.on('console', m => { if (m.type() === 'error') logs.push(m.text()); });
      page.on('pageerror', e => logs.push(String(e)));
      let row = { tool: 'WebKit', name: w.name, ok: false, required: true };
      try {
        await page.goto('/');
        await page.waitForSelector('#player', { state: 'attached', timeout: 30000 });
        await page.waitForLoadState('networkidle').catch(() => {});
        const caps = await page.evaluate(() => { const v = document.createElement('video'); return { hls: v.canPlayType('application/vnd.apple.mpegurl'), hevc: v.canPlayType('video/mp4; codecs="hvc1.1.6.L120.90"'), mse: !!window.MediaSource }; });
        await page.evaluate(async (id) => { const m = await import('/js/player/video.js'); m.play(id); }, idOf(w.src));
        await page.waitForSelector('#vid', { state: 'attached', timeout: 30000 });
        await page.evaluate(() => { const v = document.querySelector('#vid'); v.muted = true; v.play().catch(() => {}); });
        const state = () => page.evaluate(() => { const v = document.querySelector('#vid'); return { t: v?.currentTime || 0, err: v?.error ? `${v.error.code} ${v.error.message}` : null, mode: document.querySelector('#pmode')?.textContent || '', native: !!v?.src && !v.src.startsWith('blob:') }; });
        await page.waitForFunction(() => { const v = document.querySelector('#vid'); return v && (v.error || v.currentTime > 3); }, null, { timeout: 120000 }).catch(() => {});
        const a = await state();
        await page.evaluate(() => { const v = document.querySelector('#vid'); v.currentTime = Math.max(0, (v.duration || 30) / 2); });
        await page.waitForFunction((t0) => { const v = document.querySelector('#vid'); return v && (v.error || v.currentTime > t0 + 2); }, Math.max(0, 15), { timeout: 120000 }).catch(() => {});
        const b = await state();
        const wantMode = w.mode === 'transcode' ? /Omkodning/ : caps.hevc ? /Remux/ : /Omkodning/;
        row.ok = !a.err && !b.err && a.t > 3 && b.t > 17 && wantMode.test(a.mode);
        row.detail = `${a.mode} (${a.native ? 'Safaris egen HLS' : 'hls.js/MSE'}), WebKit: HLS "${caps.hls}", HEVC "${caps.hevc}"; spelat till ${a.t.toFixed(1)} s, efter spolning ${b.t.toFixed(1)} s${a.err || b.err ? ', MediaError ' + (a.err || b.err) : ''}${logs.length ? ', konsolfel: ' + logs.slice(0, 3).join(' | ') : ''}`;
      } catch (e) { row.detail = e.message; }
      await page.screenshot({ path: path.join(OUT, `webkit-${w.src}.png`) }).catch(() => {});
      results.push(row);
      await page.close();
    }
    await browser.close();
  }
} catch (e) {
  console.error(e);
  results.push({ tool: 'körning', name: 'undantag', ok: false, required: true, detail: e.message });
} finally {
  await srv.stop();
  try { fs.copyFileSync(srv.logFile, path.join(OUT, 'server.log')); } catch {}
}

// ---- sammanfattning ----
const lines = ['| Verktyg | Fall | Resultat | Detaljer |', '|---|---|---|---|',
  ...results.map(r => `| ${r.tool} | ${r.name} | ${r.ok ? 'ok' : r.required === false ? 'obs' : '**FEL**'} | ${String(r.detail || '').replace(/\|/g, '/')} |`)];
fs.writeFileSync(path.join(OUT, 'sammanfattning.md'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'sammanfattning.json'), JSON.stringify(results, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Testsamlingen på macOS\n\n' + lines.join('\n') + '\n');
console.log(lines.join('\n'));
if (results.some(r => !r.ok && r.required !== false)) exitCode = 1;
process.exit(exitCode);
