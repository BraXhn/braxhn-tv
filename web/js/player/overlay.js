// Gemensamt för helskärmsspelarna i #player: historikpost för Bakåt och litet fönster (mini-spelare)
import { $ } from '../core.js';
import { closeLive, closeRec } from './live.js';
import { P, closePlayer } from './video.js';
import { ICON } from '../ui/icons.js';

// Gemensamt för helskärmsspelarna i #player
// En öppen spelare får en egen post i historiken: Bakåt (t.ex. på TV-fjärrkontrollen) stänger spelaren
// i stället för att lämna sidan bakom den
let overlayHist = false;
// Helskärmsspelaren är modal: sidan bakom blir inert (Tab och skärmläsaren stannar i spelaren). Litet fönster och
// stängd spelare släpper den. Följer #player:s hidden/class, så att alla spelare (film, live, IPTV) omfattas.
const BEHIND = ['#top', '#rail', '#main', '#tabbar', '#skiplink'];
function syncInert() {
  const el = $('#player'); if (!el) return;
  const modal = !el.hidden && !el.classList.contains('mini');
  for (const s of BEHIND) { const b = $(s); if (b) b.inert = modal; }
}
if ($('#player')) new MutationObserver(syncInert).observe($('#player'), { attributes: true, attributeFilter: ['hidden', 'class'] });
let opener = null, pending = null;
/** Knappen som startade spelaren (den inaktiveras medan spelaren laddar och tappar då fokus) – får fokus tillbaka */
export const noteOpener = (b) => { pending = b || null; };
const backFocus = () => { syncInert(); const o = opener; opener = null; if (o?.isConnected && !o.closest('[inert]')) o.focus({ preventScroll: true }); };
export function overlayOpen(el) {
  if (el.hidden) {
    const a = document.activeElement;
    opener = pending?.isConnected ? pending : a && a !== document.body && !el.contains(a) ? a : null;
    pending = null;
  }
  el.hidden = false; document.body.style.overflow = 'hidden';
  // Fokus in i spelaren (Spela/pausa), så att tangentbord och skärmläsare hamnar där bilden är
  setTimeout(() => { if (!el.hidden && !el.contains(document.activeElement)) el.querySelector('#cplay, #ctl button, button')?.focus({ preventScroll: true }); }, 0);
  if (!history.state?.overlay) history.pushState({ overlay: 1 }, '');
  overlayHist = true;
}
export function overlayClose(el) {
  el.hidden = true; el.innerHTML = ''; document.body.style.overflow = '';
  overlayHist = false;
  backFocus();
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
  const btn = $('#cmini', el); if (btn) { btn.innerHTML = on ? ICON.expand : ICON.mini; btn.title = on ? 'Helskärmsläge' : 'Litet fönster (fortsätt bläddra)'; btn.setAttribute('aria-label', btn.title); }
  if (on) {
    $('#setp', el).hidden = true; $('#chlist', el).hidden = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.body.style.overflow = '';
    backFocus();
    // Spelarens historikpost behövs inte längre – Bakåt ska nu gälla sidan man bläddrar på
    overlayHist = false;
    setTimeout(() => { if (!overlayHist && history.state?.overlay) history.back(); }, 0);
  } else {
    opener = document.activeElement !== document.body && !el.contains(document.activeElement) ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    setTimeout(() => $('#cplay', el)?.focus({ preventScroll: true }), 0);
    if (!history.state?.overlay) history.pushState({ overlay: 1 }, '');
    overlayHist = true;
  }
}
export function stopVideo(v) { if (!v) return; v.pause(); v.removeAttribute('src'); v.load(); }
// Stänger öppna spelare (vanlig, live, inspelning)
export function closeOverlays() { closePlayer(false); closeLive(); closeRec(); }
