// Skärmtiden i videospelaren: "12 min kvar idag" i spelarens överkant och en varning de sista minuterna, som syns
// även när kontrollerna är dolda. Bara för profiler med skärmtid och en gräns idag (minuter per dag eller en sluttid).
// Statusen kommer med varje framstegsrapport (video.js sendProgress) och från menyradens märke (screentime.js).
// playerLeft är en ren funktion (testas i test/screentime-follows.test.js).
import { $, esc, t } from '../core.js';

/** Sekunder kvar när varningen visas */
export const WARN_LEFT = 5 * 60;

/** Vad spelaren visar: null (ingen skärmtid, ingen gräns idag eller redan slut) eller { min, warn } */
export function playerLeft(s) {
  if (!s?.limited || !s.allowed || s.left == null || !Number.isFinite(+s.left)) return null;
  const left = Math.max(0, +s.left);
  return { min: Math.max(1, Math.ceil(left / 60)), warn: left <= WARN_LEFT };
}
const fmt = (m) => m >= 60 ? t('{v} h {v2} min', { v: Math.floor(m / 60), v2: m % 60 }) : `${m} min`;

/** Ritar skärmtiden i spelaren el (pbar: #pstleft, varningen: #pstwarn) */
export function showScreenLeft(el, s) {
  const p = playerLeft(s);
  const pill = el && $('#pstleft', el), warn = el && $('#pstwarn', el);
  if (pill) {
    pill.hidden = !p;
    if (p) {
      // Telefon: kort text (CSS visar en av dem)
      const long = t('{left} kvar idag', { left: fmt(p.min) });
      pill.innerHTML = `<span class="stl">${esc(long)}</span><span class="sts">${esc(t('⏱ {left} kvar', { left: fmt(p.min) }))}</span>`;
      pill.title = long;
      pill.classList.toggle('low', p.warn);
    }
  }
  if (warn) {
    const txt = p?.warn ? t('Skärmtiden tar slut om {v} min', { v: p.min }) : '';
    // Texten byts bara när minuten ändras (role=status läser upp varje ändring)
    if (warn.textContent !== txt) warn.textContent = txt;
    warn.hidden = !txt;
  }
}
