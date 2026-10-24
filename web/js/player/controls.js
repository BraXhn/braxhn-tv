// Videospelarens kontroller och kortkommandon
import { $, fmtTime, store } from '../core.js';
import { setMini } from './overlay.js';
import { P, closePlayer } from './video.js';
import { setIconButton } from '../ui/buttons.js';
import { preKey } from './cinema.js';

/** Spelarens egna kontroller (raden längst ner): spela/pausa, hopp, kapitel/nästa, tid, volym och helskärm */
export function bindControls(cur, v) {
  const { el, it } = cur, q = (s) => $(s, el);
  const chaps = it.chapters || [];
  const dur = () => cur.it.duration || (isFinite(v.duration) ? v.duration : 0);
  const playBtn = q('#cplay'), muteBtn = q('#cmute'), vol = q('#cvol'), ct = q('#ctime');
  const sync = () => { setIconButton(playBtn, v.paused ? 'play' : 'pause', v.paused ? 'Spela (mellanslag)' : 'Pausa (mellanslag)'); el.classList.toggle('paused', v.paused); };
  const syncVol = () => { const off = v.muted || v.volume === 0; setIconButton(muteBtn, off ? 'mute' : 'vol', off ? 'Slå på ljudet (m)' : 'Stäng av ljudet (m)'); vol.value = v.muted ? 0 : v.volume; };
  v.volume = +store.get('pvol', 1); syncVol();
  ['play', 'pause', 'playing'].forEach(ev => v.addEventListener(ev, sync)); sync();
  v.addEventListener('volumechange', syncVol);
  v.addEventListener('timeupdate', () => { ct.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(dur())}`; });
  // Visa att något händer medan servern startar en omkodning (kan ta en stund för stora filer)
  const loading = () => { if (v.readyState < 3) ct.textContent = cur.pb?.mode === 'transcode' ? 'Startar omkodning…' : 'Laddar…'; };
  v.addEventListener('waiting', loading); v.addEventListener('loadstart', loading);
  v.addEventListener('progress', () => { const d = dur(); if (d && v.buffered.length) q('#tbuf').style.width = Math.min(100, v.buffered.end(v.buffered.length - 1) / d * 100) + '%'; });
  const toggle = () => v.paused ? v.play().catch(() => {}) : v.pause();
  playBtn.onclick = toggle;
  // Pekskärm: första trycket när kontrollerna är dolda visar dem i stället för att pausa
  el.addEventListener('touchstart', () => { cur.tapWake = el.classList.contains('idle'); }, { passive: true });
  v.onclick = () => { if (cur.tapWake) { cur.tapWake = false; return; } if (cur.mini) return setMini(false); if (!q('#setp').hidden || !q('#chlist').hidden) { q('#setp').hidden = true; q('#chlist').hidden = true; return; } toggle(); };
  const full = () => {
    if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
    if (!el.requestFullscreen) {
      // iPhone: bara videon kan bli helskärm, och då syns inga bildundertexter ovanpå. Med PGS fyller spelaren
      // i stället skärmen själv (vrid telefonen för liggande bild).
      if (cur.pgs) { el.classList.toggle('pfull'); return; }
      return v.webkitEnterFullscreen?.();
    }
    // Telefon: vrid till liggande när det går (Android); ignoreras annars
    el.requestFullscreen().then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
  };
  v.ondblclick = full; q('#cfull').onclick = full;
  q('#cback').onclick = () => { v.currentTime = Math.max(0, v.currentTime - 10); };
  q('#cfwd').onclick = () => { v.currentTime = Math.min(dur() || Infinity, v.currentTime + 30); };
  q('#cprev').onclick = () => {
    // Föregående kapitel (eller början av det aktuella om man just passerat starten), annars till början
    const c = chaps.filter(x => x.start < v.currentTime - 3).pop();
    v.currentTime = c ? c.start + 0.05 : 0;
  };
  if (q('#cnextch')) q('#cnextch').onclick = () => { const c = chaps.find(x => x.start > v.currentTime + 1); if (c) v.currentTime = c.start + 0.05; };
  q('#cstop').onclick = () => closePlayer();
  q('#cmini').onclick = () => setMini(!cur.mini);
  q('#cset').onclick = (e) => { e.stopPropagation(); q('#chlist').hidden = true; q('#setp').hidden = !q('#setp').hidden; };
  muteBtn.onclick = () => { v.muted = !v.muted; if (!v.muted && v.volume === 0) v.volume = 0.5; };
  vol.oninput = () => { v.volume = +vol.value; v.muted = v.volume === 0; store.set('pvol', v.volume); };
}

export function keys(e) {
  // I litet fönster tar spelaren inte över tangentbordet (man bläddrar och söker)
  if (!P || P.mini || e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || document.querySelector('dialog[open]')) return;
  const v = $('#vid', P.el); if (!v) return;
  if (P.pre && preKey(e, P)) return; // trailers före filmen spelas
  // Mellanslag/Enter på en fokuserad knapp eller länk (t.ex. "Hoppa över intro") ska aktivera den, inte pausa
  if ((e.key === ' ' || e.key === 'Enter') && e.target !== v && e.target.closest?.('button,a,textarea,[contenteditable]')) return;
  if (e.key.startsWith('Arrow') && moveFocus(e)) return;
  if (e.key === 'Escape' && (!$('#setp', P.el).hidden || !$('#chlist', P.el).hidden)) {
    // Stäng inställningar/kapitel först och lämna fokus på knappen som öppnade dem
    const ch = !$('#chlist', P.el).hidden;
    $('#setp', P.el).hidden = true; $('#chlist', P.el).hidden = true;
    $(ch ? '#pchap' : '#cset', P.el)?.focus();
  }
  else if (e.key === 'Escape' && !document.fullscreenElement) setMini(true);
  else if (e.key === ' ' || e.key === 'k') { e.preventDefault(); v.paused ? v.play().catch(() => {}) : v.pause(); }
  else if (e.key === 'ArrowRight' || e.key === 'l') v.currentTime += 10;
  else if (e.key === 'ArrowLeft' || e.key === 'j') v.currentTime -= 10;
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    v.volume = Math.max(0, Math.min(1, Math.round((v.volume + (e.key === 'ArrowUp' ? 0.1 : -0.1)) * 10) / 10)); v.muted = v.volume === 0;
    store.set('pvol', v.volume);
  }
  // 0–9: hoppa till 0 %, 10 % … 90 % av filmen (som YouTube)
  else if (/^[0-9]$/.test(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey && isFinite(v.duration)) v.currentTime = v.duration * (+e.key / 10);
  else if (e.key === 's' && !$('#pskip', P.el).hidden) $('#pskip', P.el).click();
  else if (e.key === 'f') document.fullscreenElement ? document.exitFullscreen() : P.el.requestFullscreen?.();
  else if (e.key === 'm') v.muted = !v.muted;
}

// Fjärrkontroll och tangentbord: när en knapp i spelaren har synligt fokus flyttar pilarna fokus mellan knapparna
// (vänster/höger i kontrollraden, upp/ner i kapitellistan och inställningarna) i stället för att spola.
// Efter ett musklick är fokus inte synligt, och då spolar pilarna som vanligt.
function moveFocus(e) {
  const t = e.target;
  if (!t?.matches || !t.matches(':focus-visible')) return false;
  const box = t.closest('#chlist,#setp,.crow,.pbar'); if (!box) return false;
  const list = box.matches('#chlist,#setp');
  const fwd = list ? e.key === 'ArrowDown' : e.key === 'ArrowRight', back = list ? e.key === 'ArrowUp' : e.key === 'ArrowLeft';
  if (!fwd && !back) {
    // Upp från kontrollraden: till "Hoppa över" om den syns
    const sk = $('#pskip', P.el);
    if (box.matches('.crow') && e.key === 'ArrowUp' && sk && !sk.hidden) { e.preventDefault(); sk.focus(); return true; }
    return false;
  }
  const items = [...box.querySelectorAll('button,select,input,summary')].filter(x => !x.disabled && x.offsetParent !== null);
  const i = items.indexOf(t);
  const n = items[i + (fwd ? 1 : -1)];
  e.preventDefault();
  n?.focus();
  return true;
}
