// Videospelarens kontroller och kortkommandon
import { $, fmtTime, mediaKey, store, t } from '../core.js';
import { setMini } from './overlay.js';
import { P, closePlayer } from './video.js';
import { setIconButton } from '../ui/buttons.js';
import { preKey } from './cinema.js';
import { move } from '../ui/spatial.js';

/** Spelarens egna kontroller (raden längst ner): spela/pausa, hopp, kapitel/nästa, tid, volym och helskärm */
export function bindControls(cur, v) {
  const { el, it } = cur, q = (s) => $(s, el);
  const chaps = it.chapters || [];
  const dur = () => cur.it.duration || (isFinite(v.duration) ? v.duration : 0);
  const playBtn = q('#cplay'), muteBtn = q('#cmute'), vol = q('#cvol'), ct = q('#ctime');
  const sync = () => { setIconButton(playBtn, v.paused ? 'play' : 'pause', v.paused ? t('Spela (mellanslag)') : t('Pausa (mellanslag)')); el.classList.toggle('paused', v.paused); };
  // Familjefiltret (familyfilter.js) tystar med video.muted – knappen visar användarens eget val
  const userMuted = () => cur.ff?.muted ? cur.ff.user : v.muted;
  const syncVol = () => { const off = userMuted() || v.volume === 0; setIconButton(muteBtn, off ? 'mute' : 'vol', off ? t('Slå på ljudet (m)') : t('Stäng av ljudet (m)')); vol.value = userMuted() ? 0 : v.volume; };
  v.volume = +store.get('pvol', 1); syncVol();
  ['play', 'pause', 'playing'].forEach(ev => v.addEventListener(ev, sync)); sync();
  v.addEventListener('volumechange', syncVol);
  // Tidslinjen är ett reglage för skärmläsare och tangentbord (←/→ via keys(), Home/End, Page Up/Down)
  const scrub = q('#scrub');
  const syncScrub = () => {
    if (!scrub) return;
    const d = Math.round(dur()), pos = Math.min(d || Infinity, Math.round(v.currentTime || 0));
    scrub.setAttribute('aria-valuemax', String(d)); scrub.setAttribute('aria-valuenow', String(pos));
    scrub.setAttribute('aria-valuetext', t('{pos} av {dur}', { pos: fmtTime(pos), dur: fmtTime(d) }));
  };
  v.addEventListener('timeupdate', () => { ct.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(dur())}`; syncScrub(); });
  v.addEventListener('durationchange', syncScrub);
  if (scrub) scrub.addEventListener('keydown', (e) => {
    const d = dur();
    const to = { Home: 0, End: d ? d - 1 : null, PageUp: v.currentTime + 60, PageDown: v.currentTime - 60 }[e.key];
    if (to == null) return;
    e.preventDefault(); e.stopPropagation();
    v.currentTime = Math.max(0, Math.min(d || Infinity, to)); syncScrub();
  });
  // Spelarens läge för skärmläsare (sparsamt: bara paus/spela, laddning som dröjer och ändringar man gjort själv)
  let wait = 0;
  v.addEventListener('waiting', () => { clearTimeout(wait); wait = setTimeout(() => say(el, t('Laddar…')), 1500); });
  v.addEventListener('playing', () => clearTimeout(wait));
  v.addEventListener('pause', () => { if (!v.ended && v.readyState > 1) say(el, t('Pausad')); });
  v.addEventListener('play', () => { if (v.currentTime > 0.5) say(el, t('Spelar')); });
  // Visa att något händer medan servern startar en omkodning (kan ta en stund för stora filer)
  const loading = () => { if (v.readyState < 3) ct.textContent = cur.pb?.mode === 'transcode' ? t('Startar omkodning…') : t('Laddar…'); };
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
  muteBtn.onclick = () => { if (cur.ff?.muted) { cur.ff.user = !cur.ff.user; return syncVol(); } v.muted = !v.muted; if (!v.muted && v.volume === 0) v.volume = 0.5; say(el, v.muted ? t('Ljudet av') : t('Ljudet på')); };
  vol.oninput = () => { v.volume = +vol.value; v.muted = v.volume === 0; store.set('pvol', v.volume); };
  const volText = () => vol.setAttribute('aria-valuetext', v.muted ? t('Ljudet av') : Math.round(v.volume * 100) + ' %');
  v.addEventListener('volumechange', volText); volText();
}

/** Läser upp spelarens läge (role=status i spelaren, töms så att samma text kan sägas igen) */
export function say(el, text) {
  const s = el && $('#pstate', el); if (!s) return;
  s.textContent = ''; setTimeout(() => { s.textContent = text; }, 30);
}

/** Mediaknapparna (tangentbord, fjärrkontroll) – även i litet fönster */
function media(e) {
  const k = mediaKey(e); if (!k || e.defaultPrevented) return false;
  const v = $('#vid', P.el); if (!v) return false;
  const click = (s) => { const b = $(s, P.el); if (b && !b.disabled) b.click(); };
  if (k === 'MediaPlayPause') v.paused ? v.play().catch(() => {}) : v.pause();
  else if (k === 'MediaPlay') v.play().catch(() => {});
  else if (k === 'MediaPause') v.pause();
  else if (k === 'MediaStop') closePlayer();
  else if (k === 'MediaFastForward') click('#cfwd');
  else if (k === 'MediaRewind') click('#cback');
  else if (k === 'MediaTrackNext') click('#pnext, #cnextch');
  else if (k === 'MediaTrackPrevious') click('#cprev');
  else return false;
  e.preventDefault();
  return true;
}

export function keys(e) {
  if (P && media(e)) return;
  // I litet fönster tar spelaren inte över tangentbordet (man bläddrar och söker)
  if (!P || P.mini || document.querySelector('dialog[open]')) return;
  const v = $('#vid', P.el); if (!v) return;
  // Fält: rullistor och reglage ger ↑/↓ till navigeringen (fjärrkontrollen), annars skriver/väljer man i dem
  const tag = e.target.tagName;
  if (tag === 'SELECT' || tag === 'INPUT') {
    if (e.key.startsWith('Arrow') && (tag === 'SELECT' || e.target.type === 'range' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) && navigate(e)) return;
    return;
  }
  if (P.pre && preKey(e, P)) return; // trailers före filmen spelas
  if (P.learn?.key(e)) return; // språkinlärningen (learn.js): a/d, r, x, p, w och pilarna mellan orden
  // Mellanslag/Enter på en fokuserad knapp eller länk (t.ex. "Hoppa över intro") ska aktivera den, inte pausa
  if ((e.key === ' ' || e.key === 'Enter') && e.target !== v && e.target.closest?.('button,a,textarea,[contenteditable]')) return;
  if (e.key.startsWith('Arrow') && navigate(e)) return;
  if (e.key === 'Escape' && (!$('#setp', P.el).hidden || !$('#chlist', P.el).hidden)) {
    // Stäng inställningar/kapitel först och lämna fokus på knappen som öppnade dem
    e.preventDefault();
    const ch = !$('#chlist', P.el).hidden;
    $('#setp', P.el).hidden = true; $('#chlist', P.el).hidden = true;
    $(ch ? '#pchap' : '#cset', P.el)?.focus();
  }
  else if (e.key === 'Escape' && !document.fullscreenElement) { e.preventDefault(); setMini(true); }
  else if (e.key === ' ' || e.key === 'k') { e.preventDefault(); v.paused ? v.play().catch(() => {}) : v.pause(); }
  else if (e.key === 'ArrowRight' || e.key === 'l' || e.key === 'ArrowLeft' || e.key === 'j') {
    e.preventDefault();
    v.currentTime += e.key === 'ArrowRight' || e.key === 'l' ? 10 : -10;
    // Fjärrkontroll med dolda kontroller: kontrollerna visas med fokus på tidslinjen, där ←/→ fortsätter spola
    if (P.keyHidden && e.key.startsWith('Arrow')) $('#scrub', P.el)?.focus({ preventScroll: true });
  }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    v.volume = Math.max(0, Math.min(1, Math.round((v.volume + (e.key === 'ArrowUp' ? 0.1 : -0.1)) * 10) / 10)); v.muted = v.volume === 0;
    store.set('pvol', v.volume); say(P.el, t('Volym {v} %', { v: Math.round(v.volume * 100) }));
  }
  // 0–9: hoppa till 0 %, 10 % … 90 % av filmen (som YouTube)
  else if (/^[0-9]$/.test(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey && isFinite(v.duration)) v.currentTime = v.duration * (+e.key / 10);
  else if (e.key === 's' && !$('#pskip', P.el).hidden) $('#pskip', P.el).click();
  else if (e.key === 'f') document.fullscreenElement ? document.exitFullscreen() : P.el.requestFullscreen?.();
  else if (e.key === 'm') { v.muted = !v.muted; say(P.el, v.muted ? t('Ljudet av') : t('Ljudet på')); }
  // c: undertexterna av/på (senast valda kommer tillbaka), < och >: långsammare/snabbare
  else if (e.key === 'c') toggleSubs();
  else if (e.key === '<' || e.key === '>') {
    const r = $('#prate', P.el); if (!r) return;
    const i = r.selectedIndex + (e.key === '>' ? 1 : -1);
    if (i < 0 || i >= r.options.length) return;
    r.selectedIndex = i; r.dispatchEvent(new Event('change')); say(P.el, t('Hastighet ') + r.options[i].text);
  }
}

let lastSub = '';
function toggleSubs() {
  const ps = $('#ps', P.el); if (!ps || ps.options.length < 2) return say(P.el, t('Inga undertexter'));
  if (ps.value) { lastSub = ps.value; ps.value = ''; }
  else ps.value = lastSub && [...ps.options].some(o => o.value === lastSub) ? lastSub : ps.options[1].value;
  ps.dispatchEvent(new Event('change'));
  say(P.el, ps.value ? t('Undertexter: ') + ps.options[ps.selectedIndex].text : t('Undertexter av'));
}

// Fjärrkontroll och tangentbord: när kontrollerna syns och en knapp i spelaren har synligt fokus flyttar pilarna fokus
// rumsligt (ui/spatial.js: kontrollraden, tidslinjen, Hoppa över, panelerna) i stället för att spola. Dolda kontroller
// (P.keyHidden – läget innan tangenten väckte dem, video.js), ett musklick (inget synligt fokus) eller fokus utanför
// spelaren: pilarna spolar (←/→) och ändrar volymen (↑/↓). På tidslinjen spolar ←/→ alltid.
function navigate(e) {
  const tg = e.target;
  if (P.keyHidden || !tg?.matches || !P.el.contains(tg) || tg.id === 'vid' || !tg.matches(':focus-visible')) return false;
  if (tg.id === 'scrub' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return false;
  const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
  e.preventDefault();
  move(dir, { scroll: false });
  return true;
}
