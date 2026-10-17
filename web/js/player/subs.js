// Undertexter i videospelaren, inklusive bildundertexter (PGS)
import { $, $$, esc, toast } from '../core.js';
import { P } from './video.js';

export function setSubs() {
  if (!P) return;
  const el = P.el, v = $('#vid', el); if (!v) return;
  $$('track', v).forEach(t => t.remove());
  // Andra undertext (t.ex. för språkinlärning): laddas dold och ritas överst i bilden
  const s2 = P.sub2 && P.sub2 !== P.sub ? P.pb?.subtitles.find(s => s.id === P.sub2) : null;
  const box2 = $('#sub2', el);
  box2.innerHTML = '';
  if (s2) {
    const t2 = document.createElement('track');
    Object.assign(t2, { kind: 'metadata', src: s2.url, label: 'sub2', srclang: s2.lang || 'und' });
    v.append(t2);
    const on = () => { t2.track.mode = 'hidden'; t2.track.oncuechange = () => {
      const txt = [...(t2.track.activeCues || [])].map(c => c.text.replace(/<[^>]+>/g, '')).join('\n');
      box2.innerHTML = txt ? `<span>${esc(txt)}</span>` : '';
    }; };
    t2.addEventListener('load', on); setTimeout(on, 50);
  }
  const img = P.pb?.imageSubs?.find(s => s.id === P.sub);
  pgsShow(img);
  const sub = P.pb?.subtitles.find(s => s.id === P.sub) || img;
  $('#poff', el).hidden = !sub;
  if (!sub && !s2) return;
  $('#poffv', el).textContent = (P.offset > 0 ? '+' : '') + P.offset.toFixed(1).replace('.', ',') + ' s';
  if (!sub || img) return;
  const t = document.createElement('track');
  const url = sub.url + (sub.url.includes('?') ? '&' : '?') + (P.offset ? 'offset=' + P.offset : '');
  Object.assign(t, { kind: 'subtitles', src: url, default: true, label: sub.label, srclang: sub.lang || 'und' });
  v.append(t);
  t.addEventListener('load', () => { t.track.mode = 'showing'; });
  setTimeout(() => { if (t.track) t.track.mode = 'showing'; }, 50);
}

// ---------------- bildundertexter (PGS) ----------------
// Servern tolkar Blu-ray-undertexten till bilder med tider; spelaren lägger rätt bild över videon.
// Medan servern fortfarande läser filen hämtas listan igen var 5:e sekund.
// iPhone saknar helskärm för element – där ger helskärmsknappen en egen helskärm i sidan så att bilderna syns.
export const subBurns = (x) => !!x?.bitmap && !x.pgs;
export function pgsStop(cur) {
  if (!cur?.pgs) return;
  const v = $('#vid', cur.el), g = cur.pgs;
  clearTimeout(g.timer);
  v?.removeEventListener('timeupdate', g.draw); v?.removeEventListener('seeked', g.draw); window.removeEventListener('resize', g.draw);
  const box = $('#pgs', cur.el); if (box) box.innerHTML = '';
  cur.pgs = null;
}
function pgsShow(sub) {
  const cur = P; if (!cur) return;
  const v = $('#vid', cur.el), box = $('#pgs', cur.el);
  // Samma spår (t.ex. ändrad förskjutning): rita om utan att hämta listan igen
  if (sub && cur.pgs?.sub.url === sub.url) { cur.pgs.shown = null; cur.pgs.draw(); return; }
  pgsStop(cur);
  if (!sub) return;
  const g = cur.pgs = { sub, data: null, shown: null, timer: null };
  const live = () => P === cur && cur.pgs === g;
  const base = sub.url.split('?')[0], qs = sub.url.includes('?') ? '?' + sub.url.split('?')[1] : '';
  const imgUrl = (n) => `${base}/${n}.png${qs}`;
  const find = (t) => {
    const c = g.data?.cues; if (!c?.length) return -1;
    let lo = 0, hi = c.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[m].s <= t) lo = m; else hi = m - 1; }
    const x = c[lo];
    return x.s <= t && t < (x.e ?? x.s + 5) ? lo : -1;
  };
  g.draw = () => {
    if (!live() || !g.data) return;
    const k = find(v.currentTime - (cur.offset || 0));
    // Bildens yta i elementet (videon skalas in med svarta kanter)
    const W = g.data.w || v.videoWidth, H = g.data.h || v.videoHeight;
    const key = `${k}:${v.clientWidth}x${v.clientHeight}:${v.videoWidth}x${v.videoHeight}`;
    if (key === g.shown) return;
    g.shown = key;
    if (k < 0 || !W || !H) { box.innerHTML = ''; return; }
    const ar = (v.videoWidth && v.videoHeight) ? v.videoWidth / v.videoHeight : W / H;
    let dw = v.clientWidth, dh = dw / ar;
    if (dh > v.clientHeight) { dh = v.clientHeight; dw = dh * ar; }
    // Likformig skala; PGS-ytan centreras på bilden. En beskuren film (1920×800 med undertext för 1920×1080)
    // får då texten i den svarta kanten som på en TV, i stället för att bilderna trycks ihop på höjden.
    // Beskuren på höjden (bredare bild) => skala efter bredden, annars efter höjden. Bilder utanför elementet flyttas in.
    const sc = W / H <= ar + 0.01 ? dw / W : dh / H;
    const ox = (v.clientWidth - W * sc) / 2, oy = (v.clientHeight - H * sc) / 2;
    const clamp = (a, lo, hi) => Math.max(lo, Math.min(a, hi));
    box.innerHTML = g.data.cues[k].i.map(([x, y, w, h, n]) =>
      `<img alt="" src="${esc(imgUrl(n))}" style="left:${clamp(ox + x * sc, 0, v.clientWidth - w * sc).toFixed(1)}px;top:${clamp(oy + y * sc, 0, v.clientHeight - h * sc).toFixed(1)}px;width:${(w * sc).toFixed(1)}px;height:${(h * sc).toFixed(1)}px">`).join('');
    // Hämta de närmaste bilderna i förväg
    for (const c of g.data.cues.slice(k + 1, k + 3)) for (const it of c.i) new Image().src = imgUrl(it[4]);
  };
  v.addEventListener('timeupdate', g.draw); v.addEventListener('seeked', g.draw); window.addEventListener('resize', g.draw);
  const poll = async () => {
    try {
      const r = await fetch(sub.url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error();
      const d = await r.json();
      if (!live()) return;
      g.data = d; g.shown = null; g.draw();
      if (d.error) toast('Undertexten kunde inte läsas');
      else if (!d.done) g.timer = setTimeout(poll, 5000);
    } catch { if (live()) g.timer = setTimeout(poll, 10000); }
  };
  poll();
}
