// Språkinlärningsläget i videospelaren (som Language Reactor, men inbyggt och lokalt). Laddas först när läget slås
// på under ⚙ (need() från video.js). Målspråket är den valda undertexten (#ps), översättningen den andra
// undertexten (#ps2): repliken i den andra undertexten som överlappar mest i tid – ingen extern tjänst.
//   - orden i repliken är knappar: klick/tryck (eller w, ←/→ och Enter) sparar ordet med meningen, översättningen,
//     tidpunkten och titeln i profilens ordlista (/api/vocab, server/vocab.js; vyn #/vocab)
//   - paus efter varje replik (valbart, p), upprepa repliken (r), långsamt med bibehållen tonhöjd (x),
//     föregående/nästa replik (a/d)
// Tiderna kommer från spelarens egna textspår (subs.js) – servern har redan lagt på undertextsynken och förskjutningen.
import { $, $$, api, store, t, toast, toastErr } from '../core.js';
import { P } from './video.js';
import { say } from './controls.js';
import { setMini } from './overlay.js';
import { iconButton } from '../ui/buttons.js';
import { measureCtl } from './comfort.js';

export const SLOW = 0.75;
const WORD = /([\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*)/u;
const plain = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
const cuesOf = (track) => track?.cues ? [...track.cues].map(c => ({ s: c.startTime, e: c.endTime, text: plain(c.text) })).filter(c => c.text).sort((a, b) => a.s - b.s) : [];
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

/** Översättningen till en replik: de andra undertextens repliker som överlappar den (mest överlapp först i tid) */
export function translationOf(cue, other) {
  if (!cue || !other?.length) return '';
  const len = Math.max(0.2, cue.e - cue.s);
  const hit = other.filter(o => Math.min(o.e, cue.e) - Math.max(o.s, cue.s) > Math.min(0.25 * len, 0.3 * Math.max(0.2, o.e - o.s)));
  if (hit.length) return oneLine(hit.map(o => o.text).join(' '));
  // Ingen överlappar ordentligt: närmaste repliken inom en sekund
  const near = other.map(o => ({ o, d: Math.abs((o.s + o.e) / 2 - (cue.s + cue.e) / 2) })).sort((a, b) => a.d - b.d)[0];
  return near && near.d < len / 2 + 1 ? oneLine(near.o.text) : '';
}
/** Index för repliken vid tiden t: { i (sista repliken som börjat, -1 = ingen), inside } */
export function at(cues, time) {
  let lo = 0, hi = cues.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cues[m].s <= time + 0.001) { i = m; lo = m + 1; } else hi = m - 1; }
  return { i, inside: i >= 0 && time < cues[i].e };
}

/** Slår på läget för spelaren cur (anropas från video.js) */
export function startLearn(cur) {
  if (!cur || cur.learn) return;
  const el = cur.el, v = $('#vid', el), bar = $('#plearnbar', el);
  const L = cur.learn = { auto: !!store.get('learn.auto', true), stopAt: null, pausedFor: -1, rate: null, saved: new Set(), raf: 0, focus: -1 };
  const live = () => P === cur && cur.learn === L;
  const main = () => cuesOf(cur.txt?.track), other = () => cuesOf(cur.sub2track);
  const restoreRate = () => { if (L.rate != null) { v.playbackRate = L.rate; L.rate = null; } };
  const seekTo = (c, i, { stop = false, slow = false } = {}) => {
    restoreRate();
    L.pausedFor = -1; L.stopAt = stop ? { e: c.e, i } : null;
    if (slow) { L.rate = v.playbackRate; v.preservesPitch = true; v.webkitPreservesPitch = true; v.playbackRate = SLOW; }
    v.currentTime = c.s + 0.01;
    if (v.paused) v.play().catch(() => {});
  };
  const none = () => { say(el, t('Ingen replik att gå till')); return true; };
  L.prev = () => { const c = main(), p = at(c, v.currentTime); const k = p.inside ? p.i - 1 : p.i; return k >= 0 ? (seekTo(c[k], k), say(el, t('Föregående replik')), true) : none(); };
  L.next = () => { const c = main(), k = c.findIndex(x => x.s > v.currentTime + 0.05); return k >= 0 ? (seekTo(c[k], k), say(el, t('Nästa replik')), true) : none(); };
  L.repeat = (slow = false) => {
    const c = main(), p = at(c, v.currentTime), k = Math.max(0, p.i);
    if (!c[k]) return none();
    seekTo(c[k], k, { stop: true, slow });
    say(el, slow ? t('Upprepar repliken långsamt') : t('Upprepar repliken'));
    return true;
  };
  L.setAuto = (on) => {
    L.auto = on; store.set('learn.auto', on);
    const b = $('#lauto', el); if (b) b.setAttribute('aria-pressed', String(on));
    say(el, on ? t('Pausar efter varje replik') : t('Pausar inte efter replikerna'));
  };
  L.words = () => {
    const ws = $$('#subtxt .lw', el);
    if (!ws.length) return none();
    v.pause(); ws[0].focus(); return true;
  };
  // Kortkommandon (controls.js keys() frågar först här). true = hanterat.
  L.key = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return false;
    const w = e.target?.closest?.('.lw');
    if (w && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const ws = $$('#subtxt .lw', el), i = ws.indexOf(w);
      ws[Math.max(0, Math.min(ws.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))]?.focus();
      e.preventDefault(); return true;
    }
    if (w && e.key === 'Escape') { e.preventDefault(); $('#cplay', el)?.focus(); return true; }
    const fn = { a: L.prev, d: L.next, r: () => L.repeat(false), x: () => L.repeat(true), p: () => (L.setAuto(!L.auto), true), w: L.words }[e.key];
    if (!fn) return false;
    e.preventDefault(); fn(); return true;
  };
  // Klickbara ord: subs.js ritar varje replik med fill() och lägger till översättningen med after()
  L.fill = (span, cue) => {
    const text = plain(cue.text), parts = text.split(WORD);
    const c = { s: cue.startTime, e: cue.endTime, text };
    parts.forEach((p, i) => {
      if (!p) return;
      if (i % 2 === 0) { span.append(document.createTextNode(p)); return; }
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'lw' + (L.saved.has(p.toLowerCase()) ? ' saved' : ''); b.tabIndex = -1; b.textContent = p;
      b.title = t('Spara i ordlistan');
      b.onclick = (ev) => { ev.stopPropagation(); save(b, p, c); };
      b.onfocus = () => { L.focus = $$('#subtxt .lw', el).indexOf(b); };
      b.onblur = (ev) => { if (!ev.relatedTarget?.closest?.('.lw')) L.focus = -1; };
      span.append(b);
    });
  };
  L.after = (box, cues) => {
    if (cues.length && cur.sub2track) {
      const c = cues[0], tr = translationOf({ s: c.startTime, e: c.endTime, text: '' }, other());
      if (tr) { const d = document.createElement('div'), s = document.createElement('span'); d.className = 'ltr'; s.textContent = tr; d.append(s); box.append(d); }
    }
    if (L.focus >= 0) $$('.lw', box)[L.focus]?.focus({ preventScroll: true });
  };
  async function save(b, word, c) {
    if (!v.paused) v.pause();
    const sub = cur.pb?.subtitles?.find(s => s.id === cur.sub) || cur.it.subtitles.find(s => s.id === cur.sub);
    const body = { itemId: cur.it.id, word, sentence: oneLine(c.text), translation: translationOf(c, other()), start: c.s, end: c.e,
      position: v.currentTime, lang: sub?.lang || null, audio: /^\d+$/.test(cur.audio || '') ? +cur.audio : null };
    try {
      const r = await api('/vocab', { method: 'POST', body, bg: true });
      L.saved.add(word.toLowerCase());
      $$('#subtxt .lw', el).filter(x => x.textContent.toLowerCase() === word.toLowerCase()).forEach(x => x.classList.add('saved'));
      if (r.dup) toast(t('”{word}” finns redan i ordlistan', { word }));
      else toast(t('”{word}” sparat i ordlistan', { word }), { action: { label: t('Ångra'), onClick: () => api('/vocab/' + r.id, { method: 'DELETE', bg: true })
        .then(() => { L.saved.delete(word.toLowerCase()); $$('#subtxt .lw.saved', el).filter(x => x.textContent.toLowerCase() === word.toLowerCase()).forEach(x => x.classList.remove('saved')); }).catch(toastErr) } });
    } catch (e) { toastErr(e); }
  }
  // Paus efter repliken och slutet av en upprepning: kontrolleras varje bildruta medan filmen spelas
  const tick = () => {
    if (!live()) return;
    L.raf = requestAnimationFrame(tick);
    if (v.paused || v.seeking) return;
    const time = v.currentTime;
    if (L.stopAt) {
      if (time >= L.stopAt.e - 0.1) { v.pause(); restoreRate(); L.pausedFor = L.stopAt.i; L.stopAt = null; }
      return;
    }
    if (!L.auto) return;
    const c = main(), p = at(c, time);
    if (p.inside && p.i !== L.pausedFor && time >= c[p.i].e - 0.12) {
      // Efter spelarens eget "Pausad" (controls.js säger det vid pause-händelsen)
      v.addEventListener('pause', () => say(el, t('Pausad efter repliken')), { once: true });
      v.pause(); L.pausedFor = p.i;
    }
  };
  L.raf = requestAnimationFrame(tick);
  // Spolning bakåt i samma replik: pausa vid dess slut igen
  L.onSeek = () => { if (L.pausedFor >= 0) { const c = main()[L.pausedFor]; if (!c || v.currentTime < c.e - 0.3) L.pausedFor = -1; } if (!L.stopAt) restoreRate(); };
  v.addEventListener('seeking', L.onSeek);
  // Verktygsraden ovanför kontrollerna
  bar.innerHTML = iconButton({ icon: '⏮', label: t('Föregående replik'), title: t('Föregående replik (a)'), id: 'lprev' })
    + iconButton({ icon: '↻', label: t('Upprepa repliken'), title: t('Upprepa repliken (r)'), id: 'lrep' })
    + iconButton({ icon: '🐢', label: t('Upprepa långsamt'), title: t('Upprepa långsamt (x)'), id: 'lslow' })
    + iconButton({ icon: '⏭', label: t('Nästa replik'), title: t('Nästa replik (d)'), id: 'lnext' })
    + iconButton({ icon: '⏸', label: t('Pausa efter varje replik'), title: t('Pausa efter varje replik (p)'), id: 'lauto', pressed: L.auto })
    + iconButton({ icon: 'Aa', label: t('Välj ord'), title: t('Välj ord att spara (w)'), id: 'lword' })
    + `<button type="button" class="ghost small" id="lvocab">${t('Ordlista')}</button><span class="lhint small" id="lhint"></span>`;
  bar.hidden = false;
  $('#lprev', bar).onclick = () => L.prev(); $('#lnext', bar).onclick = () => L.next();
  $('#lrep', bar).onclick = () => L.repeat(false); $('#lslow', bar).onclick = () => L.repeat(true);
  $('#lauto', bar).onclick = () => L.setAuto(!L.auto); $('#lword', bar).onclick = () => L.words();
  $('#lvocab', bar).onclick = () => { v.pause(); setMini(true); location.hash = '#/vocab'; };
  L.update = () => {
    const h = $('#lhint', bar); if (!h) return;
    const sub = cur.it.subtitles.find(s => s.id === cur.sub);
    h.textContent = !sub || sub.bitmap ? t('Välj en textundertext under ⚙ (målspråket)')
      : !cur.sub2 ? t('Välj en andra undertext under ⚙ för översättningen') : '';
  };
  el.classList.add('learn');
  measureCtl(el); // raden gör kontrollerna högre – undertexten lyfts över dem
  L.update();
  cur.txt?.render?.();
  // Ord som redan finns i ordlistan för titeln markeras
  api('/vocab?item=' + cur.it.id, { bg: true }).then(r => {
    if (!live()) return;
    for (const w of r.words || []) L.saved.add(w.word.toLowerCase());
    cur.txt?.render?.();
  }).catch(() => {});
}

export function stopLearn(cur) {
  const L = cur?.learn; if (!L) return;
  cancelAnimationFrame(L.raf);
  const v = $('#vid', cur.el);
  if (L.rate != null && v) v.playbackRate = L.rate;
  v?.removeEventListener('seeking', L.onSeek);
  cur.learn = null;
  cur.el.classList.remove('learn');
  const bar = $('#plearnbar', cur.el); if (bar) { bar.hidden = true; bar.innerHTML = ''; }
  measureCtl(cur.el);
  cur.txt?.render?.();
}
