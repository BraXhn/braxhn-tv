// Tittarkomfort i videospelaren: nattläge och tydligare dialog, undertextens utseende och förhandsbilder
// ur spolningsbilderna (kapitellistan). Valen sparas per användare i webbläsaren.
import { me, store } from '../core.js';

const ukey = (k) => `${k}.${me?.id ?? ''}`;

// ---------------- undertextens utseende ----------------
export const SUB_SIZES = { s: ['Liten', 0.75], m: ['Mellan', 1], l: ['Stor', 1.3], xl: ['Mycket stor', 1.65] };
export const SUB_COLORS = { white: 'Vit', yellow: 'Gul' };
export const SUB_BGS = { outline: 'Kantlinje och skugga', box: 'Halvgenomskinlig ruta', none: 'Ingen' };
export const SUB_POS = { 0: 'Längst ner', 6: 'Lite högre', 12: 'Högre' };
// Standard för TV-avstånd: mellanstorlek (ca 5 % av bildhöjden), vit text med kantlinje
const SUB_DEF = { size: 'm', color: 'white', bg: 'outline', pos: '0' };

export function subStyle() {
  const s = { ...SUB_DEF, ...(store.get(ukey('substyle'), null) || {}) };
  if (!SUB_SIZES[s.size]) s.size = SUB_DEF.size;
  if (!SUB_COLORS[s.color]) s.color = SUB_DEF.color;
  if (!SUB_BGS[s.bg]) s.bg = SUB_DEF.bg;
  s.pos = String(s.pos);
  if (!SUB_POS[s.pos]) s.pos = SUB_DEF.pos;
  return s;
}
export function setSubStyle(patch) { store.set(ukey('substyle'), { ...subStyle(), ...patch }); }
export const subScale = () => SUB_SIZES[subStyle().size][1];

/** Lägger stilen på spelaren (CSS-variabler och data-attribut som style.css läser) */
export function applySubStyle(el) {
  if (!el) return;
  const s = subStyle();
  el.style.setProperty('--subscale', String(SUB_SIZES[s.size][1]));
  el.style.setProperty('--subpos', s.pos + '%');
  el.dataset.subcolor = s.color; el.dataset.subbg = s.bg; el.dataset.subsize = s.size;
  measureCtl(el);
}
// Kontrollradens höjd: undertexten lyfts över den när kontrollerna syns
export function measureCtl(el) {
  const c = el?.querySelector('#ctl');
  if (c && c.offsetHeight) el.style.setProperty('--ctlh', c.offsetHeight + 'px');
}

/** Väljarna för undertextens utseende (spelarens inställningar och Mitt konto) */
export function subStyleFields(prefix = 'pst') {
  const s = subStyle();
  const sel = (id, label, opts, val) => `<label>${label}<select id="${prefix}-${id}" data-substyle="${id}">${Object.entries(opts).map(([k, v]) =>
    `<option value="${k}" ${String(val) === k ? 'selected' : ''}>${Array.isArray(v) ? v[0] : v}</option>`).join('')}</select></label>`;
  return sel('size', 'Textstorlek', SUB_SIZES, s.size) + sel('color', 'Färg', SUB_COLORS, s.color) +
    sel('bg', 'Bakgrund', SUB_BGS, s.bg) + sel('pos', 'Placering', SUB_POS, s.pos);
}
export function bindSubStyleFields(root, onChange) {
  root.querySelectorAll('[data-substyle]').forEach(x => x.addEventListener('change', () => { setSubStyle({ [x.dataset.substyle]: x.value }); onChange?.(); }));
}

// ---------------- nattläge och tydligare dialog ----------------
export const audioFx = () => ({ night: false, dialog: false, ...(store.get(ukey('afx'), null) || {}) });
export const setAudioFx = (patch) => store.set(ukey('afx'), { ...audioFx(), ...patch });
// Safari (och alla webbläsare på iPhone/iPad) ger tystnad när en HLS-ström går genom WebAudio. Där – och om
// WebAudio saknas – gör servern filtreringen i stället (ljudet omkodas, bilden kopieras).
const UA = navigator.userAgent;
export const webAudioFx = !!window.AudioContext && !(/AppleWebKit/.test(UA) && !/Chrome|Chromium|Android|Edg\//.test(UA));
/** Parametrar till /playback när servern ska filtrera (Safari, Chromecast) */
export function serverFxParams(force = false) {
  if (webAudioFx && !force) return {};
  const fx = audioFx(), p = {};
  if (fx.night) p.night = '1';
  if (fx.dialog) p.dialog = '1';
  return p;
}

let ctx = null, waiting = null;
const graphs = new WeakMap();
// createMediaElementSource kan bara göras en gång per element och tar då över ljudutgången. Det görs därför
// först när ett filter faktiskt slås på, och bara när ljudkontexten är igång (den startar först efter ett tryck
// eller en knapptryckning – annars skulle filmen bli tyst).
export function applyAudioFx(v) {
  if (!webAudioFx || !v) return;
  const fx = audioFx(), on = fx.night || fx.dialog;
  const g = graphs.get(v);
  if (!g && !on) return;
  try { if (!ctx) ctx = new AudioContext(); } catch { return; }
  if (ctx.state !== 'running') {
    // Startar kontexten (direkt om sidan redan fått ett tryck), annars vid nästa tryck/tangent
    ctx.resume().then(() => { if (v.isConnected && ctx.state === 'running') applyAudioFx(v); }).catch(() => {});
    if (!waiting) {
      waiting = () => { ['pointerdown', 'keydown'].forEach(e => document.removeEventListener(e, waiting, true)); waiting = null; ctx?.resume().catch(() => {}); };
      ['pointerdown', 'keydown'].forEach(e => document.addEventListener(e, waiting, true));
    }
    if (!g) return;
  }
  let gr = g;
  if (!gr) {
    try { gr = { src: ctx.createMediaElementSource(v), nodes: [] }; } catch { return; }
    graphs.set(v, gr);
  }
  // Koppla om: källa → [dialogfilter] → kompressor → efterförstärkning → begränsare → högtalare
  try { gr.src.disconnect(); } catch {}
  gr.nodes.forEach(n => { try { n.disconnect(); } catch {} });
  gr.nodes = [];
  if (on) {
    if (fx.dialog) {
      // Talets frekvenser (1–4 kHz) lyfts och det mullrande basen sänks lite
      const pk = ctx.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 2000; pk.Q.value = 0.7; pk.gain.value = 6;
      const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 150; lo.gain.value = -4;
      gr.nodes.push(lo, pk);
    }
    const c = ctx.createDynamicsCompressor();
    const set = (p, x) => { c[p].value = x; };
    if (fx.night) { set('threshold', -30); set('knee', 10); set('ratio', 6); set('attack', 0.005); set('release', 0.3); }
    else { set('threshold', -24); set('knee', 12); set('ratio', 3); set('attack', 0.01); set('release', 0.25); }
    const mk = ctx.createGain(); mk.gain.value = fx.night ? 2.2 : 1.4;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -2; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
    gr.nodes.push(c, mk, lim);
  }
  let prev = gr.src;
  for (const n of gr.nodes) { prev.connect(n); prev = n; }
  prev.connect(ctx.destination);
}
export function stopAudioFx(v) {
  const g = v && graphs.get(v); if (!g) return;
  try { g.src.disconnect(); } catch {}
  g.nodes.forEach(n => { try { n.disconnect(); } catch {} });
  graphs.delete(v);
}

// ---------------- förhandsbild för en tidpunkt ----------------
/** Bakgrundsstil för en förhandsbild (sprite-ark från trickplay) i bredden w */
export function thumbStyle(tp, itemId, t, w) {
  if (!tp?.count) return '';
  const i = Math.max(0, Math.min(tp.count - 1, Math.round(t / tp.interval))), per = tp.cols * tp.rows;
  const sheet = Math.floor(i / per) + (tp.first ?? 1), k = i % per, sc = w / tp.w, h = Math.round(tp.h * sc);
  return `width:${w}px;height:${h}px;background-image:url(/api/items/${+itemId}/trickplay/${sheet});` +
    `background-size:${(tp.cols * tp.w * sc).toFixed(1)}px auto;background-position:-${((k % tp.cols) * tp.w * sc).toFixed(1)}px -${(Math.floor(k / tp.cols) * tp.h * sc).toFixed(1)}px`;
}
