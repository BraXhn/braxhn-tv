// Gemensamt för helskärmsspelarna i #player: historikpost för Bakåt och litet fönster (mini-spelare)
import { $ } from '../core.js';
import { closeLive, closeRec } from './live.js';
import { P, closePlayer } from './video.js';
import { ICON } from '../ui/icons.js';

// Gemensamt för helskärmsspelarna i #player
// En öppen spelare får en egen post i historiken: Bakåt (t.ex. på TV-fjärrkontrollen) stänger spelaren
// i stället för att lämna sidan bakom den
let overlayHist = false;
export function overlayOpen(el) {
  el.hidden = false; document.body.style.overflow = 'hidden';
  if (!history.state?.overlay) history.pushState({ overlay: 1 }, '');
  overlayHist = true;
}
export function overlayClose(el) {
  el.hidden = true; el.innerHTML = ''; document.body.style.overflow = '';
  overlayHist = false;
  // Stängd med knapp/Escape: ta bort spelarens historikpost (om en ny spelare öppnas direkt behålls den)
  setTimeout(() => { if (!overlayHist && history.state?.overlay) history.back(); }, 0);
}
window.addEventListener('popstate', () => {
  if (!overlayHist || history.state?.overlay) return;
  overlayHist = false;
  if (P) setMini(true); else { closeLive(); closeRec(); }
});
/** Litet fönster: filmen fortsätter i en rad längst ner medan man bläddrar (som Plex). on=false: helskärm igen */
export function setMini(on) {
  const cur = P; if (!cur || !!cur.mini === on) return;
  const el = cur.el; cur.mini = on;
  el.classList.toggle('mini', on); el.classList.remove('idle');
  document.body.classList.toggle('hasmini', on);
  const btn = $('#cmini', el); if (btn) { btn.innerHTML = on ? ICON.expand : ICON.mini; btn.title = on ? 'Helskärmsläge' : 'Litet fönster (fortsätt bläddra)'; }
  if (on) {
    $('#setp', el).hidden = true; $('#chlist', el).hidden = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.body.style.overflow = '';
    // Spelarens historikpost behövs inte längre – Bakåt ska nu gälla sidan man bläddrar på
    overlayHist = false;
    setTimeout(() => { if (!overlayHist && history.state?.overlay) history.back(); }, 0);
  } else {
    document.body.style.overflow = 'hidden';
    if (!history.state?.overlay) history.pushState({ overlay: 1 }, '');
    overlayHist = true;
  }
}
export function stopVideo(v) { if (!v) return; v.pause(); v.removeAttribute('src'); v.load(); }
// Stänger öppna spelare (vanlig, live, inspelning)
export function closeOverlays() { closePlayer(false); closeLive(); closeRec(); }
