// Routing och appens skal: inloggning vid start (boot), route() med navigeringsgeneration, bibliotekslänkar,
// användarmenyn, sökfältet, flikmenyn och installation som app
import { $, $$, api, esc, leaveFns, libs, main, me, nextRoute, routeGen, setLibs, setLogin, setMe, toast, views } from './core.js';
import { stopAudio } from './audio.js';
import { closeLive, closeRec } from './player/live.js';
import { P, closeAllPlayers } from './player/video.js';
import { refreshScreen, screenBadge } from './screentime.js';
import { fillWatch } from './views/streaming.js';

// ---------- routing ----------
export async function loadLibs() {
  setLibs(await api('/libraries'));
  $('#libnav').innerHTML = `<a href="#/">Hem</a>` + libs.map(l => `<a href="#/${{ music: 'music', audiobook: 'books' }[l.type] || 'lib'}/${l.id}">${esc(l.name)}</a>`).join('')
    + (me?.liveTv ? '<a href="#/live">Live-TV</a>' : '') + (me?.streaming ? '<a href="#/streaming">Strömmande</a>' : '') + (!me?.kid ? '<a href="#/podcasts">Poddar</a>' : '');
}
function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k) { try { sessionStorage.setItem(k, '1'); } catch {} }
export async function boot() {
  const st = await api('/status');
  setLogin(st);
  if (!me) return false;
  $('#top').hidden = false;
  $('#userbtn').textContent = (me.kid ? '🧸 ' : '') + me.name + ' ▾';
  $$('[data-profiles]').forEach(e => e.hidden = me.profiles < 2);
  $$('[data-admin]').forEach(e => e.hidden = !me.adminHere);
  $$('[data-requests]').forEach(e => e.hidden = me.kid);
  $('#userbtn').classList.toggle('upd', !!(me.adminHere && me.update));
  screenBadge(me.screenTime);
  if (me.adminHere && me.update && !sessionStorageGet('upd' + me.update)) { sessionStorageSet('upd' + me.update); toast(`Version ${me.update} av BraXhn TV finns – se Administration`); }
  await loadLibs();
  return true;
}
export async function route() {
  const gen = nextRoute();
  // Stoppa timers/slingor från föregående vy
  for (const f of [...leaveFns]) { try { f(); } catch {} }
  leaveFns.clear();
  const h = location.hash.slice(2) || '';
  const [name, arg, arg2] = h.split('/');
  if (!me && name !== 'login') { location.hash = '#/login'; return; }
  // En film i litet fönster fortsätter spela medan man bläddrar
  if (P?.mini) { closeLive(); closeRec(); } else closeAllPlayers();
  $$('#libnav a').forEach(a => { const hr = a.getAttribute('href'); a.classList.toggle('on', hr === '#/' ? h === '' : ('#/' + h + '/').startsWith(hr + '/')); });
  const v = views[name || 'home'];
  if (!v) { location.hash = '#/'; return; }
  // Inloggning och profilval döljer menyn – visa den igen när man navigerar därifrån (även med Bakåt)
  $('#top').hidden = !me || name === 'login' || name === 'profiles';
  $('#tabbar').hidden = $('#top').hidden;
  $$('#tabbar [data-tab]').forEach(a => a.classList.toggle('on', a.dataset.tab === (name || '')));
  main.innerHTML = '<div class="spin"></div>';
  if (me && name !== 'timeup') refreshScreen();
  try { await v(arg, arg2); if (gen !== routeGen) return; window.scrollTo(0, 0); fillWatch(); }
  catch (e) { if (gen !== routeGen || e?.aborted) return; if (me) main.innerHTML = `<div class="empty"><h2>Något gick fel</h2><p>${esc(e.message)}</p></div>`; }
}
window.addEventListener('hashchange', route);

$('#userbtn').onclick = (e) => { e.stopPropagation(); $('#usermenu').hidden = !$('#usermenu').hidden; };
document.addEventListener('click', () => { $('#usermenu').hidden = true; });
// ---------- installera som app ----------
// Service workern kräver HTTPS (eller localhost); utan den går appen ändå att lägga på hemskärmen
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#install').hidden = false; });
window.addEventListener('appinstalled', () => { installEvt = null; $('#install').hidden = true; toast('BraXhn TV är installerad'); });
if (!standalone() && isIos()) $('#install').hidden = false; // Safari har ingen installationsdialog – visa instruktioner
document.documentElement.classList.toggle('standalone', standalone());
$('#install').onclick = async () => {
  if (installEvt) { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('#install').hidden = true; return; }
  const d = document.createElement('dialog');
  d.innerHTML = `<h2>Installera BraXhn TV</h2>${isIos()
    ? '<ol><li>Tryck på <b>Dela</b> (rutan med pilen uppåt) i Safari.</li><li>Välj <b>Lägg till på hemskärmen</b>.</li><li>Tryck <b>Lägg till</b>.</li></ol><p class="muted small">Appen öppnas sedan i helskärm med egen ikon.</p>'
    : '<p>Öppna webbläsarens meny (⋮) och välj <b>Installera app</b> eller <b>Lägg till på startskärmen</b>.</p><p class="muted small">Fullständig installation kräver att servern nås via HTTPS (se README, "Titta utanför hemmet").</p>'}
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="primary" id="ok">OK</button></div>`;
  document.body.append(d); d.showModal(); $('#ok', d).onclick = () => { d.close(); d.remove(); };
};
// Flikmenyn: Sök fokuserar sökfältet i stället för att byta sida
$('#tabbar [data-tab="search"]').onclick = (e) => { e.preventDefault(); window.scrollTo(0, 0); $('#q').focus(); };

$('#logout').onclick = async () => { stopAudio(); await api('/logout', { method: 'POST' }).catch(() => {}); setMe(null); location.hash = '#/login'; };
let qt;
$('#q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { const q = e.target.value.trim(); location.hash = q ? '#/search/' + encodeURIComponent(q) : '#/'; }, 300); };
