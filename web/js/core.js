// Kärnan i webbklienten: DOM-hjälpare, esc(), lagring, inloggningsläge, navigeringsgeneration med later()/onLeave(),
// api(), toast och formatering. Importerar inget – därför säker att använda när andra moduler utvärderas.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const main = $('#main');
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const store = {
  get(k, d) { try { const v = localStorage.getItem('braxhn-tv.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('braxhn-tv.' + k, JSON.stringify(v)); } catch {} }
};
export let me = null, libs = [], status = {};
// Inloggningsläget sätts av router.js (importerade bindningar är skrivskyddade i andra moduler)
export function setLogin(st) { status = st; me = st.user; }
export function setMe(u) { me = u; }
export function setLibs(l) { libs = l; }
// Navigering: varje route() får en ny generation. Anrop och timers från en gammal vy avbryts.
export let routeGen = 0;
export const nextRoute = () => ++routeGen;
export const leaveFns = new Set();
export const onLeave = (fn) => { leaveFns.add(fn); return fn; };
// setTimeout knuten till vyn: körs bara om man är kvar, rensas när man lämnar. Returnerar en avbrytfunktion.
export function later(fn, ms) {
  const g = routeGen;
  const cancel = () => { clearTimeout(t); leaveFns.delete(cancel); };
  const t = setTimeout(() => {
    leaveFns.delete(cancel);
    if (g !== routeGen) return;
    const r = fn();
    if (r && r.catch) r.catch(e => { if (!e?.aborted) console.warn(e); });
  }, ms);
  leaveFns.add(cancel);
  return cancel;
}
const abortErr = () => Object.assign(new Error(''), { aborted: true });
window.addEventListener('unhandledrejection', (e) => { if (e.reason?.aborted) e.preventDefault(); });
// Trasiga bilder tas bort (ersätter inline onerror, som CSP blockerar)
document.addEventListener('error', (e) => { if (e.target?.tagName === 'IMG' && e.target.dataset.fb) e.target.remove(); }, true);

// Sidan man var på när inloggningen gick ut – dit kommer man tillbaka efter ny inloggning
export function rememberPage() {
  try { if (location.hash && !/^#\/(login|profiles)/.test(location.hash)) sessionStorage.setItem('bx_after', location.hash); } catch {}
}
export function pageAfterLogin(fallback = '#/') {
  try { const h = sessionStorage.getItem('bx_after'); sessionStorage.removeItem('bx_after'); return h || fallback; } catch { return fallback; }
}
export async function api(path, opts = {}) {
  // bg: true = anropet hör inte till den aktuella vyn (t.ex. spelaren) och avbryts inte vid navigering
  const { bg, ...rest } = opts;
  const gen = routeGen;
  const o = { headers: {}, ...rest };
  if (o.body && typeof o.body !== 'string' && !(globalThis.Blob && o.body instanceof Blob)) { o.body = JSON.stringify(o.body); o.headers['Content-Type'] = 'application/json'; }
  let r;
  // Förhämtat vid start (start.js) – används en gång, bara för vanliga läsningar och om svaret är färskt
  // Alla skrivningar (inloggning, profilbyte …) gör förhämtningarna ogiltiga: de kan gälla fel profil.
  if (rest.method || o.body) globalThis.__early = null;
  const pre = globalThis.__early?.[path];
  if (pre) {
    delete globalThis.__early[path];
    if (Date.now() - pre.at < 15000) { r = await pre.res; if (!r?.ok) r = null; }
  }
  if (!r) try { r = await fetch('/api' + path, o); }
  catch (e) { if (e?.name === 'AbortError') throw e; throw Object.assign(new Error('Servern svarar inte – kontrollera att BraXhn TV körs'), { offline: true }); }
  const data = r.headers.get('content-type')?.includes('json') ? await r.json().catch(() => null) : await r.text();
  if (r.status === 401 && !path.startsWith('/login')) { me = null; rememberPage(); location.hash = '#/login'; throw new Error('Inte inloggad'); }
  if (!bg && gen !== routeGen) throw abortErr(); // användaren har gått vidare – resultatet ska inte användas
  if (!r.ok) throw Object.assign(new Error(data?.error || `Fel ${r.status}`), { code: data?.code, data });
  return data;
}
// Rader och mappar som bara har onclick: gör dem nåbara med tangentbord och fjärrkontroll (Tab/D-pad + Enter)
export function keyClick(el) {
  el.tabIndex = 0; el.setAttribute('role', 'button');
  el.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); el.click(); } };
  return el;
}
/**
 * Kort meddelande längst ner på skärmen. Läses upp av skärmläsare (role=status, fel med role=alert).
 * @param {string} msg
 * @param {{ error?: boolean, action?: { label: string, onClick: () => void }, ms?: number }} [opts]
 *   action: en knapp i meddelandet, t.ex. { label: 'Ångra', onClick }. Meddelandet står då kvar längre.
 */
export function toast(msg, opts = {}) {
  if (!msg) return;
  const { error = false, action = null, ms } = opts;
  const t = $('#toast');
  clearTimeout(toast.t);
  // Fel läses upp direkt (assertive), annat när skärmläsaren är klar (polite)
  t.setAttribute('role', error ? 'alert' : 'status');
  t.setAttribute('aria-live', error ? 'assertive' : 'polite');
  t.classList.toggle('err', !!error);
  const text = document.createElement('span'); text.textContent = msg;
  t.replaceChildren(text);
  const hide = () => { clearTimeout(toast.t); t.classList.remove('on'); t.inert = true; };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-act'; b.textContent = action.label;
    b.onclick = () => { hide(); action.onClick(); };
    t.append(b);
  }
  t.inert = false;
  t.classList.add('on');
  const wait = ms || (action ? 7000 : error ? 5000 : 3200);
  const arm = () => { clearTimeout(toast.t); toast.t = setTimeout(hide, wait); };
  // Står kvar medan muspekaren eller fokus är på meddelandet (hinner trycka på Ångra)
  t.onmouseenter = t.onfocusin = () => clearTimeout(toast.t);
  t.onmouseleave = t.onfocusout = arm;
  arm();
}
/** Visar ett fel som toast (avbrutna anrop ignoreras) */
export const toastErr = (e) => { if (!e?.aborted) toast(e?.message || String(e), { error: true }); };
// Kör en asynkron händelsehanterare och visar fel som toast (avbrutna anrop ignoreras)
export const act = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toastErr(e); } };
// Profilfärg: bara #hex, rgb()/hsl() släpps in i style-attributet
export const safeColor = (c) => typeof c === 'string' && (/^#[0-9a-f]{3,8}$/i.test(c) || /^(rgb|hsl)a?\([0-9a-z\s.,%/+-]*\)$/i.test(c)) ? c : '';
export const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
};
export const fmtDur = (s) => { if (!s) return ''; const m = Math.max(1, Math.round(s / 60)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
export const fmtSize = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB';
export const resLabel = (h) => !h ? '' : h >= 2000 ? '4K' : h >= 1000 ? '1080p' : h >= 700 ? '720p' : h >= 560 ? '576p' : h + 'p';
export const sxe = (e) => `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;
export function hue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

// ---------- bilder i rätt storlek ----------
// Servern skalar bilder till några fasta bredder (?w=, server/imgsize.js) – över mobilnätet hämtas bara det som syns
export const IMG_W = [160, 240, 320, 480, 720, 1280];
/**
 * Bredden att be om för en bild som visas css pixlar bred: × skärmens pixeltäthet, men högst dprMax (2) –
 * på en telefon med 3× skärm syns ingen skillnad på ett kort, men affischen blir nästan lika stor som originalet.
 */
export function imgW(css, dprMax = 2) {
  const px = css * Math.min(globalThis.devicePixelRatio || 1, dprMax);
  return IMG_W.find(w => w >= px) || IMG_W.at(-1);
}
/** Url med ?w= för en bild som visas css pixlar bred (max = största bredd, källbilden är sällan större) */
export const imgUrl = (url, css, max = 1280, dprMax = 2) => `${url}${url.includes('?') ? '&' : '?'}w=${Math.min(imgW(css, dprMax), max)}`;
/** Bakgrundsbilden överst på titel- och samlingssidor: dämpad bakom en toning, så skärmbredd × högst 1,5 räcker */
export const heroUrl = (url) => imgUrl(url, Math.min(globalThis.innerWidth || 1280, 1920), 1280, 1.5);
/** src-attributet för en bild som visas css pixlar bred */
export const imgSrc = (url, css, max = 720) => `src="${imgUrl(url, css, max)}"`;
/** Bredden på ett runt/fyrkantigt omslag (.cover) i pixlar efter klassen: tiny/small i listor, big överst, annars ett kort */
export const coverPx = (cls = '') => /\btiny\b/.test(cls) ? 38 : /\bsmall\b/.test(cls) ? 52 : /\bbig\b/.test(cls) ? 220 : cardW() * 1.2;
/** <img> i ett omslag (.cover): lazy, i rätt storlek, och tas bort om den inte går att läsa (plattan syns då) */
export const coverImg = (url, cls = '') => `<img loading="lazy" decoding="async" ${imgSrc(url, coverPx(cls))} alt="" width="600" height="600" data-fb="1">`;
let cwCache = 0;
/** Kortbredden just nu (--cw: reglaget för kortstorlek, mindre på telefon) */
export function cardW() {
  // Läses en gång per bildruta (många kort ritas på en gång); utan layout (tester) gäller standardbredden
  if (!cwCache) {
    try { cwCache = parseFloat(getComputedStyle(main || document.documentElement).getPropertyValue('--cw')) || 0; } catch {}
    cwCache ||= 125;
    globalThis.requestAnimationFrame?.(() => { cwCache = 0; });
  }
  return cwCache;
}

// ---------- vyer ----------
export const views = {};
export const fmtDay = (d) => { const t = new Date(d + 'T12:00:00'); return isNaN(t) ? d : t.toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' }); };
export const fmtDate = (t) => t ? new Date(t * 1000).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) : '–';

// ---------- live-TV ----------
export const hhmm = (t) => new Date(t * 1000).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
export const dayName = (t) => { const d = new Date(t * 1000), n = new Date(); const diff = Math.round((new Date(d.toDateString()) - new Date(n.toDateString())) / 864e5);
  return diff === 0 ? 'Idag' : diff === 1 ? 'Imorgon' : d.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'short' }); };
