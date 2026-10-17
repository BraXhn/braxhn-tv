// Undertexter i videospelaren, inklusive bildundertexter (PGS)
import { $, $$, esc, toast } from '../core.js';
import { P } from './video.js';

export function setSubs() {
  if (!P) return;
  const el = P.el, v = $('#vid', el); if (!v) return;
  $$('track', v).forEach(t => t.remove());
  textStop(P);
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
  textShow(sub);
}

// Textundertext: hämtas av spelaren själv (live=1) så att den syns direkt även om servern ännu inte läst hela
// spåret – då hämtas den igen med några sekunders mellanrum (och direkt efter spolning) tills allt är läst.
export function textStop(cur) {
  const g = cur?.txt; if (!g) return;
  clearTimeout(g.timer);
  $('#vid', cur.el)?.removeEventListener('seeked', g.seek);
  if (g.blob) URL.revokeObjectURL(g.blob);
  cur.txt = null;
}
function textShow(sub) {
  const cur = P; if (!cur) return;
  textStop(cur);
  const v = $('#vid', cur.el);
  const g = cur.txt = { sub, timer: null, blob: null, done: false };
  const live = () => P === cur && cur.txt === g;
  const base = sub.url + (sub.url.includes('?') ? '&' : '?') + (cur.offset ? 'offset=' + cur.offset + '&' : '') + 'live=1';
  const load = async () => {
    clearTimeout(g.timer);
    let text, done;
    try {
      const r = await fetch(base + '&pos=' + Math.floor(v.currentTime || 0), { credentials: 'same-origin' });
      if (!r.ok) throw new Error();
      text = await r.text(); done = r.headers.get('X-Undertext-Klar') !== '0';
    } catch { if (live()) g.timer = setTimeout(load, 10000); return; }
    if (!live()) return;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
    const old = [...$$('track', v)].filter(t => t.kind === 'subtitles'), oldBlob = g.blob;
    const t = document.createElement('track');
    Object.assign(t, { kind: 'subtitles', src: url, default: true, label: sub.label, srclang: sub.lang || 'und' });
    v.append(t); g.blob = url;
    const show = () => {
      if (!live()) return;
      t.track.mode = 'showing';
      // Det gamla spåret tas bort först när det nya är laddat (annars blinkar texten bort)
      old.forEach(o => { if (o.track) o.track.mode = 'disabled'; o.remove(); });
      if (oldBlob) URL.revokeObjectURL(oldBlob);
    };
    t.addEventListener('load', show); setTimeout(() => t.track && t.track.mode !== 'showing' && show(), 300);
    g.done = done;
    if (!done) g.timer = setTimeout(load, /-->/.test(text) ? 4000 : 1000);
  };
  g.seek = () => { if (!g.done) load(); };
  v.addEventListener('seeked', g.seek);
  load();
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
  v?.removeEventListener('timeupdate', g.draw); v?.removeEventListener('seeked', g.draw); v?.removeEventListener('seeked', g.seek); window.removeEventListener('resize', g.draw);
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
  // pos: servern läser spåret där tittaren är först (en stor fil tar annars minuter att läsa)
  const poll = async () => {
    clearTimeout(g.timer);
    try {
      const r = await fetch(sub.url + (sub.url.includes('?') ? '&' : '?') + 'pos=' + Math.floor(v.currentTime || 0), { credentials: 'same-origin' });
      if (!r.ok) throw new Error();
      const d = await r.json();
      if (!live()) return;
      g.data = d; g.shown = null; g.draw();
      if (d.error) toast('Undertexten kunde inte läsas');
      else if (!d.done) g.timer = setTimeout(poll, 3000);
    } catch { if (live()) g.timer = setTimeout(poll, 10000); }
  };
  g.seek = () => { if (g.data && !g.data.done) poll(); };
  v.addEventListener('seeked', g.seek);
  poll();
}
