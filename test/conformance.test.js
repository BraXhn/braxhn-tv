// Testsamlingen (mediakonformitet): varje uppspelningsväg mot realistiska syntetiska källor, med objektiva
// kontroller av HLS-strömmen som servern faktiskt skickar (ffprobe). Se docs/testsamling.md.
//
//   npm test                         – snabb delmängd (några källor och klientprofiler)
//   CONFORMANCE=full npm test        – hela matrisen (alla källor × profiler × lägen)
//   CONFORMANCE_ONLY=hevc-hdr10,vp9-webm   – bara vissa källor
//   CONFORMANCE_OUT=/mapp            – spara spellistor, ffprobe-JSON och serverlogg (annars bara vid fel)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SOURCES, generate, linkLibrary, CUES, PGS_CUES } from './media/sources.mjs';
import { parseMaster, parseMedia, probe, firstAccessUnit, parseVtt, minLevel, parseFmp4 } from './media/hlscheck.mjs';
import { startServer } from './media/server.mjs';

const pexec = promisify(execFile);
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const FULL = process.env.CONFORMANCE === 'full';
const ONLY = process.env.CONFORMANCE_ONLY ? process.env.CONFORMANCE_ONLY.split(',').map(s => s.trim()) : null;
const JOBS = +process.env.CONFORMANCE_JOBS || Math.max(2, Math.min(4, os.cpus().length >> 1));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-conf-'));
const OUT = process.env.CONFORMANCE_OUT ? path.resolve(process.env.CONFORMANCE_OUT) : path.join(ROOT, 'artefakter');
const TOL = 0.1; // sekunder: segmentstart och -längd mot spellistan

// ---------- klientprofiler (samma förmågor som respektive klient skickar) ----------
const CHROME = 'c=mp4,webm&v=h264,vp9,av1&a=aac,mp3,opus,flac';
const SAFARI = 'c=mp4&v=h264,hevc&a=aac,mp3,ac3,eac3&nhls=1';
const PROFILES = {
  chrome: { q: CHROME, label: 'Chrome (hls.js)' },
  'safari-hdr': { q: SAFARI + '&hdr=1', native: true, label: 'Safari/iPhone, HDR-skärm' },
  'safari-sdr': { q: SAFARI + '&hdr=0', native: true, label: 'Safari utan HDR' },
  // iOS-appen (AVPlayer – samma HLS-spelare som Safari, skickar nhls=1), se apps/apple/Shared/AppModel.swift
  'apple-app': { q: 'c=mp4&v=h264,hevc&a=aac,ac3,eac3,mp3,flac,alac&hdr=1&dv=0&nhls=1', native: true, label: 'iOS-appen (AVPlayer)' },
  // tvOS-appen skickar inte nhls=1 (Dolby Digital till förstärkaren); AC-3 i TS kontrolleras på riktigt i macOS-jobbet
  'apple-tv': { q: 'c=mp4&v=h264,hevc&a=aac,ac3,eac3,mp3,flac,alac&hdr=1&dv=0', label: 'tvOS-appen (AVPlayer, utan nhls)' },
  // Android-appen (ExoPlayer), se apps/automotive/…/Api.kt
  android: { q: 'c=mp4,mkv,webm&v=h264,hevc,vp9&a=aac,mp3,opus,flac,vorbis,ac3,eac3&hdr=0', label: 'Android (ExoPlayer)' },
  'remote-480': { q: CHROME + '&q=480&bw=2500', remote: true, label: 'Utanför hemmet, 480p' },
  'remote-abr': { q: SAFARI + '&hdr=0&bw=2500', native: true, remote: true, label: 'Utanför hemmet, automatisk kvalitet (ABR)' },
  // Omkodning till HEVC/AV1 i fMP4 (webbspelaren skickar tc= när webbläsaren kan avkoda det). Servern startas med
  // TRANSCODE_VCODEC=cpu så att x265/SVT-AV1 får användas; finns ingen fungerande kodare blir det H.264.
  'tc-hevc': { q: 'c=mp4,webm&v=h264,hevc,vp9&a=aac,mp3,opus,flac&tc=hevc', tc: ['hevc'], label: 'Chrome med HEVC (omkodning till HEVC)' },
  'tc-av1': { q: CHROME + '&tc=av1', tc: ['av1'], label: 'Chrome med AV1 (omkodning till AV1)' },
  'tc-safari': { q: SAFARI + '&hdr=0&tc=hevc', native: true, tc: ['hevc'], label: 'Safari, omkodning till HEVC' },
  'tc-remote': { q: CHROME.replace('v=h264,', 'v=h264,hevc,') + '&tc=hevc&bw=2500', tc: ['hevc'], remote: true, label: 'Utanför hemmet, HEVC (ABR)' }
};
const capsOf = (p) => { const u = new URLSearchParams(PROFILES[p].q); const l = (k) => new Set((u.get(k) || '').split(',')); return { c: l('c'), v: l('v'), a: l('a'), hdr: u.get('hdr') === '1' }; };

// Förväntat läge där det är entydigt (övriga kontrolleras med allmänna regler)
const EXPECT_MODE = {
  'h264-mp4': { chrome: 'direct', 'safari-sdr': 'direct', android: 'direct' },
  'h264-mkv-opengop': { chrome: 'remux', 'safari-sdr': 'remux', android: 'direct' },
  'h264-hi10': { chrome: 'transcode', 'safari-hdr': 'transcode', android: 'transcode' },
  'hevc-8': { chrome: 'transcode', 'safari-hdr': 'remux', android: 'direct' },
  'hevc-hdr10': { 'safari-hdr': 'remux', 'apple-app': 'remux', 'safari-sdr': 'transcode', android: 'transcode' },
  // HEVC i MP4 med hvc1 spelas direkt av Safari; remux prövas med force=hls
  'hevc-hlg': { 'safari-hdr': 'direct', 'safari-sdr': 'transcode' },
  dv81: { 'safari-hdr': 'direct', 'safari-sdr': 'transcode' },
  dv5: { 'safari-hdr': 'transcode', 'apple-app': 'transcode' },
  'vp9-webm': { chrome: 'direct', android: 'direct', 'safari-sdr': 'transcode' },
  'mpeg4-avi': { chrome: 'transcode', android: 'transcode' },
  'mpeg2-ts': { chrome: 'transcode' }
};

/** Fallen för en källa: [{ name, profile, query }] */
function casesFor(src) {
  const c = (profile, query = '', name = '') => ({ profile, query, name: name || `${profile}${query ? ' ' + query : ''}` });
  const fast = {
    'h264-mp4': [c('chrome'), c('safari-sdr', 'force=hls'), c('chrome', 'force=transcode&q=720'), c('remote-abr'), c('tc-hevc', 'force=transcode&q=720'), c('tc-av1', 'force=transcode&q=480'), c('tc-remote')],
    'h264-mkv-opengop': [c('chrome'), c('apple-app'), c('apple-tv'), c('android'), c('apple-app', 'sub=e4', 'apple-app PGS inbränd')],
    'h264-hi10': [c('chrome')],
    'hevc-8': [c('safari-hdr'), c('chrome')],
    'hevc-hdr10': [c('safari-hdr'), c('safari-sdr'), c('tc-safari')],
    'hevc-novui': [c('chrome')],
    'vp9-webm': [c('chrome'), c('safari-sdr')],
    'scope-dts': [c('safari-sdr'), c('android')],
    'multi-audio': [c('safari-sdr', 'audio=2'), c('chrome', 'audio=3')]
  };
  if (!FULL) return fast[src.id] || [c('chrome')];
  const out = Object.keys(PROFILES).map(p => c(p));
  out.push(c('chrome', 'force=hls'), c('safari-hdr', 'force=hls'), c('android', 'force=hls'));
  for (const q of ['1080', '720', '360']) out.push(c('chrome', `force=transcode&q=${q}`));
  out.push(c('safari-hdr', 'force=transcode&q=720'), c('remote-480', 'force=transcode'));
  out.push(c('tc-hevc', 'force=transcode'), c('tc-av1', 'force=transcode&q=720'), c('tc-safari', 'force=transcode&q=1080'));
  if (src.id === 'multi-audio') out.push(c('safari-sdr', 'audio=2'), c('apple-app', 'audio=2'), c('chrome', 'audio=3'), c('android', 'audio=4'), c('safari-hdr', 'audio=4'));
  if (src.id === 'h264-mkv-opengop') out.push(c('apple-app', 'sub=e4', 'apple-app PGS inbränd'), c('chrome', 'sub=e4', 'chrome PGS inbränd'));
  if (src.id === 'dv5') out.push(c('apple-app', 'dv=1', 'apple-app med Dolby Vision'), c('apple-app', 'dv=1&force=hls', 'apple-app med Dolby Vision, remux'));
  return out;
}

let srv, sources = [];
const items = new Map(); // källans id → objekt i biblioteket
const failures = [];
const summary = [];

const run = (name, fn) => it(name, { skip: !hasFfmpeg && 'ffmpeg/ffprobe saknas' }, fn);

describe('testsamling', { concurrency: JOBS }, () => {
  before(async () => {
    if (!hasFfmpeg) return;
    const t0 = Date.now();
    sources = await generate({ ids: ONLY, full: FULL || !!ONLY, log: (m) => console.log('[testsamling]', m) });
    linkLibrary(sources, path.join(ROOT, 'media', 'Filmer'));
    console.log(`[testsamling] ${sources.filter(s => s.file).length} källor klara på ${((Date.now() - t0) / 1000).toFixed(0)} s` +
      sources.filter(s => s.skip).map(s => `\n[testsamling] hoppar över ${s.id}: ${s.skip}`).join(''));
    srv = await startServer({ root: ROOT, media: path.join(ROOT, 'media'), env: { TRANSCODE_VCODEC: 'cpu' } });
    const list = await srv.setup();
    for (const s of sources) {
      const it = list.find(i => i.title === s.title);
      if (it) items.set(s.id, it);
    }
  });
  after(async () => {
    await srv?.stop();
    if (failures.length || process.env.CONFORMANCE_OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      try { fs.copyFileSync(path.join(ROOT, 'server.log'), path.join(OUT, 'server.log')); } catch {}
      fs.writeFileSync(path.join(OUT, 'sammanfattning.json'), JSON.stringify({ failures, summary }, null, 2));
      console.log(`[testsamling] artefakter: ${OUT}`);
    }
    if (summary.length) {
      console.log('[testsamling] källa | profil | läge | video | ljud | resultat');
      for (const r of summary.sort((a, b) => a.src.localeCompare(b.src))) console.log(`[testsamling] ${r.src} | ${r.case} | ${r.mode} | ${r.video || '-'} | ${r.audio || '-'} | ${r.ok ? 'ok' : 'FEL'}${r.dup ? ' (samma ström som ' + r.dup + ')' : ''}`);
    }
    if (!process.env.CONFORMANCE_OUT && !failures.length) fs.rmSync(ROOT, { recursive: true, force: true });
  });

  run('källorna tolkas rätt av scannern', async () => {
    for (const s of sources.filter(x => x.file)) {
      const it = items.get(s.id);
      assert.ok(it, `${s.id}: saknas i biblioteket`);
      const d = (await srv.req(`/api/items/${it.id}`)).data;
      assert.equal(d.vcodec, s.expect.vcodec, `${s.id}: vcodec`);
      assert.equal(d.hdr || null, s.expect.hdr, `${s.id}: hdr`);
      if (s.expect.audioTracks) assert.deepEqual(d.audio.map(a => a.codec), s.expect.audioTracks, `${s.id}: ljudspår`);
      if (s.expect.textSubs) assert.equal(d.subtitles.filter(x => !x.bitmap).length, s.expect.textSubs, `${s.id}: textundertexter`);
      if (s.expect.pgs) assert.equal(d.subtitles.filter(x => x.pgs).length, s.expect.pgs, `${s.id}: PGS`);
    }
  });

  // Efter avkodning på grafikkortet saknar bilderna färgegenskaper (0.9.3). Samma filterkedja som servern
  // bygger för tonmappning ska då fungera och ge BT.709 – här simulerat genom att nollställa egenskaperna.
  run('tonmappning fungerar när bilderna saknar färgegenskaper (som efter GPU-avkodning)', async () => {
    const src = sources.find(s => s.id === 'hevc-hdr10' && s.file);
    if (!src) return;
    process.env.CONFIG_DIR ??= path.join(ROOT, 'unitcfg');
    process.env.TRANSCODE_DIR ??= path.join(ROOT, 'unittc');
    const st = await import('../server/stream.js');
    const it = { hdr: 'hdr10', streams: JSON.stringify([{ type: 'video', codec: 'hevc', width: 1920, height: 1080, pix: 'yuv420p10le' }]) };
    const va = st._segs.videoArgs(it, { q: '720', tonemap: true, burn: '' }, true);
    const vf = va.filter[1];
    const out = path.join(ROOT, 'gpu-sim.mp4');
    await pexec('ffmpeg', ['-v', 'error', '-y', '-i', src.file, '-t', '1', '-vf', 'setparams=color_primaries=unknown:color_trc=unknown:colorspace=unknown,' + vf,
      ...va.enc, '-an', out]);
    const p = await probe(out);
    assert.equal(p.video.pix_fmt, 'yuv420p');
    assert.equal(p.video.color_transfer, 'bt709');
    assert.equal(p.video.color_primaries, 'bt709');
  });

  // En deltest per källa; källorna körs parallellt (JOBS), fallen inom en källa i tur och ordning
  for (const id of ONLY || SOURCES.filter(s => FULL || s.fast).map(s => s.id)) {
    run(id, async (t) => {
      const src = sources.find(s => s.id === id);
      if (!src?.file) return t.skip(src?.skip || 'källan finns inte');
      const it = items.get(id);
      assert.ok(it, `${id}: saknas i biblioteket`);
      const seen = new Map();
      const problems = [], known = [];
      for (const c of casesFor(src)) {
        const r = await runCase(src, it, c, seen).catch(e => ({ problems: [`undantag: ${e.stack || e.message}`], warnings: [] }));
        if (r.problems.length) { problems.push(...r.problems.map(p => `[${c.name}] ${p}`)); failures.push({ src: id, case: c.name, problems: r.problems, warnings: r.warnings }); }
        for (const w of r.warnings || []) t.diagnostic(`[${c.name}] varning: ${w}`);
        known.push(...(r.known || []).map(k => `[${c.name}] ${k}`));
      }
      await subtitleChecks(src, it, problems);
      // Kända brister visas som TODO (stoppar inte körningen) tills de är rättade
      if (known.length) await t.test('kända brister', { todo: 'fMP4-remux: ffmpegs HLS-muxer, se docs/testsamling.md' }, () => assert.deepEqual(known, []));
      assert.deepEqual(problems, [], `${id}: ${problems.length} fel`);
    });
  }
});

// ---------- ett fall: uppspelningsbeslut → master → variant → init → segment (+ spolning) ----------
async function get(url, file) {
  const r = await srv.req(url, { raw: true });
  if (r.status !== 200) throw new Error(`${url.split('?')[0]} gav ${r.status}: ${r.data.toString().slice(0, 200)}`);
  if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, r.data); }
  return r.data;
}
async function playback(it, c, extra = '') {
  const p = PROFILES[c.profile];
  // Fallets parametrar ersätter profilens (t.ex. dv=1)
  const u = new URLSearchParams(p.q);
  for (const [k, v] of new URLSearchParams([c.query, extra].filter(Boolean).join('&'))) u.set(k, v);
  const q = u.toString();
  const r = await srv.req(`/api/items/${it.id}/playback?${q}`, { headers: p.remote ? { 'x-forwarded-for': '81.2.3.4' } : {} });
  if (r.status !== 200) throw new Error(`playback gav ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data;
}
const decisionKey = (pb) => {
  if (pb.mode === 'direct') return 'direct';
  const u = new URLSearchParams(pb.url.split('?')[1]);
  return ['mode', 'q', 'audio', 'am', 'burn', 'tm', 'fmt', 'tag', 'vr', 'abr', 'ab', 'sbw', 'vc'].map(k => `${k}=${u.get(k) ?? ''}`).join('&');
};
const fpsOf = (s) => { const [a, b] = String(s?.avg_frame_rate || s?.r_frame_rate || '0/1').split('/').map(Number); return b ? a / b : 0; };

async function runCase(src, it, c, seen) {
  const problems = [], warnings = [], known = [];
  const fail = (m) => problems.push(m), warn = (m) => warnings.push(m);
  const check = (ok, m) => { if (!ok) fail(m); return ok; };
  const P = PROFILES[c.profile], caps = capsOf(c.profile);
  const q = new URLSearchParams(c.query);
  const dir = path.join(OUT, src.id, c.name.replace(/[^\w.=-]+/g, '_'));
  const save = (name, data) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };
  const pb = await playback(it, c);
  save('playback.json', pb);
  const sum = { src: src.id, case: c.name, mode: pb.mode, ok: false };
  summary.push(sum);
  const stop = () => srv.req(`/api/stream/${it.id}/stop`, { method: 'POST' }).catch(() => {});
  try {
    // ---- beslutet ----
    const exp = EXPECT_MODE[src.id]?.[c.profile];
    if (exp && !c.query) check(pb.mode === exp, `läge ${pb.mode}, väntat ${exp} (${pb.reasons.join(', ')})`);
    if (src.id === 'dv5' && q.get('dv') === '1') check(pb.mode === (q.get('force') ? 'remux' : 'direct'), `Dolby Vision 5 med dv=1: fick ${pb.mode}`);
    if (src.expect.alwaysTranscode || !caps.v.has(src.expect.vcodec)) check(pb.mode === 'transcode', `${src.expect.vcodec} ska omkodas för ${P.label}, fick ${pb.mode}`);
    if (src.expect.hdr && !caps.hdr) check(pb.mode === 'transcode' && pb.tonemap, `HDR utan HDR-skärm ska tonmappas, fick ${pb.mode} tonemap=${pb.tonemap}`);
    if (q.get('force') === 'transcode' || q.get('sub')) check(pb.mode === 'transcode', `ska omkodas, fick ${pb.mode}`);
    if (q.get('force') === 'hls') check(pb.mode !== 'direct', 'force=hls gav direktuppspelning');
    const full = new URLSearchParams(P.q); for (const [k, v] of q) full.set(k, v);
    if (P.remote && !full.get('q')) check(!!new URLSearchParams(pb.url.split('?')[1]).get('abr') === (pb.mode === 'transcode'), 'ABR-master förväntades vid omkodning utanför hemmet');
    if (pb.mode === 'transcode' && src.expect.hdr) check(pb.tonemap === true && pb.reasons.some(r => /tonmappas/.test(r)), `HDR-källa omkodad utan tonmappning (${pb.reasons.join(', ')})`);
    if (pb.mode === 'direct') {
      check(caps.c.has(src.ext.slice(1)), `direktuppspelning av ${src.ext} som klienten inte angett`);
      check(caps.v.has(src.expect.vcodec), `direktuppspelning av ${src.expect.vcodec}`);
      const r = await srv.req(pb.url, { headers: { range: 'bytes=0-1023' }, raw: true });
      check(r.status === 206 && r.data.length === 1024, `direkt: Range gav ${r.status}/${r.data.length} byte`);
      check(/^video\//.test(r.headers.get('content-type') || ''), `direkt: Content-Type ${r.headers.get('content-type')}`);
      sum.video = src.expect.vcodec; sum.ok = !problems.length;
      return { problems, warnings };
    }
    const key = decisionKey(pb);
    const prev = seen.get(key);
    if (prev) {
      // Samma ström som ett tidigare fall – kontrollera bara att den passar den här klienten
      checkAllowed(prev.out, P, caps, pb, fail);
      Object.assign(sum, { video: prev.out.vcodec, audio: prev.out.acodec, dup: prev.name, ok: !problems.length });
      return { problems, warnings };
    }

    // ---- master ----
    const mtxt = (await get(pb.url)).toString(); save('master.m3u8', mtxt);
    const master = parseMaster(mtxt);
    check(master.variants.length >= 1, 'mastern saknar varianter');
    for (const v of master.variants) {
      check(Number.isInteger(v.bw) && v.bw >= 100000 && v.bw <= 100e6, `BANDWIDTH ${v.bw} orimlig`);
      check(v.res && v.res[0] > 0 && v.res[1] > 0 && v.res[0] % 2 === 0 && v.res[1] % 2 === 0, `RESOLUTION ${v.attrs.RESOLUTION} orimlig`);
    }
    const pu = new URLSearchParams(pb.url.split('?')[1]);
    if (pu.get('abr') === '1') {
      // Lägre steg finns bara när källan är högre än 360p
      if (Math.max(...master.variants.map(v => v.res?.[1] || 0)) > 360) check(master.variants.length >= 2, 'ABR-mastern har bara en variant');
      const rest = master.variants.slice(1).map(v => v.bw);
      check(rest.every((b, i) => i === 0 || b <= rest[i - 1]), 'ABR-varianterna efter den första är inte i fallande ordning');
      const sbw = +pu.get('sbw');
      if (sbw) {
        const fit = master.variants.filter(v => v.bw <= sbw * 1000 * 0.8);
        if (fit.length) check(master.variants[0].bw === Math.max(...fit.map(v => v.bw)), `första varianten (${master.variants[0].bw}) är inte den största som ryms i ${sbw} kbit/s`);
        else check(master.variants[0].bw === Math.min(...master.variants.map(v => v.bw)), 'inget steg ryms – lägsta ska komma först');
      }
    }
    const vr = master.variants[0].videoRange;
    if (pb.mode === 'remux' && src.expect.hdr) check(vr === (src.expect.hdr === 'hlg' ? 'HLG' : 'PQ'), `VIDEO-RANGE ${vr} för ${src.expect.hdr}-remux`);
    else check(!vr || vr === 'SDR', `VIDEO-RANGE=${vr} för en SDR-ström`);

    // ---- variant ----
    const variant = master.variants[0];
    const vUrl = new URL(variant.uri, srv.base + pb.url).href;
    const ptxt = (await get(vUrl)).toString(); save('variant.m3u8', ptxt);
    const pl = parseMedia(ptxt);
    check(pl.endlist && pl.type === 'VOD', 'variantlistan är inte en komplett VOD-lista');
    check(pl.segments.length >= 3, `bara ${pl.segments.length} segment`);
    check(Math.abs(pl.total - it.duration) < 0.5, `spellistans längd ${pl.total.toFixed(2)} ≠ filmens ${it.duration}`);
    check(pl.segments.every(s => s.dur > 0 && Math.round(s.dur) <= pl.target), `EXTINF över TARGETDURATION ${pl.target}`);
    const fm = !!pl.map;
    let init = null;
    if (fm) {
      init = await get(new URL(pl.map, vUrl).href, path.join(dir, 'init.mp4'));
      const ip = await probe(path.join(dir, 'init.mp4'));
      save('init.json', ip.streams);
      const tag = ip.video?.codec_tag_string;
      if (ip.video?.codec_name === 'hevc') check(['hvc1', 'dvh1'].includes(tag), `HEVC i fMP4 med taggen ${tag} (Apple kräver hvc1/dvh1)`);
      if (src.id === 'dv5' && pb.mode === 'remux') check(tag === (q.get('dv') === '1' ? 'dvh1' : 'hvc1'), `Dolby Vision 5: tagg ${tag}`);
    }

    // ---- segment: 0, 1, 2 och efter spolning mitt i ----
    const segs = {};
    const fetchSeg = async (base, list, n, label) => {
      const f = path.join(dir, `${label}-${n}.${fm ? 'm4s' : 'ts'}`);
      const data = await get(new URL(list.segments[n].uri, base).href, f);
      let pf = f;
      if (fm) { pf = f.replace(/\.m4s$/, '.mp4'); fs.writeFileSync(pf, Buffer.concat([init, data])); }
      const p = await probe(pf);
      if (fm) {
        // Tidsstämplarna läses ur moof/tfdt/trun (som Apples spelare) – ffprobe räknar fel för ett ensamt fragment
        const tr = Object.values(parseFmp4(init, data));
        p.vp = tr.find(x => x.handler === 'vide')?.samples || [];
        p.ap = tr.find(x => x.handler === 'soun')?.samples || [];
      }
      save(`${label}-${n}.json`, { streams: p.streams, format: p.format, video: p.vp.slice(0, 400), audio: p.ap.slice(0, 400) });
      const au = ['h264', 'hevc'].includes(p.video?.codec_name) ? await firstAccessUnit(pf, p.video.codec_name).catch(() => null) : null;
      return { n, label, start: list.segments[n].start, dur: list.segments[n].dur, bytes: data.length, p, au };
    };
    for (const n of [0, 1, 2]) if (n < pl.segments.length) segs[`a${n}`] = await fetchSeg(vUrl, pl, n, 'seg');
    const mid = Math.floor(pl.segments.length / 2);
    if (pl.segments.length >= 5) {
      // Ny uppspelning med start mitt i (ny session: ffmpeg startar med -ss), sedan bakåt ett segment (omstart)
      const pb2 = await playback(it, c, `start=${Math.floor(pl.segments[mid].start + 0.5)}`);
      const m2 = parseMaster((await get(pb2.url)).toString());
      const v2 = m2.variants.find(v => v.attrs.RESOLUTION === variant.attrs.RESOLUTION) || m2.variants[0];
      const v2Url = new URL(v2.uri, srv.base + pb2.url).href;
      const pl2 = parseMedia((await get(v2Url)).toString());
      check(pl2.segments.length === pl.segments.length && pl2.segments.every((s, i) => Math.abs(s.dur - pl.segments[i].dur) < 1e-6), 'spellistan ändrades mellan två uppspelningar');
      if (fm) init = await get(new URL(pl2.map, v2Url).href);
      segs.s0 = await fetchSeg(v2Url, pl2, mid, 'spol');
      if (mid + 1 < pl2.segments.length) segs.s1 = await fetchSeg(v2Url, pl2, mid + 1, 'spol');
      segs.sb = await fetchSeg(v2Url, pl2, mid - 1, 'spol');
    }

    // ---- kontroller per segment ----
    const s0 = segs.a0.p;
    const vs = s0.video, fps = fpsOf(vs) || src.expect.fps || 25;
    const frame = src.expect.vfr ? 0.1 : 1 / fps;
    const tol = Math.max(TOL, 1.5 * frame);
    for (const s of Object.values(segs)) {
      const id = `${s.label} ${s.n}`;
      const vp = s.p.vp;
      if (!check(vp.length > 0, `${id}: ingen video`)) continue;
      const pts = vp.map(x => x.pts), minPts = Math.min(...pts);
      const end = Math.max(...vp.map(x => x.pts + (x.dur || frame)));
      // Remux: tidsstämplarna kan vara förskjutna upp till bildomkastningens fördröjning (B-bilder, 1–5 bilder):
      // TS-remux från början förskjuts så att första DTS blir 0, och ffmpegs fMP4-muxer räknar första fragmentet
      // annorlunda än resten. Inom den gränsen blir det en varning (se docs/testsamling.md), utöver den ett fel.
      const reorder = pb.mode === 'remux' ? Math.max(0, ...vp.map(x => x.pts - x.dts)) : 0;
      const near = (dev, lim, msg) => { if (dev > lim + reorder) fail(msg); else if (dev > lim) warn(msg + ' (inom fMP4-muxerns förskjutning)'); };
      near(Math.abs(minPts - s.start), TOL + (src.expect.vfr ? frame : 0), `${id}: börjar på ${minPts.toFixed(3)} s, spellistan säger ${s.start.toFixed(3)} s`);
      near(Math.abs(end - minPts - s.dur), tol, `${id}: längd ${(end - minPts).toFixed(3)} s, EXTINF ${s.dur.toFixed(3)} s`);
      check(vp[0].key, `${id}: första bilden är ingen nyckelbild`);
      if (s.au) {
        const okStart = s.au.irap || (src.openGop && pb.mode === 'remux' && s.au.vcl === 1 && s.au.recovery);
        check(okStart, `${id}: börjar inte med IDR/IRAP (NAL ${s.au.vcl}${s.au.recovery ? ', återhämtningspunkt' : ''})`);
        if (pb.mode === 'transcode') check(s.au.idr, `${id}: omkodat segment börjar inte med IDR (NAL ${s.au.vcl})`);
      }
      const dts = vp.map(x => x.dts);
      check(dts.every((d, i) => d != null && (i === 0 || d > dts[i - 1])), `${id}: DTS ökar inte strikt inom segmentet`);
      check(Math.min(...dts) >= -0.001 && Math.max(...dts) < it.duration + 30, `${id}: negativa eller omslagna tidsstämplar (DTS ${Math.min(...dts).toFixed(3)}–${Math.max(...dts).toFixed(3)})`);
      const ad = s.p.ap.map(x => x.dts);
      if (ad.length) {
        check(ad.every((d, i) => i === 0 || d >= ad[i - 1]), `${id}: ljudets DTS går bakåt`);
        check(Math.min(...ad) >= -0.05 && Math.max(...ad) < it.duration + 30, `${id}: ljudets tidsstämplar negativa eller omslagna`);
      }
      // Bithastighet mot BANDWIDTH (tak vid omkodning med kvalitetsgräns)
      const kbps = s.bytes * 8 / s.dur;
      if (pb.mode === 'transcode' && pb.quality !== 'orig') check(kbps <= variant.bw * 1.1, `${id}: ${Math.round(kbps / 1000)} kbit/s över BANDWIDTH ${Math.round(variant.bw / 1000)}`);
      else if (kbps > variant.bw * 1.1) warn(`${id}: ${Math.round(kbps / 1000)} kbit/s över BANDWIDTH ${Math.round(variant.bw / 1000)}`);
    }
    // Känd brist (rättas inte här, se docs/testsamling.md): ffmpegs HLS-muxer skriver fel kompositionstid för
    // nyckelbilden först i varje fMP4-fragment (utom det första) – den visas för tidigt och krockar med en annan bild
    if (fm && pb.mode === 'remux') {
      for (const run of [['a0', 'a1', 'a2'], ['s0', 's1']]) {
        const pts = run.flatMap(k => segs[k]?.p.vp.map(v => v.pts) || []).sort((a, b) => a - b);
        const dup = pts.filter((x, i) => i && Math.abs(x - pts[i - 1]) < 0.001).length;
        if (dup) known.push(`${segs[run[0]]?.label} ${run.map(k => segs[k]?.n).filter(x => x != null).join(',')}: ${dup} bilder har samma PTS som en annan (nyckelbildens tid i fMP4-fragmentet)`);
      }
    }
    // Sammanhängande segment: nästa börjar efter föregående (ingen överlappande DTS – Chrome avbryter då)
    const pairs = [['a0', 'a1'], ['a1', 'a2'], ['s0', 's1'], ['sb', 's0']];
    for (const [x, y] of pairs) {
      const a = segs[x], b = segs[y];
      if (!a || !b || !a.p.vp.length || !b.p.vp.length) continue;
      const id = `${a.label} ${a.n}→${b.label} ${b.n}${x === 'sb' ? ' (efter omstart)' : ''}`;
      const lastD = Math.max(...a.p.vp.map(v => v.dts)), firstD = Math.min(...b.p.vp.map(v => v.dts));
      check(firstD > lastD, `${id}: video-DTS överlappar (${firstD.toFixed(3)} ≤ ${lastD.toFixed(3)})`);
      const reorder = pb.mode === 'remux' ? Math.max(0, ...b.p.vp.map(v => v.pts - v.dts)) : 0;
      const gapMsg = `${id}: lucka i video-DTS ${(firstD - lastD).toFixed(3)} s`;
      if (firstD - lastD > 2.5 * frame + 0.01 + reorder) fail(gapMsg);
      else if (firstD - lastD > 2.5 * frame + 0.01) warn(gapMsg + ' (inom remuxens förskjutning)');
      const lastPts = Math.max(...a.p.vp.map(v => v.pts)), firstPts = Math.min(...b.p.vp.map(v => v.pts));
      check(firstPts > lastPts, `${id}: video-PTS överlappar`);
      if (a.p.ap.length && b.p.ap.length) {
        const la = a.p.ap[a.p.ap.length - 1], fa = b.p.ap[0];
        const gap = fa.dts - (la.dts + (la.dur || 0));
        // Efter en omstart kodas ljudet om från -ss och AAC-kodarens inledande ram (1024 prov) överlappar lite –
        // spelarna klarar det. Mer än två ljudramar är ett fel (dubbelt ljud eller förskjuten bild).
        const lim = x === 'sb' ? 0.05 : 0.03;
        if (gap < -lim) fail(`${id}: ljudet överlappar ${(-gap).toFixed(3)} s`);
        else if (gap < -0.001) warn(`${id}: ljudet överlappar ${(-gap).toFixed(3)} s`);
        if (gap > 0.1) fail(`${id}: lucka i ljudet ${gap.toFixed(3)} s`);
      }
    }

    // ---- strömmens egenskaper ----
    const out = { vcodec: vs.codec_name, acodec: s0.audio[0]?.codec_name || null, ach: s0.audio[0]?.channels || 0, fmt: fm ? 'fmp4' : 'ts' };
    save('stream.json', { video: vs, audio: s0.audio });
    Object.assign(sum, { video: `${vs.codec_name} ${vs.width}x${vs.height} ${vs.pix_fmt}${vs.color_transfer ? ' ' + vs.color_transfer : ''}`, audio: out.acodec ? `${out.acodec} ${out.ach}ch` : '-' });
    checkAllowed(out, P, caps, pb, fail);
    if (variant.res && master.variants.length) check(vs.width === variant.res[0] && vs.height === variant.res[1], `bilden är ${vs.width}x${vs.height}, mastern säger ${variant.attrs.RESOLUTION}`);
    if (pb.mode === 'transcode') {
      // Utdatans codec: H.264, eller HEVC/AV1 när klienten angett tc= och servern har en kodare (alltid i fMP4)
      const want = pb.vcodec || 'h264';
      check(vs.codec_name === want, `omkodad video är ${vs.codec_name}, beslutet säger ${want}`);
      check(want === 'h264' || (P.tc || []).includes(want), `omkodning till ${want} som klienten inte bett om`);
      if (want !== 'h264') check(fm, `${want} ska omkodas till fMP4`);
      if (P.tc && want === 'h264') warn(`ingen ${P.tc.join('/')}-kodare – omkodades till H.264`);
      check(vs.pix_fmt === 'yuv420p', `omkodad video har ${vs.pix_fmt} (ska vara 8-bitars yuv420p)`);
      if (want === 'h264') {
        check(['High', 'Main', 'Constrained Baseline', 'Baseline'].includes(vs.profile), `H.264-profil ${vs.profile}`);
        const maxL = Math.max(41, minLevel(vs.width, vs.height, fps));
        check(vs.level > 0 && vs.level <= maxL, `H.264-nivå ${vs.level / 10} för ${vs.width}x${vs.height}@${fps.toFixed(2)} (högst ${maxL / 10})`);
      } else if (want === 'hevc') check(vs.profile === 'Main', `HEVC-profil ${vs.profile} (ska vara Main, 8 bitar)`);
      check(!['smpte2084', 'arib-std-b67'].includes(vs.color_transfer), `8-bitarsvideo märkt ${vs.color_transfer}`);
      check(vs.color_primaries !== 'bt2020', '8-bitarsvideo märkt BT.2020');
      if (src.expect.hdr) check(vs.color_transfer === 'bt709' && vs.color_primaries === 'bt709', `tonmappad bild märkt ${vs.color_transfer}/${vs.color_primaries}, ska vara bt709`);
      check(+vs.has_b_frames === 0 && s0.vp.every(x => Math.abs(x.pts - x.dts) < 1e-6), 'omkodad video har B-bilder (DTS ≠ PTS)');
      if (src.interlaced) {
        // Märkningen räcker inte (x264 märker allt progressivt) – idet mäter kammen i bilden
        check(!vs.field_order || vs.field_order === 'progressive', `flätad källa omkodad som flätad (field_order ${vs.field_order})`);
        const { stderr } = await pexec('ffmpeg', ['-hide_banner', '-nostdin', '-i', path.join(dir, `seg-0.${fm ? 'mp4' : 'ts'}`), '-map', '0:v:0', '-vf', 'idet', '-f', 'null', '-']);
        // idet skriver en rad per filterinstans – den sista har räkningen
        const m = [...stderr.matchAll(/Multi frame detection: TFF:\s*(\d+) BFF:\s*(\d+) Progressive:\s*(\d+)/g)].pop();
        if (m) check(+m[3] >= +m[1] + +m[2], `flätad källa omkodad utan avflätning (idet: TFF ${m[1]}, BFF ${m[2]}, progressiva ${m[3]})`);
      }
      if (src.expect.sar) {
        const [sw, sh] = src.expect.sar.split(':').map(Number), [ow, oh] = String(vs.sample_aspect_ratio || '1:1').split(':').map(Number);
        const want = 720 * sw / sh / 576, got = vs.width * ow / oh / vs.height;
        check(Math.abs(got / want - 1) < 0.01, `bildformatet ändrades: ${got.toFixed(3)} ≠ ${want.toFixed(3)}`);
      }
    } else {
      check(vs.codec_name === src.expect.vcodec, `remux ändrade codec till ${vs.codec_name}`);
      if (src.expect.transfer) check(vs.color_transfer === src.expect.transfer, `remux tappade HDR-märkningen (${vs.color_transfer})`);
      if (src.expect.vcodec === 'hevc') check(fm, 'HEVC-remux ska vara fMP4');
    }
    if (s0.audio.length) {
      const a = s0.audio[0];
      check(s0.audio.length === 1, `${s0.audio.length} ljudspår i segmentet`);
      check([32000, 44100, 48000].includes(+a.sample_rate), `samplingsfrekvens ${a.sample_rate}`);
      check(a.channels >= 1 && a.channels <= 8, `${a.channels} ljudkanaler`);
      const am = pu.get('am');
      if (am === 'aac') check(a.codec_name === 'aac' && a.channels <= 2, `konverterat ljud är ${a.codec_name} ${a.channels} kanaler`);
      if (am === 'eac3') check(a.codec_name === 'eac3' && a.channels === 6, `konverterat surroundljud är ${a.codec_name} ${a.channels} kanaler`);
      const sel = q.get('audio');
      if (sel) {
        const track = (src.expect.audioTracks || [])[+sel - 1];
        if (am === 'copy') check(a.codec_name === track, `valt ljudspår ${sel} (${track}) men segmentet har ${a.codec_name}`);
        check(pu.get('audio') === sel, `valt ljudspår ${sel} men servern valde ${pu.get('audio')}`);
      }
    } else fail('segmentet saknar ljud');
    seen.set(key, { name: c.name, out });
    sum.ok = !problems.length;
  } catch (e) { fail(`undantag: ${e.message}`); }
  finally {
    await stop();
    // Segmenten sparas bara för fall som misslyckats (spellistor och ffprobe-JSON alltid)
    if (!problems.length) for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (/\.(ts|m4s|mp4)$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
  return { problems, warnings, known };
}

/** Får klienten den här ljud- och bildströmmen? (codec i klientens lista, inget Dolby i TS för Apples HLS) */
function checkAllowed(out, P, caps, pb, fail) {
  if (!caps.v.has(out.vcodec)) fail(`video ${out.vcodec} finns inte i klientens lista (${[...caps.v]})`);
  if (out.acodec && !caps.a.has(out.acodec)) fail(`ljud ${out.acodec} finns inte i klientens lista (${[...caps.a]})`);
  if (P.native && out.fmt === 'ts' && out.acodec && !['aac', 'mp3'].includes(out.acodec)) fail(`${out.acodec} i MPEG-TS för Apples HLS-spelare (startar inte)`);
  if (P.remote && pb.mode === 'transcode' && out.acodec && (out.acodec !== 'aac' || out.ach !== 2)) fail(`utanför hemmet ska ljudet vara AAC stereo, fick ${out.acodec} ${out.ach} kanaler`);
}

// ---------- undertexter ----------
async function subtitleChecks(src, it, problems) {
  if (!src.expect.textSubs && !src.expect.pgs) return;
  const pb = await playback(it, { profile: 'chrome', query: '' });
  await srv.req(`/api/stream/${it.id}/stop`, { method: 'POST' });
  for (const s of pb.subtitles) {
    for (const variant of s.id.startsWith('e') ? ['', '&live=1&pos=0'] : ['']) {
      const r = await srv.req(s.url + (s.url.includes('?') ? '&' : '?') + variant.slice(1), { raw: true });
      const id = `undertext ${s.id} (${s.label})${variant ? ' live' : ''}`;
      if (r.status !== 200) { problems.push(`${id}: ${r.status}`); continue; }
      let cues;
      try { cues = parseVtt(r.data.toString()); } catch (e) { problems.push(`${id}: ${e.message}`); continue; }
      // Live-läsning: läst fram till minst första repliken; övriga ska finnas när filen lästs klart
      const want = variant ? CUES.slice(0, 1) : CUES;
      for (const w of want) {
        const hit = cues.find(x => Math.abs(x.s - w.s) < 0.1 && Math.abs(x.e - w.e) < 0.1 && x.text.replace(/<[^>]+>/g, '').includes(w.text));
        if (!hit) problems.push(`${id}: repliken "${w.text}" vid ${w.s} s saknas (${cues.map(x => `${x.s}–${x.e} ${x.text}`).join(' | ')})`);
      }
    }
  }
  for (const s of pb.imageSubs || []) {
    let j = null;
    for (let i = 0; i < 40; i++) { j = (await srv.req(s.url)).data; if (j.done) break; await new Promise(r => setTimeout(r, 250)); }
    if (!j?.cues?.length) { problems.push(`PGS ${s.id}: inga repliker (${JSON.stringify(j).slice(0, 200)})`); continue; }
    for (const w of PGS_CUES) if (!j.cues.some(x => Math.abs(x.s - w.s) < 0.1)) problems.push(`PGS ${s.id}: repliken vid ${w.s} s saknas`);
    const img = await srv.req(`/api/stream/${it.id}/pgs/${s.id}/0`, { raw: true });
    if (img.status !== 200 || img.data.subarray(1, 4).toString() !== 'PNG') problems.push(`PGS ${s.id}: bild 0 gav ${img.status}`);
  }
}
