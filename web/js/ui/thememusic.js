// Temamusik på titelsidan (som Plex/Jellyfin): theme.mp3/theme.m4a i seriens eller filmens mapp spelas svagt (~25 %),
// tonas in och ut och stängs av när man lämnar sidan. Spelas bara när profilen vill det (it.theme.play, valet under
// Mitt konto – standard på för serier), aldrig när något annat spelar (musik, ljudbok, video, live-TV) och aldrig innan
// användaren har rört sidan (webbläsarnas autoplay-spärr – då försöker vi inte alls).
import { $, act, api, onLeave } from '../core.js';
import { M } from '../audio.js';

const LEVEL = 0.25, FADE_IN = 1500, FADE_OUT = 900;
let touched = false;
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => { touched = true; }, { capture: true, passive: true });
const interacted = () => touched || !!navigator.userActivation?.hasBeenActive;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let cur = null; // { a, gain, ctx, raf, watch }
/** Spelar något annat just nu (ljudspelaren eller en video/ljud på sidan)? */
export function othersPlaying(except = null) {
  if (M.audio && !M.audio.paused && M.audio !== except) return true;
  return [...document.querySelectorAll('audio,video')].some(m => m !== except && !m.paused && !m.ended);
}
const setLevel = (c, v) => { if (c.gain) c.gain.gain.value = v; else c.a.volume = v; };
const levelOf = (c) => c.gain ? c.gain.gain.value : c.a.volume;
function fade(c, to, ms, then) {
  cancelAnimationFrame(c.raf);
  const from = levelOf(c), t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    setLevel(c, from + (to - from) * k);
    if (k < 1) c.raf = requestAnimationFrame(step); else then?.();
  };
  c.raf = requestAnimationFrame(step);
}
/** Tonar ut och stänger av temamusiken (ms = 0: direkt) */
export function stopTheme(ms = FADE_OUT) {
  const c = cur; if (!c) return;
  cur = null;
  clearInterval(c.watch);
  const end = () => { cancelAnimationFrame(c.raf); c.a.pause(); c.a.removeAttribute('src'); c.a.load(); c.ctx?.close().catch(() => {}); };
  if (!ms || c.a.paused) end(); else fade(c, 0, ms, end);
}
/** Startar temamusiken för titeln om det är tillåtet (anropas när titelsidan visats) */
export function playTheme(it) {
  stopTheme(0);
  if (!it?.theme?.play || !interacted() || othersPlaying()) return;
  const a = new Audio(`/api/items/${+it.id}/theme`);
  a.preload = 'auto';
  const c = cur = { a, gain: null, ctx: null, raf: 0, watch: 0 };
  // iOS ändrar inte volume på ljudelement – där (och där det går) styrs nivån med WebAudio. Går inte det på iOS spelas inget.
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    try { c.ctx = new AC(); c.gain = c.ctx.createGain(); c.gain.gain.value = 0; c.ctx.createMediaElementSource(a).connect(c.gain).connect(c.ctx.destination); }
    catch { c.ctx?.close().catch(() => {}); c.ctx = c.gain = null; }
  }
  if (!c.gain) { if (isIOS()) { cur = null; return; } a.volume = 0; }
  onLeave(() => stopTheme());
  // Tona ut mot slutet, och direkt om något annat börjar spela
  a.addEventListener('timeupdate', () => { if (cur === c && a.duration && a.duration - a.currentTime < 2.5 && !c.out) { c.out = true; fade(c, 0, 2000); } });
  a.addEventListener('ended', () => { if (cur === c) stopTheme(0); });
  c.watch = setInterval(() => { if (cur === c && othersPlaying(a)) stopTheme(); }, 300);
  (c.ctx?.state === 'suspended' ? c.ctx.resume() : Promise.resolve())
    .then(() => { if (cur !== c) return; if (c.ctx && c.ctx.state !== 'running') throw new Error('ljudet är spärrat'); return a.play(); })
    .then(() => { if (cur === c) fade(c, LEVEL, FADE_IN); })
    .catch(() => { if (cur === c) stopTheme(0); }); // spärrat av webbläsaren eller filen saknas – tyst
}
/** Valen under Mitt konto */
export async function renderThemePrefs(box) {
  const p = await api('/me/theme-music', { bg: true });
  box.innerHTML = `<h2>Temamusik</h2>
    <p class="muted small">Ligger det en <code>theme.mp3</code> eller <code>theme.m4a</code> i seriens eller filmens mapp spelas den svagt när du öppnar titelsidan – aldrig om något annat redan spelar. Sparas för din profil.</p>
    <div class="row" style="gap:18px">
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="thshows"${p.shows ? ' checked' : ''}> Serier</label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="thmovies"${p.movies ? ' checked' : ''}> Filmer</label></div>`;
  const save = act(async () => { await api('/me/theme-music', { method: 'PUT', body: { shows: $('#thshows', box).checked, movies: $('#thmovies', box).checked }, bg: true }); });
  $('#thshows', box).onchange = save; $('#thmovies', box).onchange = save;
}
