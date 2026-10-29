// Vad klarar ffmpeg i den här miljön? Version, kodare, filter och Vulkan-enhet läses en gång vid start.
// Docker-imagen kör Debians ffmpeg 7.1, men en egen installation (eller utvecklingsmaskinen) kan ha en äldre –
// allt som kom efter 5.1 (HEVC/AV1-kodare i fMP4, libplacebo, tonemap_opencl/tonemap_cuda) sonderas i stället
// för att antas. Samma flagga kan betyda olika saker i olika versioner, så stream.js provkör dessutom varje kedja.
import { execFile } from 'node:child_process';

const run = (args, timeout = 15000) => new Promise(res => execFile('ffmpeg', ['-hide_banner', ...args], { timeout, killSignal: 'SIGKILL', maxBuffer: 8 << 20 },
  (e, out, err) => res({ ok: !e, out: String(out || ''), err: String(err || '') })));

/** "ffmpeg version 7.1.5-0+deb13u1 …" → { text, major, minor }; utvecklingsbyggen (N-…) räknas som nyast */
export function parseVersion(text) {
  const s = String(text || '');
  const m = /ffmpeg version n?(\d+)\.(\d+)(\S*)/.exec(s);
  if (m) return { text: `${m[1]}.${m[2]}${m[3]}`, major: +m[1], minor: +m[2] };
  const dev = /ffmpeg version (N-\S+)/.exec(s);
  return dev ? { text: dev[1], major: 99, minor: 0 } : { text: '', major: 0, minor: 0 };
}

/** Namnen i en lista från -encoders eller -filters (" V....D libx265  …" / " ..C libplacebo  N->V …"; ffmpeg 8 har två flaggtecken: " TS scale …") */
export function parseList(text) {
  const out = new Set();
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*([A-Z.|]{2,8})\s+(\w+)\s/.exec(line);
    if (m && m[2] !== '=') out.add(m[2]);
  }
  return out;
}

/** Vulkan-enheten som ffmpeg väljer: "Device 0 selected: NVIDIA GeForce … (discrete) (0x…)" → { name, type } */
export function parseVulkanDevice(text) {
  const m = /Device \d+ selected: (.+?) \((integrated|discrete|virtual|software|cpu|unknown|other)\)/i.exec(String(text || ''));
  return m ? { name: m[1].trim(), type: m[2].toLowerCase() } : null;
}

export const ffcaps = { version: '', major: 0, minor: 0, encoders: new Set(), filters: new Set(), placeboDovi: false };

export const ffReady = (async () => {
  const [v, enc, flt] = await Promise.all([run(['-version']), run(['-encoders']), run(['-filters'])]);
  const ver = parseVersion(v.out);
  Object.assign(ffcaps, { version: ver.text, major: ver.major, minor: ver.minor, encoders: parseList(enc.out), filters: parseList(flt.out) });
  if (ffcaps.filters.has('libplacebo')) ffcaps.placeboDovi = /apply_dolbyvision/.test((await run(['-h', 'filter=libplacebo'])).out);
  return ffcaps;
})().catch(() => ffcaps);

/** Vilken Vulkan-enhet når ffmpeg? null = ingen. type 'software' (lavapipe) är för långsam för video (3 bilder/s i 1080p). */
export async function vulkanDevice() {
  const r = await run(['-v', 'verbose', '-init_hw_device', 'vulkan=vk', '-f', 'lavfi', '-i', 'nullsrc=s=64x64:d=0.04', '-frames:v', '1', '-f', 'null', '-'], 20000);
  return r.ok ? parseVulkanDevice(r.err) : null;
}
