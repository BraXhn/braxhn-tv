// Windows-appens inbyggda spelare (mpv): webben frågar appen om den vill spela filmen, hämtar en strömlänk med token
// och lämnar över. Medan mpv spelar sköter webben det som rör servern – framsteg (Fortsätt titta, historik, skärmtid),
// stopp och nästa avsnitt – från appens meddelanden. Kan appen inte spela (av, mpv saknas, fel) spelar webbspelaren
// som vanligt. Utanför Windows-appen gör modulen ingenting.
import { api, status, t, toast, toastErr } from '../core.js';
import { lastBandwidth, measureBandwidth, saveData } from './caps.js';
import { screenBadge, timeUp } from '../screentime.js';
import { route } from '../router.js';
import { inWindowsApp, nativePlan, nativeQuery, progressBody, skipMessage } from './nativeplan.js';

let N = null;          // { id, it, nextId, autoNext, onNext } – det mpv spelar just nu
let waiters = [];      // svar från appen som väntas på: { type, resolve }
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  window.chrome.webview.addEventListener('message', (e) => {
    const m = e.data || {};
    if (typeof m.t !== 'string' || !m.t.startsWith('native-')) return;
    const w = waiters.find(x => x.type === m.t || (x.alt && x.alt === m.t));
    if (w) { waiters = waiters.filter(x => x !== w); w.resolve(m); return; }
    onHost(m);
  });
}
const send = (m) => window.chrome.webview.postMessage(m);
/** Svar från appen (type eller alt) – null efter ms millisekunder */
function reply(type, ms, alt) {
  return new Promise((resolve) => {
    const w = { type, alt, resolve };
    waiters.push(w);
    setTimeout(() => { if (waiters.includes(w)) { waiters = waiters.filter(x => x !== w); resolve(null); } }, ms);
  });
}

/** Spelar den inbyggda spelaren just nu? */
export const nativePlaying = () => !!N;

/**
 * Försök spela i Windows-appens inbyggda spelare. true = den spelar (eller uppspelningen nekades av skärmtiden),
 * false = webbspelaren ska spela som vanligt.
 * o: { start, audio, version, q, cinema, sub, onNext(nextId) }
 */
export async function playNative(it, o = {}) {
  if (!inWindowsApp()) return false;
  listen();
  // Är den inbyggda spelaren på och finns mpv? (appen svarar direkt; inget svar = äldre app eller annat fel)
  send({ t: 'native-check' });
  const ready = await reply('native-ready', 1500);
  if (!ready?.ok) return false;
  const q = { start: o.start, audio: o.audio, version: o.version || it.version, q: o.q, cinema: o.cinema };
  // Utanför hemmet: samma mätning som webbspelaren – räcker inte uppkopplingen kodar servern om, och då spelar webben
  if (status.remote) {
    q.bw = lastBandwidth() || await Promise.race([measureBandwidth(), new Promise(r => setTimeout(() => r(0), 1500))]);
    q.save = saveData();
  }
  let pb;
  try { pb = await api(`/items/${it.id}/playback?${nativeQuery(q)}`, { bg: true }); }
  catch (e) {
    if (e.code === 'screen_time') { timeUp(); return true; }
    send(skipMessage(it, { reasons: [String(e.message || e)] }, { why: 'fel' }));
    return false; // webbspelaren frågar igen och visar felet
  }
  const plan = nativePlan(it, pb, { start: o.start, origin: location.origin, sub: o.sub });
  // Appen får veta varför (Om den inbyggda spelaren), t.ex. att servern valde omkodning utanför hemmet
  if (!plan.use) { send(skipMessage(it, pb, plan, q.bw)); return false; }
  send(plan.msg);
  const r = await reply('native-started', 20000, 'native-failed'); // mpv svarar när första bilden visas (via reläet kan det ta en stund)
  if (r?.t !== 'native-started' || r.id !== it.id) {
    if (!r) send({ t: 'native-stop', id: it.id });
    return false;
  }
  N = { id: it.id, it, duration: plan.msg.duration, nextId: plan.msg.nextId, autoNext: plan.msg.autoNext, onNext: o.onNext, lastPos: o.start || 0 };
  return true;
}

/** Stoppar den inbyggda spelaren (t.ex. när en vuxen stoppar uppspelningen) */
export function stopNative() {
  if (N) send({ t: 'native-stop', id: N.id });
}

function sendProgress(pos, final = false) {
  const cur = N; if (!cur || !(pos >= 1)) return;
  const body = progressBody(pos, cur.duration);
  if (final && navigator.sendBeacon) { navigator.sendBeacon(`/api/items/${cur.id}/progress`, new Blob([body], { type: 'application/json' })); return; }
  fetch(`/api/items/${cur.id}/progress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    .then(r => r.json()).then(d => {
      if (d.screenTime) screenBadge(d.screenTime);
      if (d.stop && N === cur) {
        stopNative();
        if (d.screenTime && !d.screenTime.allowed) timeUp();
        else toast(t('Uppspelningen stoppades av administratören'));
      }
    }).catch(() => {});
}

function finish(pos) {
  const cur = N; if (!cur) return;
  sendProgress(pos, true);
  N = null;
  fetch(`/api/stream/${cur.id}/stop`, { method: 'POST' }).catch(() => {});
}

function onHost(m) {
  if (!N || m.id !== N.id) return;
  const pos = +m.pos || 0;
  switch (m.t) {
    case 'native-progress': N.lastPos = pos; sendProgress(pos); break;
    case 'native-ended': {
      // Filmen eller avsnittet tog slut: nästa avsnitt direkt om kontot vill det, annars tillbaka till sidan
      const { nextId, autoNext, onNext } = N;
      finish(pos);
      if (nextId && autoNext && onNext) onNext(nextId);
      else { send({ t: 'native-stop', id: m.id }); route(); }
      break;
    }
    case 'native-next': { const { nextId, onNext } = N; finish(pos); if (nextId && onNext) onNext(nextId); break; }
    // replaced: en annan titel startades i den inbyggda spelaren – sidan ritas inte om
    case 'native-closed': finish(pos); if (!m.replaced) route(); break;
    case 'native-failed': {
      // mpv kunde inte spela filen efter starten – eller användaren valde webbspelaren (user): den tar över där den var
      const { it } = N;
      finish(pos);
      if (!m.user) toast(t('Den inbyggda spelaren kunde inte spela filmen – webbspelaren tar över'));
      import('./video.js').then(v => v.play(it.id, pos, { noNative: true, noCinema: true })).catch(toastErr);
      break;
    }
  }
}
