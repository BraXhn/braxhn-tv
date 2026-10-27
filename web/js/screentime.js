// Skärmtid för profiler
import { $, $$, act, api, esc, later, main, me, toast, views } from './core.js';
import { route } from './router.js';
import { need } from './lazy.js';
import { emptyState } from './ui/states.js';

export let screenSt = null;
const fmtMin = (s) => { const m = Math.max(0, Math.round((s || 0) / 60)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const screenText = (s) => !s ? 'Ingen skärmtid är inställd.' : `Idag har ${fmtMin(s.used)} använts${s.daily != null ? ` av ${s.daily + s.extra} min` : ''}${s.extra ? ` (varav ${s.extra} min extra)` : ''}.${s.from || s.until ? ` Tillåten tid: ${s.from || '00:00'}–${s.until || '24:00'}.` : ''} ${s.allowed ? (s.left != null ? `Kvar just nu: ${fmtMin(s.left)}.` : '') : s.message}`;
/** Märke i menyraden med kvarvarande tid (bara för profiler med skärmtid) */
export function screenBadge(s) {
  screenSt = s || null;
  let b = $('#stbadge');
  if (!s?.limited) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('a'); b.id = 'stbadge'; b.href = '#/timeup'; b.className = 'stbadge'; $('.usermenu').before(b); }
  b.textContent = s.allowed ? (s.left != null ? `⏱ ${fmtMin(s.left)} kvar` : '⏱ Skärmtid') : '🌙 Slut för idag';
  b.title = screenText(s);
  b.classList.toggle('low', !s.allowed || (s.left != null && s.left < 600));
}
export function refreshScreen() {
  if (!me || !(me.screenTime || me.kid || screenSt)) return;
  api('/screentime', { bg: true }).then(screenBadge).catch(() => {});
}
export function timeUp() { if (location.hash === '#/timeup') route(); else location.hash = '#/timeup'; }
views.timeup = async () => {
  const s = await api('/screentime');
  screenBadge(s);
  if (!s.limited) { main.innerHTML = emptyState({ icon: '⏱', title: 'Ingen skärmtid är inställd', action: { label: 'Till startsidan', href: '#/', kind: 'ghost' } }); return; }
  if (s.allowed) {
    main.innerHTML = `<div class="timeup"><div class="big">⏱</div><h1>${s.left != null ? `${fmtMin(s.left)} kvar idag` : 'Du kan titta'}</h1>
      <p class="muted">${esc(screenText(s))}</p><a class="btn primary" href="#/">Till startsidan</a></div>`;
    return;
  }
  main.innerHTML = `<div class="timeup"><div class="big">🌙</div><h1>${s.reason === 'limit' ? 'Tiden är slut för idag' : 'Det är inte tittartid just nu'}</h1>
    <p>${esc(s.message)}</p><p class="muted">${s.reason === 'limit' ? 'I morgon finns ny tid. ' : ''}Ljudböcker och musik ${s.audio ? 'räknas också in' : 'går fortfarande att lyssna på'}.</p>
    <a class="btn" href="#/">Till startsidan</a></div>`;
  later(route, 60000); // en vuxen kan ge extra tid – kolla igen om en minut
};
/** Rapportera tittande för spelare som inte annars rapporterar (inspelningar). stop() stänger spelaren. */
export function screenPing(v, key, alive, stop) {
  if (!screenSt?.limited) return;
  let last = 0;
  v.addEventListener('timeupdate', () => {
    if (!alive() || v.paused || Date.now() - last < 10000) return;
    last = Date.now();
    api('/screentime/ping', { method: 'POST', body: { key, position: v.currentTime }, bg: true }).then(d => {
      if (d.screenTime) screenBadge(d.screenTime);
      if (d.stop && alive()) { stop(); timeUp(); }
    }).catch(() => {});
  });
}
/** Huvudkontot ställer in skärmtid för en profil */
export async function screenDialog(p) {
  if (!p) return;
  const [D0, { openDialog }] = await Promise.all([api('/screentime/' + p.id, { bg: true }), need('ui/dialog.js')]); // dialogen laddas först här
  const r = D0.rules || {};
  const DAYS = [[1, 'Måndag'], [2, 'Tisdag'], [3, 'Onsdag'], [4, 'Torsdag'], [5, 'Fredag'], [6, 'Lördag'], [0, 'Söndag']];
  const v = (x) => x == null ? '' : esc(String(x));
  const h = openDialog({ title: `Skärmtid – ${p.name}`, size: 'wide', closeOnRoute: false, body: `
    <p class="muted small" id="stnow" aria-live="polite">${esc(screenText(D0.status))}</p>
    <div class="row" style="align-items:flex-end"><div><label for="std">Max minuter per dag</label><input id="std" type="number" min="0" max="1440" value="${v(r.daily)}" placeholder="Ingen gräns" style="width:150px"></div>
      <div><label for="stf">Tillåtet från</label><input id="stf" type="time" value="${v(r.from)}"></div><div><label for="stu">Till</label><input id="stu" type="time" value="${v(r.until)}"></div></div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type="checkbox" id="sta" ${r.audio ? 'checked' : ''}> Gäller även ljud (musik, ljudböcker och poddar)</label>
    <details style="margin-top:12px"><summary>Andra tider vissa veckodagar</summary><p class="muted small">Tomma fält = samma som ovan.</p>
      <table><tr><th></th><th>Minuter</th><th>Från</th><th>Till</th></tr>${DAYS.map(([i, n]) => { const o = r.days?.[i] || {};
        return `<tr><td>${n}</td><td><input data-dd="${i}" aria-label="${n}: minuter" type="number" min="0" max="1440" value="${v(o.daily)}" style="width:90px"></td><td><input data-df="${i}" aria-label="${n}: från" type="time" value="${v(o.from)}"></td><td><input data-du="${i}" aria-label="${n}: till" type="time" value="${v(o.until)}"></td></tr>`; }).join('')}</table></details>
    <h3 style="font-size:.9375rem;margin:16px 0 6px">Extra tid idag</h3>
    <div class="row"><button class="ghost small" data-ex="15">+15 min</button><button class="ghost small" data-ex="30">+30 min</button><button class="ghost small" data-ex="60">+1 timme</button>
      <button class="ghost small" data-ex="-15">−15 min</button><button class="ghost small" data-exr="1">Nollställ dagens tid</button></div>
    <p class="muted small">Tiden räknas när film, serier, live-TV eller inspelningar spelas (inte när de är pausade) på alla enheter, och två samtidiga strömmar räknas inte dubbelt. När tiden är slut stoppas uppspelningen. Klockslagen följer serverns tid. Extra tid förlänger även dagens sluttid. Nedladdat i appen som ses utan nät räknas inte.</p>`,
    actions: [{ label: 'Stäng' }, { label: 'Ingen gräns', kind: 'danger', onClick: () => save({}) },
      { label: 'Spara', kind: 'primary', onClick: () => save({ daily: $('#std', dlg).value, from: $('#stf', dlg).value, until: $('#stu', dlg).value, audio: $('#sta', dlg).checked,
        days: Object.fromEntries(DAYS.map(([i]) => [i, { daily: $(`[data-dd="${i}"]`, dlg).value, from: $(`[data-df="${i}"]`, dlg).value, until: $(`[data-du="${i}"]`, dlg).value }])) }) }] });
  const dlg = h.el;
  // Stänger dialogen när sparandet lyckats (fel visas som toast och dialogen står kvar)
  async function save(body) { const res = await api('/screentime/' + p.id, { method: 'PUT', body, bg: true }); toast(res.rules ? 'Skärmtiden är sparad' : `${p.name} har ingen skärmtid`); }
  $$('[data-ex],[data-exr]', dlg).forEach(b => b.onclick = act(async () => {
    const res = await api(`/screentime/${p.id}/extra`, { method: 'POST', body: b.dataset.exr ? { reset: true } : { minutes: +b.dataset.ex }, bg: true });
    $('#stnow', dlg).textContent = screenText(res.status); toast('Sparat');
  }));
}
