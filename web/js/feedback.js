// Knappen Feedback nere till höger på sidorna: öppnar dialogen "Feedback och felrapporter" (views/support.js).
// Knappen syns inte på inloggningssidan, i spelaren, i läsaren eller i bildvisningen och flyttas upp över bottenmenyn
// och minispelarna (reglerna står i style.css, #fbbox). Siffran visar egna ärenden där teamet väntar på svar och, för
// administratörer, ärenden som väntar på granskning. Servern: server/support.js.
// @lazy – laddas när startsidan är ritad (app.js), aldrig vid start
import { $, api, me, t } from './core.js';
import { need } from './lazy.js';

let counts = { needinfo: 0, review: 0 }, loaded = 0, who = null;

/** Det som väntar: { needinfo, review } (review bara för administratörer) */
export const feedbackCounts = () => counts;

function paint() {
  const b = $('#fbfab'); if (!b) return;
  const n = (counts.needinfo || 0) + (counts.review || 0);
  const dot = $('.fbn', b);
  dot.hidden = !n; dot.textContent = n > 99 ? '99+' : String(n);
  b.setAttribute('aria-label', n ? t('Feedback – {n} väntar', { n }) : 'Feedback');
  // Samma siffra vid Administration i kontomenyn (bara det som väntar på granskning)
  const a = $('#usermenu a[href="#/admin"]');
  if (a) {
    let s = $('.fbn', a);
    if (!s) { s = document.createElement('span'); s.className = 'fbn'; a.append(' ', s); }
    s.hidden = !counts.review; s.textContent = String(counts.review || '');
    if (counts.review) s.title = t('Ärenden som väntar på granskning');
  }
}

/** Hämtar siffrorna igen (efter att ett ärende skickats, granskats eller besvarats) */
export async function refreshFeedback() {
  if (!me) return;
  loaded = Date.now(); who = me.id;
  try { counts = await api('/support/count', { bg: true }); } catch { return; }
  paint();
}

export function initFeedback() {
  if ($('#fbfab')) return;
  const b = document.createElement('button');
  b.id = 'fbfab'; b.type = 'button';
  b.setAttribute('aria-haspopup', 'dialog');
  b.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm3 5v2h10V8zm0 4v2h7v-2z"/></svg><span class="fbl">Feedback</span><span class="fbn" hidden></span>`;
  b.onclick = () => need('views/support.js').then(m => m.openFeedback()).catch(() => {});
  // Sist i sidan: nås med Tab och piltangenter efter innehållet, och tar aldrig fokus av sig själv
  // Ett eget landmärke (aside), så att skärmläsare hittar knappen och inget innehåll ligger utanför landmärkena
  const box = document.createElement('aside');
  box.id = 'fbbox'; box.setAttribute('aria-label', 'Feedback');
  box.append(b);
  document.body.append(box);
  refreshFeedback();
  // Efter inloggning eller profilbyte, och högst var femte minut när man bläddrar
  addEventListener('hashchange', () => {
    if (!me) return;
    if (me.id !== who) { counts = { needinfo: 0, review: 0 }; paint(); refreshFeedback(); } // en annan profil: aldrig den förras siffror
    else if (Date.now() - loaded > 5 * 60e3) refreshFeedback();
  });
}
