// Riktig Chrome för uppspelningsprov: test/web-chrome-playback.test.js och uppspelningsvakten (test/vakt.mjs).
// Playwrights Chromium saknar H.264 – därför Google Chrome. Playwright letas upp i PLAYWRIGHT (sökväg till
// index.mjs, som i GitHub Actions), som paket eller där den finns installerad globalt här.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { PW } from '../media/server.mjs';

export const CHROME = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].filter(Boolean).find(p => fs.existsSync(p)) || null;

export let chromium = null;
const require = createRequire(import.meta.url);
for (const p of [process.env.PLAYWRIGHT, 'playwright', '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { ({ chromium } = p.startsWith('/') ? await import(p) : require(p)); if (chromium) break; } catch {}
}

export const launchChrome = () => chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });

/** Ny inloggad sida (egen kontext, inget minne från förra sidan) */
export async function loginPage(browser, base, userAgent, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(userAgent ? { userAgent } : {}), ...opts });
  const p = await ctx.newPage();
  await p.goto(base + '/#/login');
  await p.fill('input[autocomplete="username"], #u, input[name=name]', 'admin'); await p.fill('input[type=password]', PW); await p.keyboard.press('Enter');
  await p.waitForFunction(() => !location.hash.includes('login'), null, { timeout: 30000 });
  return { p, close: () => ctx.close() };
}

// Hjälp i sidan: __frame(pred, max) väntar på första nya bild som uppfyller pred(mediatid) – följer med om
// videoelementet byts – och ger { ms, at } eller { ms: null, läget }. __moves(ms) räknar bildrutor och speltid.
// __errors räknar videoelementets fel (avkodningsfel), __waiting dess waiting-händelser, __modes lägena i tur och
// ordning (__errlog felens text). __quality() summerar bildrutor och tappade bildrutor över alla videoelement sidan haft.
export async function installProbes(p) {
  await p.evaluate(async () => {
    const lazy = await import('/m/js/lazy.js'); window.__V = await lazy.loadPlayer(); window.__L = lazy;
    window.__errors = 0; window.__waiting = 0; window.__modes = []; window.__errlog = [];
    // Räknarna i getVideoPlaybackQuality börjar om när spelaren kopplar in videon på nytt (återhämtning efter fel)
    const seen = new WeakSet(), vids = [], acc = { total: 0, dropped: 0 }; let hls = null;
    const tally = () => { for (const x of vids) { const q = x.v.getVideoPlaybackQuality();
      for (const k of ['total', 'dropped']) { const n = k === 'total' ? q.totalVideoFrames : q.droppedVideoFrames; acc[k] += n >= x[k] ? n - x[k] : n; x[k] = n; } } };
    // Fångas på vägen ner till videon (capture), före spelarens egen hanterare som återställer videoelementet
    document.addEventListener('error', (e) => { const v = e.target; if (v?.id !== 'vid') return;
      window.__errors++; window.__errlog.push(`${v.error?.code || 0} ${v.error?.message || ''} vid ${v.currentTime.toFixed(1)} s`); }, true);
    setInterval(() => {
      const v = document.querySelector('#vid');
      if (v && !seen.has(v)) { seen.add(v); vids.push({ v, total: 0, dropped: 0 });
        v.addEventListener('waiting', () => window.__waiting++); }
      const m = window.__V.P?.pb?.mode; if (m && window.__modes.at(-1) !== m) window.__modes.push(m);
      // hls.js säger vad felet var (videoelementets fel är redan återställt när händelsen når hit)
      const h = window.__V.P?.hls; if (h && h !== hls) { hls = h; h.on('hlsError', (_, d) => window.__errlog.push(`hls.js ${d.type}/${d.details}${d.fatal ? ' (fatalt)' : ''}${d.error?.message ? ': ' + d.error.message : ''}`)); }
      tally();
    }, 10);
    window.__quality = () => { tally(); return { ...acc }; };
    const state = window.__state = () => { const v = document.querySelector('#vid'); if (!v) return 'ingen video';
      const b = []; for (let i = 0; i < v.buffered.length; i++) b.push(v.buffered.start(i).toFixed(1) + '–' + v.buffered.end(i).toFixed(1));
      return `tid ${v.currentTime.toFixed(1)}, ${v.paused ? 'pausad' : 'spelar'}, fel ${v.error?.code || 0} ${v.error?.message || ''}, buffert [${b}], läge ${window.__V.P?.pb?.mode}`; };
    window.__frame = (pred, max = 20000) => new Promise((ok) => {
      const t0 = performance.now(); let fin = false, cur = null;
      const lim = setTimeout(() => { fin = true; ok({ ms: null, state: state() }); }, max);
      const arm = () => { if (fin) return; const v = document.querySelector('#vid');
        if (v && v !== cur) { cur = v; const cb = (now, m) => { if (fin || v !== cur) return; if (pred(m.mediaTime)) { fin = true; clearTimeout(lim); ok({ ms: Math.round(performance.now() - t0), at: m.mediaTime }); } else v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb); }
        setTimeout(arm, 20); };
      arm();
    });
    window.__moves = async (ms) => { const v = document.querySelector('#vid'); const q0 = window.__quality().total, c0 = v.currentTime; await new Promise(r => setTimeout(r, ms));
      return { frames: window.__quality().total - q0, played: v.currentTime - c0, same: document.querySelector('#vid') === v, paused: v.paused }; };
  });
}
