// Grafikkortens kodare (NVENC/QSV/VA-API) och segmentgränserna. Ägarens NVENC gav ~10 s väntan på varje första
// segment: h264_nvenc har 250 bilders GOP (≈ 10,4 s vid 23,976 bilder/s) och segment-muxern delar bara på
// nyckelbilder. Ingen GPU i CI – argumenten kontrolleras, och mekanismen (GOP-längd → segmentgränser) med libx264/libx265.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-gop-'));
process.env.TRANSCODE_DIR = path.join(process.env.CONFIG_DIR, 'tc');
process.env.TRANSCODE_PROBE = '0';
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const t = (name, fn) => test(name, { skip: !hasFfmpeg && 'ffmpeg saknas' }, fn);
const st = await import('../server/stream.js');
const { fpsOf } = await import('../server/scanner.js');

const val = (args, k) => { const i = args.lastIndexOf(k); return i >= 0 ? args[i + 1] : undefined; };

test('grafikkortens kodare: GOP = 2 s av källans bildfrekvens, tvingade nyckelbilder blir IDR, inga scenbyten', () => {
  assert.equal(st.gopFrames(23.976), 48);
  assert.equal(st.gopFrames(25), 50);
  assert.equal(st.gopFrames(59.94), 120);
  assert.equal(st.gopFrames(null), 50, 'okänd bildfrekvens: 25');
  // Alla segmentgränser (0, 2, 4, 6, 12 … – HEAD och SEG) är multiplar av GOP-längden
  for (const b of [2, 4, 6, 12, 18]) assert.equal(b % st.GOP_SEC, 0);
  for (const kind of ['nvenc', 'qsv', 'vaapi']) {
    for (const vc of ['h264', 'hevc', 'av1']) {
      for (const br of [null, 8000]) {
        const a = st.encArgs(kind, vc, br, false, 23.976);
        assert.equal(val(a, '-g'), '48', `${kind}/${vc}: -g ${val(a, '-g')}`);
        assert.equal(a.filter(x => x === '-g').length, 1);
        if (kind === 'nvenc') { assert.equal(val(a, '-forced-idr'), '1'); assert.equal(val(a, '-no-scenecut'), '1', `${vc}: inga scenbyten`); }
        if (kind === 'qsv' && vc !== 'av1') assert.equal(val(a, '-forced_idr'), '1');
      }
    }
  }
  // Processorn: oförändrat (x264 utan scenbyten, x265/SVT-AV1 bara de tvingade)
  assert.equal(val(st.encArgs('none', 'h264', null, false, 25), '-sc_threshold'), '0');
  assert.match(val(st.encArgs('none', 'hevc', null, false, 25), '-x265-params'), /keyint=1000/);
  // Bildfrekvensen ur ffprobe
  assert.equal(fpsOf('24000/1001'), 23.976);
  assert.equal(fpsOf('25/1'), 25);
  assert.equal(fpsOf('0/0'), null);
  assert.equal(fpsOf('90000/1'), null);
});

test('grafikkortets kedja i omkodningen: -g, -forced-idr och -force_key_frames i samma körning (HWACCEL i egen process)', () => {
  for (const hw of ['nvenc', 'qsv', 'vaapi']) {
    const code = `const st = await import(${JSON.stringify(new URL('../server/stream.js', import.meta.url).href)});
      const it = { id: 1, hdr: null, streams: JSON.stringify([{ type: 'video', index: 0, codec: 'h264', pix: 'yuv420p', width: 1920, height: 1080, fps: 23.976 }]) };
      const out = { start: st._segs.videoArgs(it, { q: '1080', mode: 'transcode' }, true).enc, seek: st._segs.videoArgs(it, { q: '720', mode: 'transcode' }, false).enc };
      console.log(JSON.stringify(out)); process.exit(0);`;
    const env = { ...process.env, HWACCEL: hw, TRANSCODE_PROBE: '0', CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-gop-hw-')), TRANSCODE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-gop-tc-')) };
    const r = JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { env }).toString().trim().split('\n').pop());
    for (const [k, enc] of Object.entries(r)) {
      assert.equal(val(enc, '-c:v'), `h264_${hw}`, `${hw}/${k}`);
      assert.equal(val(enc, '-g'), '48', `${hw}/${k}: GOP 2 s`);
      assert.equal(val(enc, '-bf'), '0');
      assert.match(val(enc, '-force_key_frames'), /^expr:/, `${hw}/${k}: tvingade nyckelbilder på segmentgränserna`);
    }
  }
});

// Segmentgränserna (sekunder) som segment-muxern faktiskt skriver med en viss GOP-inställning
function bounds(enc, { forced = true, fmp4 = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-gop-seg-'));
  const fk = forced ? ['-force_key_frames', 'expr:if(lt(n_forced,3),gte(t,2*n_forced),gte(t,6*(n_forced-2)))'] : [];
  const out = fmp4 ? ['-f', 'segment', '-segment_format', 'mp4', '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof']
    : ['-f', 'segment', '-segment_format', 'mpegts'];
  const csv = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:d=20:r=24000/1001',
    '-map', '0:v', '-pix_fmt', 'yuv420p', ...enc, ...fk, '-bf', '0', ...out, '-segment_times', '1.995,3.995,5.995,11.995,17.995',
    '-segment_list', 'pipe:1', '-segment_list_type', 'csv', path.join(dir, `s_%02d.${fmp4 ? 'm4s' : 'ts'}`)]).toString();
  fs.rmSync(dir, { recursive: true, force: true });
  return csv.trim().split('\n').map(l => +l.split(',')[2]).slice(0, -1);
}
const near = (got, want, why) => { assert.equal(got.length, want.length, `${why}: ${got}`); got.forEach((g, i) => assert.ok(Math.abs(g - want[i]) < 0.05, `${why}: ${got} ≠ ${want}`)); };

t('mekanismen: GOP 250 utan tvingade nyckelbilder ger segment per GOP (~10 s); GOP 2 s ger rutnätet även utan dem', () => {
  // Som h264_nvenc med standardvärden när de tvingade nyckelbilderna inte tas emot: första gränsen efter 250 bilder
  const old = bounds(['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '250', '-sc_threshold', '0'], { forced: false });
  assert.ok(old[0] > 10 && old[0] < 10.6, `första segmentet slutar vid 250 bilder (${old[0]} s)`);
  // Samma kodare med serverns GOP för grafikkortet (gopFrames) – gränserna hamnar på 2, 4, 6, 12, 18 s ändå
  const g = String(st.gopFrames(fpsOf('24000/1001')));
  near(bounds(['-c:v', 'libx264', '-preset', 'ultrafast', '-g', g, '-sc_threshold', '0'], { forced: false }), [2, 4, 6, 12, 18], 'GOP 2 s utan tvingade');
  // Med tvingade nyckelbilder (som i omkodningen) blir det rätt med båda GOP-längderna
  near(bounds(['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '250', '-sc_threshold', '0']), [2, 4, 6, 12, 18], 'GOP 250 med tvingade');
  near(bounds(['-c:v', 'libx264', '-preset', 'ultrafast', '-g', g, '-sc_threshold', '0']), [2, 4, 6, 12, 18], 'GOP 2 s med tvingade');
});

test('mekanismen i fMP4 (HEVC): libx265 med grafikkortets GOP utan tvingade nyckelbilder delar på rutnätet', { skip: !hasFfmpeg || !/libx265/.test(spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout) }, () => {
  const g = String(st.gopFrames(23.976));
  const x265 = (keyint) => ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', `log-level=error:scenecut=0:open-gop=0:keyint=${keyint}:min-keyint=${keyint}`];
  const old = bounds(x265(250), { forced: false, fmp4: true });
  assert.ok(old[0] > 10 && old[0] < 10.6, `GOP 250: ${old}`);
  near(bounds(x265(g), { forced: false, fmp4: true }), [2, 4, 6, 12, 18], 'GOP 2 s');
});
