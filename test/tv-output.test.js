// Google TV-appen: ljudspår väljs i appen (atrack=1) och skärmens HDR-typer (hdrt=) – bara tillägg i parseCaps/decide
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bxtv-tvout-'));
process.env.TRANSCODE_DIR = path.join(process.env.CONFIG_DIR, 'tc');
const st = await import('../server/stream.js');

const film = (hdr, video, audios) => ({ id: 880001, path: '/m/Film (2020).mkv', size: 30e9, duration: 7200, hdr, vcodec: video.codec, mtime: 1,
  streams: JSON.stringify([{ index: 0, type: 'video', ...video }, ...audios.map((a, i) => ({ index: i + 1, type: 'audio', ...a }))]) });
// Det Android-appen skickar på en Google TV med förstärkare som tar emot bitström
const tv = (extra = {}) => ({ ...st.parseCaps(new URLSearchParams({ c: 'mp4,mkv,webm', v: 'h264,hevc,vp9,av1', a: 'aac,mp3,opus,flac,vorbis,ac3,eac3,dts,truehd',
  hdr: '1', ...extra })), assumeKf: true });

test('Google TV: DTS/TrueHD spelas direkt, även ett annat ljudspår än standard när appen väljer spåret själv', () => {
  const it = film(null, { codec: 'h264', width: 1920, height: 1080, pix: 'yuv420p' },
    [{ codec: 'truehd', channels: 8, default: true, lang: 'eng' }, { codec: 'dts', channels: 6, lang: 'swe' }]);
  assert.equal(st.decide(it, tv()).mode, 'direct', 'TrueHD-standardspåret går direkt');
  // Utan atrack=1 (webben, äldre appar): ett annat spår kräver remux, och DTS konverteras
  const old = st.decide(it, { ...tv(), audio: '2' });
  assert.equal(old.mode, 'remux'); assert.equal(old.audioMode, 'eac3');
  const d = st.decide(it, { ...tv({ atrack: '1' }), audio: '2' });
  assert.equal(d.mode, 'direct', 'appen väljer DTS-spåret själv – ingen omkodning');
  assert.equal(d.audio, '2', 'svaret talar om vilket spår appen ska välja');
  // Ett spår som enheten inte klarar går fortfarande via servern
  const pcm = st.decide(it, { ...st.parseCaps(new URLSearchParams({ c: 'mp4,mkv', v: 'h264', a: 'aac,ac3,eac3', atrack: '1' })), audio: '2', assumeKf: true });
  assert.notEqual(pcm.mode, 'direct');
});

test('Google TV: HDR spelas direkt bara när skärmen klarar just den HDR-typen', () => {
  const v = { codec: 'hevc', width: 3840, height: 2160, pix: 'yuv420p10le' };
  const a = [{ codec: 'eac3', channels: 6, default: true }];
  const hlg = film('hlg', v, a), hdr10 = film('hdr10', v, a);
  const dv8 = film('dovi', { ...v, dovi: true, dvProfile: 8 }, a), dv5 = film('dovi', { ...v, dovi: true, dvProfile: 5 }, a);
  // Utan hdrt gäller hdr=1 för alla typer (som förut)
  assert.equal(st.decide(hlg, tv()).mode, 'direct');
  // Skärm med bara HDR10: HLG tonmappas, HDR10 och Dolby Vision med HDR10-bas går direkt
  const only10 = tv({ hdrt: 'hdr10' });
  assert.equal(st.decide(hlg, only10).tonemap, true);
  assert.equal(st.decide(hdr10, only10).mode, 'direct');
  assert.equal(st.decide(dv8, only10).mode, 'direct');
  // Profil 5 kräver en Dolby Vision-enhet (dv=1)
  assert.notEqual(st.decide(dv5, only10).mode, 'direct');
  assert.equal(st.decide(dv5, tv({ hdrt: 'hdr10,dovi', dv: '1' })).mode, 'direct');
  // hdr=0 vinner alltid (SDR-skärm)
  assert.equal(st.decide(hdr10, tv({ hdr: '0', hdrt: 'hdr10' })).tonemap, true);
});
