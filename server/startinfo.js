// Startloggen: det en hemanvändare (eller den som svarar i supporttråden) behöver se först i Unraids logg –
// version, arkitektur, användare, ffmpeg, hårdvaruacceleration och sökvägar med behörighetsproblem och ett konkret råd.
// Bara läsning; ingenting ändras. Anropas en gång från index.js.
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';

const can = (p, mode) => { try { fs.accessSync(p, mode); return true; } catch { return false; } };

/** Status för en mapp: { path, exists, ok, problem } – write = servern måste kunna skriva där */
export function checkDir(p, { write = false } = {}) {
  if (!p) return null;
  if (!fs.existsSync(p)) return { path: p, exists: false, ok: !write, problem: write ? 'finns inte' : null };
  const ok = write ? can(p, fs.constants.W_OK | fs.constants.X_OK) : can(p, fs.constants.R_OK | fs.constants.X_OK);
  return { path: p, exists: true, ok, problem: ok ? null : (write ? 'kan inte skriva' : 'kan inte läsa') };
}

/** Grafikenheter som syns i containern */
export function gpuDevices() {
  const out = [];
  try { for (const f of fs.readdirSync('/dev/dri')) if (/^renderD\d+$/.test(f)) out.push('/dev/dri/' + f); } catch {}
  if (fs.existsSync('/dev/nvidia0')) out.push('/dev/nvidia0');
  return out;
}

/** Råd för hårdvaruaccelerationen: HWACCEL mot de enheter som faktiskt finns */
export function hwAdvice(hw, devs) {
  hw = String(hw || 'none').toLowerCase();
  const dri = devs.some(d => d.startsWith('/dev/dri/')), nv = devs.includes('/dev/nvidia0');
  if ((hw === 'vaapi' || hw === 'qsv') && !dri) return `HWACCEL=${hw} men /dev/dri saknas i containern – lägg till enheten /dev/dri i mallen (GPU-enhet).`;
  if (hw === 'nvenc' && !nv) return 'HWACCEL=nvenc men inget NVIDIA-kort syns – installera pluginen Nvidia-Driver, lägg till --runtime=nvidia under Extra Parameters och NVIDIA_VISIBLE_DEVICES=all (eller använd mallen braxhn-tv-nvidia.xml).';
  if (hw === 'none' && (dri || nv)) return `ett grafikkort finns (${devs.join(', ')}) men HWACCEL=none – välj ${nv ? 'nvenc' : 'vaapi eller qsv'} under Hårdvaruomkodning för snabbare omkodning.`;
  return null;
}

const ffmpegLine = () => new Promise(r => execFile('ffmpeg', ['-hide_banner', '-version'], { timeout: 5000 },
  (e, o) => r(e ? null : (/ffmpeg version (\S+)/.exec(String(o))?.[1] || String(o).split('\n')[0]))));

export async function logStart({ version, config }) {
  const env = process.env;
  const uid = process.getuid?.(), gid = process.getgid?.();
  const um = process.umask().toString(8).padStart(3, '0');
  console.log(`BraXhn TV ${version} · Node ${process.versions.node} · ${process.platform}/${os.arch()} · ${os.cpus().length} kärnor, ${Math.round(os.totalmem() / 2 ** 30)} GB minne`);
  if (uid !== undefined) console.log(`[start] körs som ${uid}:${gid}, umask ${um}${uid === 0 ? ' – root (sätt hellre PUID=99 och PGID=100)' : ''}`);
  const ff = await ffmpegLine();
  console.log(ff ? `[start] ffmpeg ${ff}` : '[start] FEL: ffmpeg hittades inte – analys och omkodning fungerar inte. Docker-imagen har ffmpeg; kör du utan Docker: installera ffmpeg (7.x).');
  const devs = gpuDevices();
  console.log(`[start] hårdvaruacceleration: HWACCEL=${env.HWACCEL || 'none'}, enheter: ${devs.length ? devs.join(', ') : 'inga'}`);
  const adv = hwAdvice(env.HWACCEL, devs);
  if (adv) console.log('[start] OBS: ' + adv);
  const dirs = [
    ['konfiguration', checkDir(config, { write: true })],
    ['media', checkDir(env.MEDIA_ROOT || '/media')],
    ['omkodningscache', checkDir(env.TRANSCODE_DIR, { write: true })],
    ['inspelningar', fs.existsSync('/recordings') ? checkDir('/recordings', { write: true }) : null],
  ].filter(([, s]) => s);
  console.log('[start] sökvägar: ' + dirs.map(([n, s]) => `${n} ${s.path}${s.exists ? '' : ' (saknas)'}`).join(', '));
  for (const [n, s] of dirs) if (!s.ok) {
    console.warn(`[start] VARNING: ${n} ${s.path}: ${s.problem} som ${uid}:${gid}. ` +
      (s.exists ? `Rätta ägaren på värdmappen (Unraid: chown -R ${uid}:${gid} <mappen>) eller ändra PUID/PGID i mallen.` : 'Kontrollera sökvägen i mallen.'));
  }
  return { devs, dirs: Object.fromEntries(dirs), ffmpeg: ff };
}

