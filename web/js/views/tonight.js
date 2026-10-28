// Kvällsvalet: hushållet väljer film eller serie tillsammans (#/tonight, #/tonight/<id>, #/tonight/k/<kod> från QR-koden).
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
// Var och en sveper på samma förslag i samma ordning; när alla (eller en majoritet) gillat samma titel visas matchen för
// alla direkt. Servern: server/tonight.js och server/routes/tonight.js, realtid med SSE som Titta tillsammans.
// Mobilen är huvudfallet: kortet sveps med fingret, och knapparna (och ← →, Backsteg för Ångra) gör samma sak.
import { $, $$, api, esc, fmtDur, imgSrc, main, onLeave, status, store, toast, toastErr, views, t, tn } from '../core.js';
import { errorState, emptyState } from '../ui/states.js';
import { confirmDialog } from '../ui/dialog.js';
import { need, openRemotePicker, startPlay } from '../lazy.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion');
const spaced = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;
const joinUrl = (code) => `${status.publicUrl || location.origin}/#/tonight/k/${code}`;

views.tonight = async (a, b) => {
  if (a === 'k') return joinCode(b);
  if (a) return session(a);
  return startPage();
};

// ---------- startsidan: starta, gå med i hushållets eller med kod ----------
async function startPage() {
  const r = await api('/tonight');
  const list = r.sessions.length ? `<section class="panel" aria-labelledby="tlh"><h2 id="tlh">${t('Pågår i hushållet')}</h2><ul class="tlist">
    ${r.sessions.map(s => `<li><span><b>${esc(s.host)}</b> <span class="muted">· ${esc(tn(s.members, '{n} deltagare', '{n} deltagare'))} · ${s.phase === 'lobby' ? t('väntar på start') : t('röstning pågår')}</span></span>
      ${s.joined ? `<a class="btn small" href="#/tonight/${esc(s.id)}">${t('Fortsätt')}</a>` : `<button type="button" class="primary small" data-join="${esc(s.id)}">${t('Gå med')}</button>`}</li>`).join('')}</ul></section>` : '';
  main.innerHTML = `<div class="tonight">
    <h1>${t('Kvällsvalet')}</h1>
    <p class="muted tlead">${t('Välj film eller serie tillsammans: alla sveper på samma förslag, och när ni gillar samma titel är kvällen avgjord.')}</p>
    ${list}
    <section class="panel" aria-labelledby="tsh"><h2 id="tsh">${t('Starta ett kvällsval')}</h2>
      <p>${t('Du väljer filter (bibliotek, genre, längd …) och de andra går med på sina telefoner med en kod eller QR-kod. Barnprofiler kan vara med – då visas bara det som är tillåtet för alla.')}</p>
      <button type="button" class="primary" id="tnew">${t('Starta ett kvällsval')}</button></section>
    <section class="panel" aria-labelledby="tjh"><h2 id="tjh">${t('Gå med med kod')}</h2>
      <form id="tjoin" class="row"><label for="tcode">${t('Kod')}</label>
        <input id="tcode" class="qc-input" inputmode="numeric" autocomplete="off" maxlength="7" required pattern="[0-9 ]{6,7}" aria-describedby="tjhint">
        <button type="submit" class="primary">${t('Gå med')}</button></form>
      <p class="muted small" id="tjhint">${t('Sex siffror – de visas hos den som startade kvällsvalet.')}</p></section></div>`;
  $('#tnew').onclick = async (e) => {
    e.currentTarget.disabled = true;
    try { const s = await api('/tonight', { method: 'POST', body: { filters: store.get('tonight.filters', {}) } }); location.hash = '#/tonight/' + s.id; }
    catch (x) { toastErr(x); e.currentTarget.disabled = false; }
  };
  for (const btn of $$('[data-join]')) btn.onclick = async () => {
    btn.disabled = true;
    try { await api(`/tonight/${encodeURIComponent(btn.dataset.join)}/join`, { method: 'POST' }); location.hash = '#/tonight/' + btn.dataset.join; }
    catch (x) { toastErr(x); btn.disabled = false; }
  };
  $('#tjoin').onsubmit = async (e) => {
    e.preventDefault();
    try { const s = await api('/tonight/join', { method: 'POST', body: { code: $('#tcode').value } }); location.hash = '#/tonight/' + s.id; }
    catch (x) { toastErr(x); $('#tcode').select(); }
  };
}
async function joinCode(code) {
  try { const s = await api('/tonight/join', { method: 'POST', body: { code } }); location.replace('#/tonight/' + s.id); }
  catch (e) {
    if (e.aborted) throw e;
    main.innerHTML = `<div class="tonight"><h1>${t('Kvällsvalet')}</h1>${errorState(e)}<p><a class="btn" href="#/tonight">${t('Till Kvällsvalet')}</a></p></div>`;
  }
}

// ---------- ett kvällsval ----------
let S = null; // { id, st, deck: Map, order: [], hist: [], pending: Map, es, phase, cur, opts, announced }
async function session(id) {
  const r = await api('/tonight/' + encodeURIComponent(id));
  S = { id, st: r, deck: new Map(r.deck.map(i => [i.id, i])), order: r.deck.map(i => i.id), dtotal: r.total, hist: [], pending: new Map(), phase: null, cur: undefined, opts: null, announced: false };
  const me = S;
  main.innerHTML = `<div class="tonight tsess">
    <div class="thead"><h1>${t('Kvällsvalet')}</h1><ul class="tmembers" id="tmem" aria-label="${t('Deltagare')}"></ul></div>
    <div id="tbody"></div>
    <div id="tlive" class="sr-only" aria-live="polite"></div></div>`;
  render();
  // Realtid: läget skickas vid varje ändring; 'deck' = förslagen ändrades (hämtas på nytt)
  const es = new EventSource(`/api/tonight/${encodeURIComponent(id)}/events`);
  me.es = es;
  onLeave(() => { es.close(); document.removeEventListener('keydown', keys); if (S === me) S = null; });
  es.addEventListener('state', (e) => { if (S !== me) return; S.st = JSON.parse(e.data); render(); });
  es.addEventListener('deck', () => refetch(me));
  es.addEventListener('closed', () => { es.close(); if (S === me) ended(t('Kvällsvalet är avslutat.')); });
  es.addEventListener('left', () => es.close());
  // Anslutningen tappad för gott (t.ex. kvällsvalet städades bort medan sidan låg i bakgrunden)
  es.onerror = () => { if (es.readyState === EventSource.CLOSED && S === me) refetch(me); };
  document.addEventListener('keydown', keys);
}
async function refetch(me) {
  if (me.fetching) return;
  me.fetching = true;
  try {
    const r = await api('/tonight/' + encodeURIComponent(me.id), { bg: true });
    if (S !== me) return;
    S.st = r; S.order = r.deck.map(i => i.id); S.dtotal = r.total;
    for (const i of r.deck) S.deck.set(i.id, i);
    S.hist = S.hist.filter(id => S.order.includes(id)); // borttagna förslag (någon gick med) kan inte ångras
    S.cur = undefined;
    render();
  } catch (e) { if (S === me && !e.aborted) ended(e.message); }
  finally { me.fetching = false; }
}
function ended(msg) {
  S?.es?.close();
  S = null;
  main.innerHTML = `<div class="tonight"><h1>${t('Kvällsvalet')}</h1>${emptyState({ icon: '🍿', title: t('Kvällsvalet finns inte längre'), text: msg, action: { label: t('Till Kvällsvalet'), href: '#/tonight' } })}</div>`;
}

// Mina röster: serverns läge + det som just skickats (svaret har inte kommit än)
const myVote = (id) => S.pending.has(id) ? S.pending.get(id) : S.st.votes?.[id];
const nextUp = () => S.order.find(id => myVote(id) == null);
const total = () => S.order.length;
const votedCount = () => S.order.filter(id => myVote(id) != null).length;

function render() {
  if (!S) return;
  const st = S.st;
  renderMembers();
  // Förslagen har ändrats (röstningen började, någon gick med): vänta på den nya listan i stället för att visa fel kort
  if (st.phase !== 'lobby' && st.total !== S.dtotal) return refetch(S);
  const phase = st.phase === 'voting' && (st.done || nextUp() == null) ? 'waiting' : st.phase;
  if (phase !== S.phase) {
    // Fokus låg i det som ritas om (t.ex. Gilla-knappen när matchen kom): flytta det till nya rubriken
    const a = document.activeElement, lost = S.phase != null && (!a || a === document.body || !a.isConnected || !!$('#tbody')?.contains(a));
    S.phase = phase; S.cur = undefined; renderBody();
    const h = lost && $('#tbody h2');
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  }
  else updateBody();
  if (st.phase === 'matched' && !S.announced) {
    S.announced = true;
    const it = S.deck.get(st.match.id);
    if (it) { $('#tlive').textContent = t('Det blev en match: {title}', { title: it.title }); toast(t('Det blev en match: {title}', { title: it.title })); }
  }
}
function renderMembers() {
  const st = S.st, list = $('#tmem'); if (!list) return;
  list.innerHTML = st.members.map(m => {
    const prog = st.phase === 'voting' ? ` <span class="tprog">${m.voted}/${st.total}</span>` : '';
    const what = [m.self ? t('du') : '', m.host ? t('värd') : '', m.online ? '' : t('inte ansluten')].filter(Boolean).join(', ');
    return `<li class="${m.online ? '' : 'off'}">${m.kid ? '<span aria-hidden="true">🧸</span> ' : ''}${esc(m.name)}${what ? `<span class="sr-only"> (${esc(what)})</span>` : ''}${m.host ? ' <span class="muted small" aria-hidden="true">★</span>' : ''}${prog}</li>`;
  }).join('');
}
function renderBody() {
  const body = $('#tbody'), st = S.st;
  if (S.phase === 'lobby') return lobby(body);
  if (S.phase === 'voting') return voting(body);
  if (S.phase === 'waiting') return waiting(body);
  if (S.phase === 'matched') return matched(body);
  body.innerHTML = errorState({ message: st.phase });
}
function updateBody() {
  const st = S.st;
  if (S.phase === 'lobby') {
    $('#tfits') && ($('#tfits').textContent = fitsText());
    $('#tage') && ($('#tage').innerHTML = ageText());
    if ($('#tstart')) $('#tstart').disabled = !st.fits;
    if (!st.isHost && $('#tsum')) $('#tsum').innerHTML = summary(st.filters);
    if (st.isHost && !$('#tform')) renderBody(); // blev värd (den förra lämnade)
  } else if (S.phase === 'voting') {
    if (S.cur !== nextUp()) showCard();
    $('#tcount').textContent = t('Förslag {i} av {n}', { i: Math.min(votedCount() + 1, total()), n: total() });
  } else if (S.phase === 'waiting') {
    // Ritas bara om när något som syns ändrats (annars tappar knapparna fokus vid varje röst från de andra)
    const key = JSON.stringify([st.done, st.top, st.more, st.isHost, S.hist.length]);
    if (key !== S.wkey) waiting($('#tbody'));
  }
  else if (S.phase === 'matched') matchedParty();
}

// ---------- lobbyn ----------
const fitsText = () => tn(S.st.fits ?? 0, '{n} titel passar alla som är med', '{n} titlar passar alla som är med');
const ageText = () => S.st.maxAge != null ? `<span aria-hidden="true">🧸</span> ${esc(t('Bara titlar till och med {n} år visas – den lägsta åldersgränsen bland er.', { n: S.st.maxAge }))}` : '';
const LENGTHS = [[0, t('Ingen gräns')], [90, t('Högst 1,5 timme')], [120, t('Högst 2 timmar')], [150, t('Högst 2,5 timmar')]];
const RATINGS = [[0, t('Alla')], [6, t('6 eller mer')], [7, t('7 eller mer')], [8, t('8 eller mer')]];
function summary(f) {
  const kinds = f.kinds.length === 2 ? t('Filmer och serier') : f.kinds[0] === 'movie' ? t('Filmer') : t('Serier');
  const parts = [kinds, f.genres.length ? f.genres.map(esc).join(', ') : t('alla genrer')];
  if (f.maxMinutes) parts.push(t('högst {n} min', { n: f.maxMinutes }));
  if (f.minRating) parts.push(t('betyg {n} eller mer', { n: f.minRating }));
  if (f.unseen) parts.push(t('bara osett'));
  parts.push(f.rule === 'majority' ? t('match när majoriteten gillar') : t('match när alla gillar'));
  parts.push(tn(f.size, '{n} förslag', '{n} förslag'));
  return parts.map(p => `<span class="chip">${p}</span>`).join(' ');
}
async function lobby(body) {
  const st = S.st, me = S;
  body.innerHTML = `<section class="panel tcodebox" aria-labelledby="tch"><h2 id="tch">${t('Bjud in de andra')}</h2>
      <p>${t('Skanna QR-koden med telefonen, eller välj <b>Kvällsvalet</b> i menyn och skriv koden. Profiler i hushållet ser kvällsvalet direkt.')}</p>
      <div class="tcodewrap"><div class="qc-code" aria-label="${esc(t('Kod {code}', { code: st.code.split('').join(' ') }))}">${esc(spaced(st.code))}</div>
        <div class="qc-qr" id="tqr" aria-hidden="true"></div></div></section>
    <section class="panel" aria-labelledby="tfh"><h2 id="tfh">${t('Förslagen')}</h2>
      ${st.isHost ? '<div id="tform"></div>' : `<p id="tsum">${summary(st.filters)}</p>`}
      <p id="tfits" role="status">${fitsText()}</p><p class="muted small" id="tage">${ageText()}</p>
      <div class="row">${st.isHost ? `<button type="button" class="primary" id="tstart"${st.fits ? '' : ' disabled'}>${t('Börja svepa')}</button>`
        : `<p class="muted" role="status">${t('Väntar på att {name} ska börja …', { name: esc(st.host) })}</p>`}
        <button type="button" class="ghost" id="tleave">${t('Lämna')}</button>
        ${st.isHost ? `<button type="button" class="ghost" id="tend">${t('Avsluta för alla')}</button>` : ''}</div></section>`;
  need('views/quickconnect.js').then(m => { const q = $('#tqr'); if (q) m.drawQr(q, joinUrl(st.code), 5); }).catch(() => { $('#tqr')?.remove(); });
  bindLeave();
  if (!st.isHost) return;
  $('#tstart').onclick = async (e) => {
    e.currentTarget.disabled = true;
    try { await api(`/tonight/${encodeURIComponent(S.id)}/start`, { method: 'POST', bg: true }); }
    catch (x) { toastErr(x); if ($('#tstart')) $('#tstart').disabled = !S?.st.fits; }
  };
  if (!me.opts) { try { me.opts = await api('/tonight', { bg: true }); } catch { me.opts = { libraries: [], genres: [] }; } }
  if (S !== me || !$('#tform')) return;
  filterForm($('#tform'), me.opts);
}
function filterForm(box, o) {
  const f = S.st.filters;
  const check = (name, value, label, on) => `<label class="tchk"><input type="checkbox" name="${name}" value="${esc(value)}"${on ? ' checked' : ''}> ${esc(label)}</label>`;
  const libs = o.libraries.length > 1 ? `<fieldset class="tfs"><legend>${t('Bibliotek')}</legend><p class="muted small">${t('Inget valt = alla')}</p>${o.libraries.map(l => check('lib', l.id, l.name, f.libs.includes(l.id))).join('')}</fieldset>` : '';
  const genres = o.genres.length ? `<fieldset class="tfs"><legend>${t('Genrer')}</legend><p class="muted small">${t('Inget valt = alla')}</p><div class="tgenres">${o.genres.map(g => check('genre', g, g, f.genres.includes(g))).join('')}</div></fieldset>` : '';
  const sel = (id, label, opts, cur) => `<label class="tsel" for="${id}">${label}<select id="${id}">${opts.map(([v, l]) => `<option value="${v}"${+cur === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  box.innerHTML = `<form id="tform2" class="tform">
    <fieldset class="tfs"><legend>${t('Vad ska ni se?')}</legend>${check('kind', 'movie', t('Filmer'), f.kinds.includes('movie'))}${check('kind', 'show', t('Serier'), f.kinds.includes('show'))}</fieldset>
    ${libs}${genres}
    <div class="row">${sel('tmax', t('Längd'), LENGTHS, f.maxMinutes || 0)}${sel('trate', t('Lägsta betyg'), RATINGS, f.minRating || 0)}${sel('tsize', t('Antal förslag'), [[10, '10'], [20, '20'], [30, '30']], f.size)}</div>
    <label class="tchk"><input type="checkbox" id="tunseen"${f.unseen ? ' checked' : ''}> ${t('Bara sådant som ingen av oss har sett')}</label>
    <fieldset class="tfs"><legend>${t('Match när')}</legend>
      <label class="tchk"><input type="radio" name="rule" value="all"${f.rule !== 'majority' ? ' checked' : ''}> ${t('alla gillar samma titel')}</label>
      <label class="tchk"><input type="radio" name="rule" value="majority"${f.rule === 'majority' ? ' checked' : ''}> ${t('majoriteten gillar samma titel')}</label></fieldset></form>`;
  let tm = null;
  $('#tform2').onchange = () => {
    clearTimeout(tm);
    tm = setTimeout(async () => {
      const q = (s) => $$(s, box).filter(x => x.checked).map(x => x.value);
      const nf = { kinds: q('[name=kind]'), libs: q('[name=lib]').map(Number), genres: q('[name=genre]'), maxMinutes: +$('#tmax').value || null, minRating: +$('#trate').value || null,
        size: +$('#tsize').value, unseen: $('#tunseen').checked, rule: q('[name=rule]')[0] || 'all' };
      store.set('tonight.filters', nf);
      if (!S) return;
      try { await api(`/tonight/${encodeURIComponent(S.id)}/filters`, { method: 'PUT', body: nf, bg: true }); } catch (e) { toastErr(e); }
    }, 250);
  };
  $('#tform2').onsubmit = (e) => e.preventDefault();
}
function bindLeave() {
  const id = S.id;
  if ($('#tleave')) $('#tleave').onclick = async () => {
    if (!await confirmDialog(t('Lämna kvällsvalet?'), { okLabel: t('Lämna') })) return;
    try { await api(`/tonight/${encodeURIComponent(id)}/me`, { method: 'DELETE', bg: true }); location.hash = '#/tonight'; } catch (e) { toastErr(e); }
  };
  if ($('#tend')) $('#tend').onclick = async () => {
    if (!await confirmDialog(t('Avsluta kvällsvalet för alla?'), { okLabel: t('Avsluta'), danger: true })) return;
    try { await api(`/tonight/${encodeURIComponent(id)}`, { method: 'DELETE', bg: true }); location.hash = '#/tonight'; } catch (e) { toastErr(e); }
  };
}

// ---------- svepa ----------
function meta(it) {
  const p = [it.year, it.kind === 'show' ? t('Serie') : t('Film')];
  if (it.kind === 'show' && it.seasons) p.push(tn(it.seasons, '{n} säsong', '{n} säsonger'));
  else if (it.duration) p.push(fmtDur(it.duration));
  if (it.rating) p.push('★ ' + Number(it.rating).toFixed(1));
  if (it.cert) p.push(it.cert);
  return p.filter(Boolean).map(x => esc(String(x))).join(' · ');
}
const poster = (it, w = 320) => it.poster ? `<img ${imgSrc(`/api/image/${+it.id}/poster`, w)} alt="" width="300" height="450" decoding="async" data-fb="1">` : '';
function voting(body) {
  body.innerHTML = `<div class="tvote"><p class="tcount" id="tcount">${t('Förslag {i} av {n}', { i: Math.min(votedCount() + 1, total()), n: total() })}</p>
    <div class="tstack" id="tstack"></div>
    <div class="tbtns">
      <button type="button" class="tno" id="tno"><span aria-hidden="true">✕</span> ${t('Nej tack')}</button>
      <button type="button" class="ghost tundo" id="tundo"${S.hist.length ? '' : ' disabled'}><span aria-hidden="true">↶</span> ${t('Ångra')}</button>
      <button type="button" class="tyes" id="tyes"><span aria-hidden="true">♥</span> ${t('Gilla')}</button></div>
    <p class="muted small thint">${t('Svep åt höger för ja och åt vänster för nej – eller använd knapparna eller piltangenterna ← →.')}</p>
    <div class="row"><button type="button" class="ghost small" id="tleave">${t('Lämna')}</button></div></div>`;
  $('#tno').onclick = () => cast(false);
  $('#tyes').onclick = () => cast(true);
  $('#tundo').onclick = undo;
  bindLeave();
  showCard();
}
function showCard() {
  const box = $('#tstack'); if (!box) return;
  const id = nextUp(); S.cur = id;
  if (id == null) return render();
  const it = S.deck.get(id);
  if (!it) { refetch(S); return; }
  box.innerHTML = `<article class="tcard" id="tcard" aria-labelledby="tct" aria-describedby="tcm">
    <div class="tposter"><div class="ph" aria-hidden="true">${esc(it.title)}</div>${poster(it)}
      <span class="tstamp yes" aria-hidden="true">${t('JA')}</span><span class="tstamp no" aria-hidden="true">${t('NEJ')}</span></div>
    <div class="tinfo"><h2 id="tct">${esc(it.title)}</h2><p class="tmeta" id="tcm">${meta(it)}</p>
      ${it.genres?.length ? `<p class="tgen">${it.genres.slice(0, 4).map(g => `<span class="chip">${esc(g)}</span>`).join(' ')}</p>` : ''}
      ${it.overview ? `<p class="tov">${esc(it.overview)}</p>` : ''}</div></article>`;
  $('#tcount').textContent = t('Förslag {i} av {n}', { i: Math.min(votedCount() + 1, total()), n: total() });
  $('#tundo').disabled = !S.hist.length;
  bindSwipe($('#tcard'));
}
/** Svep med finger eller mus: kortet följer pekaren, och släpps det långt nog åt sidan räknas det som en röst */
function bindSwipe(card) {
  let x0 = null, y0 = 0, dx = 0, horiz = false;
  card.addEventListener('pointerdown', (e) => {
    if (e.button || e.target.closest('a,button')) return;
    x0 = e.clientX; y0 = e.clientY; dx = 0; horiz = false;
  });
  card.addEventListener('pointermove', (e) => {
    if (x0 == null) return;
    dx = e.clientX - x0;
    if (!horiz && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(e.clientY - y0)) { horiz = true; try { card.setPointerCapture(e.pointerId); } catch {} card.classList.add('drag'); }
    if (!horiz) return;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 24}deg)`;
    card.style.setProperty('--yes', String(Math.max(0, Math.min(1, dx / 110))));
    card.style.setProperty('--no', String(Math.max(0, Math.min(1, -dx / 110))));
  });
  const end = () => {
    if (x0 == null) return;
    x0 = null; card.classList.remove('drag');
    if (horiz && Math.abs(dx) > Math.min(110, card.offsetWidth * 0.3)) cast(dx > 0);
    else { card.style.transform = ''; card.style.setProperty('--yes', '0'); card.style.setProperty('--no', '0'); }
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}
async function cast(like) {
  if (!S || S.phase !== 'voting') return;
  const id = S.cur, me = S;
  if (id == null || S.pending.has(id)) return;
  const it = S.deck.get(id), card = $('#tcard');
  S.pending.set(id, like); S.hist.push(id);
  $('#tlive').textContent = like ? t('Gillad: {title}', { title: it?.title || '' }) : t('Nej tack: {title}', { title: it?.title || '' });
  const go = () => { if (S === me) render(); };
  if (card && !reduced()) { card.classList.add(like ? 'out-yes' : 'out-no'); setTimeout(go, 180); } else go();
  try { await api(`/tonight/${encodeURIComponent(me.id)}/vote`, { method: 'POST', body: { item: id, like }, bg: true }); if (me.st.votes) me.st.votes[id] = like; }
  catch (e) { me.hist = me.hist.filter(x => x !== id); toastErr(e); }
  finally { me.pending.delete(id); if (S === me) render(); }
}
async function undo() {
  if (!S || !S.hist.length || (S.st.phase !== 'voting')) return;
  const id = S.hist.pop(), me = S;
  S.pending.set(id, null);
  delete S.st.votes[id];
  const it = S.deck.get(id);
  $('#tlive').textContent = t('Ångrade: {title}', { title: it?.title || '' });
  if (S.phase !== 'voting') { S.phase = null; } // från "klar" tillbaka till korten
  render();
  try { await api(`/tonight/${encodeURIComponent(me.id)}/vote`, { method: 'POST', body: { item: id, like: null }, bg: true }); }
  catch (e) { toastErr(e); }
  finally { me.pending.delete(id); if (S === me) render(); }
}
function keys(e) {
  if (!S || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented || document.querySelector('dialog[open], [role=menu]')) return;
  if (e.target.closest?.('input,textarea,select,[contenteditable]') || !document.getElementById('tbody')) return;
  if (S.phase === 'voting' && e.key === 'ArrowRight') { e.preventDefault(); cast(true); }
  else if (S.phase === 'voting' && e.key === 'ArrowLeft') { e.preventDefault(); cast(false); }
  else if ((S.phase === 'voting' || S.phase === 'waiting') && (e.key === 'Backspace' || e.key === 'z')) { e.preventDefault(); undo(); }
}

// ---------- klar, ingen match ----------
function waiting(body) {
  const st = S.st;
  S.wkey = JSON.stringify([st.done, st.top, st.more, st.isHost, S.hist.length]);
  const host = st.isHost;
  if (!st.done) {
    body.innerHTML = `<section class="panel tdone" aria-labelledby="twh"><h2 id="twh">${t('Du har svept klart')}</h2>
      <p role="status">${t('Väntar på de andra – matchen visas här så fort den finns.')}</p>
      <div class="row"><button type="button" class="ghost" id="tundo2"${S.hist.length ? '' : ' disabled'}><span aria-hidden="true">↶</span> ${t('Ångra')}</button>
        ${host && st.more ? `<button type="button" class="ghost" id="tmore">${t('Fler förslag')}</button>` : ''}
        <button type="button" class="ghost" id="tleave">${t('Lämna')}</button></div></section>`;
  } else {
    const top = st.top || [];
    body.innerHTML = `<section class="panel tdone" aria-labelledby="twh"><h2 id="twh">${t('Ingen match den här gången')}</h2>
      <p>${top.length ? t('De här gillades mest:') : t('Ingen av er gillade något av förslagen.')}</p>
      ${top.length ? `<ul class="tlist">${top.map(x => { const it = S.deck.get(x.id); return `<li><span><b>${esc(it?.title || '')}</b> <span class="muted">${esc(t('{likes} av {n} gillade', { likes: x.likes, n: st.members.length }))}</span></span>
        ${host ? `<button type="button" class="primary small" data-pick="${+x.id}" aria-label="${esc(t('Välj {title}', { title: it?.title || '' }))}">${t('Välj')}</button>` : ''}</li>`; }).join('')}</ul>` : ''}
      <div class="row">${host && st.more ? `<button type="button" class="primary" id="tmore">${t('Fler förslag')}</button>` : ''}
        ${!host ? `<p class="muted">${st.more ? t('{name} kan hämta fler förslag eller välja en av titlarna.', { name: esc(st.host) }) : t('{name} kan välja en av titlarna.', { name: esc(st.host) })}</p>` : ''}
        <button type="button" class="ghost" id="tleave">${t('Lämna')}</button></div></section>`;
  }
  if ($('#tundo2')) $('#tundo2').onclick = undo;
  if ($('#tmore')) $('#tmore').onclick = async (e) => { e.currentTarget.disabled = true; try { await api(`/tonight/${encodeURIComponent(S.id)}/more`, { method: 'POST', bg: true }); } catch (x) { toastErr(x); } };
  for (const b of $$('[data-pick]')) b.onclick = async () => { try { await api(`/tonight/${encodeURIComponent(S.id)}/pick`, { method: 'POST', body: { item: +b.dataset.pick }, bg: true }); } catch (x) { toastErr(x); } };
  bindLeave();
}

// ---------- match ----------
function matched(body) {
  const st = S.st, m = st.match, it = S.deck.get(m.id);
  if (!it) { refetch(S); return; }
  const why = m.picked ? t('Vald av {name}', { name: m.by || st.host }) : m.likes === m.of ? tn(m.of, 'Du gillade den', 'Alla {n} gillade den') : t('{likes} av {n} gillade den', { likes: m.likes, n: m.of });
  body.innerHTML = `<section class="tmatch" aria-labelledby="tmh">
    <p class="tmkick">${m.picked ? t('Kvällens val') : t('Det blev en match!')}</p>
    <div class="tmrow"><div class="tposter small"><div class="ph" aria-hidden="true">${esc(it.title)}</div>${poster(it, 200)}</div>
      <div class="tinfo"><h2 id="tmh">${esc(it.title)}</h2><p class="tmeta">${meta(it)}</p><p>${esc(why)}</p></div></div>
    <div class="tmbtns">
      ${m.play ? `<button type="button" class="primary" id="tplay"><span aria-hidden="true">▶</span> ${t('Spela här')}</button>
      <button type="button" id="tcast" class="ghost" aria-haspopup="menu"><span aria-hidden="true">📺</span> ${t('Spela på TV:n …')}</button>` : ''}
      <span id="tpartybox"></span>
      <a class="btn" href="#/item/${+it.id}">${t('Om titeln')}</a></div>
    <p class="muted small">${t('<b>Spela på TV:n</b> skickar titeln till en annan webbläsare i hushållet (Spela på…). <b>Titta tillsammans</b> startar samma film för alla som är med, var och en på sin skärm.')}</p>
    <div class="row"><a class="btn ghost" href="#/tonight">${t('Nytt kvällsval')}</a></div></section>`;
  if ($('#tplay')) $('#tplay').onclick = (e) => startPlay(e.currentTarget, m.play.id, m.play.position || 0);
  if ($('#tcast')) $('#tcast').onclick = (e) => openRemotePicker(e.currentTarget, { item: m.play.id, position: m.play.position || 0 });
  matchedParty();
}
function matchedParty() {
  const box = $('#tpartybox'); if (!box || !S) return;
  const rid = S.st.party, has = box.dataset.rid || '';
  if (rid && has === rid) return;
  if (!rid && box.firstChild) return;
  box.dataset.rid = rid || '';
  if (rid) box.innerHTML = `<a class="btn primary" href="#/party/${esc(rid)}"><span aria-hidden="true">👥</span> ${t('Gå med i Titta tillsammans')}</a>`;
  else if (S.st.match?.play) {
    box.innerHTML = `<button type="button" class="ghost" id="tparty"><span aria-hidden="true">👥</span> ${t('Titta tillsammans')}</button>`;
    $('#tparty').onclick = async (e) => {
      e.currentTarget.disabled = true;
      try { const r = await api(`/tonight/${encodeURIComponent(S.id)}/party`, { method: 'POST', bg: true }); location.hash = '#/party/' + r.id; }
      catch (x) { toastErr(x); if ($('#tparty')) $('#tparty').disabled = false; }
    };
  }
}
