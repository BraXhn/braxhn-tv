// Tittarkomfort i videospelaren: nattläge och tydligare dialog, undertextens utseende och förhandsbilder
// ur spolningsbilderna (kapitellistan). Valen sparas per användare i webbläsaren.
import { me, store, t } from '../core.js';

const ukey = (k) => `${k}.${me?.id ?? ''}`;

// ---------------- undertextens utseende ----------------
// Allt som FCC (47 CFR 79.103) och WCAG räknar upp för undertexter: storlek, typsnitt, textfärg, bakgrund (färg
// och täckning), kantlinje och placering. Äldre sparade val (bg = outline/box/none) översätts i subStyle().
export const SUB_SIZES = { s: [t('Liten'), 0.75], m: [t('Mellan'), 1], l: [t('Stor'), 1.3], xl: [t('Mycket stor'), 1.65], xxl: [t('Störst'), 2] };
export const SUB_COLORS = { white: [t('Vit'), '#ffffff'], yellow: [t('Gul'), '#ffe14d'], cyan: ['Cyan', '#5ff4ff'], green: [t('Grön'), '#6dff7a'],
  magenta: ['Magenta', '#ff7dff'], red: [t('Röd'), '#ff6b6b'], blue: [t('Blå'), '#8fb4ff'], black: [t('Svart'), '#000000'] };
export const SUB_FONTS = { sans: [t('Standard (utan seriffer)'), 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif'], serif: [t('Med seriffer'), 'Georgia,"Times New Roman",serif'],
  mono: [t('Jämnbred'), 'ui-monospace,Menlo,Consolas,monospace'], casual: [t('Handskriven'), '"Comic Sans MS","Comic Neue",cursive'],
  caps: [t('Kapitäler'), 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif'] };
export const SUB_BGS = { none: t('Ingen'), semi: t('Halvgenomskinlig ruta'), solid: t('Täckande ruta') };
export const SUB_BGCOLORS = { black: [t('Svart'), '0,0,0'], gray: [t('Grå'), '60,60,60'], white: [t('Vit'), '255,255,255'], blue: [t('Blå'), '10,30,110'] };
export const SUB_EDGES = { outline: t('Kantlinje'), shadow: t('Skugga'), raised: t('Upphöjd'), depressed: t('Nedsänkt'), none: t('Ingen') };
export const SUB_POS = { 0: t('Längst ner'), 6: t('Lite högre'), 12: t('Högre'), 24: t('Mitt på') };
const SHADOW = { outline: '0 0 .08em #000,0 0 .08em #000,.04em .04em .1em #000,-.04em -.04em .1em #000,.04em -.04em .1em #000,-.04em .04em .1em #000',
  shadow: '.06em .06em .12em rgba(0,0,0,.95)', raised: '-.04em -.04em 0 #fff8,.05em .05em 0 #000', depressed: '.04em .04em 0 #fff8,-.05em -.05em 0 #000', none: 'none' };
// Standard för TV-avstånd: mellanstorlek (ca 5 % av bildhöjden), vit text med kantlinje
const SUB_DEF = { size: 'm', color: 'white', font: 'sans', bg: 'none', bgcolor: 'black', edge: 'outline', pos: '0' };
const OLD_BG = { outline: { bg: 'none', edge: 'outline' }, box: { bg: 'semi', edge: 'none' } };

export function subStyle() {
  const saved = store.get(ukey('substyle'), null) || {};
  const s = { ...SUB_DEF, ...saved };
  if (OLD_BG[saved.bg]) Object.assign(s, OLD_BG[saved.bg]);
  else if (saved.bg === 'none' && !saved.edge) s.edge = 'shadow';
  for (const [k, list] of [['size', SUB_SIZES], ['color', SUB_COLORS], ['font', SUB_FONTS], ['bg', SUB_BGS], ['bgcolor', SUB_BGCOLORS], ['edge', SUB_EDGES]])
    if (!list[s[k]]) s[k] = SUB_DEF[k];
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
  el.style.setProperty('--subcolor', SUB_COLORS[s.color][1]);
  el.style.setProperty('--subfont', SUB_FONTS[s.font][1]);
  el.style.setProperty('--subbg', s.bg === 'none' ? 'transparent' : `rgba(${SUB_BGCOLORS[s.bgcolor][1]},${s.bg === 'solid' ? 1 : 0.62})`);
  el.style.setProperty('--subshadow', SHADOW[s.edge]);
  el.dataset.subcolor = s.color; el.dataset.subbg = s.bg; el.dataset.subsize = s.size; el.dataset.subedge = s.edge; el.dataset.subfont = s.font;
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
  return sel('size', t('Textstorlek'), SUB_SIZES, s.size) + sel('font', t('Typsnitt'), SUB_FONTS, s.font) + sel('color', t('Textfärg'), SUB_COLORS, s.color) +
    sel('edge', t('Kantlinje'), SUB_EDGES, s.edge) + sel('bg', t('Bakgrund'), SUB_BGS, s.bg) + sel('bgcolor', t('Bakgrundsfärg'), SUB_BGCOLORS, s.bgcolor) +
    sel('pos', t('Placering'), SUB_POS, s.pos);
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
