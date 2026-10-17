// BraXhn TV webbklient – ren JavaScript, inga ramverk
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const main = $('#main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('braxhn-tv.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('braxhn-tv.' + k, JSON.stringify(v)); } catch {} }
};
let me = null, libs = [], status = {};
// Navigering: varje route() får en ny generation. Anrop och timers från en gammal vy avbryts.
let routeGen = 0;
const leaveFns = new Set();
const onLeave = (fn) => { leaveFns.add(fn); return fn; };
// setTimeout knuten till vyn: körs bara om man är kvar, rensas när man lämnar. Returnerar en avbrytfunktion.
function later(fn, ms) {
  const g = routeGen;
  const cancel = () => { clearTimeout(t); leaveFns.delete(cancel); };
  const t = setTimeout(() => {
    leaveFns.delete(cancel);
    if (g !== routeGen) return;
    const r = fn();
    if (r && r.catch) r.catch(e => { if (!e?.aborted) console.warn(e); });
  }, ms);
  leaveFns.add(cancel);
  return cancel;
}
const abortErr = () => Object.assign(new Error(''), { aborted: true });
window.addEventListener('unhandledrejection', (e) => { if (e.reason?.aborted) e.preventDefault(); });
// Trasiga bilder tas bort (ersätter inline onerror, som CSP blockerar)
document.addEventListener('error', (e) => { if (e.target?.tagName === 'IMG' && e.target.dataset.fb) e.target.remove(); }, true);

async function api(path, opts = {}) {
  // bg: true = anropet hör inte till den aktuella vyn (t.ex. spelaren) och avbryts inte vid navigering
  const { bg, ...rest } = opts;
  const gen = routeGen;
  const o = { headers: {}, ...rest };
  if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers['Content-Type'] = 'application/json'; }
  const r = await fetch('/api' + path, o);
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (r.status === 401 && !path.startsWith('/login')) { me = null; location.hash = '#/login'; throw new Error('Inte inloggad'); }
  if (!bg && gen !== routeGen) throw abortErr(); // användaren har gått vidare – resultatet ska inte användas
  if (!r.ok) throw Object.assign(new Error(data?.error || `Fel ${r.status}`), { code: data?.code, data });
  return data;
}
// Rader och mappar som bara har onclick: gör dem nåbara med tangentbord och fjärrkontroll (Tab/D-pad + Enter)
function keyClick(el) {
  el.tabIndex = 0; el.setAttribute('role', 'button');
  el.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); el.click(); } };
  return el;
}
function toast(msg) {
  if (!msg) return;
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 3200);
}
// Kör en asynkron händelsehanterare och visar fel som toast (avbrutna anrop ignoreras)
const act = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (!e?.aborted) toast(e?.message || String(e)); } };
// Profilfärg: bara #hex, rgb()/hsl() släpps in i style-attributet
const safeColor = (c) => typeof c === 'string' && (/^#[0-9a-f]{3,8}$/i.test(c) || /^(rgb|hsl)a?\([0-9a-z\s.,%/+-]*\)$/i.test(c)) ? c : '';
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
};
const fmtDur = (s) => { if (!s) return ''; const m = Math.max(1, Math.round(s / 60)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const fmtSize = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB';
const resLabel = (h) => !h ? '' : h >= 2000 ? '4K' : h >= 1000 ? '1080p' : h >= 700 ? '720p' : h >= 560 ? '576p' : h + 'p';
const sxe = (e) => `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;
function hue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

// ---------- kort ----------
function art(it, land) {
  const pick = land ? (it.thumb ? 'thumb' : it.backdrop ? 'backdrop' : it.poster ? 'poster' : null)
    : (it.poster ? 'poster' : it.thumb ? 'thumb' : null);
  const imgId = land && !it.thumb && it.kind === 'episode' && it.show ? null : it.id;
  const h = hue(it.title);
  let html = `<div class="ph" style="--h1:hsl(${h} 45% 32%);--h2:hsl(${(h + 50) % 360} 50% 18%)">${esc(it.showTitle || it.title)}</div>`;
  if (pick && imgId) html += `<img loading="lazy" src="/api/image/${imgId}/${pick}" alt="" data-fb="1">`;
  if (it.kind === 'show') {
    const left = (it.episodes || 0) - (it.watchedEpisodes || 0);
    if (it.watched) html += `<span class="seen" title="Sedd">✓</span>`;
    else if (left > 0 && it.watchedEpisodes > 0) html += `<span class="badge" title="Osedda avsnitt">${left}</span>`;
  } else {
    if (it.watched) html += `<span class="seen" title="Sedd">✓</span>`;
    if (it.position > 0 && it.duration) html += `<div class="bar"><i style="width:${Math.min(100, it.position / it.duration * 100)}%"></i></div>`;
  }
  return `<div class="art">${html}</div>`;
}
function card(it, land = false) {
  let t = it.title, s = it.year || '';
  if (it.kind === 'episode') { t = land && it.showTitle ? it.showTitle : it.title; s = `${sxe(it)}${land && it.showTitle ? ' · ' + esc(it.title) : ''}`; }
  if (it.kind === 'show') s = [it.year, it.episodes ? `${it.episodes} avsnitt` : ''].filter(Boolean).join(' · ');
  const href = it.kind === 'episode' && !land ? `#/item/${it.show}` : `#/item/${it.id}`;
  return `<a class="card${land ? ' land' : ''}" href="${href}" data-id="${it.id}">${art(it, land)}<div class="t">${esc(t)}</div><div class="s">${s}</div></a>`;
}

// ---------- passkeys (WebAuthn) ----------
const b64uEnc = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDec = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const passkeyOk = () => !!window.PublicKeyCredential && window.isSecureContext;
async function passkeyLogin() {
  const o = await (await fetch('/api/passkey/options', { method: 'POST' })).json();
  if (o.error) throw new Error(o.error);
  const cred = await navigator.credentials.get({ publicKey: { ...o, challenge: b64uDec(o.challenge) } });
  const r = await fetch('/api/passkey/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    id: cred.id, response: { clientDataJSON: b64uEnc(cred.response.clientDataJSON), authenticatorData: b64uEnc(cred.response.authenticatorData),
      signature: b64uEnc(cred.response.signature) } }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Fel ' + r.status);
}
async function passkeyRegister(password, name, code) {
  const o = await api('/me/passkeys/options', { method: 'POST', body: { password, code } });
  const cred = await navigator.credentials.create({ publicKey: { ...o, challenge: b64uDec(o.challenge), user: { ...o.user, id: b64uDec(o.user.id) },
    excludeCredentials: o.excludeCredentials.map(c => ({ ...c, id: b64uDec(c.id) })) } });
  await api('/me/passkeys', { method: 'POST', body: { name, id: cred.id, response: { clientDataJSON: b64uEnc(cred.response.clientDataJSON), attestationObject: b64uEnc(cred.response.attestationObject) } } });
}

// ---------- vyer ----------
const views = {};

views.login = async () => {
  const st = await api('/status');
  const setup = st.needsSetup;
  $('#top').hidden = true;
  main.innerHTML = `<form class="auth" id="f">
    <div class="brand"><img src="/icon.svg" alt=""><span>BraXhn TV</span></div>
    <p>${setup ? 'Välkommen! Skapa administratörskontot.' : 'Logga in'}</p>
    <label for="n">Användarnamn</label><input id="n" autocomplete="username" required maxlength="64">
    <label for="p">Lösenord</label><input id="p" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 10 : 1}">
    ${setup ? '<p class="muted small" style="text-align:left;margin-top:6px">Minst 10 tecken med blandade tecken, eller minst 14 tecken.</p>' : ''}
    <div id="codebox" hidden><label for="code">Kod från autentiseringsappen (eller reservkod)</label>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12"></div>
    <div class="err" id="e"></div>
    <button class="primary">${setup ? 'Skapa konto' : 'Logga in'}</button>
    ${!setup && passkeyOk() ? '<button type="button" class="ghost" id="pkl" style="width:100%;margin-top:10px">Logga in med passkey</button>' : ''}</form>`;
  if ($('#pkl')) $('#pkl').onclick = async () => {
    try { await passkeyLogin(); await boot(); location.hash = me.profiles > 1 ? '#/profiles' : '#/'; }
    catch (e) { $('#e').textContent = e.name === 'NotAllowedError' ? 'Avbrutet' : e.message; }
  };
  $('#n').focus();
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const body = { name: $('#n').value, password: $('#p').value };
    if (!$('#codebox').hidden) body.code = $('#code').value.trim();
    try {
      const r = await fetch('/api' + (setup ? '/setup' : '/login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (d.need2fa) { $('#codebox').hidden = false; $('#code').focus(); $('#e').textContent = body.code ? d.error : ''; return; }
      if (!r.ok) throw new Error(d.error || 'Fel ' + r.status);
      await boot();
      if (d.weakPassword) { toast('Ditt lösenord är svagt – byt det under Mitt konto'); location.hash = '#/account'; }
      else location.hash = setup ? '#/admin' : me.profiles > 1 ? '#/profiles' : '#/';
    } catch (e) { $('#e').textContent = e.message; }
  };
};

function shelf(title, items, land = false, more = '') {
  return items?.length ? `<section class="section"><h2>${esc(title)} ${more}</h2><div class="shelf${land ? ' wide' : ''}">${items.map(i => card(i, land)).join('')}</div></section>` : '';
}
function colCard(c) {
  const h = hue(c.name);
  return `<a class="card" href="#/collection/${c.id}"><div class="art"><div class="ph" style="--h1:hsl(${h} 45% 32%);--h2:hsl(${(h + 50) % 360} 50% 18%)">${esc(c.name)}</div>
    ${c.poster ? `<img loading="lazy" src="/api/collection-image/${c.id}/poster" alt="" data-fb="1">` : ''}<span class="badge">${c.count}</span></div>
    <div class="t">${esc(c.name)}</div><div class="s">${c.years?.[0] || ''}${c.years?.[1] && c.years[1] !== c.years[0] ? '–' + c.years[1] : ''}</div></a>`;
}
views.home = async () => {
  const [d, cols] = await Promise.all([api('/home'), api('/collections').catch(() => [])]);
  let html = '';
  if (!libs.length) {
    html = `<div class="empty"><h2>Inga bibliotek ännu</h2><p>${me.is_admin ? 'Lägg till en mapp med filmer eller serier för att komma igång.' : 'Be administratören att lägga till bibliotek.'}</p>
      ${me.is_admin ? '<a class="btn primary" href="#/admin">Lägg till bibliotek</a>' : ''}</div>`;
  }
  if (d.forYou?.length) html += `<section class="section"><h2>Nytt för dig <span class="fycount">${d.forYou.length}</span> <a href="#" id="fyclear">Markera som sedda</a></h2><div class="shelf wide">${d.forYou.map(i => card(i, true)).join('')}</div></section>`;
  if (d.continue.length) html += `<section class="section"><h2>Fortsätt titta</h2><div class="shelf wide">${d.continue.map(i => card(i, true)).join('')}</div></section>`;
  html += shelf('Min lista', d.watchlist, false, '<a href="#/watchlist">Visa alla</a>');
  html += shelf('Rekommenderat för dig', d.recommended);
  if (cols.length) html += `<section class="section"><h2>Samlingar</h2><div class="shelf">${cols.map(colCard).join('')}</div></section>`;
  for (const r of d.rows) if (r.items.length)
    html += `<section class="section"><h2>${esc(r.title)} <a href="#/lib/${r.library.id}">Visa alla</a></h2><div class="shelf">${r.items.map(i => card(i)).join('')}</div></section>`;
  if (libs.length && !d.rows.some(r => r.items.length)) {
    const s = await api('/scan');
    html += `<div class="empty"><h2>${s.running ? 'Skannar bibliotek…' : 'Inget innehåll hittades'}</h2><p>${s.running ? esc(s.phase) + ' ' + s.done + '/' + s.total : 'Kontrollera sökvägarna under Administration.'}</p></div>`;
    if (s.running) later(route, 3000);
  }
  main.innerHTML = html;
  if ($('#fyclear')) $('#fyclear').onclick = act(async (e) => { e.preventDefault(); await api('/foryou/seen', { method: 'POST', body: {} }); route(); });
};

views.lib = async (id) => {
  const sort = store.get('sort.' + id, 'title'), filter = store.get('filter.' + id, '');
  const d = await api(`/libraries/${id}/items?sort=${sort}&filter=${filter}`);
  main.innerHTML = `<div class="toolbar"><h1>${esc(d.library.name)}</h1><span class="muted">${d.items.length} titlar</span>
    <select id="flt"><option value="">Alla</option><option value="unwatched">Osedda</option><option value="watched">Sedda</option></select>
    <select id="srt"><option value="title">Titel</option><option value="added">Senast tillagda</option><option value="year">År</option><option value="rating">Betyg</option></select></div>
    <div class="grid">${d.items.map(i => card(i)).join('') || '<p class="muted">Inget här.</p>'}</div>`;
  $('#srt').value = sort; $('#flt').value = filter;
  $('#srt').onchange = (e) => { store.set('sort.' + id, e.target.value); route(); };
  $('#flt').onchange = (e) => { store.set('filter.' + id, e.target.value); route(); };
};

views.search = async (q) => {
  q = decodeURIComponent(q || '');
  if ($('#q').value !== q && document.activeElement !== $('#q')) $('#q').value = q;
  const [r, ppl] = q.length >= 1 ? await Promise.all([api('/search?q=' + encodeURIComponent(q)),
    api('/search/people?q=' + encodeURIComponent(q)).catch(e => { if (e?.aborted) throw e; return []; })]) : [[], []];
  const top = r.filter(i => i.kind !== 'episode'), eps = r.filter(i => i.kind === 'episode');
  main.innerHTML = `<div class="toolbar"><h1>Sök: ”${esc(q)}”</h1></div>
    ${top.length ? `<section class="section"><h2>Filmer och serier</h2><div class="grid">${top.map(i => card(i)).join('')}</div></section>` : ''}
    ${ppl.length ? `<section class="section"><h2>Personer</h2><div class="shelf people">${ppl.map(p => personCard(p, `${p.titles} ${p.titles === 1 ? 'titel' : 'titlar'}`)).join('')}</div></section>` : ''}
    ${eps.length ? `<section class="section"><h2>Avsnitt</h2><div class="grid">${eps.map(i => card(i, true)).join('')}</div></section>` : ''}
    ${!r.length && !ppl.length ? '<div class="empty">Inga träffar.</div>' : ''}`;
};

function heroHtml(it, extra = '') {
  const meta = [it.year, it.kind === 'movie' ? fmtDur(it.duration) : (it.episodes ? `${it.episodes} avsnitt` : ''),
    it.rating ? `<span class="star">★ ${it.rating.toFixed(1)}</span>` : '', it.kind === 'movie' ? resLabel(it.height) : '',
    it.age != null ? `<span class="agebadge" title="${esc(it.cert || '')}">${it.age === 0 ? 'Barntillåten' : it.age + '+'}</span>` : '',
    (it.genres || []).slice(0, 3).map(esc).join(', ')]
    .filter(Boolean).map(x => `<span>${x}</span>`).join('');
  return `<div class="hero">${it.backdrop ? `<div class="bd" style="background-image:url(/api/image/${it.id}/backdrop)"></div>` : ''}
    <div class="in"><div class="poster card">${art({ ...it, position: 0 })}</div>
    <div><h1>${esc(it.title)}</h1><div class="meta">${meta}</div>
    ${it.overview ? `<p class="overview">${esc(it.overview)}</p>` : ''}${extra}${it.kind !== 'episode' && !me.kid ? `<div class="watchprov" data-wid="${it.id}"></div>` : ''}</div></div></div>`;
}

views.item = async (id) => {
  // Flera versioner (t.ex. 4K och 1080p): valet sparas per film i webbläsaren, annars väljer servern
  const chosen = store.get('version.' + id, '');
  const it = await api('/items/' + id + (chosen ? '?version=' + encodeURIComponent(chosen) : ''));
  if (it.kind === 'show') return showView(it);
  const verSel = it.versions ? (it.versions.some(v => String(v.id) === String(chosen)) ? String(chosen) : '') : '';
  const resume = it.position > 30;
  const actions = `<div class="row">
    ${resume ? `<button class="primary" data-play="${it.position}">▶ Fortsätt från ${fmtTime(it.position)}</button><button class="ghost" data-play="0">Börja om</button>`
      : `<button class="primary" data-play="0">▶ Spela</button>`}
    <button class="ghost" id="seen">${it.watched ? 'Markera som osedd' : 'Markera som sedd'}</button>
    <button class="ghost" id="wl">${it.inWatchlist ? '✓ I Min lista' : '+ Min lista'}</button>${trailerBtns(it)}
    <a class="btn" href="/api/stream/${it.version || it.id}/download" download>Ladda ner</a>
    ${me.is_admin ? `<button class="ghost" id="refresh">Uppdatera metadata</button><button class="ghost" id="match">Fel titel?</button><button class="ghost" id="edit">Redigera</button>` : ''}</div>`;
  const back = it.kind === 'episode' ? `<p><a class="muted" href="#/item/${it.show}">← ${esc(it.showTitle)}</a> · ${sxe(it)}</p>` : '';
  const versions = it.versions ? `<div class="row" style="margin-top:10px"><label class="muted small" for="ver">Version</label>
    <select id="ver"><option value="">Automatiskt</option>${it.versions.map(v => `<option value="${v.id}">${esc(v.label)}${v.size ? ' · ' + fmtSize(v.size) : ''}</option>`).join('')}</select></div>` : '';
  main.innerHTML = heroHtml(it, back + actions + versions) + `<div class="tech">
    <span>Fil</span><b>${esc(it.file)}</b><span>Storlek</span><b>${fmtSize(it.size)}</b>
    <span>Video</span><b>${esc(it.vcodec || '–')} ${it.width ? it.width + '×' + it.height : ''}</b>
    <span>Ljud</span><b>${it.audio.map(a => esc([a.lang, a.codec, a.channels ? a.channels + 'ch' : ''].filter(Boolean).join(' '))).join(', ') || '–'}</b>
    <span>Undertexter</span><b>${it.subtitles.map(s => esc(s.label)).join(', ') || '–'}</b>
    ${it.hdr ? `<span>HDR</span><b>${esc(it.hdr.toUpperCase())} – tonmappas automatiskt på skärmar utan HDR</b>` : ''}
    ${it.recap ? `<span>Sammanfattning</span><b>${fmtTime(it.recap.start)}–${fmtTime(it.recap.end)}</b>` : ''}
    ${it.intro ? `<span>Intro</span><b>${fmtTime(it.intro.start)}–${fmtTime(it.intro.end)}</b>` : ''}
    ${it.credits ? `<span>Eftertexter</span><b>från ${fmtTime(it.credits)}</b>` : ''}
    <span>Uppspelning</span><b id="pbinfo">…</b></div>
    <div class="row" style="margin-top:16px"><button class="ghost small" id="subsearch">Sök undertexter online</button>
    ${me.is_admin && it.kind === 'episode' ? '<button class="ghost small" id="markers">Justera intro/eftertexter</button>' : ''}</div>`;
  if ($('#ver')) {
    $('#ver').value = verSel;
    $('#ver').onchange = (e) => { store.set('version.' + it.id, e.target.value); route(); };
  }
  api(`/items/${it.id}/playback?${capsQuery(verSel ? { version: verSel } : {})}&info=1`).then(p => {
    const m = { direct: 'Direktuppspelning', remux: 'Remux', transcode: 'Omkodning' }[p.mode];
    if ($('#pbinfo')) $('#pbinfo').textContent = m + (p.reasons.length ? ' (' + p.reasons.join(', ') + ')' : '');
    // Visa vilken version servern valde automatiskt
    const auto = !verSel && p.versions && p.versions.find(v => v.id === p.version);
    if (auto && $('#ver')) $('#ver').options[0].textContent = 'Automatiskt (' + auto.label + ')';
  }).catch(() => {});
  $('#subsearch').onclick = () => subSearch(it);
  bindWatchlist(it);
  bindTrailers(it);
  main.insertAdjacentHTML('beforeend', castShelf(it));
  if (it.collectionInfo && it.collectionInfo.items.length > 1) main.insertAdjacentHTML('beforeend', shelf(`Del av ${it.collectionInfo.name}`, it.collectionInfo.items, false, `<a href="#/collection/${it.collectionInfo.id}">Visa samlingen</a>`));
  main.insertAdjacentHTML('beforeend', shelf('Liknande', it.similar));
  if ($('#markers')) $('#markers').onclick = () => editMarkers(it);
  $$('[data-play]').forEach(b => b.onclick = () => startPlay(b, it.id, +b.dataset.play, verSel ? { version: verSel } : {}));
  $('#seen').onclick = act(async () => { await api(`/items/${it.id}/watched`, { method: 'POST', body: { watched: !it.watched } }); route(); });
  if (me.is_admin) {
    $('#refresh').onclick = () => refreshMeta(it);
    if ($('#match')) $('#match').onclick = () => matchItem(it);
    $('#edit').onclick = () => editItem(it);
  }
};

function showView(it) {
  const seasons = [...new Set(it.children.map(e => e.season))].sort((a, b) => a - b);
  let cur = store.get('season.' + it.id, it.next?.season ?? seasons[0]);
  if (!seasons.includes(cur)) cur = seasons[0];
  const nx = it.next;
  const actions = `<div class="row">${nx ? `<button class="primary" id="playnext">▶ ${nx.position > 0 ? 'Fortsätt' : 'Spela'} ${sxe(nx)}</button>` : ''}
    <button class="ghost" id="seen">${it.watched ? 'Markera serien som osedd' : 'Markera serien som sedd'}</button>
    <button class="ghost" id="wl">${it.inWatchlist ? '✓ I Min lista' : '+ Min lista'}</button>${trailerBtns(it)}
    <button class="ghost" id="follow" title="Få besked när nya avsnitt kommer">${it.following ? '🔔 Följer' : '🔕 Följ'}</button>
    <select id="fsync" title="Håll nästa osedda avsnitt nedladdade i appen" ${it.following ? '' : 'hidden'}>${[['', 'Appen: standard'], ['0', 'Appen: ladda inte ner'], ...[1, 2, 3, 5].map(n => [String(n), `Appen: håll ${n} nedladdade`])].map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
    ${me.is_admin ? `<button class="ghost" id="refresh">Uppdatera metadata</button>${it.kind !== 'episode' ? '<button class="ghost" id="match">Fel titel?</button>' : ''}<button class="ghost" id="edit">Redigera</button>` : ''}</div>`;
  main.innerHTML = heroHtml(it, actions) + `<div class="tabs" id="tabs">${seasons.map(s =>
    `<button data-s="${s}" class="${s === cur ? 'on' : ''}">${s === 0 ? 'Specialavsnitt' : 'Säsong ' + s}</button>`).join('')}</div><div id="eps"></div>`;
  const renderEps = () => {
    const eps = it.children.filter(e => e.season === cur);
    const allSeen = eps.every(e => e.watched);
    $('#eps').innerHTML = `<div class="row" style="margin-bottom:10px"><button class="ghost small" id="seasonSeen">${allSeen ? 'Markera säsongen som osedd' : 'Markera säsongen som sedd'}</button></div>
      <div class="eps">${eps.map(e => `<div class="ep">${card(e, true).replace(`href="#/item/${e.id}"`, `href="#/item/${e.id}"`)}
      <div class="info"><h3>${e.episode}. ${esc(e.title)}</h3><div class="muted">${fmtDur(e.duration)}${e.watched ? ' · Sedd' : e.position ? ` · ${fmtTime(e.position)} kvar: ${fmtTime(e.duration - e.position)}` : ''}</div>
      ${e.overview ? `<p>${esc(e.overview)}</p>` : ''}
      <div class="acts" style="margin-top:8px"><button class="primary small" data-play="${e.id}" data-pos="${e.position}">▶ Spela</button>
      <button class="ghost small" data-seen="${e.id}" data-w="${e.watched ? 1 : 0}">${e.watched ? 'Osedd' : 'Sedd'}</button></div></div></div>`).join('')}</div>`;
    $$('[data-play]', $('#eps')).forEach(b => b.onclick = () => startPlay(b, +b.dataset.play, +b.dataset.pos));
    $$('[data-seen]').forEach(b => b.onclick = act(async () => { await api(`/items/${b.dataset.seen}/watched`, { method: 'POST', body: { watched: b.dataset.w !== '1' } }); route(); }));
    $('#seasonSeen').onclick = act(async () => { await api(`/items/${it.id}/watched?season=${cur}`, { method: 'POST', body: { watched: !allSeen } }); route(); });
  };
  renderEps();
  bindWatchlist(it);
  bindTrailers(it);
  main.insertAdjacentHTML('beforeend', castShelf(it));
  bindFollow(it);
  main.insertAdjacentHTML('beforeend', shelf('Liknande serier', it.similar));
  $$('#tabs button').forEach(b => b.onclick = () => {
    cur = +b.dataset.s; store.set('season.' + it.id, cur);
    $$('#tabs button').forEach(x => x.classList.toggle('on', x === b)); renderEps();
  });
  if (nx) $('#playnext').onclick = (e) => startPlay(e.currentTarget, nx.id, nx.position);
  $('#seen').onclick = act(async () => { await api(`/items/${it.id}/watched`, { method: 'POST', body: { watched: !it.watched } }); route(); });
  if (me.is_admin) { $('#refresh').onclick = () => refreshMeta(it); $('#edit').onclick = () => editItem(it); if ($('#match')) $('#match').onclick = () => matchItem(it); }
}

function bindWatchlist(it) {
  const b = $('#wl'); if (!b) return;
  b.onclick = act(async () => {
    const add = !it.inWatchlist;
    await api(`/items/${it.id}/watchlist`, { method: 'POST', body: { add } });
    it.inWatchlist = add;
    b.textContent = it.inWatchlist ? '✓ I Min lista' : '+ Min lista';
    toast(it.inWatchlist ? 'Tillagd i Min lista' : 'Borttagen från Min lista');
  });
}

views.watchlist = async () => {
  const items = await api('/watchlist');
  main.innerHTML = `<div class="toolbar"><h1>Min lista</h1><span class="muted">${items.length} titlar</span></div>
    <div class="grid">${items.map(i => card(i)).join('') || '<p class="muted">Lägg till filmer och serier med ”+ Min lista”.</p>'}</div>`;
};
views.collection = async (id) => {
  const c = await api('/collections/' + id);
  main.innerHTML = `<div class="hero">${c.backdrop ? `<div class="bd" style="background-image:url(/api/collection-image/${c.id}/backdrop)"></div>` : ''}
    <div class="in"><div><h1>${esc(c.name)}</h1><div class="meta"><span>${c.items.length} filmer</span></div>${c.overview ? `<p class="overview">${esc(c.overview)}</p>` : ''}
    ${c.items.find(i => !i.watched) ? `<button class="primary" id="playfirst">▶ Spela ${esc(c.items.find(i => !i.watched).title)}</button>` : ''}</div></div></div>
    <div class="grid" style="margin-top:20px">${c.items.map(i => card(i)).join('')}</div>`;
  const first = c.items.find(i => !i.watched);
  if (first) $('#playfirst').onclick = (e) => startPlay(e.currentTarget, first.id, first.position || 0);
};

// ---------- Skådespelare och personsidor ----------
const ROLE_NAME = { director: 'Regi', creator: 'Skapare' };
const initials = (n) => String(n || '').split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
function personArt(p) {
  const h = hue(p.name);
  return `<div class="art"><div class="ph" style="--h1:hsl(${h} 30% 34%);--h2:hsl(${(h + 40) % 360} 35% 18%)">${esc(initials(p.name))}</div>
    ${p.image ? `<img loading="lazy" src="/api/people/${+p.id}/image" alt="" data-fb="1">` : ''}</div>`;
}
const personCard = (p, sub = '') => `<a class="card pcard" href="#/person/${+p.id}">${personArt(p)}<div class="t">${esc(p.name)}</div><div class="s">${esc(sub)}</div></a>`;
function castShelf(it) {
  if (!it.cast?.length) return '';
  return `<section class="section"><h2>Rollista</h2><div class="shelf people">${it.cast.map(p => personCard(p, p.role === 'cast' ? p.character || '' : ROLE_NAME[p.role] || '')).join('')}</div></section>`;
}
const fmtDay = (d) => { const t = new Date(d + 'T12:00:00'); return isNaN(t) ? d : t.toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' }); };
views.person = async (id) => {
  const p = await api('/people/' + encodeURIComponent(id));
  const age = p.birthday ? Math.floor(((p.deathday ? new Date(p.deathday) : new Date()) - new Date(p.birthday)) / 31557600000) : null;
  const life = [p.birthday ? `Född ${fmtDay(p.birthday)}${!p.deathday && age ? ` (${age} år)` : ''}` : '', p.birthplace || '',
    p.deathday ? `Död ${fmtDay(p.deathday)}${age ? ` (${age} år)` : ''}` : ''].filter(Boolean);
  const roleText = (i) => i.roles.map(r => r.role === 'cast' ? (r.character || 'Medverkar') : ROLE_NAME[r.role] || r.role).join(', ');
  main.innerHTML = `<div class="person-head"><div class="card pcard">${personArt(p)}</div>
    <div><h1>${esc(p.name)}</h1><div class="meta">${life.map(x => `<span>${esc(x)}</span>`).join('')}</div>
    ${p.bio ? `<p class="overview bio clamp" id="bio">${esc(p.bio)}</p><button class="ghost small" id="biomore" hidden>Visa mer</button>` : ''}</div></div>
    <section class="section"><h2>I biblioteket <span class="muted small">${p.items.length} ${p.items.length === 1 ? 'titel' : 'titlar'}</span></h2>
    <div class="grid">${p.items.map(i => `<div>${card(i)}<div class="role">${esc(roleText(i))}</div></div>`).join('')}</div></section>`;
  const bio = $('#bio');
  if (bio && bio.scrollHeight > bio.clientHeight + 4) {
    $('#biomore').hidden = false;
    $('#biomore').onclick = (e) => { const closed = bio.classList.toggle('clamp'); e.currentTarget.textContent = closed ? 'Visa mer' : 'Visa mindre'; };
  }
};

// ---------- Trailers ----------
function trailerBtns(it) {
  const local = (it.trailers || []).map(t => `<button class="ghost" data-trailer="${+t.id}">▶ ${esc(t.name)}</button>`).join('');
  // YouTube öppnas i ny flik (CSP tillåter inte inbäddning)
  const yt = it.youtube ? `<a class="btn" href="https://www.youtube.com/watch?v=${encodeURIComponent(it.youtube)}" target="_blank" rel="noopener noreferrer">Trailer (YouTube)</a>` : '';
  return local + yt;
}
function bindTrailers(it) {
  $$('[data-trailer]').forEach(b => b.onclick = () => playTrailer(+b.dataset.trailer, it.title));
}
function playTrailer(id, title) {
  const d = document.createElement('dialog');
  d.className = 'wide trailer';
  d.innerHTML = `<h2>${esc(title)} – trailer</h2><video controls autoplay playsinline src="/api/trailers/${+id}/stream"></video>
    <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="ghost" id="tclose">Stäng</button></div>`;
  document.body.append(d); d.showModal();
  const v = $('video', d);
  v.onerror = () => toast('Trailern kan inte spelas i webbläsaren (filformatet stöds inte)');
  const leave = onLeave(() => { if (d.open) d.close(); });
  d.onclose = () => { leaveFns.delete(leave); v.onerror = null; stopVideo(v); d.remove(); };
  $('#tclose', d).onclick = () => d.close();
}

// ---------- Årssammanfattning ----------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
views.wrapped = async (year, uid) => {
  year = parseInt(year) || new Date().getFullYear();
  const w = await api(`/wrapped/${year}${uid ? '?user=' + encodeURIComponent(uid) : ''}`);
  const h = (x) => (x || 0).toLocaleString('sv-SE', { maximumFractionDigits: 1 });
  const yrs = [...new Set([year, new Date().getFullYear(), ...w.years])].sort((a, b) => b - a);
  const other = w.user.id !== me.id;
  const maxM = Math.max(1, ...w.video.months);
  const empty = !w.video.plays && !w.music.plays && !w.books.list.length;
  const rows = (list, f) => list.length ? `<table>${list.map((x, i) => `<tr><td class="muted">${i + 1}</td>${f(x)}</tr>`).join('')}</table>` : '<p class="muted">–</p>';
  main.innerHTML = `<div class="toolbar"><h1>${other ? 'Året för ' + esc(w.user.name) : 'Ditt år'} – ${year}</h1>
    <select id="wy" aria-label="År">${yrs.map(y => `<option value="${y}"${y === year ? ' selected' : ''}>${y}</option>`).join('')}</select>
    ${w.users ? `<select id="wu" aria-label="Användare">${w.users.map(u => `<option value="${+u.id}"${u.id === w.user.id ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}</select>` : ''}</div>
    ${empty ? `<div class="empty"><h2>Ingen statistik för ${year}</h2><p>Titta på film och serier eller lyssna på musik och ljudböcker så fylls sammanfattningen på.</p></div>` : `
    <p class="wrap-hero">${other ? esc(w.user.name) : 'Du'} tittade och lyssnade i <b>${h(w.hours)} timmar</b> under ${year}${w.topGenre ? ` – favoritgenren var <b>${esc(w.topGenre)}</b>` : ''}.</p>
    <div class="tiles">
      <div class="tile"><b>${h(w.video.hours)} h</b><span>film och tv</span></div>
      <div class="tile"><b>${w.video.movies}</b><span>filmer</span></div>
      <div class="tile"><b>${w.video.episodes}</b><span>avsnitt</span></div>
      <div class="tile"><b>${h(w.music.hours)} h</b><span>musik (${w.music.plays} spelningar)</span></div>
      <div class="tile"><b>${h(w.books.hours)} h</b><span>ljudböcker</span></div>
      <div class="tile"><b>${esc(w.topGenre || '–')}</b><span>favoritgenre</span></div>
    </div>
    ${w.video.titles.length ? `<section class="section"><h2>Mest sett</h2><div class="shelf">${w.video.titles.map((t, i) =>
      `<a class="card" href="#/item/${+t.id}">${art({ id: t.id, title: t.title, kind: 'movie', poster: true })}<div class="t">${i + 1}. ${esc(t.title)}</div>
      <div class="s">${t.plays} ${t.plays === 1 ? 'gång' : 'gånger'}</div></a>`).join('')}</div></section>` : ''}
    ${w.video.plays ? `<div class="panel"><h2>Uppspelningar per månad</h2><div class="bars">${w.video.months.map((n, i) =>
      `<div class="bar" title="${MONTHS[i]}: ${n}"><i style="height:${Math.max(2, n / maxM * 100)}%"></i><span>${MONTHS[i]}</span></div>`).join('')}</div></div>` : ''}
    <div class="grid2">
      <div class="panel"><h2>Genrer</h2>${rows(w.video.genres, g => `<td>${esc(g.name)}</td><td class="r">${g.plays}</td>`)}</div>
      <div class="panel"><h2>Mest spelade artister</h2>${rows(w.music.artists, a => `<td><a href="#/artist/${+a.id}">${esc(a.name)}</a></td><td class="r">${a.plays} ggr</td>`)}</div>
      <div class="panel"><h2>Mest spelade låtar</h2>${rows(w.music.tracks, t => `<td>${t.album ? `<a href="#/album/${+t.album}">${esc(t.title)}</a>` : esc(t.title)}<div class="muted small">${esc(t.artist || '')}</div></td><td class="r">${t.plays} ggr</td>`)}</div>
      <div class="panel"><h2>Ljudböcker</h2>${rows(w.books.list, b => `<td><a href="#/book/${+b.id}">${esc(b.title)}</a><div class="muted small">${esc(b.author || '')}</div></td><td class="r">${b.finished ? 'Utläst' : 'Påbörjad'}</td>`)}</div>
    </div>`}`;
  const go = () => { const u = $('#wu')?.value; location.hash = `#/wrapped/${$('#wy').value}${u && +u !== me.id ? '/' + u : ''}`; };
  $('#wy').onchange = go;
  if ($('#wu')) $('#wu').onchange = go;
};

// ---------- Profiler: "Vem tittar?" ----------
views.profiles = async () => {
  const d = await api('/profiles');
  $('#top').hidden = true;
  main.innerHTML = `<div class="profiles"><h1>Vem tittar?</h1><div class="plist">${d.profiles.map(p => {
    const h = hue(p.name);
    return `<button class="pcard" data-pid="${p.id}" data-pin="${p.hasPin ? 1 : 0}" data-kid="${p.kid ? 1 : 0}">
      <span class="pav" style="background:${esc(safeColor(p.color)) || `hsl(${h} 55% 45%)`}">${esc(p.name.slice(0, 1).toUpperCase())}</span>
      <span>${esc(p.name)}</span>${p.kid ? `<small class="muted">Barn · max ${p.maxAge} år</small>` : p.hasPin ? '<small class="muted">🔒 PIN</small>' : ''}</button>`;
  }).join('')}</div>
  <div class="row" style="justify-content:center;margin-top:30px"><button class="ghost" id="pdone">Fortsätt som ${esc(me.name)}</button></div></div>`;
  $('#pdone').onclick = () => { $('#top').hidden = false; location.hash = '#/'; };
  $$('[data-pid]').forEach(b => b.onclick = async () => {
    const id = +b.dataset.pid;
    if (id === me.id) { $('#top').hidden = false; location.hash = '#/'; return; }
    const body = { id };
    const attempt = async () => {
      const r = await fetch('/api/profiles/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (j.needPin) { const pin = prompt(body.pin ? 'Fel PIN – försök igen:' : 'Ange PIN för profilen:'); if (!pin) return; body.pin = pin; return attempt(); }
      if (j.needPassword) { const pw = prompt('Ange huvudkontots lösenord:'); if (!pw) return; body.password = pw; return attempt(); }
      if (!r.ok) return toast(j.error || 'Kunde inte byta profil');
      stopAudio(); // framsteg ska inte sparas på den nya profilen
      await boot(); location.hash = '#/';
    };
    act(attempt)();
  });
};

async function refreshMeta(it) {
  toast('Uppdaterar…');
  try { await api(`/items/${it.id}/refresh`, { method: 'POST', body: {} }); toast('Klart'); route(); }
  catch (e) { toast(e.message); }
}
function matchItem(it) {
  const d = document.createElement('dialog');
  d.className = 'wide';
  d.innerHTML = `<h2>Välj rätt ${it.kind === 'show' ? 'serie' : 'film'}</h2>
    <form id="mf" class="row" style="align-items:flex-end"><div style="flex:1;min-width:180px"><label>Sök</label><input id="mq" value="${esc(it.title)}"></div>
    <div><label>År</label><input id="my" type="number" value="${it.year || ''}" style="width:100px"></div><button class="primary">Sök</button></form>
    <div id="mres" class="matchgrid"><div class="spin"></div></div>
    <div class="row" style="margin-top:14px;justify-content:space-between"><span class="muted small" id="mlock"></span><span><button class="ghost" id="munlock" hidden>Lås upp (automatisk matchning)</button> <button class="ghost" id="mclose">Stäng</button></span></div>`;
  document.body.append(d); d.showModal();
  const close = () => { d.close(); d.remove(); };
  $('#mclose', d).onclick = close;
  const search = async () => {
    $('#mres', d).innerHTML = '<div class="spin"></div>';
    try {
      const r = await api(`/items/${it.id}/match?q=${encodeURIComponent($('#mq', d).value)}&year=${encodeURIComponent($('#my', d).value)}`);
      $('#mlock', d).textContent = r.locked ? 'Matchningen är låst och ändras inte vid omskanning.' : '';
      $('#munlock', d).hidden = !r.locked;
      $('#mres', d).innerHTML = r.results.map(x => `<button class="mcard${x.id === r.current ? ' on' : ''}" data-tid="${x.id}">
        ${x.poster ? `<img src="${esc(x.poster)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
        <div><b>${esc(x.title)}</b> ${x.year ? `<span class="muted">(${x.year})</span>` : ''}${x.original && x.original !== x.title ? `<div class="muted small">${esc(x.original)}</div>` : ''}
        <div class="small muted">${esc(x.overview)}</div></div></button>`).join('') || '<p class="muted">Inga träffar – prova en annan stavning eller originaltiteln.</p>';
      $$('[data-tid]', d).forEach(b => b.onclick = async () => {
        b.disabled = true;
        try { await api(`/items/${it.id}/match`, { method: 'POST', body: { tmdbId: +b.dataset.tid } }); toast('Matchat'); close(); route(); }
        catch (e) { toast(e.message); b.disabled = false; }
      });
    } catch (e) { $('#mres', d).innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  };
  $('#mf', d).onsubmit = (e) => { e.preventDefault(); search(); };
  $('#munlock', d).onclick = act(async () => { await api(`/items/${it.id}/match`, { method: 'POST', body: { unlock: true } }); toast('Upplåst – matchas automatiskt vid nästa skanning'); close(); });
  search();
}
function editItem(it) {
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog"><h2>Redigera</h2>
    <label>Titel</label><input id="et" value="${esc(it.title)}">
    <label>År</label><input id="ey" type="number" value="${it.year || ''}">
    <label>Beskrivning</label><textarea id="eo" rows="4">${esc(it.overview || '')}</textarea>
    ${it.kind !== 'episode' ? `<label>Åldersgräns (år, tomt = okänd)</label><input id="eage" type="number" min="0" max="18" value="${it.age ?? ''}">` : ''}
    <div class="row" style="margin-top:18px;justify-content:flex-end"><button value="cancel" class="ghost">Avbryt</button><button value="ok" class="primary">Spara</button></div></form>`;
  document.body.append(d); d.showModal();
  d.onclose = async () => {
    if (d.returnValue === 'ok') {
      try {
        await api(`/items/${it.id}`, { method: 'PUT', body: { title: $('#et', d).value, year: $('#ey', d).value, overview: $('#eo', d).value, ...($('#eage', d) ? { age: $('#eage', d).value } : {}) } });
        toast('Sparat'); route();
      } catch (e) { toast(e.message); }
    }
    d.remove();
  };
}

const EVENTS = { login_ok: 'Inloggning', login_fail: 'Misslyckad inloggning', login_locked: 'Spärrad inloggning', login_denied: 'Nekad inloggning',
  setup: 'Server konfigurerad', password_changed: 'Lösenord bytt', '2fa_enabled': '2FA aktiverad', '2fa_disabled': '2FA avstängd',
  '2fa_recovery_used': 'Reservkod använd', '2fa_recovery_regenerated': 'Nya reservkoder', session_revoked: 'Enhet utloggad', sessions_revoked_all: 'Alla enheter utloggade',
  user_created: 'Användare skapad', user_updated: 'Användare ändrad', user_deleted: 'Användare borttagen', settings_changed: 'Inställningar ändrade',
  admin_denied: 'Admin nekad (utifrån)', passkey_added: 'Passkey tillagd', passkey_removed: 'Passkey borttagen', passkey_add_fail: 'Passkey misslyckades', acme_obtain: 'Certifikat begärt', library_added: 'Bibliotek tillagt', library_removed: 'Bibliotek borttaget' };
const fmtDate = (t) => t ? new Date(t * 1000).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) : '–';
const device = (ua) => {
  ua = ua || '';
  if (/BraXhnTV-Android|Android.*Automotive/i.test(ua)) return 'Android-app';
  if (/CFNetwork|Darwin|BraXhnTV/i.test(ua)) return 'iPhone/iPad/Apple TV-app';
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Okänd';
  const o = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${o ? ' på ' + o : ''}`;
};
function loadQr() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  return new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/vendor/qrcode.min.js'; s.onload = () => ok(window.qrcode); s.onerror = no; document.head.append(s); });
}
function showCodes(codes) {
  const d = document.createElement('dialog');
  d.innerHTML = `<h2>Dina reservkoder</h2><p class="muted">Spara dem säkert (t.ex. i en lösenordshanterare). Varje kod kan användas <b>en gång</b> om du tappar telefonen. De visas bara nu.</p>
    <pre style="font-size:17px;line-height:1.7;background:var(--bg3);padding:14px;border-radius:8px;columns:2">${codes.map(esc).join('\n')}</pre>
    <div class="row" style="justify-content:flex-end"><button class="ghost" id="cp">Kopiera</button><button class="primary" id="ok">Jag har sparat dem</button></div>`;
  document.body.append(d); d.showModal();
  $('#cp', d).onclick = () => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Kopierat'));
  $('#ok', d).onclick = () => { d.close(); d.remove(); route(); };
}

views.account = async () => {
  const [tfa, sess, pks, TR] = await Promise.all([api('/me/2fa'), api('/me/sessions'), api('/me/passkeys'), api('/me/trakt')]);
  main.innerHTML = `
  <div class="panel"><h2>Mitt konto – ${esc(me.name)}</h2>
    <h3 style="font-size:15px;margin:0 0 4px">Byt lösenord</h3>
    <form id="pw"><label>Nuvarande lösenord</label><input type="password" id="c" autocomplete="current-password" required>
    <label>Nytt lösenord</label><input type="password" id="n1" autocomplete="new-password" minlength="10" required>
    <p class="muted small" style="margin:6px 0 0">Minst 10 tecken med tre olika teckentyper, eller en lösenfras på minst 14 tecken. Andra enheter loggas ut.</p>
    <div class="row" style="margin-top:12px"><button class="primary">Byt lösenord</button></div></form>
  </div>
  <div class="panel"><h2>Årssammanfattning</h2>
    <p class="muted small">Det du har sett och lyssnat på mest under året: titlar, timmar, favoritgenre, musik och ljudböcker.</p>
    <div class="row"><a class="btn" href="#/wrapped/${new Date().getFullYear()}">Visa ${new Date().getFullYear()}</a></div></div>
  <div class="panel"><h2>Tvåstegsverifiering ${tfa.enabled ? '<span class="ok-badge">På</span>' : '<span class="warn-badge">Av</span>'}</h2>
    ${tfa.enabled ? `<p class="muted">Inloggning kräver en kod från din autentiseringsapp. Reservkoder kvar: <b>${tfa.recoveryLeft}</b>.</p>
      <div class="row"><button class="ghost" id="newrc">Skapa nya reservkoder</button><button class="danger" id="off">Stäng av</button></div>`
    : `<p class="muted">Skyddar kontot även om lösenordet läcker. Fungerar med t.ex. Google Authenticator, Microsoft Authenticator, 1Password eller Bitwarden.${tfa.required ? ' <b>Krävs för att logga in utanför hemmet.</b>' : ''}</p>
      <div id="tfasetup"><button class="primary" id="on">Aktivera tvåstegsverifiering</button></div>`}
  </div>
  ${!me.kid ? `<div class="panel"><h2>Passkeys</h2>
    <p class="muted small">Logga in med Face ID, Touch ID, Windows Hello eller en säkerhetsnyckel i stället för lösenord. En passkey räknas som tvåstegsverifiering och kan inte nätfiskas. Kräver HTTPS och att du når servern via ett domännamn (inte en IP-adress).</p>
    ${pks.length ? `<table>${pks.map(k => `<tr><td>${esc(k.name || 'Passkey')}</td><td class="muted small">Skapad ${fmtDate(k.created)} · senast använd ${fmtDate(k.last_used)}</td>
      <td class="r"><button class="danger small" data-pkdel="${esc(k.id)}">Ta bort</button></td></tr>`).join('')}</table>` : ''}
    <div class="row" style="margin-top:12px">${passkeyOk() ? '<button class="primary" id="pkadd">Lägg till passkey</button>' : '<span class="muted">Passkeys kräver HTTPS (eller localhost) i den här webbläsaren.</span>'}</div></div>` : ''}
  ${!me.kid ? `<div class="panel"><h2>Profiler i hushållet</h2>
    <p class="muted small">Profiler delar inloggning men har egen tittarhistorik och Min lista. Barnprofiler ser bara titlar upp till sin åldersgräns. Med PIN kan barnen inte byta till vuxnas profiler.</p>
    <div id="proflist"><div class="spin"></div></div>
    <form id="addprof" class="row" style="margin-top:12px;align-items:flex-end">
      <div style="flex:1;min-width:140px"><label>Namn</label><input id="pn" required maxlength="40"></div>
      <div><label>Åldersgräns</label><select id="pa"><option value="">Vuxen (ingen)</option><option value="0">Barntillåten</option><option value="7">7 år</option><option value="11">11 år</option><option value="13">13 år</option><option value="15">15 år</option></select></div>
      <div><label>PIN (valfri)</label><input id="pp" inputmode="numeric" maxlength="8" style="width:110px"></div>
      <button class="primary">Lägg till profil</button></form></div>` : ''}
  ${TR.enabled ? `<div class="panel"><h2>Trakt ${TR.connected ? '<span class="ok-badge">Kopplat</span>' : ''}</h2>
    ${TR.connected ? `<p class="muted small">Kopplat till <b>${esc(TR.username || '')}</b>. Det du ser markeras på Trakt och det du sett på andra ställen markeras här. Synkas var 6:e timme${TR.last_sync ? ', senast ' + fmtDate(TR.last_sync) : ''}.${TR.sync_error ? ' <span class="err">' + esc(TR.sync_error) + '</span>' : ''}</p>
      <div class="row"><button class="ghost" id="trsync">Synka nu</button><button class="danger" id="troff">Koppla från</button></div>`
    : `<p class="muted small">Synka vad du sett med Trakt.tv – åt båda hållen.</p><div id="trbox"><button class="primary" id="tron">Koppla Trakt</button></div>`}</div>` : ''}
  <div class="panel" id="listenprefs"></div>
  <div class="panel"><h2>Inloggade enheter</h2>
    <table><tr><th>Enhet</th><th>IP</th><th>Senast aktiv</th><th></th></tr>
    ${sess.map(s => `<tr><td>${esc(device(s.ua))}${s.current ? ' <span class="ok-badge">Den här</span>' : ''}</td><td class="muted">${esc(s.ip || '–')}</td><td class="muted">${fmtDate(s.last_seen)}</td>
      <td class="r">${s.current ? '' : `<button class="ghost small" data-rev="${s.id}">Logga ut</button>`}</td></tr>`).join('')}</table>
    <div class="row" style="margin-top:12px"><button class="ghost" id="revall">Logga ut alla andra enheter</button></div>
  </div>`;
  $('#pw').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/me/password', { method: 'POST', body: { current: $('#c').value, password: $('#n1').value } }); toast('Lösenordet är bytt – andra enheter är utloggade'); route(); }
    catch (er) { toast(er.message); }
  };
  $$('[data-rev]').forEach(b => b.onclick = act(async () => { await api('/me/sessions/' + b.dataset.rev, { method: 'DELETE' }); route(); }));
  renderListenPrefs($('#listenprefs')).catch(e => { if (!e?.aborted) $('#listenprefs').hidden = true; });
  if ($('#tron')) $('#tron').onclick = async () => {
    try {
      const r = await api('/me/trakt/connect', { method: 'POST' });
      $('#trbox').innerHTML = `<p>Gå till <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a> och ange koden:</p><p style="font-size:32px;letter-spacing:6px;font-weight:800">${esc(r.userCode)}</p><p class="muted small" id="trst">Väntar…</p>`;
      const tick = async () => {
        const p = await api('/me/trakt/poll', { method: 'POST' }).catch(e => { if (e.aborted) throw e; return { status: 'pending' }; });
        if (p.status === 'connected') { toast('Trakt kopplat – synkar'); route(); }
        else if (p.status === 'pending') later(tick, (r.interval || 5) * 1000);
        else if ($('#trst')) $('#trst').textContent = p.status === 'denied' ? 'Nekades på Trakt.' : 'Koden gick ut – försök igen.';
      };
      later(tick, (r.interval || 5) * 1000);
    } catch (e) { toast(e.message); }
  };
  if ($('#trsync')) $('#trsync').onclick = async () => { try { const r = await api('/me/trakt/sync', { method: 'POST' }); toast(`Synkat: ${r.imported} markerade här, ${r.exported} skickade till Trakt`); route(); } catch (e) { toast(e.message); } };
  if ($('#troff')) $('#troff').onclick = act(async () => { if (confirm('Koppla från Trakt?')) { await api('/me/trakt', { method: 'DELETE' }); route(); } });
  $$('[data-pkdel]').forEach(b => b.onclick = act(async () => { if (confirm('Ta bort passkeyn?')) { await api('/me/passkeys/' + encodeURIComponent(b.dataset.pkdel), { method: 'DELETE' }); route(); } }));
  if ($('#pkadd')) $('#pkadd').onclick = async () => {
    const password = prompt('Ange ditt lösenord för att lägga till en passkey:'); if (!password) return;
    // Med tvåstegsverifiering krävs även en kod (en passkey loggar in utan den)
    const code = me?.totp ? prompt('Ange koden från din autentiseringsapp:') : undefined; if (me?.totp && !code) return;
    const name = prompt('Namn på passkeyn (t.ex. "iPhone" eller "Jobbdator"):', device(navigator.userAgent)) || 'Passkey';
    try { await passkeyRegister(password, name, code); toast('Passkey tillagd'); route(); }
    catch (e) { toast(e.name === 'NotAllowedError' ? 'Avbrutet' : e.name === 'InvalidStateError' ? 'Den här enheten har redan en passkey för kontot' : e.message); }
  };
  if ($('#proflist')) {
    const P2 = await api('/profiles');
    $('#proflist').innerHTML = `<table>${P2.profiles.map(p => `<tr><td>${esc(p.name)}${p.owner ? ' <span class="muted small">(huvudkonto)</span>' : ''}</td>
      <td class="muted small">${p.kid ? (p.maxAge === 0 ? 'Barntillåten' : 'max ' + p.maxAge + ' år') : 'Vuxen'}${p.hasPin ? ' · PIN' : ''}</td>
      <td class="r">${p.owner ? '' : `<button class="ghost small" data-pst="${p.id}">Skärmtid</button>`}<button class="ghost small" data-ppin="${p.id}">${p.hasPin ? 'Byt/ta bort PIN' : 'Sätt PIN'}</button>
      ${p.owner ? '' : `<button class="danger small" data-pdel="${p.id}">Ta bort</button>`}</td></tr>`).join('')}</table>`;
    $$('[data-ppin]').forEach(b => b.onclick = async () => {
      const pin = prompt('Ny PIN (4–8 siffror). Lämna tomt för att ta bort PIN:'); if (pin === null) return;
      try { await api('/profiles/' + b.dataset.ppin, { method: 'PUT', body: { pin } }); toast('Sparat'); route(); } catch (e) { toast(e.message); }
    });
    $$('[data-pst]').forEach(b => b.onclick = act(() => screenDialog(P2.profiles.find(p => p.id === +b.dataset.pst))));
    $$('[data-pdel]').forEach(b => b.onclick = act(async () => { if (confirm('Ta bort profilen och dess tittarhistorik?')) { await api('/profiles/' + b.dataset.pdel, { method: 'DELETE' }); route(); } }));
    $('#addprof').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/profiles', { method: 'POST', body: { name: $('#pn').value, maxAge: $('#pa').value, pin: $('#pp').value } }); toast('Profil skapad'); route(); }
      catch (er) { toast(er.message); }
    };
  }
  $('#revall').onclick = act(async () => { if (confirm('Logga ut alla andra enheter, inklusive appar?')) { await api('/me/sessions/revoke-others', { method: 'POST' }); toast('Utloggade'); route(); } });
  if ($('#on')) $('#on').onclick = act(async () => {
    const r = await api('/me/2fa/setup', { method: 'POST' });
    $('#tfasetup').innerHTML = `<ol style="padding-left:18px;line-height:1.7">
      <li>Skanna QR-koden med din autentiseringsapp<div id="qr" style="background:#fff;display:inline-block;padding:10px;border-radius:8px;margin:8px 0"></div></li>
      <li>Eller ange nyckeln manuellt: <code style="user-select:all;word-break:break-all">${esc(r.secret.replace(/(.{4})/g, '$1 ').trim())}</code></li>
      <li>Skriv in den sexsiffriga koden som visas i appen:</li></ol>
      <div class="row"><input id="tc" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="max-width:160px;font-size:20px;letter-spacing:4px">
      <input id="tpw" type="password" autocomplete="current-password" placeholder="Ditt lösenord" style="max-width:220px"><button class="primary" id="tcok">Bekräfta</button></div>`;
    loadQr().then(q => { const el = $('#qr'); if (!el) return; const qr = q(0, 'M'); qr.addData(r.uri); qr.make(); el.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0 }); })
      .catch(() => { const el = $('#qr'); if (el) el.outerHTML = '<span class="muted">(QR-koden kunde inte laddas – använd nyckeln nedan)</span>'; });
    $('#tc').focus();
    $('#tcok').onclick = async () => {
      try { const res = await api('/me/2fa/enable', { method: 'POST', body: { code: $('#tc').value, password: $('#tpw').value } }); showCodes(res.recoveryCodes); }
      catch (e) { toast(e.message); }
    };
  });
  if ($('#off')) $('#off').onclick = async () => {
    const password = prompt('Ange ditt lösenord för att stänga av tvåstegsverifiering:'); if (!password) return;
    const code = prompt('Ange en kod från autentiseringsappen (eller en reservkod):'); if (!code) return;
    try { await api('/me/2fa/disable', { method: 'POST', body: { password, code } }); toast('Tvåstegsverifiering avstängd'); route(); } catch (e) { toast(e.message); }
  };
  if ($('#newrc')) $('#newrc').onclick = async () => {
    const password = prompt('Ange ditt lösenord:'); if (!password) return;
    try { const r = await api('/me/2fa/recovery', { method: 'POST', body: { password } }); showCodes(r.recoveryCodes); } catch (e) { toast(e.message); }
  };
  await accountExtras();
};


// ---------- ljudböcker ----------
const bookCover = (b, cls = '') => `<div class="cover book ${cls}" style="--h1:hsl(${hue(String(b.id))} 35% 30%);--h2:hsl(${(hue(String(b.id)) + 60) % 360} 40% 15%)">${b.cover ? `<img loading="lazy" src="/api/audiobooks/cover/${b.id}" alt="" data-fb="1">` : `<span>${esc((b.title || '').slice(0, 40))}</span>`}</div>`;
const bookCard = (b) => `<a class="card mcard" href="#/book/${b.id}">${bookCover(b)}${b.duration && b.position ? `<div class="prog"><i style="width:${Math.min(100, b.position / b.duration * 100)}%"></i></div>` : ''}
  <div class="t">${esc(b.title)}</div><div class="s">${esc(b.author || '')}${b.finished ? ' · ✓' : ''}</div></a>`;
views.books = async (lid) => {
  const sort = store.get('booksort', 'title');
  const B = await api(`/audiobooks/${lid}?sort=${sort}`);
  main.innerHTML = `<div class="toolbar"><h1>${esc(B.library.name)}</h1><span class="muted">${B.books.length} böcker</span>
    <select id="bsort" style="margin-left:auto">${[['title', 'Titel'], ['author', 'Författare'], ['added', 'Senast tillagda'], ['recent', 'Senast lyssnade']].map(([v, n]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    ${B.continue.length ? `<section class="section"><h2>Fortsätt lyssna</h2><div class="shelf">${B.continue.map(bookCard).join('')}</div></section>` : ''}
    ${B.books.length ? `<div class="grid">${B.books.map(bookCard).join('')}</div>` : '<div class="empty"><p>Inga ljudböcker ännu. Lägg dem i mappar som <code>Författare/Boktitel/</code> – en .m4b-fil eller flera mp3-filer per bok.</p></div>'}`;
  $('#bsort').onchange = (e) => { store.set('booksort', e.target.value); route(); };
};
function bookSpoken(b) {
  return { kind: 'book', id: b.id, title: b.title, sub: b.author, link: `#/book/${b.id}`, cover: b.cover ? `/api/audiobooks/cover/${b.id}` : null,
    duration: b.duration, position: b.position, speed: b.speed, chapters: b.chapters,
    files: b.files.map(f => ({ id: f.id, offset: f.offset, duration: f.duration, url: `/api/audiobooks/files/${f.id}/stream?a=${audioCaps()}` })) };
}
views.book = async (id) => {
  const b = await api('/audiobooks/book/' + id);
  const left = b.duration ? b.duration - b.position : 0;
  main.innerHTML = `<div class="mhero">${bookCover(b, 'big')}<div><div class="muted small">LJUDBOK</div><h1>${esc(b.title)}</h1>
    <div class="meta"><span>${esc(b.author || '')}</span>${b.narrator ? `<span>Uppläsare: ${esc(b.narrator)}</span>` : ''}${b.year ? `<span>${b.year}</span>` : ''}<span>${fmtDur(b.duration)}</span>
      ${b.position > 30 ? `<span>${fmtDur(left)} kvar</span>` : ''}${b.finished ? '<span>✓ Utläst</span>' : ''}</div>
    <div class="row"><button class="primary" id="bp">${b.position > 30 ? '▶ Fortsätt' : '▶ Lyssna'}</button>${b.position > 30 || b.finished ? '<button class="ghost" id="bstart">Börja om</button>' : ''}
      <button class="ghost" id="bmark">🔖 Bokmärke</button>${b.finished ? '' : '<button class="ghost" id="bdone">Markera som utläst</button>'}</div>
    ${b.description ? `<p class="overview">${esc(b.description)}</p>` : ''}</div></div>
    ${b.bookmarks.length ? `<section class="section"><h2>Bokmärken</h2><table>${b.bookmarks.map(m => `<tr><td><button class="ghost small" data-bm="${m.position}">${fmtTime(m.position)}</button></td><td>${esc(m.note || '')}</td><td class="muted small">${fmtDate(m.created)}</td><td class="r"><button class="ghost small" data-bmdel="${m.id}">✕</button></td></tr>`).join('')}</table></section>` : ''}
    <section class="section"><h2>Kapitel</h2><table class="tracks">${b.chapters.map((c, i) => `<tr data-chs="${c.start}" class="${c.start <= b.position && b.position < c.end ? 'playing' : ''}"><td class="muted" style="width:40px">${i + 1}</td><td>${esc(c.title)}</td><td class="r muted">${fmtTime(c.end - c.start)}</td></tr>`).join('')}</table></section>
    ${b.sameAuthor.length ? `<section class="section"><h2>Mer av ${esc(b.author)}</h2><div class="shelf">${b.sameAuthor.map(x => bookCard({ ...x, author: b.author })).join('')}</div></section>` : ''}`;
  const sp = bookSpoken(b);
  $('#bp').onclick = () => playSpoken(sp);
  if ($('#bstart')) $('#bstart').onclick = () => playSpoken({ ...sp, position: 0 });
  $$('[data-chs]').forEach(r => keyClick(r).onclick = () => { if (M.spoken?.kind === 'book' && M.spoken.id === b.id) spokenSeek(+r.dataset.chs + 0.01); else playSpoken({ ...sp, position: +r.dataset.chs + 0.01 }); });
  $$('[data-bm]').forEach(x => x.onclick = () => { if (M.spoken?.kind === 'book' && M.spoken.id === b.id) spokenSeek(+x.dataset.bm); else playSpoken({ ...sp, position: +x.dataset.bm }); });
  $$('[data-bmdel]').forEach(x => x.onclick = act(async () => { await api('/audiobooks/bookmarks/' + x.dataset.bmdel, { method: 'DELETE' }); route(); }));
  $('#bmark').onclick = act(async () => {
    const pos = M.spoken?.kind === 'book' && M.spoken.id === b.id ? spokenPos() : b.position;
    const note = prompt(`Bokmärke vid ${fmtTime(pos)} – anteckning (valfri):`); if (note === null) return;
    await api(`/audiobooks/book/${b.id}/bookmarks`, { method: 'POST', body: { position: pos, note } }); route();
  });
  if ($('#bdone')) $('#bdone').onclick = act(async () => { await api(`/audiobooks/book/${b.id}/progress`, { method: 'POST', body: { position: b.duration } }); route(); });
};

// ---------- poddar ----------
const podCover = (p, cls = '') => `<div class="cover ${cls}" style="--h1:hsl(${hue('p' + p.id)} 40% 30%);--h2:hsl(${(hue('p' + p.id) + 60) % 360} 45% 16%)">🎙${p.image ? `<img loading="lazy" src="/api/podcasts/${p.id}/image" alt="" data-fb="1">` : ''}</div>`;
const epRows = (eps, showPod) => `<table class="tracks">${eps.map((e, i) => `<tr data-ep="${i}"><td style="width:100%"><b>${esc(e.title)}</b>${e.played ? ' <span class="muted">✓</span>' : ''}
  <div class="muted small">${showPod ? esc(e.podcastTitle || '') + ' · ' : ''}${fmtDate(e.published)}${e.duration ? ' · ' + fmtDur(e.duration) : ''}${e.position > 0 && !e.played ? ` · ${fmtDur((e.duration || 0) - e.position)} kvar` : ''}${e.downloaded ? ' · nedladdat' : e.downloading ? ' · laddas ner…' : ''}</div></td>
  <td class="r" style="white-space:nowrap"><button class="ghost small" data-epplay="${i}">▶</button> <button class="ghost small" data-epdone="${i}" title="${e.played ? 'Markera som ej lyssnad' : 'Markera som lyssnad'}">${e.played ? '↺' : '✓'}</button></td></tr>`).join('')}</table>`;
function bindEps(eps) {
  const sp = (e) => ({ kind: 'podcast', id: e.id, title: e.title, sub: e.podcastTitle, link: `#/podcast/${e.podcast}`, cover: `/api/podcasts/${e.podcast}/image`,
    duration: e.duration || 0, position: e.played ? 0 : e.position, files: [{ id: e.id, offset: 0, duration: e.duration, url: `/api/podcasts/episodes/${e.id}/stream` }] });
  $$('[data-epplay]').forEach(b => b.onclick = () => playSpoken(sp(eps[+b.dataset.epplay])));
  $$('[data-epdone]').forEach(b => b.onclick = act(async () => { const e = eps[+b.dataset.epdone]; await api(`/podcasts/episodes/${e.id}/progress`, { method: 'POST', body: { position: 0, played: !e.played } }); route(); }));
}
views.podcasts = async () => {
  store.set('pods', '1');
  const D = await api('/podcasts');
  main.innerHTML = `<div class="toolbar"><h1>Poddar</h1></div>
    ${D.canAdd ? `<form id="padd" class="row panel" style="align-items:flex-end"><div style="flex:1;min-width:220px"><label>Prenumerera – klistra in poddens RSS-adress</label><input id="purl" placeholder="https://…/feed.xml" inputmode="url"></div><button class="primary">Lägg till</button></form>
      <p class="muted small">Tips: RSS-adressen hittar du på poddens webbplats eller genom att söka på poddens namn + "RSS". De senaste avsnitten laddas ner automatiskt.</p>` : ''}
    ${D.podcasts.length ? `<div class="grid">${D.podcasts.map(p => `<a class="card mcard" href="#/podcast/${p.id}">${podCover(p)}<div class="t">${esc(p.title || '…')}</div><div class="s">${p.unplayed ? `${p.unplayed} nya` : esc(p.author || '')}${p.error ? ' · ⚠' : ''}</div></a>`).join('')}</div>` : '<div class="empty"><p>Inga poddar ännu.</p></div>'}
    ${D.latest.length ? `<section class="section"><h2>Senaste avsnitten</h2>${epRows(D.latest, true)}</section>` : ''}`;
  bindEps(D.latest);
  if ($('#padd')) $('#padd').onsubmit = async (e) => {
    e.preventDefault(); const b = $('#padd button'); b.disabled = true; b.textContent = 'Hämtar…';
    try { const r = await api('/podcasts', { method: 'POST', body: { url: $('#purl').value } }); location.hash = '#/podcast/' + r.id; }
    catch (er) { toast(er.message); b.disabled = false; b.textContent = 'Lägg till'; }
  };
  loadLibs().catch(() => {});
};
views.podcast = async (id) => {
  const p = await api('/podcasts/' + id);
  const eps = p.episodes.map(e => ({ ...e, podcastTitle: p.title }));
  main.innerHTML = `<div class="mhero">${podCover(p, 'big')}<div><div class="muted small">PODD</div><h1>${esc(p.title || '')}</h1>
    <div class="meta"><span>${esc(p.author || '')}</span><span>${p.episodes.length} avsnitt</span>${/^https?:\/\//i.test(p.link || '') ? `<a href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">Webbplats</a>` : ''}</div>
    ${p.error ? `<p class="err small">Senaste uppdateringen misslyckades: ${esc(p.error)}</p>` : ''}
    ${p.canEdit ? `<div class="row"><button class="ghost" id="prf">Uppdatera</button><label class="small muted">Ladda ner de senaste <input id="pkeep" type="number" min="0" max="50" value="${p.keep}" style="width:64px"> avsnitten</label><button class="danger" id="pdel">Avsluta prenumeration</button></div>` : ''}
    ${p.description ? `<p class="overview">${esc(p.description)}</p>` : ''}</div></div>
    <section class="section">${epRows(eps, false)}</section>`;
  bindEps(eps);
  if (!p.canEdit) return;
  $('#prf').onclick = async () => { try { await api(`/podcasts/${id}/refresh`, { method: 'POST' }); toast('Uppdaterad'); route(); } catch (e) { toast(e.message); } };
  $('#pkeep').onchange = act(async (e) => { await api('/podcasts/' + id, { method: 'PUT', body: { keep: e.target.value } }); toast('Sparat'); });
  $('#pdel').onclick = async () => { if (confirm('Avsluta prenumerationen och ta bort nedladdade avsnitt?')) { try { await api('/podcasts/' + id, { method: 'DELETE' }); location.hash = '#/podcasts'; } catch (e) { toast(e.message); } } };
};

// ---------- live-TV ----------
const hhmm = (t) => new Date(t * 1000).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
const dayName = (t) => { const d = new Date(t * 1000), n = new Date(); const diff = Math.round((new Date(d.toDateString()) - new Date(n.toDateString())) / 864e5);
  return diff === 0 ? 'Idag' : diff === 1 ? 'Imorgon' : d.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'short' }); };
const chLogo = (c, cls = '') => `<span class="chlogo ${cls}">${c.logo ? `<img src="/api/live/logo/${c.id}" alt="" loading="lazy" data-fb="1">` : ''}<i>${esc(c.number || c.name.slice(0, 3))}</i></span>`;
let LP = null, RP = null; // live-spelare, inspelningsspelare
// Gemensamt för helskärmsspelarna i #player
// En öppen spelare får en egen post i historiken: Bakåt (t.ex. på TV-fjärrkontrollen) stänger spelaren
// i stället för att lämna sidan bakom den
let overlayHist = false;
function overlayOpen(el) {
  el.hidden = false; document.body.style.overflow = 'hidden';
  if (!history.state?.overlay) history.pushState({ overlay: 1 }, '');
  overlayHist = true;
}
function overlayClose(el) {
  el.hidden = true; el.innerHTML = ''; document.body.style.overflow = '';
  overlayHist = false;
  // Stängd med knapp/Escape: ta bort spelarens historikpost (om en ny spelare öppnas direkt behålls den)
  setTimeout(() => { if (!overlayHist && history.state?.overlay) history.back(); }, 0);
}
window.addEventListener('popstate', () => {
  if (!overlayHist || history.state?.overlay) return;
  overlayHist = false;
  if (P) closePlayer(); else { closeLive(); closeRec(); }
});
function stopVideo(v) { if (!v) return; v.pause(); v.removeAttribute('src'); v.load(); }
// Stänger öppna spelare (vanlig, live, inspelning)
function closeOverlays() { closePlayer(false); closeLive(); closeRec(); }
// Som ovan, men avbryter även en uppspelning som håller på att starta
function closeAllPlayers() { playSeq++; closeOverlays(); }
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.fullscreenElement || document.querySelector('dialog[open]')) return;
  if (RP) closeRec(); else if (LP) closeLive();
});

async function playLive(ch) {
  closeAllPlayers();
  if (M.audio && !M.audio.paused) M.audio.pause();
  const el = $('#player');
  el.innerHTML = `<video id="lvid" controls autoplay playsinline></video>
    <div class="pbar"><button class="ghost small" id="lclose">← Tillbaka</button><span class="title">${esc(ch.number ? ch.number + ' · ' : '')}${esc(ch.name)}</span>
      <span class="muted small" id="lnow">${ch.now ? esc(ch.now.title) + ' · ' + hhmm(ch.now.start) + '–' + hhmm(ch.now.stop) : ''}</span>
      <span class="muted small" id="lstat">Startar kanalen…</span>
      <button class="ghost small" id="lback" title="Spola tillbaka 30 sekunder" hidden>⏪ 30 s</button><button class="ghost small" id="lfwd" title="Spola fram 30 sekunder" hidden>30 s ⏩</button>
      <button class="small liveind" id="llive" hidden>● Live</button>
      ${ch.now ? `<button class="ghost small" id="lrec">⏺ Spela in</button>` : ''}</div>`;
  overlayOpen(el);
  const v = $('#lvid', el), stat = $('#lstat', el);
  // Lokal referens: om spelaren stängs (eller en annan öppnas) under start avbryter vi utan att röra borttagna element
  const lp = LP = { ch, hls: null, el, v };
  const cur = () => LP === lp;
  const setStat = (t) => { if (cur()) stat.textContent = t; };
  videoSession(v);
  $('#lclose', el).onclick = () => closeLive(lp);
  const rb = $('#lrec', el);
  if (rb) rb.onclick = act(async () => { await api('/dvr/program', { method: 'POST', body: { programId: ch.now.id }, bg: true }); toast('Spelar in ' + ch.now.title); rb.disabled = true; });
  try {
    const r = await api(`/live/${ch.id}/play`, { method: 'POST', bg: true });
    if (!cur()) return;
    if (v.canPlayType('application/vnd.apple.mpegurl') && !window.MediaSource) { v.src = r.url; }
    else {
      const Hls = await loadHls();
      if (!cur()) return;
      // Timeshift: servern sparar upp till några timmar bakåt. Spelaren hoppar inte själv tillbaka till live
      // (liveMaxLatencyDurationCount är oändlig som standard) och håller bara en kort buffert bakåt i minnet.
      const hls = lp.hls = new Hls({ liveSyncDurationCount: 3, backBufferLength: 90, xhrSetup: (x) => { x.withCredentials = true; } });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal || !cur() || lp.hls !== hls) return;
        if (d.response?.code === 403) { hls.destroy(); lp.hls = null; if (screenSt?.limited) { closeLive(lp); timeUp(); } else setStat('Uppspelningen nekades'); }
        else if (d.response?.code === 409 || d.response?.code === 502) { setStat(d.response.code === 409 ? 'Alla tuners används' : 'Kanalen kunde inte startas'); hls.destroy(); lp.hls = null; }
        else if (d.type === 'networkError') setTimeout(() => { if (cur() && lp.hls === hls) hls.startLoad(); }, 1500);
        else if (d.type === 'mediaError') hls.recoverMediaError();
      });
      hls.loadSource(r.url); hls.attachMedia(v);
    }
    v.addEventListener('playing', () => { setStat(''); liveControls(lp); }, { once: true });
    v.play().catch(() => {});
  } catch (e) { setStat(e.message); }
}
// Timeshift i livespelaren: spola i det sparade fönstret och "Live" som hoppar till direktsändningen när man ligger efter
function liveControls(lp) {
  const { v, el } = lp, btn = $('#llive', el), back = $('#lback', el), fwd = $('#lfwd', el);
  if (!btn || LP !== lp) return;
  const range = () => { const s = v.seekable; return s.length ? { start: s.start(0), end: s.end(s.length - 1) } : null; };
  // Direktsändningens punkt: hls.js räknar fram den, Safari ger slutet av det spolbara fönstret
  const edge = () => { const h = lp.hls?.liveSyncPosition; if (h != null && isFinite(h)) return h; const r = range(); return r ? r.end : null; };
  const seekTo = (t) => { const r = range(), e = edge(); if (!r || e == null) return; v.currentTime = Math.max(r.start + 0.5, Math.min(e, t)); };
  btn.onclick = () => { const e = edge(); if (e != null) v.currentTime = e; v.play().catch(() => {}); };
  back.onclick = () => seekTo(v.currentTime - 30);
  fwd.onclick = () => seekTo(v.currentTime + 30);
  const update = () => {
    if (LP !== lp) return clearInterval(lp.tick);
    const r = range(), e = edge();
    const canSeek = !!r && r.end - r.start > 20;
    back.hidden = fwd.hidden = !canSeek; btn.hidden = !r;
    const behind = e == null ? 0 : e - v.currentTime;
    const atLive = behind < 10 && !v.paused;
    btn.classList.toggle('on', atLive);
    btn.textContent = atLive ? '● Live' : `Gå till live (−${fmtTime(Math.max(0, behind))})`;
    fwd.disabled = behind < 10;
  };
  lp.tick = setInterval(update, 1000);
  update();
}
function closeLive(lp = LP) {
  if (!lp || LP !== lp) return;
  LP = null;
  clearInterval(lp.tick);
  if (lp.hls) { lp.hls.destroy(); lp.hls = null; }
  stopVideo(lp.v);
  overlayClose(lp.el);
  musicSession();
}
async function playRec(r, cs = {}) {
  const u = await api(`/dvr/recordings/${r.id}/play`, { method: 'POST' }); // avbryts om man hunnit lämna sidan
  closeAllPlayers();
  if (M.audio && !M.audio.paused) M.audio.pause();
  const el = $('#player');
  const ads = Array.isArray(r.commercials) ? r.commercials : [];
  el.innerHTML = `<video id="rvid" controls autoplay playsinline src="${esc(u.url)}"></video><div class="pbar"><button class="ghost small" id="rclose">← Tillbaka</button><span class="title">${esc(r.title)}${r.subtitle ? ' – ' + esc(r.subtitle) : ''}</span>
    ${ads.length ? `<label class="small"><input type="checkbox" id="rauto"> Hoppa över reklam automatiskt</label>` : ''}</div>
    <button class="skip" id="rskip" hidden>Hoppa över reklam ⏭</button>`;
  overlayOpen(el);
  const rp = RP = { el, v: $('#rvid', el) };
  videoSession(rp.v);
  screenPing(rp.v, 'r:' + r.id, () => RP === rp, () => closeRec(rp));
  $('#rclose', el).onclick = () => closeRec(rp);
  if (ads.length) recCommercials(rp, ads, cs.autoSkip);
}
// Reklamavbrott i inspelningar: knappen visas inne i ett avbrott, eller hoppas över automatiskt (val per användare i webbläsaren)
function recCommercials(rp, ads, autoDefault) {
  const { v, el } = rp, b = $('#rskip', el), auto = $('#rauto', el);
  const key = 'comskipAuto.' + (me?.id ?? '');
  auto.checked = !!store.get(key, !!autoDefault);
  auto.onchange = () => store.set(key, auto.checked);
  const skipped = new Set(); // ett avbrott hoppas bara över automatiskt en gång (spolar man tillbaka in i det får man titta)
  v.addEventListener('timeupdate', () => {
    if (RP !== rp) return;
    const t = v.currentTime, i = ads.findIndex(a => t >= a.start && t < a.end - 1);
    if (i < 0) { b.hidden = true; return; }
    if (auto.checked && !skipped.has(i)) { skipped.add(i); v.currentTime = ads[i].end; toast('Reklam överhoppad'); b.hidden = true; return; }
    b.hidden = false;
    b.onclick = () => { v.currentTime = ads[i].end; b.hidden = true; };
  });
}
function closeRec(rp = RP) {
  if (!rp || RP !== rp) return;
  RP = null;
  stopVideo(rp.v);
  overlayClose(rp.el);
  musicSession();
}
function loadLogos() {}
views.live = async () => {
  const D = await api('/live/channels');
  main.innerHTML = `<div class="toolbar"><h1>Live-TV</h1><a class="btn ghost" href="#/guide">📅 TV-guide</a><a class="btn ghost" href="#/dvr">⏺ Inspelningar</a></div>
    ${D.channels.length ? `<div class="chgrid">${D.channels.map((c, i) => `<button class="chcard" data-ch="${i}">${chLogo(c)}<div class="chinfo"><b>${esc(c.name)}</b>
      ${c.now ? `<div class="small">${esc(c.now.title)}</div><div class="prog"><i style="width:${Math.min(100, (Date.now() / 1000 - c.now.start) / (c.now.stop - c.now.start) * 100)}%"></i></div>` : '<div class="small muted">Ingen guide</div>'}
      ${c.next ? `<div class="small muted">${hhmm(c.next.start)} ${esc(c.next.title)}</div>` : ''}</div></button>`).join('')}</div>`
    : `<div class="empty"><p>Inga kanaler ännu.${me.adminHere ? ' Lägg till en HDHomeRun eller en IPTV-lista under Administration → Live-TV.' : ''}</p></div>`}`;
  $$('[data-ch]').forEach(b => b.onclick = () => playLive(D.channels[+b.dataset.ch]));
  loadLogos();
};
views.guide = async (dayOffset) => {
  const start = Math.floor(Date.now() / 1000 / 1800) * 1800 - 1800 + (+dayOffset || 0) * 86400;
  const G = await api(`/live/guide?from=${start}&hours=6`);
  const PX = 4; // px per minut
  const W = (G.to - G.from) / 60 * PX;
  const x = (t) => Math.max(0, (t - G.from) / 60 * PX);
  const nowX = x(Date.now() / 1000);
  const ticks = []; for (let t = G.from; t < G.to; t += 1800) ticks.push(t);
  main.innerHTML = `<div class="toolbar"><h1>TV-guide</h1><span class="muted">${dayName(G.from)}</span>
    <div class="row" style="margin-left:auto">${start - 21600 >= Date.now() / 1000 - 25 * 3600 ? `<a class="btn ghost small" href="#/guide/${(+dayOffset || 0) - 0.25}">← Tidigare</a>` : ''}<a class="btn ghost small" href="#/guide">Nu</a><a class="btn ghost small" href="#/guide/${(+dayOffset || 0) + 0.25}">Senare →</a><a class="btn ghost small" href="#/dvr">⏺ Inspelningar</a></div></div>
    <form id="gsearch" class="row" style="margin-bottom:12px"><input id="gq" placeholder="Sök program…" style="max-width:320px"><button class="ghost">Sök</button></form><div id="gres"></div>
    <div class="guide"><div class="gch">${'<div class="gtime-pad"></div>' + G.channels.map(c => `<div class="grow-h">${chLogo(c, 'small')}<span>${esc(c.name)}</span></div>`).join('')}</div>
      <div class="gscroll"><div style="width:${W}px;position:relative">
        <div class="gtimes">${ticks.map(t => `<span style="left:${x(t)}px">${hhmm(t)}</span>`).join('')}</div>
        ${nowX > 0 && nowX < W ? `<div class="gnow" style="left:${nowX}px"></div>` : ''}
        ${G.channels.map(c => `<div class="grow">${c.programs.map(p => { const l = x(p.start), w = Math.max(2, x(p.stop) - l - 2);
          return `<button class="gp${p.start <= Date.now() / 1000 && p.stop > Date.now() / 1000 ? ' on' : ''}" style="left:${l}px;width:${w}px" data-pid="${p.id}" title="${esc(p.title)}"><b>${esc(p.title)}</b><span>${hhmm(p.start)}${p.subtitle ? ' · ' + esc(p.subtitle) : ''}</span></button>`; }).join('')}</div>`).join('')}
      </div></div></div>
    ${G.guide.error ? `<p class="err small">Guiden kunde inte uppdateras: ${esc(G.guide.error)}</p>` : ''}`;
  $$('[data-pid]').forEach(b => b.onclick = () => programDialog(+b.dataset.pid));
  if (nowX > 200) $('.gscroll').scrollLeft = nowX - 200;
  $('#gsearch').onsubmit = act(async (e) => {
    e.preventDefault(); const q = $('#gq').value.trim(); if (!q) return;
    const r = await api('/live/search?q=' + encodeURIComponent(q));
    if (!$('#gres')) return;
    $('#gres').innerHTML = `<table>${r.map(p => `<tr data-pid2="${p.id}" style="cursor:pointer"><td>${dayName(p.start)} ${hhmm(p.start)}</td><td><b>${esc(p.title)}</b>${p.subtitle ? ' – ' + esc(p.subtitle) : ''}</td><td class="muted">${esc(p.channel)}</td></tr>`).join('') || '<tr><td class="muted">Inga träffar</td></tr>'}</table>`;
    $$('[data-pid2]').forEach(r2 => keyClick(r2).onclick = () => programDialog(+r2.dataset.pid2));
  });
  loadLogos();
};
async function programDialog(id) {
  let p;
  try { p = await api('/live/programs/' + id); } catch (e) { toast(e.message); return; }
  const nowT = Date.now() / 1000, onNow = p.start <= nowT && p.stop > nowT;
  const d = document.createElement('dialog');
  d.innerHTML = `<h2>${esc(p.title)}</h2>
    <p class="muted">${esc(p.channel_name)} · ${dayName(p.start)} ${hhmm(p.start)}–${hhmm(p.stop)}${p.season ? ` · S${p.season}${p.episode ? 'E' + p.episode : ''}` : ''}${p.is_new ? ' · Nytt' : ''}${p.category ? ' · ' + esc(p.category) : ''}</p>
    ${p.subtitle ? `<p><b>${esc(p.subtitle)}</b></p>` : ''}${p.description ? `<p>${esc(p.description)}</p>` : ''}
    ${p.recording ? `<p class="ok-badge" style="display:inline-block">${{ scheduled: 'Inspelning bokad', recording: 'Spelas in nu', processing: 'Bearbetas', done: 'Inspelad' }[p.recording.status]}</p>` : ''}
    ${p.airings.length ? `<details><summary class="muted small">Fler sändningar (${p.airings.length})</summary><table>${p.airings.map(a => `<tr><td>${dayName(a.start)} ${hhmm(a.start)}</td><td class="muted">${esc(a.channel)}</td></tr>`).join('')}</table></details>` : ''}
    <div class="row" style="margin-top:16px;justify-content:flex-end;flex-wrap:wrap">
      ${onNow ? '<button class="primary" id="pdw">▶ Titta</button>' : ''}
      ${p.recording ? (p.recording.status === 'scheduled' ? '<button class="ghost" id="pdc">Avboka</button>' : '') : '<button class="ghost" id="pdr">⏺ Spela in</button>'}
      ${p.rule ? '<span class="muted small">Serieinspelning aktiv</span>' : '<button class="ghost" id="pds">⏺⏺ Spela in serien</button>'}
      <button class="ghost" id="pdx">Stäng</button></div>`;
  document.body.append(d); d.showModal();
  const close = () => { d.close(); d.remove(); };
  $('#pdx', d).onclick = close;
  if ($('#pdw', d)) $('#pdw', d).onclick = act(async () => { close(); const D = await api('/live/channels'); const ch = D.channels.find(c => c.id === p.channel_id); if (ch) playLive(ch); });
  if ($('#pdr', d)) $('#pdr', d).onclick = async () => { try { const r = await api('/dvr/program', { method: 'POST', body: { programId: id } }); toast(r.conflict ? 'Bokad – men alla tuners är upptagna då. Inspelningen väntar på en ledig tuner.' : 'Inspelning bokad'); close(); } catch (e) { toast(e.message); } };
  if ($('#pdc', d)) $('#pdc', d).onclick = act(async () => { await api('/dvr/recordings/' + p.recording.id, { method: 'DELETE' }); toast('Avbokad'); close(); });
  if ($('#pds', d)) $('#pds', d).onclick = async () => {
    const any = confirm(`Spela in "${p.title}" på alla kanaler? (Avbryt = bara ${p.channel_name})`);
    try { await api('/dvr/program' + (any ? '?anyChannel=1' : ''), { method: 'POST', body: { programId: id, series: true, newOnly: true } }); toast('Serieinspelning skapad – bara nya avsnitt spelas in'); close(); } catch (e) { toast(e.message); }
  };
}
views.dvr = async () => {
  const D = await api('/dvr');
  const st = { scheduled: 'Bokad', recording: '⏺ Spelar in', processing: 'Bearbetas…', done: '', failed: 'Misslyckades' };
  main.innerHTML = `<div class="toolbar"><h1>Inspelningar</h1><a class="btn ghost" href="#/guide">📅 TV-guide</a><a class="btn ghost" href="#/live">Live-TV</a></div>
    ${D.done.filter(r => r.status === 'done').length ? `<section class="section"><h2>Inspelat</h2><div class="reclist">${D.done.filter(r => r.status === 'done').map(r => `<div class="rec">
      <div><b>${esc(r.title)}</b>${r.subtitle ? ' – ' + esc(r.subtitle) : ''}<div class="muted small">${esc(r.channel_name || '')} · ${dayName(r.start)} ${hhmm(r.start)} · ${fmtDur(r.stop - r.start)}${r.size ? ' · ' + (r.size / 1e9).toFixed(1) + ' GB' : ''}${r.commercials?.length ? ` · ${r.commercials.length} reklamavbrott` : ''}${['pending', 'running'].includes(r.commercials_status) ? ' · letar reklam…' : ''}${r.error ? ' · ' + esc(r.error) : ''}</div></div>
      <div class="row"><button class="primary small" data-rplay="${r.id}">▶ Spela</button>${me.adminHere && D.comskip?.enabled ? `<button class="ghost small" data-rcs="${r.id}" title="Analysera reklamavbrott igen">Leta reklam</button>` : ''}<button class="ghost small" data-rdel="${r.id}">Ta bort</button></div></div>`).join('')}</div></section>` : ''}
    <section class="section"><h2>Kommande</h2>${D.scheduled.length ? `<table>${D.scheduled.map(r => `<tr><td>${dayName(r.start)} ${hhmm(r.start)}–${hhmm(r.stop)}</td><td><b>${esc(r.title)}</b>${r.subtitle ? ' – ' + esc(r.subtitle) : ''}</td><td class="muted">${esc(r.channel_name || '')}</td>
      <td>${st[r.status]}</td><td class="r">${r.status === 'recording' ? `<button class="ghost small" data-rstop="${r.id}">Stoppa</button>` : `<button class="ghost small" data-rdel="${r.id}">Avboka</button>`}</td></tr>`).join('')}</table>` : '<p class="muted">Inga bokade inspelningar. Välj ett program i TV-guiden.</p>'}</section>
    ${D.rules.length ? `<section class="section"><h2>Serieinspelningar</h2><table>${D.rules.map(r => `<tr><td><b>${esc(r.title)}</b></td><td class="muted">${esc(r.channel_name || 'Alla kanaler')}${r.new_only ? ' · bara nya' : ''}${r.keep ? ` · sparar ${r.keep}` : ''}</td><td>${r.upcoming} kommande</td><td class="r"><button class="ghost small" data-rule="${r.id}">Ta bort</button></td></tr>`).join('')}</table></section>` : ''}
    ${D.done.filter(r => r.status !== 'done').length ? `<section class="section"><h2>Pågående och misslyckade</h2><table>${D.done.filter(r => r.status !== 'done').map(r => `<tr><td>${dayName(r.start)} ${hhmm(r.start)}</td><td>${esc(r.title)}</td><td>${st[r.status]}</td><td class="muted small">${esc(r.error || '')}</td><td class="r"><button class="ghost small" data-rdel="${r.id}">Ta bort</button></td></tr>`).join('')}</table></section>` : ''}
    ${D.dir ? `<p class="muted small">Inspelningar sparas i <code>${esc(D.dir)}</code>.</p>` : ''}`;
  $$('[data-rdel]').forEach(b => b.onclick = async () => { if (confirm('Ta bort?')) { try { await api('/dvr/recordings/' + b.dataset.rdel, { method: 'DELETE' }); route(); } catch (e) { toast(e.message); } } });
  $$('[data-rstop]').forEach(b => b.onclick = act(async () => { await api(`/dvr/recordings/${b.dataset.rstop}/stop`, { method: 'POST' }); toast('Stoppad – sparas'); later(route, 1500); }));
  $$('[data-rcs]').forEach(b => b.onclick = act(async () => { await api(`/dvr/recordings/${b.dataset.rcs}/commercials`, { method: 'POST' }); toast('Letar reklamavbrott i bakgrunden'); later(route, 1500); }));
  $$('[data-rule]').forEach(b => b.onclick = act(async () => { if (confirm('Ta bort serieinspelningen och dess bokningar?')) { await api('/dvr/rules/' + b.dataset.rule, { method: 'DELETE' }); route(); } }));
  $$('[data-rplay]').forEach(b => b.onclick = act(async () => {
    if (b.disabled) return;
    b.disabled = true;
    try { await playRec(D.done.find(x => x.id === +b.dataset.rplay), D.comskip || {}); } finally { b.disabled = false; }
  }));
};

// ---------- streamingtjänster ----------
const provLinks = (list) => list.map(p => `<a class="prov${p.mine ? ' mine' : ''}" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" title="Öppna i ${esc(p.name)}">${p.logo ? `<img src="${esc(p.logo)}" alt="">` : ''}<span>${esc(p.name)}</span></a>`).join('');
const provBlock = (w) => {
  if (!w) return '';
  const sub = [...w.flatrate, ...w.free], pay = [...w.rent, ...w.buy.filter(b => !w.rent.some(r => r.id === b.id))];
  if (!sub.length && !pay.length) return '';
  return `${sub.length ? `<div class="provrow"><span class="muted small">Ingår i</span>${provLinks(sub)}</div>` : ''}${pay.length ? `<div class="provrow"><span class="muted small">Hyr/köp</span>${provLinks(pay.slice(0, 6))}</div>` : ''}
    <div class="muted small" style="margin-top:4px">Uppgifter från JustWatch via TMDB. Öppnas i tjänstens app eller webbplats.</div>`;
};
async function fillWatch() {
  const el = $('[data-wid]'); if (!el) return;
  const w = await api(`/items/${el.dataset.wid}/watch`).catch(() => null);
  const html = provBlock(w);
  if (html && el.isConnected) el.innerHTML = `<h3 style="font-size:15px;margin:14px 0 6px">Finns även på</h3>${html}`;
}
views.streaming = async () => {
  if (me.kid) { location.hash = '#/'; return; }
  const P_ = await api('/streaming/providers').catch(e => { if (e.aborted) throw e; return { error: e.message }; });
  if (P_.error) { main.innerHTML = `<div class="empty"><p>${esc(P_.error)}</p></div>`; return; }
  const kind = store.get('stkind', 'movie');
  const sel = (store.get('stprov', '') || P_.mine.join(',')).split(',').map(Number).filter(Boolean);
  const shown = P_.all.filter(p => P_.mine.includes(p.id) || sel.includes(p.id));
  main.innerHTML = `<div class="toolbar"><h1>Strömmande</h1><span class="muted">Det som finns på era tjänster just nu</span>
      <select id="stk" style="margin-left:auto"><option value="movie">Filmer</option><option value="show">Serier</option></select>${me.adminHere ? '<button class="ghost" id="stmine">Välj era tjänster</button>' : ''}</div>
    ${P_.mine.length ? `<div class="provrow" id="stchips">${shown.map(p => `<button class="prov chip${sel.includes(p.id) ? ' mine' : ''}" data-pv="${p.id}">${p.logo ? `<img src="${esc(p.logo)}" alt="">` : ''}<span>${esc(p.name)}</span></button>`).join('')}</div>
      <div class="grid" id="stgrid" style="margin-top:16px"><div class="spin"></div></div><div class="row" style="justify-content:center;margin:16px 0"><button class="ghost" id="stmore" hidden>Visa fler</button></div>`
    : `<div class="empty"><p>${me.adminHere ? 'Välj vilka tjänster ni har (t.ex. Prime Video och TV4 Play) så visas deras utbud här.' : 'En administratör behöver välja vilka tjänster ni har.'}</p></div>`}
    <p class="muted small">BraXhn TV kan inte spela upp innehåll från tjänsterna (de är kopieringsskyddade) – ett klick öppnar titeln i tjänstens egen app eller webbplats.</p>`;
  $('#stk').value = kind;
  $('#stk').onchange = (e) => { store.set('stkind', e.target.value); route(); };
  if ($('#stmine')) $('#stmine').onclick = () => {
    const d = document.createElement('dialog'); d.className = 'wide';
    d.innerHTML = `<h2>Era streamingtjänster</h2><div class="provpick">${P_.all.map(p => `<label class="prov"><input type="checkbox" value="${p.id}" ${P_.mine.includes(p.id) ? 'checked' : ''}>${p.logo ? `<img src="${esc(p.logo)}" alt="">` : ''}<span>${esc(p.name)}</span></label>`).join('')}</div>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="ghost" id="pc">Avbryt</button><button class="primary" id="ps">Spara</button></div>`;
    document.body.append(d); d.showModal();
    $('#pc', d).onclick = () => { d.close(); d.remove(); };
    $('#ps', d).onclick = act(async () => { const ids = $$('input:checked', d).map(i => +i.value); await api('/streaming/mine', { method: 'PUT', body: { ids } }); store.set('stprov', ''); d.close(); d.remove(); route(); });
  };
  if (!P_.mine.length) return;
  $$('[data-pv]').forEach(b => b.onclick = () => { const id = +b.dataset.pv; const s = new Set(sel); s.has(id) ? s.delete(id) : s.add(id); store.set('stprov', [...s].join(',') || P_.mine.join(',')); route(); });
  let page = 1, results = [];
  const stCard = (x, i) => `<a class="card" href="#" data-st="${i}"><div class="art">${x.poster ? `<img loading="lazy" src="${esc(x.poster)}" alt="">` : `<div class="ph">${esc(x.title)}</div>`}${x.inLibrary ? '<span class="badge">Hemma</span>' : ''}</div><div class="t">${esc(x.title)}</div><div class="s">${x.year || ''}</div></a>`;
  const load = async () => {
    const r = await api(`/streaming/discover?kind=${kind}&providers=${sel.join(',')}&page=${page}`);
    const grid = $('#stgrid'), more = $('#stmore');
    if (!grid || !more) return;
    const from = results.length;
    results = results.concat(r.results);
    const html = r.results.map((x, j) => stCard(x, from + j)).join('');
    if (from === 0) grid.innerHTML = html || '<p class="muted">Inget hittades.</p>';
    else grid.insertAdjacentHTML('beforeend', html);
    more.hidden = page >= r.pages;
    $$('[data-st]', grid).slice(from).forEach(a => a.onclick = (e) => { e.preventDefault(); streamDialog(results[+a.dataset.st]); });
  };
  $('#stmore').onclick = act(async () => {
    const b = $('#stmore'); if (!b || b.disabled) return;
    b.disabled = true; page++;
    try { await load(); } catch (e) { page--; throw e; } finally { b.disabled = false; }
  });
  load().catch(e => { if (!e.aborted && $('#stgrid')) $('#stgrid').innerHTML = `<p class="err">${esc(e.message)}</p>`; });
};
async function streamDialog(x) {
  const d = document.createElement('dialog');
  d.innerHTML = `<div class="row" style="align-items:flex-start;gap:16px;flex-wrap:nowrap">${x.poster ? `<img src="${esc(x.poster)}" alt="" style="width:110px;border-radius:8px">` : ''}
    <div><h2 style="margin-top:0">${esc(x.title)} ${x.year ? `<span class="muted">(${x.year})</span>` : ''}</h2><p class="small">${esc(x.overview || '')}</p></div></div>
    <div id="sdp"><div class="spin"></div></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px">${x.inLibrary ? `<a class="btn primary" href="#/item/${x.inLibrary}">▶ Finns hemma – spela</a>` : '<button class="ghost" id="sdr">Önska till biblioteket</button>'}<button class="ghost" id="sdx">Stäng</button></div>`;
  document.body.append(d); d.showModal();
  const close = () => { d.close(); d.remove(); };
  $('#sdx', d).onclick = close;
  $$('a[href^="#/"]', d).forEach(a => a.addEventListener('click', close));
  if ($('#sdr', d)) $('#sdr', d).onclick = async () => { try { const r = await api('/requests', { method: 'POST', body: { kind: x.kind, tmdbId: x.id, title: x.title, year: x.year, poster: x.poster, overview: x.overview } }); toast(REQ_STATUS[r.status]?.[0] || 'Önskad'); close(); } catch (e) { toast(e.message); } };
  const w = await api(`/streaming/title/${x.kind}/${x.id}?title=${encodeURIComponent(x.title)}`).catch(() => null);
  if ($('#sdp', d)) $('#sdp', d).innerHTML = provBlock(w) || '<p class="muted small">Inga tjänster hittades.</p>';
}

const REQ_STATUS = { pending: ['Väntar på godkännande', 'warn-badge'], approved: ['Godkänd', 'ok-badge'], sent: ['Laddas ner', 'ok-badge'],
  available: ['Finns att titta på', 'ok-badge'], declined: ['Nekad', 'warn-badge'], failed: ['Misslyckades', 'warn-badge'] };
views.requests = async () => {
  const R = await api('/requests');
  const kind = store.get('reqkind', 'movie');
  main.innerHTML = `<div class="toolbar"><h1>Önskningar</h1><span class="muted">Önska filmer och serier som saknas${R.radarr || R.sonarr ? ' – de laddas ner automatiskt när de godkänts' : ''}</span></div>
    ${R.canRequest ? `<form id="rqf" class="row panel" style="align-items:flex-end"><div><label>Typ</label><select id="rqk"><option value="movie">Film</option><option value="show">Serie</option></select></div>
      <div style="flex:1;min-width:200px"><label>Sök</label><input id="rqq" placeholder="Titel…" autocomplete="off"></div><button class="primary">Sök</button></form>
      <div id="rqres" class="matchgrid" style="max-height:none"></div>` : '<p class="muted">Önskemål är avstängda.</p>'}
    <div class="panel"><h2>Alla önskemål</h2><table>${R.items.map(r => `<tr><td style="width:48px">${r.poster ? `<img src="${esc(r.poster)}" alt="" style="width:40px;border-radius:4px">` : ''}</td>
      <td><b>${esc(r.title)}</b> ${r.year ? `<span class="muted">(${r.year})</span>` : ''}<div class="muted small">${r.kind === 'movie' ? 'Film' : 'Serie'} · ${esc(r.user || '')} · ${fmtDate(r.created)}${r.note ? ' · ' + esc(r.note) : ''}</div></td>
      <td><span class="${REQ_STATUS[r.status]?.[1] || ''}">${REQ_STATUS[r.status]?.[0] || esc(r.status)}</span></td>
      <td class="r">${me.adminHere && ['pending', 'failed', 'approved'].includes(r.status) ? `<button class="primary small" data-rqok="${r.id}">${r.status === 'failed' ? 'Försök igen' : r.status === 'approved' ? 'Skicka' : 'Godkänn'}</button>` : ''}
        ${me.adminHere && r.status === 'pending' ? `<button class="ghost small" data-rqno="${r.id}">Neka</button>` : ''}
        ${me.adminHere || (r.userId === me.id && r.status === 'pending') ? `<button class="ghost small" data-rqdel="${r.id}">Ta bort</button>` : ''}</td></tr>`).join('') || '<tr><td class="muted">Inga önskemål ännu.</td></tr>'}</table></div>`;
  $$('[data-rqok]').forEach(b => b.onclick = async () => { try { await api(`/requests/${b.dataset.rqok}/approve`, { method: 'POST' }); toast('Skickad'); } catch (e) { toast(e.message); } route(); });
  $$('[data-rqno]').forEach(b => b.onclick = act(async () => { const note = prompt('Anledning (valfritt):'); if (note === null) return; await api(`/requests/${b.dataset.rqno}/decline`, { method: 'POST', body: { note } }); route(); }));
  $$('[data-rqdel]').forEach(b => b.onclick = act(async () => { await api(`/requests/${b.dataset.rqdel}`, { method: 'DELETE' }); route(); }));
  if (!$('#rqf')) return;
  $('#rqk').value = kind;
  $('#rqk').onchange = () => store.set('reqkind', $('#rqk').value);
  $('#rqq').focus();
  $('#rqf').onsubmit = async (e) => {
    e.preventDefault();
    const k = $('#rqk').value, q = $('#rqq').value.trim(); if (!q) return;
    $('#rqres').innerHTML = '<div class="spin"></div>';
    try {
      const res = await api(`/requests/search?kind=${k}&q=${encodeURIComponent(q)}`);
      $('#rqres').innerHTML = res.map((x, i) => `<div class="mcard">${x.poster ? `<img src="${esc(x.poster)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
        <div style="flex:1"><b>${esc(x.title)}</b> ${x.year ? `<span class="muted">(${x.year})</span>` : ''}${x.streaming?.length ? `<div class="small" style="color:var(--ok)">Finns redan på ${esc(x.streaming.join(', '))}</div>` : ''}<div class="small muted">${esc(x.overview)}</div></div>
        <div>${x.inLibrary ? `<a class="btn small" href="#/item/${x.inLibrary}">Finns – titta</a>` : x.request ? `<span class="${REQ_STATUS[x.request]?.[1]}">${REQ_STATUS[x.request]?.[0]}</span>` : `<button class="primary small" data-rqadd="${i}">Önska</button>`}</div></div>`).join('') || '<p class="muted">Inga träffar.</p>';
      $$('[data-rqadd]').forEach(b => b.onclick = async () => {
        const x = res[+b.dataset.rqadd]; b.disabled = true;
        try { const r = await api('/requests', { method: 'POST', body: { kind: k, tmdbId: x.id, title: x.title, year: x.year, poster: x.poster, overview: x.overview } });
          b.outerHTML = `<span class="${REQ_STATUS[r.status]?.[1]}">${REQ_STATUS[r.status]?.[0]}</span>`; }
        catch (er) { toast(er.message); b.disabled = false; }
      });
    } catch (er) { $('#rqres').innerHTML = `<p class="err">${esc(er.message)}</p>`; }
  };
};

views.stats = async () => {
  if (!me.adminHere) { location.hash = '#/'; return; }
  const [S, B, OF] = await Promise.all([api('/stats'), api('/backups'), api('/offsite')]);
  const L = S.library;
  const gb = (b) => b > 1e12 ? (b / 1e12).toFixed(1) + ' TB' : (b / 1e9).toFixed(0) + ' GB';
  const hrs = (x) => Math.round(x / 3600);
  const maxDay = Math.max(1, ...S.days.map(d => d.n));
  const modeName = { direct: 'Direkt', remux: 'Remux', transcode: 'Omkodning' };
  main.innerHTML = `
  <div class="toolbar"><h1>Statistik</h1><span class="muted">Senaste 30 dagarna</span><a class="btn small" href="#/wrapped/${new Date().getFullYear()}">Årssammanfattning</a></div>
  <div class="panel"><h2>Spelas nu <span class="muted small" id="nowcount"></span></h2><div id="now"><div class="spin"></div></div></div>
  <div class="tiles">
    <div class="tile"><b>${L.movies}</b><span>filmer</span></div><div class="tile"><b>${L.shows}</b><span>serier</span></div>
    <div class="tile"><b>${L.episodes}</b><span>avsnitt</span></div><div class="tile"><b>${gb(L.bytes)}</b><span>media</span></div>
    <div class="tile"><b>${hrs(L.seconds).toLocaleString('sv-SE')} h</b><span>speltid</span></div>
    <div class="tile"><b>${S.days.reduce((a, d) => a + d.n, 0)}</b><span>uppspelningar</span></div>
  </div>
  <div class="panel"><h2>Uppspelningar per dag</h2>
    <div class="bars">${S.days.map(d => `<div class="bar" title="${esc(d.day)}: ${d.n}"><i style="height:${Math.max(4, d.n / maxDay * 100)}%"></i><span>${esc(d.day.slice(8))}</span></div>`).join('') || '<p class="muted">Inga uppspelningar ännu.</p>'}</div></div>
  <div class="grid2">
    <div class="panel"><h2>Mest sett</h2><table>${S.top.map((t, i) => `<tr><td class="muted">${i + 1}</td><td><a href="#/item/${t.id}">${esc(t.title)}</a></td><td class="r">${t.plays} ggr · ${t.viewers} pers</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table></div>
    <div class="panel"><h2>Användare</h2><table>${S.users.map(u => `<tr><td>${esc(u.name)}</td><td class="r">${u.plays} uppspelningar · ${hrs(u.watched_seconds)} h sett</td></tr>`).join('')}</table></div>
    <div class="panel"><h2>Uppspelningsläge</h2><table>${S.modes.map(m => `<tr><td>${esc(modeName[m.mode] || m.mode)}</td><td class="r">${m.n}</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table>
      <p class="muted small">Remux och direktuppspelning belastar servern minst.</p></div>
    <div class="panel"><h2>Enheter</h2><table>${S.devices.map(d => `<tr><td>${esc(d.device || '?')}</td><td class="r">${d.n}</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table></div>
  </div>
  ${S.disk?.at ? `<div class="panel"><h2>Diskutrymme</h2>${diskTable(S.disk)}</div>` : ''}
  <div class="panel"><h2>Senaste uppspelningar</h2><table>${S.recent.map(r => `<tr><td class="muted small">${fmtDate(r.ts)}</td><td>${esc(r.user)}</td><td>${esc(r.title)}</td><td class="muted small">${esc(modeName[r.mode] || r.mode || '')}${r.remote ? ' · utifrån' : ''} · ${esc(r.device || '')}</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table></div>
  <div class="panel"><h2>Säkerhetskopior</h2>
    <p class="muted small">Databasen (konton, tittarhistorik, inställningar) kopieras automatiskt varje natt kl. 03 till <code>${esc(B.dir)}</code>. ${B.keep} kopior sparas.</p>
    <div class="row" style="margin-bottom:10px"><label class="switch"><input type="checkbox" id="bken" ${B.enabled ? 'checked' : ''}> Automatisk säkerhetskopiering</label>
      <input id="bkkeep" type="number" min="1" max="365" value="${B.keep}" style="width:90px"> <span class="muted small">kopior</span>
      <button class="ghost small" id="bksave">Spara</button><button class="primary small" id="bknow">Säkerhetskopiera nu</button></div>
    <table>${B.files.map(f => `<tr><td>${esc(f.name)}</td><td class="muted small">${fmtDate(f.mtime)}</td><td class="muted small">${(f.size / 1e6).toFixed(1)} MB</td><td class="r"><a class="btn small" href="/api/backups/${encodeURIComponent(f.name)}">Ladda ner</a> <button class="ghost small" data-rlocal="${esc(f.name)}">Återställ</button></td></tr>`).join('') || '<tr><td class="muted">Inga kopior ännu.</td></tr>'}</table>
    ${OF.restorePending ? `<p class="warn-badge" style="display:inline-block;margin-top:10px">En återställning väntar – starta om containern i Unraid för att använda den.</p> <button class="ghost small" id="rcancel">Avbryt återställningen</button>` : ''}
  </div>
  <div class="panel"><h2>Extern säkerhetskopia ${OF.kind !== 'none' ? (OF.state.error ? '<span class="warn-badge">Fel</span>' : OF.state.last ? '<span class="ok-badge">OK</span>' : '') : ''}</h2>
    <p class="muted small">Skickar en <b>krypterad</b> kopia av databasen varje natt efter den lokala – till en annan disk eller NAS (lägg till en sökvägsmappning i Unraid, t.ex. <code>/backup</code>) eller till S3-kompatibel molnlagring som Backblaze B2, Wasabi, Cloudflare R2, MinIO eller AWS. Ingen hos lagringstjänsten kan läsa kopian utan din lösenfras – och <b>inte du heller om du tappar bort den</b>.</p>
    <form id="ofform"><div class="row"><div><label>Mål</label><select id="ofk"><option value="none">Av</option><option value="folder">Mapp (annan disk/NAS)</option><option value="s3">S3-kompatibel lagring</option></select></div>
      <div style="flex:1;min-width:200px"><label>Lösenfras (minst 12 tecken)</label><input id="ofp" type="password" autocomplete="new-password" placeholder="${OF.passSet ? '•••••• (sparad)' : ''}"></div>
      <div><label>Antal kopior</label><input id="ofkeep" type="number" min="1" max="365" value="${OF.keep}" style="width:90px"></div></div>
      <div id="ofdir"><label>Mapp i containern</label><input id="ofd" value="${esc(OF.dir)}" placeholder="/backup"></div>
      <div id="ofs3"><div class="row"><div style="flex:2;min-width:220px"><label>Adress (endpoint)</label><input id="ofe" value="${esc(OF.endpoint)}" placeholder="https://s3.eu-central-003.backblazeb2.com"></div>
        <div style="flex:1;min-width:120px"><label>Region</label><input id="ofr" value="${esc(OF.region)}"></div></div>
        <div class="row"><div style="flex:1;min-width:150px"><label>Bucket</label><input id="ofb" value="${esc(OF.bucket)}"></div><div style="flex:1;min-width:150px"><label>Mapp i bucketen</label><input id="ofpre" value="${esc(OF.prefix)}"></div></div>
        <div class="row"><div style="flex:1;min-width:180px"><label>Nyckel-id (access key)</label><input id="ofa" value="${esc(OF.accessKey)}" autocomplete="off"></div>
        <div style="flex:1;min-width:180px"><label>Hemlig nyckel</label><input id="ofs" type="password" autocomplete="off" placeholder="${OF.secretSet ? '•••••• (sparad)' : ''}"></div></div>
        <label class="switch"><input type="checkbox" id="ofv" ${OF.vhost ? 'checked' : ''}> Bucket i värdnamnet (virtual-hosted – krävs av vissa tjänster)</label></div>
      <div class="row" style="margin-top:12px"><button class="ghost">Spara</button><button type="button" class="ghost" id="oftest">Testa anslutningen</button><button type="button" class="primary" id="ofrun">Skicka en kopia nu</button></div></form>
    <p class="muted small">${OF.state.last ? 'Senast skickad ' + new Date(OF.state.last).toLocaleString('sv-SE') + ' (' + esc(OF.state.lastName || '') + ')' : ''}${OF.state.error ? ' · Fel: ' + esc(OF.state.error) : ''}</p>
    <div id="oflist"></div>
  </div>`;
  $('#ofk').value = OF.kind;
  const ofShow = () => { $('#ofdir').hidden = $('#ofk').value !== 'folder'; $('#ofs3').hidden = $('#ofk').value !== 's3'; };
  $('#ofk').onchange = ofShow; ofShow();
  const ofSave = () => {
    const body = { kind: $('#ofk').value, keep: $('#ofkeep').value, dir: $('#ofd').value, endpoint: $('#ofe').value, region: $('#ofr').value, bucket: $('#ofb').value, prefix: $('#ofpre').value, accessKey: $('#ofa').value, vhost: $('#ofv').checked };
    if ($('#ofp').value) body.passphrase = $('#ofp').value;
    if ($('#ofs').value) body.secretKey = $('#ofs').value;
    return api('/offsite', { method: 'PUT', body });
  };
  $('#ofform').onsubmit = async (e) => { e.preventDefault(); try { await ofSave(); toast('Sparat'); route(); } catch (er) { toast(er.message); } };
  $('#oftest').onclick = async () => { try { await ofSave(); await api('/offsite/test', { method: 'POST' }); toast('Anslutningen fungerar'); } catch (er) { toast(er.message); } };
  $('#ofrun').onclick = async () => { $('#ofrun').disabled = true; try { await ofSave(); const r = await api('/offsite/run', { method: 'POST' }); toast('Skickade ' + r.name); route(); } catch (er) { toast(er.message); $('#ofrun').disabled = false; } };
  const restore = async (body, label) => {
    if (!confirm(`Återställ ${label}? Allt som ändrats efter kopian (tittarhistorik, konton, inställningar) försvinner. Den nuvarande databasen sparas och återställningen sker när containern startas om.`)) return;
    try { await api('/restore', { method: 'POST', body }); toast('Klart – starta om containern i Unraid'); route(); } catch (e) { toast(e.message); }
  };
  $$('[data-rlocal]').forEach(b => b.onclick = () => restore({ local: b.dataset.rlocal }, b.dataset.rlocal));
  if ($('#rcancel')) $('#rcancel').onclick = act(async () => { await api('/restore', { method: 'DELETE' }); route(); });
  if (OF.kind !== 'none') api('/offsite/list').then(list => {
    if (!$('#oflist')) return;
    $('#oflist').innerHTML = list.length ? `<table>${list.map(f => `<tr><td>${esc(f.name)}</td><td class="muted small">${fmtDate(f.mtime)}</td><td class="muted small">${(f.size / 1e6).toFixed(1)} MB</td><td class="r"><button class="ghost small" data-rremote="${esc(f.name)}">Återställ</button></td></tr>`).join('')}</table>` : '<p class="muted small">Inga externa kopior ännu.</p>';
    $$('[data-rremote]').forEach(b => b.onclick = () => restore({ remote: b.dataset.rremote }, b.dataset.rremote));
  }).catch(e => { if (!e.aborted && $('#oflist')) $('#oflist').innerHTML = `<p class="err small">${esc(e.message)}</p>`; });
  $('#bknow').onclick = async () => { try { const r = await api('/backups', { method: 'POST' }); toast('Skapade ' + r.name); route(); } catch (e) { toast(e.message); } };
  $('#bksave').onclick = act(async () => { await api('/settings', { method: 'PUT', body: { backupEnabled: $('#bken').checked, backupKeep: $('#bkkeep').value } }); toast('Sparat'); });
  // En enda uppdateringsslinga: nytt anrop avbryter den schemalagda och gamla svar ignoreras
  let nowSeq = 0, cancelNow = null;
  const loadNow = async () => {
    const seq = ++nowSeq;
    if (cancelNow) { cancelNow(); cancelNow = null; }
    try {
      const A = await api('/activity');
      if (seq !== nowSeq || !$('#now')) return;
      $('#nowcount').textContent = A.length ? `(${A.length})` : '';
      $('#now').innerHTML = A.length ? `<table>${A.map(a => `<tr><td><b>${esc(a.user)}</b><div class="muted small">${esc(a.device)} · ${esc(a.ip)}${a.remote ? ' · utifrån' : ''}</div></td>
        <td>${esc(a.title)}<div class="prog" style="max-width:260px"><i style="width:${a.duration ? Math.min(100, a.position / a.duration * 100) : 0}%"></i></div></td>
        <td class="muted small">${esc(modeName[a.mode] || a.mode)}${a.quality && a.quality !== 'orig' ? ' · ' + esc(a.quality) + 'p' : ''}${a.paused ? ' · pausad' : ''}<div>${esc((a.reasons || []).join(', '))}</div></td>
        <td class="r"><button class="danger small" data-stop="${esc(a.key)}">Stoppa</button></td></tr>`).join('')}</table>` : '<p class="muted">Ingen tittar just nu.</p>';
      $$('[data-stop]').forEach(b => b.onclick = act(async () => { if (confirm('Stoppa uppspelningen?')) { await api(`/activity/${b.dataset.stop}/stop`, { method: 'POST' }); loadNow(); } }));
    } catch (e) { if (e?.aborted) return; }
    if (seq === nowSeq) cancelNow = later(loadNow, 5000);
  };
  loadNow();
};

views.admin = async () => {
  if (!me.is_admin) { location.hash = '#/'; return; }
  if (!me.adminHere) { main.innerHTML = '<div class="empty"><h2>Administration är spärrad härifrån</h2><p>Av säkerhetsskäl kan servern bara administreras från hemnätverket eller via VPN (t.ex. NetBird).</p></div>'; return; }
  const [IN, LT, L, U, S, SC, AU, AC, NO, UP] = await Promise.all([api('/integrations'), api('/live/tuners'), api('/libraries'), api('/users'), api('/settings'), api('/security-check'), api('/audit?limit=60'), api('/acme'), api('/notify'), api('/updates')]);
  const lvl = { ok: '✓', info: 'ℹ', warn: '!', bad: '✕' };
  main.innerHTML = `
  <div class="panel"><h2>Säkerhetskontroll</h2>
    <div class="checks">${SC.map(i => `<div class="check ${i.level}"><span class="dot">${lvl[i.level]}</span><div><b>${esc(i.title)}</b>${i.detail ? `<div class="muted small">${esc(i.detail)}</div>` : ''}</div></div>`).join('')}</div>
  </div>
  <div class="panel"><h2>Bibliotek</h2>
    <table><tr><th>Namn</th><th>Typ</th><th>Mapp</th><th>Titlar</th><th></th></tr>
    ${L.map(l => `<tr><td>${esc(l.name)}</td><td>${{ movie: 'Filmer', show: 'Serier', music: 'Musik', audiobook: 'Ljudböcker' }[l.type]}${l.type === 'show' ? ` <label class="small muted" title="Absolut avsnittsnumrering (t.ex. One Piece - 1071) mappas till säsonger"><input type="checkbox" data-anime="${l.id}" ${l.anime ? 'checked' : ''}> anime</label>` : ''}</td><td class="muted">${esc(l.path)}</td><td>${l.count}</td>
      <td class="r"><button class="ghost small" data-scan="${l.id}">Skanna</button> <button class="danger small" data-del="${l.id}">Ta bort</button></td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">Inga bibliotek ännu.</td></tr>'}</table>
    <div id="scanst" class="muted" style="margin-top:12px"></div>
    <h3 style="margin:22px 0 4px;font-size:15px">Lägg till bibliotek</h3>
    <form id="addlib"><div class="row"><div style="flex:1;min-width:180px"><label>Namn</label><input id="ln" placeholder="Filmer" required></div>
      <div><label>Typ</label><select id="lt"><option value="movie">Filmer</option><option value="show">Serier</option><option value="music">Musik</option><option value="audiobook">Ljudböcker</option></select></div></div>
      <label class="switch" id="lanimew" hidden><input type="checkbox" id="lanime"> Anime (absolut avsnittsnumrering som "Serie - 1071" mappas till säsonger)</label>
      <label>Mapp (under ${esc(S.mediaRoot)})</label><input id="lp" value="${esc(S.mediaRoot)}" required>
      <div class="fsb" id="fsb"></div>
      <div class="row" style="margin-top:14px"><button class="primary">Lägg till och skanna</button><button type="button" class="ghost" id="scanall">Skanna alla nu</button></div></form>
  </div>
  <div class="panel"><h2>Användare</h2>
    <table><tr><th>Namn</th><th>Roll</th><th>2FA</th><th>Utanför hemmet</th><th>Senast aktiv</th><th></th></tr>
    ${U.map(u => `<tr><td>${esc(u.name)}</td><td>${u.is_admin ? 'Admin' : 'Användare'}</td>
      <td>${u.totp_enabled ? '<span class="ok-badge">På</span>' : '<span class="warn-badge">Av</span>'}</td>
      <td><label class="switch"><input type="checkbox" data-remote="${u.id}" ${u.remote_allowed ? 'checked' : ''}> Tillåten</label></td>
      <td class="muted small">${fmtDate(u.last_seen)}</td>
      <td class="r"><button class="ghost small" data-pw="${u.id}">Nytt lösenord</button>
      ${u.totp_enabled && u.id !== me.id ? `<button class="ghost small" data-r2fa="${u.id}">Återställ 2FA</button>` : ''}
      <button class="ghost small" data-lout="${u.id}">Logga ut överallt</button>
      ${u.id !== me.id ? `<button class="ghost small" data-adm="${u.id}" data-v="${u.is_admin ? 0 : 1}">${u.is_admin ? 'Ta bort admin' : 'Gör till admin'}</button>
      <button class="danger small" data-udel="${u.id}">Ta bort</button>` : ''}</td></tr>`).join('')}</table>
    <form id="adduser" class="row" style="margin-top:14px;align-items:flex-end">
      <div style="flex:1;min-width:140px"><label>Namn</label><input id="un" required maxlength="64"></div>
      <div style="flex:1;min-width:140px"><label>Lösenord (minst 10 tecken)</label><input id="up" type="password" minlength="10" required autocomplete="new-password"></div>
      <label style="display:flex;gap:6px;align-items:center;margin:0 0 10px"><input type="checkbox" id="ua"> Admin</label>
      <label style="display:flex;gap:6px;align-items:center;margin:0 0 10px"><input type="checkbox" id="ur" checked> Får titta utanför hemmet</label>
      <button class="primary">Lägg till</button></form>
  </div>
  <div class="panel"><h2>Säkerhet</h2><form id="secform">
    <label class="switch"><input type="checkbox" id="s2fa" ${S.require2faRemote ? 'checked' : ''}> Kräv tvåstegsverifiering för inloggning utanför hemmet</label>
    <label class="switch"><input type="checkbox" id="sadm" ${S.adminAnywhere ? 'checked' : ''} ${S.youAreLocal ? '' : 'disabled'}> Tillåt administration från internet <span class="muted">(rekommenderas inte)</span></label>
    <label class="switch"><input type="checkbox" id="svpn" ${S.trustVpnRange ? 'checked' : ''} ${S.youAreLocal ? '' : 'disabled'}> Räkna VPN-nätet 100.64.0.0/10 (NetBird/Tailscale) som hemma <span class="muted">(behövs normalt inte om VPN:et routas via routern)</span></label>
    <label>Extra betrodda nät utöver hemnätet, t.ex. 10.8.0.0/24 (minst /16)</label><input id="stn" value="${esc(S.trustedNetworks)}" placeholder="kommaseparerade CIDR">
    <label class="switch"><input type="checkbox" id="sunr" ${S.allowUnrated ? 'checked' : ''}> Barnprofiler får se titlar utan känd åldersgräns</label>
    <label class="switch"><input type="checkbox" id="strick" ${S.trickplay ? 'checked' : ''}> Skapa förhandsbilder för spolning (kräver lite diskutrymme och tid vid skanning)</label>
    <label class="switch"><input type="checkbox" id="srecap" ${S.detectRecap ? 'checked' : ''}> Leta efter "tidigare i serien" (analyserar hela föregående avsnitt)</label>
    <label class="switch"><input type="checkbox" id="swatch" ${S.watchEnabled ? 'checked' : ''}> Skanna direkt när filer läggs till (filbevakning – ${S.watching} bibliotek bevakas)</label>
    <div class="row"><div style="flex:1"><label>Max samtidiga omkodningar (totalt)</label><input id="smt" type="number" min="1" max="32" value="${S.maxTranscodes}"></div>
    <div style="flex:1"><label>Max samtidiga omkodningar per användare</label><input id="smu" type="number" min="1" max="16" value="${S.maxTranscodesUser}"></div></div>
    <div class="row" style="margin-top:14px"><button class="primary">Spara säkerhetsinställningar</button></div></form>
  </div>
  <div class="panel"><h2>Version ${esc(UP.current)} ${UP.available ? `<span class="warn-badge">${esc(UP.latest)} finns</span>` : UP.latest ? '<span class="ok-badge">Senaste</span>' : ''}</h2>
    ${UP.available ? `<p>Uppdatera i Unraid: <b>Docker → BraXhn TV → Check for updates → Apply update</b>. Databasen uppgraderas automatiskt.</p>${UP.notes ? `<pre class="small" style="white-space:pre-wrap;max-height:240px;overflow:auto">${esc(UP.notes)}</pre>` : ''}` : ''}
    <p class="muted small">${UP.checked ? 'Senast kontrollerat ' + new Date(UP.checked).toLocaleString('sv-SE') : 'Inte kontrollerat än'}${UP.error ? ' – fel: ' + esc(UP.error) : ''}. Servern hämtar bara versionsnumret från GitHub (${esc(UP.repo)}) och skickar ingenting om dig.</p>
    <div class="row"><label class="switch" style="margin:0"><input type="checkbox" id="upen" ${UP.enabled ? 'checked' : ''}> Leta efter nya versioner</label><button class="ghost small" id="upchk">Kontrollera nu</button></div>
  </div>
  <div class="panel"><h2>Live-TV och inspelning</h2>
    <p class="muted small"><b>HDHomeRun</b> (antenn/kabel) eller <b>IPTV</b> med en M3U-lista. TV-guide från en XMLTV-adress (t.ex. från din IPTV-leverantör eller <i>xmltv.se</i>) – HDHomeRun har egen guide om ingen anges. Inspelningar sparas i <code>${esc(LT.settings.dvrDir)}</code> – lägg till sökvägen <code>/recordings</code> i Unraid-mallen.</p>
    ${LT.tuners.length ? `<table>${LT.tuners.map(t => `<tr><td><b>${esc(t.name)}</b><div class="muted small">${t.kind === 'hdhr' ? 'HDHomeRun' : 'IPTV'} · ${esc(t.url)}${t.epg_url ? ' · guide: ' + esc(t.epg_url) : ''}</div>${t.error ? `<div class="err small">${esc(t.error)}</div>` : ''}</td>
      <td>${t.channels} kanaler · ${LT.inUse[t.id] || 0}/${t.tuner_count} tuners används</td>
      <td class="r"><button class="ghost small" data-trf="${t.id}">Uppdatera</button><button class="ghost small" data-tepg="${t.id}">TV-guide…</button><button class="danger small" data-tdel="${t.id}">Ta bort</button></td></tr>`).join('')}</table>` : ''}
    <form id="ltadd" style="margin-top:12px"><div class="row" style="align-items:flex-end"><div><label>Källa</label><select id="ltk"><option value="hdhr">HDHomeRun</option><option value="m3u">IPTV (M3U)</option></select></div>
      <div style="flex:2;min-width:220px"><label id="ltul">IP-adress till HDHomeRun</label><input id="ltu" placeholder="192.168.1.50" required></div>
      <div style="flex:2;min-width:220px"><label>TV-guide, XMLTV (valfri)</label><input id="lte" placeholder="https://…/guide.xml.gz"></div>
      <div id="ltnw" hidden><label>Samtidiga strömmar</label><input id="ltn" type="number" min="1" max="20" value="2" style="width:80px"></div></div>
      <div class="row" style="margin-top:10px"><button class="primary">Lägg till</button><button type="button" class="ghost" id="ltdisc">Sök efter HDHomeRun</button><button type="button" class="ghost" id="ltgr">Uppdatera TV-guiden</button></div></form>
    ${LT.channels.length ? `<details style="margin-top:12px"><summary>Kanaler (${LT.channels.length}) – dölj eller markera favoriter</summary><table>${LT.channels.map(c => `<tr><td>${esc(c.number || '')}</td><td>${esc(c.name)}</td><td class="muted small">${c.now ? esc(c.now.title) : 'ingen guide'}${c.epgId ? '' : ' · <span class="warn-badge">ej kopplad</span>'}</td>
      <td><label class="small"><input type="checkbox" data-chfav="${c.id}" ${c.favorite ? 'checked' : ''}> favorit</label> <label class="small"><input type="checkbox" data-chhide="${c.id}" ${c.hidden ? 'checked' : ''}> dold</label> <button class="ghost small" data-chepg="${c.id}" data-epgid="${esc(c.epgId || '')}">Guide-id</button></td></tr>`).join('')}</table></details>` : ''}
    <form id="ltset" class="row" style="margin-top:12px;align-items:flex-end"><div style="flex:1;min-width:160px"><label>Inspelningsmapp</label><input id="lsd" value="${esc(LT.settings.dvrDir)}"></div>
      <div><label>Starta före (s)</label><input id="lsb" type="number" min="0" value="${LT.settings.padBefore}" style="width:90px"></div><div><label>Sluta efter (s)</label><input id="lsa" type="number" min="0" value="${LT.settings.padAfter}" style="width:90px"></div>
      <div><label>Live-omkodning</label><select id="lst"><option value="auto" ${LT.settings.liveTranscode === 'auto' ? 'selected' : ''}>Bara vid behov</option><option value="always" ${LT.settings.liveTranscode === 'always' ? 'selected' : ''}>Alltid</option></select></div>
      <div><label title="Hur långt bakåt man kan pausa och spola i live-TV (0 = av)">Timeshift (min)</label><input id="lsts" type="number" min="0" max="720" value="${LT.settings.timeshiftMinutes ?? 120}" style="width:90px"></div>
      <div><label title="Högsta diskanvändning för timeshift, alla kanaler tillsammans">Timeshift max (GB)</label><input id="lstg" type="number" min="0.5" step="0.5" value="${LT.settings.timeshiftMaxGb ?? 20}" style="width:90px"></div>
      <label class="small"><input type="checkbox" id="lscs" ${LT.settings.comskip ? 'checked' : ''}> Leta reklamavbrott i inspelningar</label>
      <label class="small"><input type="checkbox" id="lsca" ${LT.settings.comskipAutoSkip ? 'checked' : ''}> Hoppa över reklam automatiskt (standard)</label>
      <button class="ghost">Spara</button></form>
  </div>
  <div class="panel"><h2>Sonarr, Radarr och Trakt</h2>
    <p class="muted small"><b>Direkt skanning:</b> lägg till en webhook i Sonarr och Radarr (Settings → Connect → + → Webhook, händelser <i>On Import</i>, <i>On Upgrade</i>, <i>On Rename</i> och <i>On Delete</i>) med adressen nedan. Då dyker nya avsnitt upp direkt efter nedladdning.</p>
    <div class="row"><input id="whurl" readonly value="${esc((S.publicUrl || location.origin) + IN.webhookPath)}" style="flex:1"><button type="button" class="ghost small" id="whcopy">Kopiera</button><button type="button" class="ghost small" id="whnew">Ny nyckel</button></div>
    <form id="inform">
      <label>Sökvägar i Sonarr/Radarr → här (om de skiljer sig), t.ex. <code>/tv=/media/Serier,/movies=/media/Filmer</code></label><input id="inpm" value="${esc(IN.pathMap)}">
      ${['radarr', 'sonarr'].map(k => `<h3 style="margin:18px 0 0;font-size:15px">${k === 'radarr' ? 'Radarr (filmer)' : 'Sonarr (serier)'}</h3>
      <div class="row"><div style="flex:2;min-width:200px"><label>Adress</label><input id="${k}u" value="${esc(IN[k + 'Url'])}" placeholder="http://192.168.1.10:${k === 'radarr' ? 7878 : 8989}"></div>
      <div style="flex:1;min-width:160px"><label>API-nyckel</label><input id="${k}k" type="password" autocomplete="off" placeholder="${IN[k + 'KeySet'] ? '•••••• (sparad)' : 'Settings → General'}"></div></div>
      <div class="row"><div style="flex:1"><label>Kvalitetsprofil</label><select id="${k}p"><option value="0">Första</option></select></div>
      <div style="flex:1"><label>Rotmapp</label><select id="${k}r"><option value="">Första</option></select></div><button type="button" class="ghost small" data-arrload="${k}">Hämta från ${k === 'radarr' ? 'Radarr' : 'Sonarr'}</button></div>`).join('')}
      <label class="switch"><input type="checkbox" id="inre" ${IN.requestsEnabled ? 'checked' : ''}> Användare kan önska filmer och serier</label>
      <label class="switch"><input type="checkbox" id="inra" ${IN.requestsAuto ? 'checked' : ''}> Godkänn önskemål automatiskt (annars godkänner en administratör)</label>
      <h3 style="margin:18px 0 0;font-size:15px">Trakt</h3>
      <p class="muted small">Skapa en gratis app på <a href="https://trakt.tv/oauth/applications" target="_blank" rel="noopener">trakt.tv/oauth/applications</a> (Redirect URI: <code>urn:ietf:wg:oauth:2.0:oob</code>). Varje användare kopplar sedan sitt konto under Mitt konto.</p>
      <div class="row"><div style="flex:1;min-width:180px"><label>Client ID</label><input id="trid" value="${esc(IN.traktClientId)}" autocomplete="off"></div>
      <div style="flex:1;min-width:180px"><label>Client Secret</label><input id="trsec" type="password" autocomplete="off" placeholder="${IN.traktSecretSet ? '•••••• (sparad)' : ''}"></div></div>
      <div class="row" style="margin-top:12px"><button class="primary">Spara</button></div></form>
  </div>
  <div class="panel"><h2>Notiser till mobilen</h2>
    <p class="muted small">Få larm vid t.ex. attacker, spärrade konton, certifikatproblem och misslyckade säkerhetskopior. Enklast är <b>ntfy</b>: installera ntfy-appen, hitta på ett långt hemligt ämnesnamn och ange <code>https://ntfy.sh/ditt-ämne</code> (eller din egen ntfy-server).</p>
    <form id="noform"><div class="row"><div><label>Tjänst</label><select id="nok">${NO.kinds.map(k => `<option value="${k}" ${k === NO.kind ? 'selected' : ''}>${{ none: 'Av', ntfy: 'ntfy', pushover: 'Pushover', gotify: 'Gotify', discord: 'Discord', telegram: 'Telegram', webhook: 'Webhook (JSON)' }[k]}</option>`).join('')}</select></div>
      <div style="flex:2;min-width:220px"><label>Adress <span class="muted small">(ntfy/Gotify/Discord/webhook)</span></label><input id="nou" value="${esc(NO.url)}" placeholder="https://ntfy.sh/mitt-hemliga-amne"></div></div>
      <div class="row"><div style="flex:1;min-width:180px"><label>Token/nyckel <span class="muted small">(Pushover app-token, Telegram bot-token, Gotify app-token)</span></label><input id="not" type="password" placeholder="${NO.tokenSet ? '•••••• (sparad)' : ''}" autocomplete="off"></div>
      <div style="flex:1;min-width:180px"><label>Mottagare <span class="muted small">(Pushover user key / Telegram chat-id)</span></label><input id="nous" value="${esc(NO.user)}"></div></div>
      <label>Skicka notis vid</label>${Object.entries(NO.allEvents).map(([k, v]) => `<label class="switch"><input type="checkbox" data-nev="${k}" ${NO.events.includes(k) ? 'checked' : ''}> ${esc(v)}</label>`).join('')}
      <div class="row" style="margin-top:12px"><button class="primary">Spara</button><button type="button" class="ghost" id="notest">Skicka testnotis</button></div></form>
    ${NO.recent.length ? `<details style="margin-top:10px"><summary class="muted small">Senaste notiser</summary><table>${NO.recent.map(n => `<tr><td class="muted small">${new Date(n.at).toLocaleString('sv-SE')}</td><td>${esc(n.title)}</td><td class="muted small">${esc(n.message)}</td></tr>`).join('')}</table></details>` : ''}
  </div>
  <div class="panel"><h2>HTTPS med Let's Encrypt ${AC.cert ? `<span class="ok-badge">${AC.cert.daysLeft} dagar kvar</span>` : '<span class="warn-badge">Inget certifikat</span>'}</h2>
    <p class="muted small">Inbyggt gratis certifikat som förnyas automatiskt. Kräver ett domännamn som pekar på din publika IP (t.ex. via DuckDNS eller din DNS-leverantör) och att port <b>80</b> i routern vidarebefordras till BraXhn TV:s port 8420 under valideringen. HTTPS serveras på port ${AC.httpsPort} – vidarebefordra 443 dit. Använder du redan en omvänd proxy (Nginx Proxy Manager, SWAG) behövs inte detta.</p>
    ${AC.cert ? `<p class="small">Certifikat för <b>${esc(AC.cert.san || AC.cert.subject)}</b> från ${esc(AC.cert.issuer || '')}, gäller till ${esc(AC.cert.validTo)}.</p>` : ''}
    <form id="acmeform"><div class="row"><div style="flex:1;min-width:180px"><label>Domän</label><input id="acd" value="${esc(AC.domain)}" placeholder="tv.dindomän.se"></div>
      <div style="flex:1;min-width:180px"><label>E-post för påminnelser (valfri)</label><input id="ace" type="email" value="${esc(AC.email)}"></div></div>
      <label class="switch"><input type="checkbox" id="acs" ${AC.staging ? 'checked' : ''}> Testmiljö (staging) – prova först utan att riskera Let's Encrypts gränser</label>
      <label class="switch"><input type="checkbox" id="aca" ${AC.auto ? 'checked' : ''}> Förnya automatiskt (30 dagar före utgång)</label>
      <div class="row" style="margin-top:12px"><button class="ghost">Spara</button><button type="button" class="primary" id="acgo" ${AC.running ? 'disabled' : ''}>${AC.cert ? 'Förnya nu' : 'Hämta certifikat'}</button></div></form>
    <pre id="aclog" class="small muted" style="white-space:pre-wrap;margin-top:10px;${AC.log.length ? '' : 'display:none'}">${esc(AC.log.join('\n'))}</pre>
  </div>
  <div id="opsp"></div>
  <div class="panel"><h2>Säkerhetslogg</h2>
    <div style="max-height:360px;overflow:auto"><table><tr><th>Tid</th><th>Händelse</th><th>Användare</th><th>IP</th><th>Detaljer</th></tr>
    ${AU.map(a => `<tr class="${/fail|denied|locked/.test(a.event) ? 'warnrow' : ''}"><td class="muted small">${fmtDate(a.ts)}</td><td>${esc(EVENTS[a.event] || a.event)}</td><td>${esc(a.user_name || '–')}</td><td class="muted small">${esc(a.ip || '')}</td><td class="muted small">${esc(a.detail || '')}</td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">Inga händelser ännu.</td></tr>'}</table></div>
  </div>
  <div class="panel"><h2>Inställningar</h2><form id="settings">
    <label>TMDB API-nyckel (gratis på themoviedb.org – ger affischer, beskrivningar och betyg)</label>
    <input id="tk" type="password" placeholder="${S.tmdbKeySet ? (S.tmdbFromEnv ? 'Satt via miljövariabel' : '•••••••• (sparad – lämna tomt för att behålla)') : 'Ingen nyckel – endast filnamn och miniatyrer används'}">
    <div class="row"><div style="flex:1"><label>Språk för metadata</label><select id="lang">
      ${[['sv-SE', 'Svenska'], ['en-US', 'Engelska'], ['nb-NO', 'Norska'], ['da-DK', 'Danska'], ['fi-FI', 'Finska'], ['de-DE', 'Tyska']].map(([v, n]) => `<option value="${v}" ${S.language === v ? 'selected' : ''}>${n}</option>`).join('')}
    </select></div><div style="flex:1"><label>Automatisk skanning (minuter, 0 = av)</label><input id="si" type="number" min="0" value="${S.scanInterval}"></div></div>
    <h3 style="margin:22px 0 0;font-size:15px">Undertexter (OpenSubtitles.com)</h3>
    <p class="muted" style="font-size:13px;margin:4px 0 0">Gratis API-nyckel under <i>API Consumers</i> på opensubtitles.com. Konto ger fler nedladdningar per dygn.</p>
    <label>API-nyckel</label><input id="osk" type="password" placeholder="${S.osKeySet ? '•••••••• (sparad)' : 'Ingen nyckel'}">
    <div class="row"><div style="flex:1"><label>Användarnamn (valfritt)</label><input id="osu" value="${esc(S.osUser || '')}" autocomplete="off"></div>
    <div style="flex:1"><label>Lösenord</label><input id="osp" type="password" autocomplete="new-password" placeholder="${S.osPassSet ? '•••••••• (sparat)' : ''}"></div></div>
    <label>Språk att söka (kommaseparerade, t.ex. sv,en)</label><input id="osl" value="${esc(S.subLangs)}">
    <label class="switch"><input type="checkbox" id="osa" ${S.subAuto ? 'checked' : ''}> Hämta undertexter automatiskt vid skanning när de saknas</label>
    <div class="row"><div style="flex:1"><label>Språk att hämta automatiskt</label><input id="osal" value="${esc(S.subAutoLangs)}"></div>
    <div><label>Max per skanning</label><input id="osam" type="number" min="1" max="100" value="${S.subAutoMax}" style="width:110px"></div></div>
    <label class="switch"><input type="checkbox" id="osah" ${S.subAutoHash ? 'checked' : ''}> Bara exakta träffar (filhash) – rekommenderas, annars kan tiderna vara fel</label>
    <p class="muted small" style="margin:4px 0 0">Hämtade hittills: ${S.subAutoStats.downloaded}${S.subAutoStats.error ? ' · senaste fel: ' + esc(S.subAutoStats.error) : ''}. Gratiskonton får ett begränsat antal nedladdningar per dygn – resten hämtas vid nästa skanning.</p>
    <h3 style="margin:22px 0 0;font-size:15px">Utanför hemmet</h3>
    <div class="row"><div style="flex:1"><label>Maxkvalitet utanför hemmet (automatisk)</label><select id="rq">
      ${[['orig', 'Original (ingen gräns)'], ['1080', '1080p – 8 Mbit/s'], ['720', '720p – 4 Mbit/s'], ['480', '480p – 1,5 Mbit/s'], ['360', '360p – 0,8 Mbit/s']].map(([v, n]) => `<option value="${v}" ${S.remoteQuality === v ? 'selected' : ''}>${n}</option>`).join('')}
    </select></div><div style="flex:1"><label>Publik adress (används för Chromecast och appar)</label><input id="pu" placeholder="https://tv.dindomän.se" value="${esc(S.publicUrl || '')}"></div></div>
    <p class="muted" style="font-size:13px;margin:8px 0 0">Du är just nu ansluten ${S.youAreLocal ? '<b>från hemnätverket</b>' : '<b>utifrån</b>'} via ${S.https ? 'HTTPS ✓' : 'HTTP (okrypterat)'}${S.tlsBuiltin ? ' · inbyggd HTTPS aktiv på port 8443' : ''}. Se README → <i>Titta utanför hemmet</i>.</p>
    <p class="muted" style="font-size:13px;margin:14px 0 0">Hårdvaruomkodning: <b>${esc(S.hwaccel)}</b> (sätts med miljövariabeln HWACCEL) · Pågående omkodningar: ${S.activeTranscodes} · Version ${esc(S.version)}</p>
    <div class="row" style="margin-top:16px"><button class="primary">Spara</button><button type="button" class="ghost" id="remeta">Hämta om all metadata</button><button type="button" class="ghost" id="remark">Leta intro igen</button></div></form></div>`;

  // Mappväljare
  const browse = async (p) => {
    try {
      const r = await api('/fs?path=' + encodeURIComponent(p));
      $('#lp').value = r.path;
      $('#fsb').innerHTML = (r.parent ? `<div data-p="${esc(r.parent)}">⬆ ..</div>` : '') + r.dirs.map(d => `<div data-p="${esc(r.path + '/' + d)}">📁 ${esc(d)}</div>`).join('')
        || '<div class="muted">Inga undermappar</div>';
      $$('#fsb [data-p]').forEach(el => keyClick(el).onclick = () => browse(el.dataset.p));
    } catch (e) { $('#fsb').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  browse(S.mediaRoot);
  $('#addlib').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/libraries', { method: 'POST', body: { name: $('#ln').value, type: $('#lt').value, path: $('#lp').value, anime: $('#lanime').checked } }); toast('Bibliotek tillagt – skannar'); await loadLibs(); route(); }
    catch (er) { toast(er.message); }
  };
  $('#lt').onchange = () => { $('#lanimew').hidden = $('#lt').value !== 'show'; };
  $('#lanimew').hidden = $('#lt').value !== 'show';
  $$('[data-anime]').forEach(b => b.onchange = act(async () => { await api('/libraries/' + b.dataset.anime, { method: 'PUT', body: { anime: b.checked } }); toast('Sparat – serierna matchas om'); }));
  $('#scanall').onclick = act(async () => { await api('/scan', { method: 'POST' }); toast('Skanning startad'); poll(); });
  $$('[data-scan]').forEach(b => b.onclick = act(async () => { await api(`/libraries/${b.dataset.scan}/scan`, { method: 'POST' }); toast('Skanning startad'); poll(); }));
  $$('[data-del]').forEach(b => b.onclick = act(async () => {
    if (!confirm('Ta bort biblioteket? Filerna på disken påverkas inte.')) return;
    await api('/libraries/' + b.dataset.del, { method: 'DELETE' }); await loadLibs(); route();
  }));
  $('#adduser').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/users', { method: 'POST', body: { name: $('#un').value, password: $('#up').value, isAdmin: $('#ua').checked, remoteAllowed: $('#ur').checked } }); toast('Användare skapad'); route(); }
    catch (er) { toast(er.message); }
  };
  $$('[data-udel]').forEach(b => b.onclick = act(async () => { if (confirm('Ta bort användaren?')) { await api('/users/' + b.dataset.udel, { method: 'DELETE' }); route(); } }));
  $$('[data-remote]').forEach(b => b.onchange = act(async () => { await api('/users/' + b.dataset.remote, { method: 'PUT', body: { remoteAllowed: b.checked } }); toast('Sparat'); }));
  $$('[data-r2fa]').forEach(b => b.onclick = act(async () => { if (confirm('Återställ tvåstegsverifiering för användaren?')) { await api('/users/' + b.dataset.r2fa, { method: 'PUT', body: { reset2fa: true } }); route(); } }));
  $$('[data-lout]').forEach(b => b.onclick = act(async () => { if (confirm('Logga ut användaren från alla enheter?')) { await api('/users/' + b.dataset.lout, { method: 'PUT', body: { logoutAll: true } }); toast('Utloggad'); } }));
  $('#secform').onsubmit = async (e) => {
    e.preventDefault();
    const body = { require2faRemote: $('#s2fa').checked, trustedNetworks: $('#stn').value, maxTranscodes: $('#smt').value, maxTranscodesUser: $('#smu').value,
      allowUnrated: $('#sunr').checked, watchEnabled: $('#swatch').checked, trickplay: $('#strick').checked, detectRecap: $('#srecap').checked };
    if (!$('#sadm').disabled) body.adminAnywhere = $('#sadm').checked;
    if (!$('#svpn').disabled) body.trustVpnRange = $('#svpn').checked;
    if (body.require2faRemote && !me.totp) { if (!confirm('Du har själv inte tvåstegsverifiering. Du kommer inte kunna logga in utifrån förrän du aktiverat den. Fortsätta?')) return; }
    try { await api('/settings', { method: 'PUT', body }); toast('Sparat'); route(); } catch (er) { toast(er.message); }
  };
  $('#upen').onchange = act(async () => { await api('/updates', { method: 'PUT', body: { enabled: $('#upen').checked } }); toast('Sparat'); });
  $('#upchk').onclick = act(async () => { const u = await api('/updates/check', { method: 'POST' }); toast(u.error ? 'Kunde inte kontrollera: ' + u.error : u.available ? `Version ${u.latest} finns` : 'Du har senaste versionen'); route(); });
  const noSave = () => { const body = { kind: $('#nok').value, url: $('#nou').value, user: $('#nous').value, events: $$('[data-nev]').filter(x => x.checked).map(x => x.dataset.nev) };
    if ($('#not').value) body.token = $('#not').value; return api('/notify', { method: 'PUT', body }); };
  $('#noform').onsubmit = async (e) => { e.preventDefault(); try { await noSave(); toast('Sparat'); } catch (er) { toast(er.message); } };
  $('#notest').onclick = async () => { try { await noSave(); await api('/notify/test', { method: 'POST' }); toast('Testnotis skickad'); } catch (er) { toast(er.message); } };
  $('#ltk').onchange = () => { const h = $('#ltk').value === 'hdhr'; $('#ltul').textContent = h ? 'IP-adress till HDHomeRun' : 'Adress till M3U-listan (eller fil under /config)'; $('#ltu').placeholder = h ? '192.168.1.50' : 'https://…/playlist.m3u'; $('#ltnw').hidden = h; };
  $('#ltadd').onsubmit = async (e) => {
    e.preventDefault(); const b = $('#ltadd button'); b.disabled = true; b.textContent = 'Hämtar kanaler…';
    try { const r = await api('/live/tuners', { method: 'POST', body: { kind: $('#ltk').value, url: $('#ltu').value, epgUrl: $('#lte').value, tuners: $('#ltn').value } }); toast('Tillagd'); await boot(); route(); void r; }
    catch (er) { toast(er.message); b.disabled = false; b.textContent = 'Lägg till'; }
  };
  $('#ltdisc').onclick = act(async () => { toast('Söker…'); const r = await api('/live/discover', { method: 'POST' }); if (r.found.length) { $('#ltk').value = 'hdhr'; $('#ltk').onchange(); $('#ltu').value = r.found[0]; toast('Hittade ' + r.found.join(', ')); } else toast('Ingen hittades – ange IP-adressen (sökning kräver host-nätverk i Docker)'); });
  $('#ltgr').onclick = async () => { toast('Uppdaterar guiden…'); try { await api('/live/guide/refresh', { method: 'POST' }); toast('Guiden uppdaterad'); route(); } catch (er) { toast(er.message); } };
  $$('[data-trf]').forEach(b => b.onclick = async () => { try { const r = await api(`/live/tuners/${b.dataset.trf}/refresh`, { method: 'POST' }); toast(`${r.channels} kanaler`); route(); } catch (er) { toast(er.message); } });
  $$('[data-tdel]').forEach(b => b.onclick = act(async () => { if (confirm('Ta bort källan och dess kanaler?')) { await api('/live/tuners/' + b.dataset.tdel, { method: 'DELETE' }); await boot(); route(); } }));
  $$('[data-tepg]').forEach(b => b.onclick = async () => { const u = prompt('Adress till XMLTV-guiden (tomt = ingen / HDHomeRuns egen):', LT.tuners.find(t => t.id === +b.dataset.tepg)?.epg_url || ''); if (u === null) return; try { await api('/live/tuners/' + b.dataset.tepg, { method: 'PUT', body: { epgUrl: u } }); await api(`/live/tuners/${b.dataset.tepg}/refresh`, { method: 'POST' }); toast('Sparat'); route(); } catch (er) { toast(er.message); } });
  $$('[data-chfav]').forEach(b => b.onchange = act(() => api('/live/channels/' + b.dataset.chfav, { method: 'PUT', body: { favorite: b.checked } })));
  $$('[data-chhide]').forEach(b => b.onchange = act(() => api('/live/channels/' + b.dataset.chhide, { method: 'PUT', body: { hidden: b.checked } })));
  $$('[data-chepg]').forEach(b => b.onclick = act(async () => { const v = prompt('Kanalens id i XMLTV-guiden (t.ex. svt1.svt.se):', b.dataset.epgid); if (v === null) return; await api('/live/channels/' + b.dataset.chepg, { method: 'PUT', body: { epgId: v } }); toast('Sparat – uppdatera guiden'); }));
  $('#ltset').onsubmit = async (e) => { e.preventDefault(); try { await api('/live/settings', { method: 'PUT', body: { dvrDir: $('#lsd').value, padBefore: $('#lsb').value, padAfter: $('#lsa').value, liveTranscode: $('#lst').value,
    timeshiftMinutes: $('#lsts').value, timeshiftMaxGb: $('#lstg').value, comskip: $('#lscs').checked, comskipAutoSkip: $('#lsca').checked } }); toast('Sparat'); } catch (er) { toast(er.message); } };
  $('#whcopy').onclick = () => navigator.clipboard?.writeText($('#whurl').value).then(() => toast('Kopierat'));
  $('#whnew').onclick = act(async () => { if (!confirm('Skapa ny nyckel? Webhooks i Sonarr/Radarr måste uppdateras.')) return; await api('/integrations', { method: 'PUT', body: { newWebhookKey: true } }); route(); });
  for (const k of ['radarr', 'sonarr']) {
    const prof = IN[k + 'Profile'], root = IN[k + 'Root'];
    if (prof) $('#' + k + 'p').innerHTML += `<option value="${prof}" selected>Profil ${prof}</option>`;
    if (root) $('#' + k + 'r').innerHTML += `<option value="${esc(root)}" selected>${esc(root)}</option>`;
  }
  $$('[data-arrload]').forEach(b => b.onclick = async () => {
    const k = b.dataset.arrload;
    try {
      await api('/integrations', { method: 'PUT', body: { [k + 'Url']: $('#' + k + 'u').value, [k + 'Key']: $('#' + k + 'k').value } });
      const o = await api('/integrations/arr-options?kind=' + (k === 'radarr' ? 'movie' : 'show'));
      $('#' + k + 'p').innerHTML = o.profiles.map(p => `<option value="${p.id}" ${p.id === IN[k + 'Profile'] ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
      $('#' + k + 'r').innerHTML = o.roots.map(r => `<option value="${esc(r.path)}" ${r.path === IN[k + 'Root'] ? 'selected' : ''}>${esc(r.path)} (${Math.round(r.free / 1e9)} GB ledigt)</option>`).join('');
      toast('Ansluten');
    } catch (e) { toast(e.message); }
  });
  $('#inform').onsubmit = async (e) => {
    e.preventDefault();
    const body = { pathMap: $('#inpm').value, requestsEnabled: $('#inre').checked, requestsAuto: $('#inra').checked, traktClientId: $('#trid').value };
    if ($('#trsec').value) body.traktSecret = $('#trsec').value;
    for (const k of ['radarr', 'sonarr']) { body[k + 'Url'] = $('#' + k + 'u').value; if ($('#' + k + 'k').value) body[k + 'Key'] = $('#' + k + 'k').value; body[k + 'Profile'] = $('#' + k + 'p').value; body[k + 'Root'] = $('#' + k + 'r').value; }
    try { await api('/integrations', { method: 'PUT', body }); toast('Sparat'); } catch (er) { toast(er.message); }
  };
  const acSave = () => api('/acme', { method: 'PUT', body: { domain: $('#acd').value, email: $('#ace').value, staging: $('#acs').checked, auto: $('#aca').checked } });
  $('#acmeform').onsubmit = async (e) => { e.preventDefault(); try { await acSave(); toast('Sparat'); } catch (er) { toast(er.message); } };
  let cancelAc = null;
  const acPoll = async () => {
    cancelAc = null;
    if (!$('#aclog')) return;
    const a = await api('/acme').catch(e => { if (e.aborted) throw e; return null; }); if (!a || !$('#aclog')) return;
    $('#aclog').style.display = ''; $('#aclog').textContent = a.log.join('\n');
    if (a.running) cancelAc = later(acPoll, 1500);
    else { $('#acgo').disabled = false; toast(a.error ? 'Certifikatet kunde inte hämtas: ' + a.error : 'Certifikatet är klart – HTTPS är igång'); if (!a.error) later(route, 1500); }
  };
  $('#acgo').onclick = async () => {
    try { await acSave(); await api('/acme/obtain', { method: 'POST' }); $('#acgo').disabled = true; if (cancelAc) cancelAc(); cancelAc = later(acPoll, 800); } catch (er) { toast(er.message); }
  };
  $$('[data-adm]').forEach(b => b.onclick = act(async () => { await api('/users/' + b.dataset.adm, { method: 'PUT', body: { isAdmin: b.dataset.v === '1' } }); route(); }));
  $$('[data-pw]').forEach(b => b.onclick = async () => {
    const pw = prompt('Nytt lösenord (minst 10 tecken). Användaren loggas ut från alla enheter:'); if (!pw) return;
    try { await api('/users/' + b.dataset.pw, { method: 'PUT', body: { password: pw } }); toast('Lösenord ändrat'); } catch (er) { toast(er.message); }
  });
  $('#settings').onsubmit = act(async (e) => {
    e.preventDefault();
    const body = { language: $('#lang').value, scanInterval: $('#si').value, osUser: $('#osu').value, subLangs: $('#osl').value,
      remoteQuality: $('#rq').value, publicUrl: $('#pu').value,
      subAuto: $('#osa').checked, subAutoLangs: $('#osal').value, subAutoMax: $('#osam').value, subAutoHash: $('#osah').checked };
    if ($('#tk').value.trim()) body.tmdbKey = $('#tk').value.trim();
    if ($('#osk').value.trim()) body.osKey = $('#osk').value.trim();
    if ($('#osp').value) body.osPass = $('#osp').value;
    await api('/settings', { method: 'PUT', body }); toast('Sparat'); route();
  });
  $('#remark').onclick = act(async () => { await api('/settings', { method: 'PUT', body: { resetMarkers: true } }); await api('/scan', { method: 'POST' }); toast('Analyserar intro/eftertexter i bakgrunden'); });
  $('#remeta').onclick = act(async () => { await api('/settings', { method: 'PUT', body: { resetMeta: true } }); await api('/scan', { method: 'POST' }); toast('Hämtar om metadata i bakgrunden'); });

  // Skanningsstatus – en enda slinga per vy (knuten till navigeringen via later())
  let pollSeq = 0, cancelPoll = null;
  async function poll() {
    const seq = ++pollSeq;
    if (cancelPoll) { cancelPoll(); cancelPoll = null; }
    try {
      const s = await api('/scan');
      const el = $('#scanst'); if (!el || seq !== pollSeq) return;
      const bar = (x) => `<div class="prog"><i style="width:${x.total ? x.done / x.total * 100 : 0}%"></i></div>`;
      const a = s.analysis;
      el.innerHTML = (s.running ? `Skannar <b>${esc(s.library || '')}</b>: ${esc(s.phase)} ${s.done}/${s.total}${s.queued ? ` · ${s.queued} till i kö` : ''}${bar(s)}`
        : s.last ? `Senaste skanning: ${new Date(s.last * 1000).toLocaleString('sv-SE')}` : '')
        // Tunga analyser körs för sig och hindrar inte skanning eller metadata
        + (a?.running ? `<div class="muted small" style="margin-top:8px">I bakgrunden: <b>${esc(a.library || '')}</b> – ${esc(a.phase)} ${a.done}/${a.total}${a.queued ? ` · ${a.queued} bibliotek till i kö` : ''}${bar(a)}</div>` : '');
      cancelPoll = later(poll, s.running || a?.running ? 1500 : 6000);
    } catch {}
  }
  poll();
  adminOps().catch(e => { if (!e?.aborted) toast(e.message); });
};

// ---------- Drift: diskutrymme, import från Plex/Jellyfin, DLNA och Prometheus ----------
const DISK_LEVEL = { ok: ['OK', 'ok-badge'], low: ['Lite plats', 'warn-badge'], critical: ['Nästan fullt', 'warn-badge'], unknown: ['', ''] };
const fmtGb = (b) => b >= 1e12 ? (b / 1e12).toFixed(1) + ' TB' : b >= 1e10 ? Math.round(b / 1e9) + ' GB' : (b / 1e9).toFixed(1) + ' GB';
function diskTable(D) {
  if (!D?.at) return '<p class="muted small">Kontrolleras strax efter start.</p>';
  return `<table>${D.entries.map(e => {
    const [txt, cls] = DISK_LEVEL[e.level] || DISK_LEVEL.unknown;
    const used = e.total ? Math.min(100, Math.max(0, 100 - e.free / e.total * 100)) : 0;
    return `<tr><td>${esc(e.label)}<div class="muted small">${esc(e.path)}</div></td>
      <td>${e.error ? `<span class="muted small">${esc(e.error)}</span>` : `${fmtGb(e.free)} ledigt av ${fmtGb(e.total)} (${Math.round(e.free / e.total * 100)} %)<div class="prog"><i style="width:${used.toFixed(1)}%"></i></div>`}</td>
      <td class="r">${txt ? `<span class="${cls}">${txt}</span>` : ''}</td></tr>`;
  }).join('')}</table>`;
}
async function adminOps() {
  if (!$('#opsp')) return;
  const O = await api('/ops');
  const el = $('#opsp'); if (!el) return;
  const userOpts = O.users.map(u => `<label class="switch"><input type="checkbox" data-impu="${+u.id}"> ${u.parent_id ? '&nbsp;&nbsp;↳ ' : ''}${esc(u.name)}</label>`).join('');
  el.innerHTML = `
  <div class="panel"><h2>Diskutrymme</h2>
    <p class="muted small">Ledigt utrymme kontrolleras var 5:e minut. Notis skickas när något går under gränsen (och högst en påminnelse per dygn) – kryssa i <i>Lågt diskutrymme</i> under Notiser. När omkodningsmappen nästan är full rensas inaktiva uppspelningar tidigare.</p>
    <div id="opdisk">${diskTable(O.disk)}</div>
    <form id="opdiskf"><div class="row" style="margin-top:10px"><div><label>Varna under (% ledigt)</label><input id="opdp" type="number" min="0" max="50" step="0.5" value="${esc(O.diskMinPct)}" style="width:110px"></div>
      <div><label>eller under (GB ledigt)</label><input id="opdg" type="number" min="0" step="1" value="${esc(O.diskMinGb)}" style="width:110px"></div>
      <button class="ghost">Spara</button><button type="button" class="ghost" id="opdchk">Kontrollera nu</button></div>
      <p class="muted small">0 stänger av gränsen. Kritiskt = under en fjärdedel av gränsen.</p></form>
  </div>
  <div class="panel"><h2>Importera tittarhistorik från Plex eller Jellyfin</h2>
    <p class="muted small">Hämtar vad som är sett och hur långt du kommit i påbörjade filmer och avsnitt och för in det på valda användare här. Titlar matchas i första hand på TMDB/IMDb/TVDB-id, sedan på filsökväg och sist på titel och år (serier: säsong och avsnitt). Inget ändras förrän du klickar på <i>Importera</i>.</p>
    <form id="impf"><div class="row"><div><label>Källa</label><select id="imps"><option value="plex">Plex</option><option value="jellyfin">Jellyfin / Emby</option></select></div>
      <div style="flex:2;min-width:220px"><label>Adress</label><input id="impu" placeholder="http://192.168.1.10:32400"></div></div>
      <div class="row" id="impplex"><div style="flex:1;min-width:220px"><label>X-Plex-Token <span class="muted small">(historiken för kontot som äger token)</span></label><input id="impt" type="password" autocomplete="off"></div></div>
      <div class="row" id="impjf" hidden><div style="flex:1;min-width:180px"><label>API-nyckel <span class="muted small">(Instrumentpanel → API-nycklar)</span></label><input id="impk" type="password" autocomplete="off"></div>
        <div style="flex:1;min-width:160px"><label>Användare i Jellyfin</label><select id="impjfu"><option value="">Hämta först…</option></select></div>
        <button type="button" class="ghost small" id="impjfl">Hämta användare</button></div>
      <label>Sökvägsmappning om filerna ligger på olika ställen (en per rad), t.ex. <code>/data/movies=/media/Filmer</code></label><textarea id="impm" rows="2" style="width:100%"></textarea>
      <div class="row" style="margin-top:12px"><button class="primary">Förhandsvisa</button></div></form>
    <div id="impres"></div>
  </div>
  <div class="panel"><h2>DLNA – smart-TV utan app ${O.dlna.enabled ? (O.dlna.running ? '<span class="ok-badge">Aktiv</span>' : O.dlna.error ? '<span class="warn-badge">Fel</span>' : '<span class="warn-badge">Startar</span>') : ''}</h2>
    <p class="muted small">Smart-TV, spelkonsoler och mediaspelare (VLC, Kodi) hittar biblioteket under <i>Medieservrar</i> och spelar filerna direkt, utan omkodning – formatet måste alltså stödjas av TV:n. <b>Ingen inloggning:</b> alla enheter på hemnätet kan se och spela det som visas här, därför finns en åldersgräns. Nås aldrig via omvänd proxy eller utifrån. I Docker krävs nätverkstypen <b>host</b> (eller macvlan/br0 med egen IP) för att TV:n ska hitta servern.</p>
    ${O.dlna.error ? `<p class="err small">${esc(O.dlna.error)}</p>` : ''}${O.dlna.running && O.dlna.addresses.length ? `<p class="muted small">Annonseras på ${esc(O.dlna.addresses.join(', '))}.</p>` : ''}
    <form id="dlnaf"><label class="switch"><input type="checkbox" id="dlen" ${O.dlna.enabled ? 'checked' : ''}> Dela biblioteket med DLNA</label>
      <div class="row"><div style="flex:1;min-width:180px"><label>Namn på TV:n</label><input id="dlname" value="${esc(O.dlna.name)}" maxlength="60"></div>
      <div><label>Högsta åldersgräns <span class="muted small">(tomt = som huvudkontot${O.dlna.effectiveMaxAge == null ? ': allt' : ''})</span></label><input id="dlage" value="${esc(O.dlna.maxAge)}" placeholder="t.ex. 11" style="width:140px"></div></div>
      <div class="row" style="margin-top:12px"><button class="primary">Spara</button></div></form>
  </div>
  <div class="panel"><h2>Prometheus-mätvärden ${O.metrics.enabled ? '<span class="ok-badge">På</span>' : ''}</h2>
    <p class="muted small"><code>GET /metrics</code> i Prometheus-format: uppspelningar, ffmpeg, skanning, bibliotek, inloggningsfel, tuners, inspelningar, diskutrymme och minne. Kräver <code>Authorization: Bearer &lt;token&gt;</code>; utan token är adressen avstängd.</p>
    ${O.metrics.fromEnv ? '<p class="small">En token är satt med miljövariabeln <code>METRICS_TOKEN</code>.</p>' : ''}
    <div class="row"><button type="button" class="ghost" id="mtnew">${O.metrics.enabled && !O.metrics.fromEnv ? 'Skapa ny token' : 'Skapa token'}</button>${O.metrics.enabled && !O.metrics.fromEnv ? '<button type="button" class="danger" id="mtoff">Stäng av</button>' : ''}</div>
    <div id="mttok"></div>
  </div>`;

  const showDisk = (D) => { const d = $('#opdisk'); if (d) d.innerHTML = diskTable(D); };
  $('#opdiskf').onsubmit = act(async (e) => { e.preventDefault(); const r = await api('/ops', { method: 'PUT', body: { diskMinPct: $('#opdp').value, diskMinGb: $('#opdg').value } }); showDisk(r.disk); toast('Sparat'); });
  $('#opdchk').onclick = act(async () => showDisk(await api('/ops/disk/check', { method: 'POST' })));

  // Import
  const src = () => $('#imps').value;
  $('#imps').onchange = () => { $('#impplex').hidden = src() !== 'plex'; $('#impjf').hidden = src() === 'plex'; $('#impu').placeholder = src() === 'plex' ? 'http://192.168.1.10:32400' : 'http://192.168.1.10:8096'; };
  const fillJfUsers = (users) => { $('#impjfu').innerHTML = users.map(u => `<option value="${esc(u.name)}">${esc(u.name)}</option>`).join('') || '<option value="">Inga användare</option>'; };
  $('#impjfl').onclick = act(async () => fillJfUsers(await api('/import/users', { method: 'POST', body: { url: $('#impu').value, apiKey: $('#impk').value } })));
  $('#impf').onsubmit = async (e) => {
    e.preventDefault();
    const b = $('#impf button.primary'); b.disabled = true; b.textContent = 'Hämtar…';
    $('#impres').innerHTML = '<div class="spin"></div>';
    try {
      const P = await api('/import/preview', { method: 'POST', body: { source: src(), url: $('#impu').value, token: $('#impt').value, apiKey: $('#impk').value, user: $('#impjfu').value, pathMap: $('#impm').value } });
      if (!$('#impres')) return;
      $('#impres').innerHTML = `<div class="tiles" style="margin-top:14px"><div class="tile"><b>${+P.total}</b><span>sedda/påbörjade</span></div><div class="tile"><b>${+P.matched}</b><span>matchade</span></div><div class="tile"><b>${+P.unmatched}</b><span>saknas här</span></div></div>
        <p class="muted small">Matchade på id: ${+P.byMethod.id} · filsökväg: ${+P.byMethod.path} · titel: ${+P.byMethod.title}. Att importera: ${+P.watched} sedda och ${+P.inProgress} påbörjade.</p>
        ${P.unmatchedSample.length ? `<details><summary class="muted small">Omatchade (${+P.unmatched}${P.unmatched > P.unmatchedSample.length ? `, visar ${P.unmatchedSample.length}` : ''})</summary><table>${P.unmatchedSample.map(u => `<tr><td>${esc(u.title)}</td><td class="muted small" style="word-break:break-all">${esc(u.path || '')}</td></tr>`).join('')}</table></details>` : ''}
        ${P.matched ? `<label style="margin-top:10px">För in på</label>${userOpts}
        <label class="switch"><input type="checkbox" id="impow"> Skriv över nyare positioner här (sedda titlar avmarkeras aldrig)</label>
        <div class="row" style="margin-top:10px"><button class="primary" id="imprun">Importera</button></div>` : ''}`;
      const run = $('#imprun');
      if (run) run.onclick = act(async () => {
        const users = $$('[data-impu]').filter(x => x.checked).map(x => +x.dataset.impu);
        if (!users.length) return toast('Välj minst en användare');
        run.disabled = true;
        try {
          const r = await api('/import/run', { method: 'POST', body: { id: P.id, users, overwrite: $('#impow').checked } });
          $('#impres').innerHTML = `<p class="ok-badge" style="display:inline-block;margin-top:12px">Klart: ${+r.watched} markerade som sedda, ${+r.progress} påbörjade, ${+r.skipped} oförändrade (${+r.users} användare).</p>`;
        } finally { if ($('#imprun')) run.disabled = false; }
      });
    } catch (er) {
      if (er.aborted) return;
      if ($('#impres')) $('#impres').innerHTML = `<p class="err">${esc(er.message)}</p>`;
    } finally { b.disabled = false; b.textContent = 'Förhandsvisa'; }
  };

  // DLNA
  $('#dlnaf').onsubmit = act(async (e) => {
    e.preventDefault();
    await api('/ops', { method: 'PUT', body: { dlnaEnabled: $('#dlen').checked, dlnaName: $('#dlname').value, dlnaMaxAge: $('#dlage').value } });
    toast('Sparat'); later(adminOps, 1500);
  });

  // Prometheus
  $('#mtnew').onclick = act(async () => {
    if (O.metrics.enabled && !O.metrics.fromEnv && !confirm('Skapa ny token? Den gamla slutar gälla.')) return;
    const r = await api('/ops', { method: 'PUT', body: { metricsToken: 'new' } });
    $('#mttok').innerHTML = `<p class="small" style="margin-top:10px">Ny token (visas bara nu – lägg in den i Prometheus):</p><input readonly id="mttokv" style="width:100%">
      <pre class="small muted" style="white-space:pre-wrap">scrape_configs:\n  - job_name: braxhn-tv\n    authorization:\n      credentials: &lt;token&gt;\n    static_configs:\n      - targets: ['${esc(location.host)}']</pre>`;
    $('#mttokv').value = r.token;
  });
  if ($('#mtoff')) $('#mtoff').onclick = act(async () => { if (!confirm('Stäng av /metrics?')) return; await api('/ops', { method: 'PUT', body: { metricsToken: 'off' } }); toast('Avstängt'); await adminOps(); });
}

// ---------- uppspelning: vad klarar den här webbläsaren? ----------
let CAPS = null;
function capsQuery(extra = {}) {
  if (!CAPS) {
    const v = document.createElement('video');
    const ok = (t) => { try { return !!(v.canPlayType(t) || (window.MediaSource && MediaSource.isTypeSupported(t))); } catch { return false; } };
    const vc = ['h264'], ac = ['aac', 'mp3'], cont = ['mp4'];
    if (ok('video/mp4; codecs="hvc1.1.6.L120.90"') || ok('video/mp4; codecs="hev1.1.6.L120.90"')) vc.push('hevc');
    if (ok('video/webm; codecs="vp9"')) { vc.push('vp9'); cont.push('webm'); }
    if (ok('video/webm; codecs="vp8"')) vc.push('vp8');
    if (ok('video/mp4; codecs="av01.0.08M.08"')) vc.push('av1');
    if (ok('audio/webm; codecs="opus"') || ok('audio/mp4; codecs="opus"')) ac.push('opus');
    if (ok('audio/webm; codecs="vorbis"')) ac.push('vorbis');
    if (ok('audio/mp4; codecs="flac"') || ok('audio/flac')) ac.push('flac');
    if (ok('audio/mp4; codecs="ac-3"')) ac.push('ac3');
    if (ok('audio/mp4; codecs="ec-3"')) ac.push('eac3');
    const hdr = !!(window.matchMedia && matchMedia('(dynamic-range: high)').matches) && vc.includes('hevc');
    CAPS = { c: cont.join(','), v: vc.join(','), a: ac.join(','), hdr: hdr ? '1' : '0' };
  }
  return new URLSearchParams({ ...CAPS, ...extra }).toString();
}
const canAirPlay = () => !!window.WebKitPlaybackTargetAvailabilityEvent;

// ---------- undertexter online ----------
async function subSearch(it) {
  const d = document.createElement('dialog');
  d.innerHTML = `<h2>Sök undertexter</h2><p class="muted" id="ssm">Söker på OpenSubtitles…</p><div id="ssr" style="max-height:50vh;overflow:auto"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="ghost" id="ssc">Stäng</button></div>`;
  document.body.append(d); d.showModal();
  let got = false;
  // Stängs dialogen: ladda bara om sidan om något faktiskt hämtades
  d.addEventListener('close', () => { d.remove(); if (got && !P && !LP && !RP) route(); });
  $('#ssc', d).onclick = () => d.close();
  try {
    const r = await api(`/items/${it.id}/subsearch`);
    $('#ssm', d).textContent = r.length ? `${r.length} träffar – ✓ = exakt matchning mot din fil` : 'Inga träffar.';
    $('#ssr', d).innerHTML = `<table>${r.slice(0, 40).map((x, i) => `<tr><td>${x.hashMatch ? '✓ ' : ''}<b>${esc(x.lang)}</b></td><td style="word-break:break-all">${esc(x.name)}${x.hi ? ' <span class="muted">(HI)</span>' : ''}</td>
      <td class="muted">${esc(x.downloads)}</td><td class="r"><button class="primary small" data-i="${i}">Hämta</button></td></tr>`).join('')}</table>`;
    $$('[data-i]', d).forEach(b => b.onclick = async () => {
      const x = r[+b.dataset.i]; b.disabled = true; b.textContent = '…';
      try { const res = await api(`/items/${it.id}/subdownload`, { method: 'POST', body: { fileId: x.fileId, lang: x.lang } }); b.textContent = '✓'; got = true; toast(`Undertext sparad${res.remaining != null ? ` – ${res.remaining} nedladdningar kvar idag` : ''}`); }
      catch (e) { b.textContent = 'Fel'; toast(e.message); }
    });
  } catch (e) { if ($('#ssm', d)) $('#ssm', d).textContent = e.message; }
}

function editMarkers(it) {
  const d = document.createElement('dialog');
  const t = (x) => x == null ? '' : fmtTime(x);
  d.innerHTML = `<form method="dialog"><h2>Intro och eftertexter</h2><p class="muted">Ange tider som mm:ss eller h:mm:ss. Lämna tomt för att ta bort.</p>
    <div class="row"><div style="flex:1"><label>Intro start</label><input id="is" value="${t(it.intro?.start)}"></div><div style="flex:1"><label>Intro slut</label><input id="ie" value="${t(it.intro?.end)}"></div></div>
    <label>Eftertexter börjar</label><input id="cs" value="${t(it.credits)}">
    <div class="row" style="margin-top:18px;justify-content:space-between"><button type="button" class="ghost" id="redo">Analysera säsongen igen</button>
    <span class="row"><button value="cancel" class="ghost">Avbryt</button><button value="ok" class="primary">Spara</button></span></div></form>`;
  document.body.append(d); d.showModal();
  const sec = (v) => { v = v.trim(); if (!v) return null; return v.split(':').reduce((a, x) => a * 60 + (+x || 0), 0); };
  $('#redo', d).onclick = act(async () => { await api(`/items/${it.id}/markers/redetect`, { method: 'POST' }); toast('Analyserar i bakgrunden'); d.close(); });
  d.onclose = act(async () => {
    const vals = { introStart: sec($('#is', d).value), introEnd: sec($('#ie', d).value), creditsStart: sec($('#cs', d).value) };
    d.remove();
    if (d.returnValue === 'ok') {
      await api(`/items/${it.id}/markers`, { method: 'PUT', body: vals });
      toast('Sparat'); route();
    }
  });
}

// ---------- Chromecast ----------
let castReady = false;
function initCast() {
  if (!window.chrome || !window.isSecureContext || document.getElementById('castsdk')) return;
  window.__onGCastApiAvailable = (ok) => {
    if (!ok || !window.cast?.framework) return;
    cast.framework.CastContext.getInstance().setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });
    castReady = true;
    $$('.castbtn').forEach(b => b.hidden = false);
  };
  const s = document.createElement('script'); s.id = 'castsdk';
  s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
  document.head.append(s);
}
async function castItem(it, position) {
  if (!castReady) return toast('Chromecast kräver Chrome och att servern nås via HTTPS');
  const ctx = cast.framework.CastContext.getInstance();
  try { await ctx.requestSession(); } catch { return; }
  const sess = ctx.getCurrentSession(); if (!sess) return;
  // Default Media Receiver: H.264/VP8/VP9 + AAC/MP3/Opus i MP4/WebM eller HLS
  const p = await api(`/items/${it.id}/playback?` + new URLSearchParams({ c: 'mp4,webm', v: 'h264,vp8,vp9', a: 'aac,mp3,opus,flac', hdr: '0', cast: '1', audio: P?.audio || '', q: P?.q === 'auto' ? '' : (P?.q || ''),
    ...(it.version ? { version: it.version } : {}) }), { bg: true });
  const origin = status.publicUrl || location.origin;
  const mi = new chrome.cast.media.MediaInfo(origin + p.url, p.mime);
  mi.streamType = chrome.cast.media.StreamType.BUFFERED;
  if (p.mode !== 'direct') { mi.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat.TS; mi.hlsVideoSegmentFormat = chrome.cast.media.HlsVideoSegmentFormat.MPEG2_TS; }
  mi.metadata = new chrome.cast.media.GenericMediaMetadata();
  mi.metadata.title = it.kind === 'episode' ? `${it.showTitle} – ${sxe(it)} ${it.title}` : it.title;
  if (it.thumb || it.poster) mi.metadata.images = [new chrome.cast.Image(`${origin}/api/image/${p.version || it.id}/${it.poster ? 'poster' : 'thumb'}?t=${p.token}`)];
  mi.tracks = p.subtitles.map((s, i) => {
    const t = new chrome.cast.media.Track(i + 1, chrome.cast.media.TrackType.TEXT);
    t.trackContentId = origin + s.url; t.trackContentType = 'text/vtt'; t.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
    t.name = s.label; t.language = s.lang || 'und'; return t;
  });
  const req = new chrome.cast.media.LoadRequest(mi);
  req.currentTime = position || 0;
  const subIdx = P?.sub ? p.subtitles.findIndex(s => s.id === P.sub) : -1;
  if (subIdx >= 0) req.activeTrackIds = [subIdx + 1];
  try { await sess.loadMedia(req); toast('Spelas på ' + sess.getCastDevice().friendlyName); if (P) closePlayer(false); }
  catch (e) { toast('Kunde inte casta: ' + (e?.code || e)); }
}

// ---------- spelare ----------
let P = null;
let playSeq = 0; // ökas för varje play() och när alla spelare stängs – äldre anrop avbryter sig själva
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  const add = (src) => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = () => ok(window.Hls); s.onerror = no; document.head.append(s); });
  return add('/vendor/hls.min.js');
}
// Startknapp: inaktiveras medan spelaren startar (dubbelklick ger inte två spelare)
function startPlay(b, ...args) {
  if (b) { if (b.disabled) return; b.disabled = true; }
  return play(...args).catch(e => toast(e?.message)).finally(() => { if (b) b.disabled = false; });
}

async function play(id, start = 0, opts = {}) {
  const seq = ++playSeq;
  let it;
  try {
    // Flera versioner: hämta spårlistan (ljud/undertexter) för den version som faktiskt spelas
    const want = opts.version || store.get('version.' + id, '');
    it = await api('/items/' + id + (want ? '?version=' + encodeURIComponent(want) : ''), { bg: true });
    if (it.versions && !it.versions.some(v => String(v.id) === String(want))) {
      const q = store.get('quality', 'auto');
      const p = await api(`/items/${id}/playback?${capsQuery({ q: q === 'auto' ? '' : q })}&info=1`, { bg: true });
      if (p.version && p.version !== it.version) it = await api(`/items/${id}?version=${p.version}`, { bg: true });
    }
  }
  catch (e) { if (seq === playSeq) toast(e.message); return; }
  if (seq !== playSeq) return; // ett nyare play() eller en navigering har tagit över
  const partyId = opts.party || (P && P.party) || null;
  // Behåll anslutningen till rummet vid byte av avsnitt – tas över först nu när hämtningen lyckats
  const keepParty = P && P.party && P.party === partyId ? P.es : null;
  if (keepParty) P.es = null;
  if (M.audio && !M.audio.paused) M.audio.pause();
  closeOverlays();
  const el = $('#player');
  const q = (s) => $(s, el);
  const audios = it.audio, defAudio = audios.find(a => a.default) || audios[0];
  const subPref = store.get('sublang', '');
  const textSubs = it.subtitles.filter(s => !s.bitmap);
  const defSub = textSubs.find(s => s.forced) || (subPref && textSubs.find(s => s.lang === subPref));
  const sub2Pref = store.get('sub2lang', ''), defSub2 = sub2Pref && textSubs.find(s => s.lang === sub2Pref && s.id !== defSub?.id);
  const cur = P = { it, el, q: store.get('quality', 'auto'), audio: defAudio ? String(defAudio.index) : '', sub: defSub ? defSub.id : '', sub2: defSub2 ? defSub2.id : '', offset: 0, hls: null, lastSent: 0, nextTimer: null, pb: null,
    party: partyId, es: keepParty, applying: false, tok: null, lmd: null };
  const title = it.kind === 'episode' ? `${esc(it.showTitle)} · ${sxe(it)} · ${esc(it.title)}` : esc(it.title);
  el.innerHTML = `<video id="vid" controls autoplay playsinline x-webkit-airplay="allow"></video>
    <div class="pbar"><button class="ghost small" id="pclose">← Tillbaka</button><span class="title">${title}</span><span class="muted small" id="pmode"></span>
      <select id="pq" title="Kvalitet"><option value="auto">Auto</option><option value="orig">Original</option><option value="1080">1080p (8 Mbit/s)</option><option value="720">720p (4 Mbit/s)</option><option value="480">480p (1,5 Mbit/s)</option><option value="360">360p (0,8 Mbit/s)</option></select>
      ${audios.length > 1 ? `<select id="pa" title="Ljudspår">${audios.map(a => `<option value="${a.index}">${esc([a.lang || 'Ljud', a.title, a.codec, a.channels ? a.channels + 'ch' : ''].filter(Boolean).join(' · '))}</option>`).join('')}</select>` : ''}
      <select id="ps" title="Undertexter"><option value="">Inga undertexter</option>${it.subtitles.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}</select>
      ${textSubs.length > 1 ? `<select id="ps2" title="Andra undertext (visas överst)"><option value="">Ingen andra undertext</option>${textSubs.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}</select>` : ''}
      ${it.chapters?.length ? '<button class="ghost small" id="pchap" title="Kapitel">☰ Kapitel</button>' : ''}
      <span id="poff" class="row" hidden><button class="ghost small" data-off="-0.5" title="Undertext tidigare">−</button><span class="small" id="poffv">0,0 s</span><button class="ghost small" data-off="0.5" title="Undertext senare">+</button></span>
      <button class="ghost small castbtn" id="pcast" ${castReady ? '' : 'hidden'} title="Casta till Chromecast">📺 Casta</button>
      ${canAirPlay() ? '<button class="ghost small" id="pair" title="AirPlay">AirPlay</button>' : ''}
      <button class="ghost small" id="pparty" title="Titta tillsammans med någon annanstans">👥 ${partyId ? 'Rummet' : 'Titta tillsammans'}</button>
      ${it.nextId ? '<button class="ghost small" id="pnext">Nästa ⏭</button>' : ''}</div>
    <div class="partybox" id="partybox" hidden><div class="row" style="justify-content:space-between"><b>Titta tillsammans</b><button class="ghost small" id="pbclose">✕</button></div>
      <div class="muted small" id="pmembers"></div><div class="row" style="margin:6px 0"><input id="plink" readonly><button class="ghost small" id="pcopy">Kopiera</button></div>
      <div class="pchat" id="pchat"></div><input id="pmsg" placeholder="Skriv ett meddelande…" maxlength="300"></div>
    <button class="skip" id="pskip" hidden></button><div class="sub2" id="sub2"></div><div class="chapters" id="chlist" hidden></div>
    <div class="scrub" id="scrub"><div class="preview" id="prev" hidden><div class="pimg" id="pimg"></div><span id="ptime"></span></div>
      <div class="track" id="track"><i id="tfill"></i>${(it.chapters || []).slice(1).map(c => it.duration ? `<span class="chap" style="left:${c.start / it.duration * 100}%"></span>` : '').join('')}</div></div>`;
  overlayOpen(el);
  const v = q('#vid');
  q('#pq').value = cur.q; if (q('#pa')) q('#pa').value = cur.audio; q('#ps').value = cur.sub; if (q('#ps2')) q('#ps2').value = cur.sub2;
  q('#pclose').onclick = () => closePlayer();
  q('#pq').onchange = (e) => { cur.q = e.target.value; store.set('quality', cur.q); reload(); };
  if (q('#pa')) q('#pa').onchange = (e) => { cur.audio = e.target.value; reload(); };
  q('#ps').onchange = (e) => {
    const prev = it.subtitles.find(x => x.id === cur.sub), s = it.subtitles.find(x => x.id === e.target.value);
    cur.sub = e.target.value; store.set('sublang', s?.lang || ''); cur.offset = 0;
    // Bildundertexter bränns in av servern => ny ström. Textundertexter byts direkt.
    if (s?.bitmap || prev?.bitmap) reload(); else setSubs();
  };
  if (q('#ps2')) q('#ps2').onchange = (e) => { cur.sub2 = e.target.value; store.set('sub2lang', it.subtitles.find(x => x.id === cur.sub2)?.lang || ''); setSubs(); };
  if (q('#pchap')) q('#pchap').onclick = (e) => {
    e.stopPropagation();
    const l = q('#chlist');
    if (!l.hidden) { l.hidden = true; return; }
    const c0 = it.chapters.filter(c => c.start <= v.currentTime).pop();
    l.innerHTML = it.chapters.map((c, i) => `<button data-ch="${i}" class="${c === c0 ? 'on' : ''}"><span>${esc(c.title)}</span><span class="muted">${fmtTime(c.start)}</span></button>`).join('');
    l.hidden = false;
    $$('[data-ch]', l).forEach(b => b.onclick = () => { v.currentTime = it.chapters[+b.dataset.ch].start + 0.05; l.hidden = true; });
  };
  $$('[data-off]', el).forEach(b => b.onclick = () => { cur.offset = Math.round((cur.offset + +b.dataset.off) * 10) / 10; setSubs(); });
  if (q('#pcast')) q('#pcast').onclick = () => castItem(it, v.currentTime);
  if (q('#pair')) q('#pair').onclick = () => v.webkitShowPlaybackTargetPicker();
  if (q('#pnext')) q('#pnext').onclick = () => { sendProgress(true); goNext(it.nextId); };
  q('#pparty').onclick = async () => {
    if (!cur.party) {
      try { const r = await api('/party', { method: 'POST', body: { itemId: it.id }, bg: true }); if (P !== cur) return; cur.party = r.id; pushState(); joinParty(); toast('Rum skapat – dela länken'); }
      catch (e) { return toast(e.message); }
    }
    q('#partybox').hidden = !q('#partybox').hidden;
  };
  q('#pbclose').onclick = () => { q('#partybox').hidden = true; };
  q('#pcopy').onclick = () => { navigator.clipboard?.writeText(q('#plink').value).then(() => toast('Länken kopierad')); };
  q('#pmsg').onkeydown = (e) => { if (e.key === 'Enter' && e.target.value.trim() && cur.party) { api(`/party/${cur.party}/chat`, { method: 'POST', body: { text: e.target.value }, bg: true }).catch(() => {}); e.target.value = ''; } };
  // Lokala händelser skickas till rummet (men inte de som kommer från rummet självt)
  const pushState = () => { if (P === cur && cur.party && !cur.applying) api(`/party/${cur.party}/state`, { method: 'POST', body: { playing: !v.paused, position: v.currentTime }, bg: true }).catch(() => {}); };
  ['play', 'pause', 'seeked'].forEach(ev => v.addEventListener(ev, pushState));
  if (cur.party) joinParty();
  v.addEventListener('timeupdate', () => {
    if (P !== cur) return; if (Date.now() - cur.lastSent > 10000) sendProgress(); markers();
    const d = cur.it.duration || v.duration; if (d) q('#tfill').style.width = Math.min(100, v.currentTime / d * 100) + '%';
  });
  // Spolningslist med förhandsbilder (bredd cachas, ritas högst en gång per bildruta)
  api(`/items/${it.id}/trickplay`, { bg: true }).then(tp => { if (P === cur) cur.tp = tp; }).catch(() => {});
  const track = q('#track'), prev = q('#prev'), ptime = q('#ptime'), img = q('#pimg');
  let rect = null, raf = 0, mx = 0;
  const tAt = (x, r) => Math.max(0, Math.min(1, (x - r.left) / r.width)) * (cur.it.duration || v.duration || 0);
  const drawPrev = () => {
    raf = 0;
    if (P !== cur || !rect) return;
    const t = tAt(mx, rect);
    const ch = (cur.it.chapters || []).filter(c => c.start <= t).pop();
    ptime.textContent = fmtTime(t) + (ch ? ' · ' + ch.title : '');
    const tp = cur.tp;
    if (tp) {
      const i = Math.min(tp.count - 1, Math.floor(t / tp.interval)), per = tp.cols * tp.rows, sheet = Math.floor(i / per) + tp.first, k = i % per;
      Object.assign(img.style, { width: tp.w + 'px', height: tp.h + 'px', backgroundImage: `url(/api/items/${cur.it.id}/trickplay/${sheet})`,
        backgroundPosition: `-${(k % tp.cols) * tp.w}px -${Math.floor(k / tp.cols) * tp.h}px`, display: 'block' });
    } else img.style.display = 'none';
    prev.hidden = false;
    const pw = prev.offsetWidth;
    prev.style.left = Math.max(0, Math.min(rect.width - pw, mx - rect.left - pw / 2)) + 'px';
  };
  track.onmouseenter = () => { rect = track.getBoundingClientRect(); };
  track.onmousemove = (e) => {
    if (P !== cur) return;
    if (!rect) rect = track.getBoundingClientRect();
    mx = e.clientX;
    if (!raf) raf = requestAnimationFrame(drawPrev);
  };
  track.onmouseleave = () => { prev.hidden = true; rect = null; if (raf) { cancelAnimationFrame(raf); raf = 0; } };
  track.onclick = (e) => { v.currentTime = tAt(e.clientX, track.getBoundingClientRect()); };
  v.addEventListener('pause', () => P === cur && sendProgress());
  v.addEventListener('ended', () => P === cur && onEnded());
  v.addEventListener('error', () => {
    if (P === cur && cur.pb?.mode === 'direct' && !cur.forceHls) { toast('Webbläsaren kunde inte spela filen direkt – byter läge'); cur.forceHls = true; reload(); }
  });
  let idle; const wake = () => { el.classList.remove('idle'); clearTimeout(idle); idle = setTimeout(() => P === cur && !v.paused && el.classList.add('idle'), 3000); };
  el.onmousemove = wake; el.ontouchstart = wake; wake();
  videoSession(v);
  document.addEventListener('keydown', keys);
  await load(start);
}

function markers() {
  if (!P) return;
  const v = $('#vid', P.el), b = $('#pskip', P.el), pb = P.pb; if (!v || !b || !pb) return;
  const t = v.currentTime;
  if (pb.recap && t >= pb.recap.start && t < pb.recap.end - 1) {
    if (b.dataset.k !== 'recap') { b.dataset.k = 'recap'; b.textContent = 'Hoppa över sammanfattning ⏭'; b.onclick = () => { v.currentTime = pb.recap.end; b.hidden = true; }; }
    b.hidden = false;
  } else if (pb.intro && t >= pb.intro.start && t < pb.intro.end - 1) {
    if (b.dataset.k !== 'intro') { b.dataset.k = 'intro'; b.textContent = 'Hoppa över intro ⏭'; b.onclick = () => { v.currentTime = pb.intro.end; b.hidden = true; }; }
    b.hidden = false;
  } else if (pb.credits && P.it.nextId && t >= pb.credits && t < pb.credits + 60) {
    if (b.dataset.k !== 'credits') { b.dataset.k = 'credits'; b.textContent = 'Nästa avsnitt ⏭'; b.onclick = () => { if (!P) return; sendProgress(true); goNext(P.it.nextId); }; }
    b.hidden = false;
  } else { b.hidden = true; b.dataset.k = ''; }
}

function keys(e) {
  if (!P || e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || document.querySelector('dialog[open]')) return;
  const v = $('#vid', P.el); if (!v) return;
  // Mellanslag/Enter på en fokuserad knapp eller länk (t.ex. "Hoppa över intro") ska aktivera den, inte pausa
  if ((e.key === ' ' || e.key === 'Enter') && e.target !== v && e.target.closest?.('button,a,textarea,[contenteditable]')) return;
  if (e.key === 'Escape' && !document.fullscreenElement) closePlayer();
  else if (e.key === ' ' || e.key === 'k') { e.preventDefault(); v.paused ? v.play().catch(() => {}) : v.pause(); }
  else if (e.key === 'ArrowRight') v.currentTime += 10;
  else if (e.key === 'ArrowLeft') v.currentTime -= 10;
  else if (e.key === 's' && !$('#pskip', P.el).hidden) $('#pskip', P.el).click();
  else if (e.key === 'f') document.fullscreenElement ? document.exitFullscreen() : P.el.requestFullscreen?.();
}

async function load(start) {
  const cur = P; if (!cur) return;
  const { it, el } = cur, v = $('#vid', el);
  if (!v || !v.isConnected) return;
  // Varje anrop får en egen token – ett senare load() (kvalitets-/ljudbyte) eller stängning gör detta inaktuellt
  const tok = cur.tok = Symbol();
  const live = () => P === cur && cur.tok === tok && v.isConnected;
  if (cur.hls) { cur.hls.destroy(); cur.hls = null; }
  if (cur.lmd) { v.removeEventListener('loadedmetadata', cur.lmd); cur.lmd = null; }
  const sub = it.subtitles.find(s => s.id === cur.sub);
  const extra = { q: cur.q === 'auto' ? '' : cur.q, audio: cur.audio, sub: sub?.bitmap ? sub.id : '' };
  if (it.version) extra.version = it.version; // spårlistan hör till just den versionen
  if (cur.forceHls) extra.force = 'hls';
  if (canAirPlay()) extra.cast = '1'; // AirPlay-mottagaren hämtar strömmen själv och behöver token i URL:en
  let pb;
  try { pb = await api(`/items/${it.id}/playback?${capsQuery(extra)}`, { bg: true }); }
  catch (e) { if (live()) { if (e.code === 'screen_time') { closePlayer(false); timeUp(); } else toast(e.message); } return; }
  if (!live()) return;
  cur.pb = pb;
  const label = { direct: 'Direkt', remux: 'Remux', transcode: 'Omkodning' }[pb.mode];
  const pm = $('#pmode', el);
  pm.textContent = `${label}${pb.quality && pb.quality !== 'orig' ? ' · ' + pb.quality + 'p' : ''}${pb.tonemap ? ' · HDR→SDR' : ''}${pb.remote ? ' · utanför hemmet' : ''}`;
  pm.title = pb.reasons.join(', ');
  if (pb.mode === 'direct' || v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = pb.url;
  } else {
    let Hls;
    try { Hls = await loadHls(); if (!Hls.isSupported()) throw new Error(); }
    catch { if (live()) toast('Kunde inte ladda HLS-spelaren'); return; }
    if (!live()) return;
    if (cur.hls) { cur.hls.destroy(); cur.hls = null; }
    // abrEwmaDefaultEstimate: startgissning för bandbredden när mastern har flera kvalitetssteg (annars börjar
    // hls.js på lägsta steget); spelaren mäter sedan själv och växlar upp eller ner
    const hls = cur.hls = new Hls({ startPosition: start, maxBufferLength: 40, abrEwmaDefaultEstimate: 6e6, xhrSetup: (x) => { x.withCredentials = true; } });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_, d) => {
      const l = hls.levels?.[d.level];
      if (hls.levels?.length > 1 && l?.height && cur.hls === hls && live()) pm.textContent = `${label} · ${l.height}p (anpassas)${pb.remote ? ' · utanför hemmet' : ''}`;
    });
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal || cur.hls !== hls || !live()) return;
      if (d.type === 'networkError') hls.startLoad(); else if (d.type === 'mediaError') hls.recoverMediaError(); else toast('Uppspelningsfel: ' + d.details);
    });
    hls.loadSource(pb.url); hls.attachMedia(v);
  }
  const lmd = cur.lmd = () => {
    if (cur.lmd === lmd) cur.lmd = null;
    if (!live()) return;
    if (start > 0 && Math.abs(v.currentTime - start) > 2) v.currentTime = start;
    setSubs();
  };
  v.addEventListener('loadedmetadata', lmd, { once: true });
  v.play().catch(() => {});
}
function reload() { if (!P) return; const v = $('#vid', P.el); if (v) load(v.currentTime || 0); }

function setSubs() {
  if (!P) return;
  const el = P.el, v = $('#vid', el); if (!v) return;
  $$('track', v).forEach(t => t.remove());
  // Andra undertext (t.ex. för språkinlärning): laddas dold och ritas överst i bilden
  const s2 = P.sub2 && P.sub2 !== P.sub ? P.pb?.subtitles.find(s => s.id === P.sub2) : null;
  const box2 = $('#sub2', el);
  box2.innerHTML = '';
  if (s2) {
    const t2 = document.createElement('track');
    Object.assign(t2, { kind: 'metadata', src: s2.url, label: 'sub2', srclang: s2.lang || 'und' });
    v.append(t2);
    const on = () => { t2.track.mode = 'hidden'; t2.track.oncuechange = () => {
      const txt = [...(t2.track.activeCues || [])].map(c => c.text.replace(/<[^>]+>/g, '')).join('\n');
      box2.innerHTML = txt ? `<span>${esc(txt)}</span>` : '';
    }; };
    t2.addEventListener('load', on); setTimeout(on, 50);
  }
  const sub = P.pb?.subtitles.find(s => s.id === P.sub);
  $('#poff', el).hidden = !sub;
  if (!sub && !s2) return;
  $('#poffv', el).textContent = (P.offset > 0 ? '+' : '') + P.offset.toFixed(1).replace('.', ',') + ' s';
  if (!sub) return;
  const t = document.createElement('track');
  const url = sub.url + (sub.url.includes('?') ? '&' : '?') + (P.offset ? 'offset=' + P.offset : '');
  Object.assign(t, { kind: 'subtitles', src: url, default: true, label: sub.label, srclang: sub.lang || 'und' });
  v.append(t);
  t.addEventListener('load', () => { t.track.mode = 'showing'; });
  setTimeout(() => { if (t.track) t.track.mode = 'showing'; }, 50);
}

function sendProgress(final = false) {
  if (!P) return;
  const cur = P, v = $('#vid', cur.el); if (!v || !v.duration || v.currentTime < 1) return;
  cur.lastSent = Date.now();
  const body = JSON.stringify({ position: v.currentTime, duration: cur.it.duration || v.duration });
  if (final && navigator.sendBeacon) navigator.sendBeacon(`/api/items/${cur.it.id}/progress`, new Blob([body], { type: 'application/json' }));
  else fetch(`/api/items/${cur.it.id}/progress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    .then(r => r.json()).then(d => {
      if (d.screenTime) screenBadge(d.screenTime);
      if (d.stop && P === cur) { if (d.screenTime && !d.screenTime.allowed) { closePlayer(false); timeUp(); } else { toast('Uppspelningen stoppades av administratören'); closePlayer(); } }
    }).catch(() => {});
}

function onEnded() {
  sendProgress(true);
  const cur = P, { it } = cur;
  if (!it.nextId) return closePlayer();
  const box = document.createElement('div'); box.className = 'next';
  let n = 8;
  box.innerHTML = `<b>Nästa avsnitt om <span class="cd">${n}</span> s</b><div class="row"><button class="primary small" data-go>Spela nu</button><button class="ghost small" data-stay>Avbryt</button></div>`;
  cur.el.append(box);
  clearInterval(cur.nextTimer);
  const t = cur.nextTimer = setInterval(() => {
    if (P !== cur) return clearInterval(t);
    n--; $('.cd', box).textContent = n;
    if (n <= 0) { clearInterval(t); goNext(it.nextId); }
  }, 1000);
  $('[data-go]', box).onclick = () => { clearInterval(t); goNext(it.nextId); };
  $('[data-stay]', box).onclick = () => { clearInterval(t); box.remove(); };
}

async function goNext(nextId) {
  const party = P?.party;
  await play(nextId, 0);
  // I ett rum byter alla till nästa avsnitt
  if (party) api(`/party/${party}/state`, { method: 'POST', body: { itemId: nextId, playing: true, position: 0 }, bg: true }).catch(() => {});
}
function joinParty() {
  if (!P) return;
  const rid = P.party, el = P.el;
  $('#plink', el).value = `${status.publicUrl || location.origin}/#/party/${rid}`;
  $('#pparty', el).textContent = '👥 Rummet';
  if (P.es) return;
  const es = P.es = new EventSource(`/api/party/${rid}/events`);
  const apply = (st) => {
    const v = P && $('#vid', P.el); if (!v) return;
    const target = st.position + (st.playing ? (Date.now() - st.at) / 1000 : 0);
    const cur = P;
    cur.applying = true;
    if (Math.abs(v.currentTime - target) > 1.5) v.currentTime = target;
    if (st.playing && v.paused) v.play().catch(() => {});
    if (!st.playing && !v.paused) v.pause();
    setTimeout(() => { cur.applying = false; }, 600);
  };
  const members = (m) => { const x = $('#pmembers', el); if (x) x.textContent = 'Här nu: ' + m.map(y => y.name).join(', '); };
  const addChat = (c) => { const x = $('#pchat', el); if (!x) return; x.insertAdjacentHTML('beforeend', `<div><b>${esc(c.name)}:</b> ${esc(c.text)}</div>`); x.scrollTop = 1e9; };
  // hello skickas vid varje (åter)anslutning med hela historiken – töm chatten först så inget dubbleras
  es.addEventListener('hello', (e) => { const d = JSON.parse(e.data); const x = $('#pchat', el); if (x) x.innerHTML = ''; members(d.members); d.chat.forEach(addChat); if (d.state.by !== me.name || d.state.position > 0) apply(d.state); });
  es.addEventListener('state', (e) => { const st = JSON.parse(e.data); if (st.by !== me.name) apply(st); });
  es.addEventListener('members', (e) => members(JSON.parse(e.data)));
  es.addEventListener('chat', (e) => { const c = JSON.parse(e.data); addChat(c); const pb = $('#partybox', el); if (c.name !== me.name && (!pb || pb.hidden)) toast(`${c.name}: ${c.text}`); });
  es.addEventListener('item', (e) => { const d = JSON.parse(e.data); if (P && P.it.id !== d.itemId) { toast(`${d.by} bytte till nästa avsnitt`); play(d.itemId, 0); } });
  es.addEventListener('closed', () => { toast('Rummet stängdes'); es.close(); if (P && P.es === es) { P.party = null; P.es = null; } });
}
views.party = async (rid) => {
  try {
    const r = await api('/party/' + rid);
    const pos = r.state.position + (r.state.playing ? (Date.now() - r.state.at) / 1000 : 0);
    location.hash = '#/item/' + r.itemId;
    setTimeout(() => play(r.itemId, pos, { party: rid }), 50);
  } catch (e) { if (e.aborted) throw e; main.innerHTML = `<div class="empty"><h2>Rummet finns inte längre</h2><p>${esc(e.message)}</p></div>`; }
};

function closePlayer(refresh = true) {
  if (!P) return;
  if (P.es) { P.es.close(); P.es = null; }
  sendProgress(true);
  clearInterval(P.nextTimer);
  if (P.hls) { P.hls.destroy(); P.hls = null; }
  const el = P.el, v = $('#vid', el), id = P.it.id;
  if (v && P.lmd) v.removeEventListener('loadedmetadata', P.lmd);
  P.tok = null; P.lmd = null;
  P = null;
  stopVideo(v);
  fetch(`/api/stream/${id}/stop`, { method: 'POST' }).catch(() => {});
  document.removeEventListener('keydown', keys);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  overlayClose(el);
  musicSession();
  if (refresh) route();
}
window.addEventListener('pagehide', () => sendProgress(true));
initCast();

// ================= MUSIK =================
let ACAPS = null;
function audioCaps() {
  if (ACAPS) return ACAPS;
  const a = document.createElement('audio'), ok = (t) => { try { return !!a.canPlayType(t); } catch { return false; } };
  const c = ['mp3'];
  if (ok('audio/mp4; codecs="mp4a.40.2"')) c.push('aac');
  if (ok('audio/flac')) c.push('flac');
  if (ok('audio/ogg; codecs="opus"') || ok('audio/webm; codecs="opus"')) c.push('opus');
  if (ok('audio/ogg; codecs="vorbis"')) c.push('vorbis');
  if (ok('audio/mp4; codecs="alac"')) c.push('alac');
  return (ACAPS = c.join(','));
}
const cover = (albumId, has, cls = '') => {
  const h = hue(String(albumId));
  return `<div class="cover ${cls}" style="--h1:hsl(${h} 40% 30%);--h2:hsl(${(h + 60) % 360} 45% 16%)">♪${has ? `<img loading="lazy" src="/api/music/cover/${albumId}" alt="" data-fb="1">` : ''}</div>`;
};
const albumCard = (a) => `<a class="card mcard" href="#/album/${a.id}">${cover(a.id, a.cover)}<div class="t">${esc(a.title)}</div><div class="s">${esc(a.artist || '')}${a.year ? ' · ' + a.year : ''}</div></a>`;
function trackRows(tracks, opts = {}) {
  return `<table class="tracks">${tracks.map((t, i) => `<tr data-ti="${i}" data-tid="${t.id}" class="${M.cur && M.cur.id === t.id ? 'playing' : ''}">
    <td class="muted num">${opts.showCover ? cover(t.albumId, t.cover, 'tiny') : (t.track || i + 1)}</td>
    <td><b>${esc(t.title)}</b>${opts.showArtist || opts.showCover ? `<div class="muted small">${esc(t.artist || '')}${opts.showCover && t.album ? ' · ' + esc(t.album) : ''}</div>` : ''}</td>
    <td class="r muted">${fmtTime(t.duration)}</td>
    <td class="r"><button class="ghost small fav" data-fav="${t.id}" title="Favorit">${t.favorite ? '♥' : '♡'}</button>
    <button class="ghost small" data-addpl="${t.id}" title="Lägg till i spellista">+</button></td></tr>`).join('')}</table>`;
}
function bindTracks(tracks, root = main) {
  $$('[data-ti]', root).forEach(r => keyClick(r).onclick = (e) => { if (e.target.closest('button')) return; playQueue(tracks, +r.dataset.ti); });
  $$('[data-fav]', root).forEach(b => b.onclick = act(async () => {
    const on = b.textContent !== '♥'; b.textContent = on ? '♥' : '♡';
    try { await api(`/music/tracks/${b.dataset.fav}/favorite`, { method: 'POST', body: { on }, bg: true }); }
    catch (e) { b.textContent = on ? '♡' : '♥'; throw e; }
  }));
  $$('[data-addpl]', root).forEach(b => b.onclick = act(() => addToPlaylist([+b.dataset.addpl])));
}
async function addToPlaylist(ids) {
  const pls = await api('/music/playlists', { bg: true });
  const d = document.createElement('dialog');
  d.innerHTML = `<h2>Lägg till i spellista</h2><div class="plpick">${pls.map(p => `<button class="ghost" data-pl="${p.id}">${esc(p.name)} <span class="muted small">${p.tracks} låtar</span></button>`).join('')}</div>
    <div class="row" style="margin-top:12px"><input id="newpl" placeholder="Ny spellista…"><button class="primary" id="mkpl">Skapa</button></div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" id="cl">Stäng</button></div>`;
  document.body.append(d); d.showModal();
  $('#cl', d).onclick = () => { d.close(); d.remove(); };
  $$('[data-pl]', d).forEach(b => b.onclick = act(async () => { await api(`/music/playlists/${b.dataset.pl}/tracks`, { method: 'POST', body: { trackIds: ids }, bg: true }); toast('Tillagd'); d.close(); d.remove(); }));
  $('#mkpl', d).onclick = act(async () => { const n = $('#newpl', d).value.trim(); if (!n) return; await api('/music/playlists', { method: 'POST', body: { name: n, trackIds: ids }, bg: true }); toast('Spellista skapad'); d.close(); d.remove(); });
}

views.music = async (lid, tab) => {
  tab = tab || store.get('mtab.' + lid, 'home');
  store.set('mtab.' + lid, tab);
  const tabs = [['home', 'Översikt'], ['albums', 'Album'], ['artists', 'Artister'], ['playlists', 'Spellistor']];
  let body = '';
  if (tab === 'home') {
    const d = await api(`/music/${lid}/home`);
    body = `<p class="muted">${d.stats.artists} artister · ${d.stats.albums} album · ${d.stats.tracks} låtar</p>
      ${d.recentlyPlayed.length ? `<section class="section"><h2>Spelat nyligen</h2><div class="shelf">${d.recentlyPlayed.map(albumCard).join('')}</div></section>` : ''}
      ${d.smart?.length ? `<section class="section"><h2>Smarta listor</h2><div class="shelf">${d.smart.map(x => smartCard(lid, x)).join('')}</div></section>` : ''}
      <section class="section"><h2>Nytt i biblioteket</h2><div class="shelf">${d.recentAlbums.map(albumCard).join('') || '<p class="muted">Inga album ännu.</p>'}</div></section>
      ${d.favorites.length ? `<section class="section"><h2>Favoriter <button class="ghost small" id="playfav">▶ Spela</button> <button class="ghost small" id="shufav">⤨ Blanda</button></h2>${trackRows(d.favorites, { showCover: true })}</section>` : ''}`;
    main.innerHTML = musicHeader(lid, tabs, tab) + body;
    if (d.favorites.length) { bindTracks(d.favorites); $('#playfav').onclick = () => playQueue(d.favorites, 0); $('#shufav').onclick = () => playQueue(shuffle(d.favorites), 0); }
    return;
  }
  if (tab === 'albums') {
    const sort = store.get('msort', 'artist');
    const a = await api(`/music/${lid}/albums?sort=${sort}`);
    body = `<div class="toolbar"><select id="msort"><option value="artist">Artist</option><option value="title">Titel</option><option value="added">Senast tillagda</option><option value="year">År</option></select></div>
      <div class="grid">${a.map(albumCard).join('')}</div>`;
    main.innerHTML = musicHeader(lid, tabs, tab) + body;
    $('#msort').value = sort; $('#msort').onchange = (e) => { store.set('msort', e.target.value); route(); };
    return;
  }
  if (tab === 'artists') {
    const a = await api(`/music/${lid}/artists`);
    body = `<div class="grid">${a.map(x => `<a class="card mcard" href="#/artist/${x.id}">${cover(x.cover_album || x.id, !!x.cover_album, 'round')}<div class="t">${esc(x.name)}</div><div class="s">${x.albums} album</div></a>`).join('')}</div>`;
  }
  if (tab === 'playlists') {
    const p = await api('/music/playlists');
    body = `<div class="row" style="margin-bottom:14px"><input id="npl" placeholder="Ny spellista" style="max-width:260px"><button class="primary" id="mknpl">Skapa</button></div>
      <table>${p.map(x => `<tr><td><a href="#/playlist/${x.id}"><b>${esc(x.name)}</b></a></td><td class="muted">${x.tracks} låtar · ${fmtDur(x.duration || 0)}</td></tr>`).join('') || '<tr><td class="muted">Inga spellistor ännu.</td></tr>'}</table>`;
  }
  main.innerHTML = musicHeader(lid, tabs, tab) + body;
  if ($('#mknpl')) $('#mknpl').onclick = act(async () => { const n = $('#npl').value.trim(); if (!n) return; await api('/music/playlists', { method: 'POST', body: { name: n } }); route(); });
};
function musicHeader(lid, tabs, tab) {
  const lib = libs.find(l => l.id === +lid);
  return `<div class="toolbar"><h1>${esc(lib?.name || 'Musik')}</h1><input id="msearch" placeholder="Sök artist, album, låt (Enter)" style="max-width:280px"></div>
    <div class="tabs">${tabs.map(([k, n]) => `<a class="tabbtn ${k === tab ? 'on' : ''}" href="#/music/${lid}/${k}">${n}</a>`).join('')}</div>`;
}
let msearchSeq = 0;
document.addEventListener('keydown', act(async (e) => {
  if (e.target.id !== 'msearch' || e.key !== 'Enter') return;
  const lid = location.hash.split('/')[2], q = e.target.value.trim(); if (!q) return;
  const gen = routeGen, seq = ++msearchSeq;
  const r = await api(`/music/${lid}/search?q=${encodeURIComponent(q)}`);
  // Användaren kan ha bytt sida (eller sökt igen) medan vi väntade
  const tabs = $('.tabs');
  if (gen !== routeGen || seq !== msearchSeq || !tabs || !$('#msearch')) return;
  const box = document.createElement('div');
  box.innerHTML = `<section class="section"><h2>Sökresultat för ”${esc(q)}”</h2>
    ${r.artists.length ? `<div class="row" style="margin-bottom:10px">${r.artists.map(a => `<a class="btn small" href="#/artist/${a.id}">${esc(a.name)}</a>`).join('')}</div>` : ''}
    ${r.albums.length ? `<div class="shelf" style="margin-bottom:14px">${r.albums.map(albumCard).join('')}</div>` : ''}
    ${r.tracks.length ? trackRows(r.tracks, { showCover: true }) : ''}${!r.artists.length && !r.albums.length && !r.tracks.length ? '<p class="muted">Inga träffar.</p>' : ''}</section>`;
  $$('.msearchres').forEach(x => x.remove()); box.className = 'msearchres';
  tabs.after(box); bindTracks(r.tracks, box);
}));

views.album = async (id) => {
  const a = await api('/music/albums/' + id);
  main.innerHTML = `<div class="mhero">${cover(a.id, a.cover, 'big')}<div><div class="muted small">ALBUM</div><h1>${esc(a.title)}</h1>
    <div class="meta"><a href="#/artist/${a.artistId}">${esc(a.artist || '')}</a>${a.year ? `<span>${a.year}</span>` : ''}<span>${a.tracks} låtar · ${fmtDur(a.duration)}</span>${a.genre ? `<span>${esc(a.genre)}</span>` : ''}</div>
    <div class="row"><button class="primary" id="pa">▶ Spela</button><button class="ghost" id="sa">⤨ Blanda</button><button class="ghost" id="aa">+ Spellista</button></div></div></div>
    ${trackRows(a.trackList, { showArtist: a.trackList.some(t => t.artist !== a.artist) })}`;
  bindTracks(a.trackList);
  $('#pa').onclick = () => playQueue(a.trackList, 0);
  $('#sa').onclick = () => playQueue(shuffle(a.trackList), 0);
  $('#aa').onclick = act(() => addToPlaylist(a.trackList.map(t => t.id)));
};
views.artist = async (id) => {
  const a = await api('/music/artists/' + id);
  main.innerHTML = `<div class="mhero">${cover(a.albums[0]?.id || a.id, a.albums[0]?.cover, 'big round')}<div><div class="muted small">ARTIST</div><h1>${esc(a.name)}</h1>
    <div class="row"><button class="primary" id="pp">▶ Spela populära</button></div></div></div>
    ${a.popular.length ? `<section class="section"><h2>Populärt</h2>${trackRows(a.popular, { showCover: true })}</section>` : ''}
    <section class="section"><h2>Album</h2><div class="grid">${a.albums.map(albumCard).join('')}</div></section>`;
  bindTracks(a.popular);
  $('#pp').onclick = () => playQueue(a.popular, 0);
};
views.playlist = async (id) => {
  const p = await api('/music/playlists/' + id);
  main.innerHTML = `<div class="mhero"><div class="cover big plcover">♫</div><div><div class="muted small">SPELLISTA</div><h1>${esc(p.name)}</h1>
    <div class="meta"><span>${p.trackList.length} låtar · ${fmtDur(p.trackList.reduce((s, t) => s + (t.duration || 0), 0))}</span></div>
    <div class="row"><button class="primary" id="pp">▶ Spela</button><button class="ghost" id="sp">⤨ Blanda</button><button class="ghost" id="rn">Byt namn</button><button class="danger" id="dl">Ta bort</button></div></div></div>
    <div id="pltracks">${trackRows(p.trackList, { showCover: true })}</div>`;
  bindTracks(p.trackList);
  // Ta bort enskilda låtar
  $$('#pltracks tr').forEach((r, i) => { const b = document.createElement('button'); b.className = 'ghost small'; b.textContent = '✕'; b.title = 'Ta bort ur listan';
    b.onclick = act(async () => { const ids = p.trackList.map(t => t.id); ids.splice(i, 1); await api('/music/playlists/' + id, { method: 'PUT', body: { trackIds: ids } }); route(); });
    r.lastElementChild.append(b); });
  $('#pp').onclick = () => playQueue(p.trackList, 0);
  $('#sp').onclick = () => playQueue(shuffle(p.trackList), 0);
  $('#rn').onclick = act(async () => { const n = prompt('Nytt namn:', p.name); if (n) { await api('/music/playlists/' + id, { method: 'PUT', body: { name: n } }); route(); } });
  $('#dl').onclick = act(async () => { if (confirm('Ta bort spellistan?')) { await api('/music/playlists/' + id, { method: 'DELETE' }); history.back(); } });
};
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------- musikspelare (följer med mellan sidor) ----------
const M = { queue: [], idx: -1, cur: null, audio: null, repeat: false, seekSeq: 0 };
// Stäng musikbaren och sluta ladda ljudet (utan load() fortsätter elementet buffra och håller omkodningen vid liv)
function stopAudio() {
  if (!M.audio) return;
  if (M.spoken) spokenSave();
  M.spoken = null; M.cur = null; M.queue = []; M.idx = -1; M.sfile = null; M.seekSeq++;
  setSleep(0); showLyrics(false);
  stopVideo(M.audio);
  const bar = $('#mbar'); if (bar) bar.hidden = true;
  document.body.classList.remove('hasbar');
  setSession({});
}
function ensureBar() {
  if ($('#mbar')) return;
  const bar = document.createElement('div'); bar.id = 'mbar'; bar.hidden = true;
  bar.innerHTML = `<audio id="maudio" preload="auto"></audio>
    <div class="mleft"><div id="mcov"></div><div class="mtxt"><b id="mtitle"></b><a id="martist" class="muted small"></a></div></div>
    <div class="mmid"><div class="row mctl"><button class="ghost small" id="mprev">⏮</button><button class="primary" id="mplay">⏸</button><button class="ghost small" id="mnext">⏭</button>
      <button class="ghost small" id="mrep" title="Upprepa">🔁</button><button class="ghost small" id="msleep" title="Sovtimer">☾</button><button class="ghost small" id="mlyr" title="Låttext">Text</button></div>
      <div class="mseek"><span id="mcurt" class="small muted">0:00</span><div class="track" id="mtrack"><i id="mfill"></i></div><span id="mdur" class="small muted">0:00</span></div></div>
    <div class="mright"><select id="mspeed" title="Hastighet" hidden>${[0.75, 1, 1.1, 1.25, 1.5, 1.75, 2].map(v => `<option value="${v}">${String(v).replace('.', ',')}×</option>`).join('')}</select><input type="range" id="mvol" min="0" max="1" step="0.05" value="${store.get('mvol', 1)}"><button class="ghost small" id="mq">Kö</button><button class="ghost small" id="mx" title="Stäng">✕</button></div>`;
  document.body.append(bar);
  const a = M.audio = $('#maudio');
  a.volume = store.get('mvol', 1);
  ensureLyricsPanel();
  a.ontimeupdate = () => {
    if (M.spoken) return spokenTick();
    lyricsTick();
    // Omkodad ström som startats om vid spolning börjar på 0 – lägg till startpositionen
    const t = a.currentTime + (M.offset || 0);
    $('#mcurt').textContent = fmtTime(t); const d = M.cur?.duration || a.duration; if (d) { $('#mfill').style.width = (t / d * 100) + '%'; $('#mdur').textContent = fmtTime(d); } };
  a.onended = () => M.spoken ? spokenEnded() : nextTrack(true);
  $('#mspeed').onchange = (e) => { a.playbackRate = +e.target.value; if (M.spoken) { M.spoken.speed = a.playbackRate; store.set('speed', a.playbackRate); } };
  a.onplay = () => { if (NORM.ctx?.state === 'suspended') NORM.ctx.resume().catch(() => {}); $('#mplay').textContent = '⏸'; if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'; };
  a.onpause = () => { $('#mplay').textContent = '▶'; if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'; if (M.spoken) spokenSave(); };
  a.onerror = () => toast('Kunde inte spela låten');
  $('#mplay').onclick = () => a.paused ? a.play() : a.pause();
  $('#mnext').onclick = () => M.spoken ? spokenSeek(spokenPos() + LPREFS.skipForward) : nextTrack(false);
  $('#mprev').onclick = () => { if (M.spoken) return spokenSeek(spokenPos() - LPREFS.skipBack); if (a.currentTime + (M.offset || 0) > 3) seekTo(0); else if (M.idx > 0) loadTrack(M.idx - 1); };
  $('#mrep').onclick = () => { M.repeat = !M.repeat; $('#mrep').classList.toggle('on', M.repeat); };
  $('#mvol').oninput = (e) => { store.set('mvol', +e.target.value); applyVolume(); };
  $('#msleep').onclick = sleepDialog;
  $('#mlyr').onclick = toggleLyrics;
  $('#mtrack').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(), d = M.spoken?.duration || M.cur?.duration || a.duration; if (d) seekTo((e.clientX - r.left) / r.width * d); };
  $('#mx').onclick = stopAudio;
  $('#mq').onclick = showQueue;
  if (!P && !LP && !RP) musicSession();
}
// Mediatangenter (tangentbord, hörlurar, låsskärm) styr den spelare som är aktiv
const MS_ACTIONS = ['play', 'pause', 'nexttrack', 'previoustrack', 'seekto', 'seekbackward', 'seekforward', 'stop'];
function setSession(h) {
  if (!navigator.mediaSession) return;
  for (const k of MS_ACTIONS) { try { navigator.mediaSession.setActionHandler(k, h[k] || null); } catch {} }
}
function videoSession(v) {
  setSession({ play: () => v.play().catch(() => {}), pause: () => v.pause(),
    seekto: (d) => { v.currentTime = d.seekTime; }, seekbackward: () => { v.currentTime -= 10; }, seekforward: () => { v.currentTime += 10; } });
  if (navigator.mediaSession) navigator.mediaSession.metadata = null;
}
function musicSession() {
  const a = M.audio;
  if (!a) return setSession({});
  setSession({ play: () => a.play().catch(() => {}), pause: () => a.pause(), nexttrack: () => nextTrack(false), previoustrack: () => $('#mprev')?.click(),
    seekto: (d) => seekTo(d.seekTime),
    seekbackward: () => M.spoken ? spokenSeek(spokenPos() - LPREFS.skipBack) : (a.currentTime -= 10),
    seekforward: () => M.spoken ? spokenSeek(spokenPos() + LPREFS.skipForward) : (a.currentTime += 10) });
}
// ---------- tal: ljudböcker och poddar (flera filer, global position, hastighet, sparad position) ----------
function setBarMode(spoken) {
  $('#mspeed').hidden = !spoken; $('#mrep').hidden = spoken; $('#mq').hidden = spoken; $('#mlyr').hidden = spoken;
  const b = LPREFS.skipBack, f = LPREFS.skipForward;
  $('#mprev').textContent = spoken ? `↺${b}` : '⏮'; $('#mnext').textContent = spoken ? `${f}↻` : '⏭';
  $('#mprev').title = spoken ? `${b} sekunder bakåt` : 'Föregående'; $('#mnext').title = spoken ? `${f} sekunder framåt` : 'Nästa';
  if (spoken) showLyrics(false);
  applyVolume();
}
function playSpoken(s) {
  ensureBar();
  loadListenPrefs();
  closeAllPlayers();
  if (M.spoken) spokenSave();
  M.queue = []; M.idx = -1; M.cur = { id: null, duration: s.duration, title: s.title };
  M.spoken = { ...s, speed: s.speed || +store.get('speed', 1), lastSave: Date.now() };
  M.sfile = null;
  setBarMode(true);
  const bar = $('#mbar'); bar.hidden = false; document.body.classList.add('hasbar');
  $('#mcov').innerHTML = s.cover ? `<div class="cover small"><img src="${esc(s.cover)}" alt=""></div>` : '<div class="cover small">🎧</div>';
  $('#mtitle').textContent = s.title;
  $('#martist').textContent = s.sub || ''; $('#martist').href = s.link || '#';
  $('#mspeed').value = String(M.spoken.speed);
  if (navigator.mediaSession && window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: s.sub || '', artwork: s.cover ? [{ src: s.cover, sizes: '600x600', type: 'image/jpeg' }] : [] });
  spokenSeek(s.position && s.duration && s.duration - s.position > 30 ? s.position : 0);
}
const spokenPos = () => M.spoken && M.sfile ? M.sfile.offset + (M.soff || 0) + M.audio.currentTime : 0;
async function spokenSeek(t) {
  const s = M.spoken, a = M.audio; if (!s) return;
  t = Math.max(0, Math.min(t, (s.duration || 1e9) - 0.5));
  const f = [...s.files].reverse().find(x => x.offset <= t) || s.files[0];
  const local = t - f.offset;
  const seq = ++M.seekSeq;
  if (M.sfile === f && !M.transcoded) { a.currentTime = local; return; }
  const head = await fetch(f.url, { method: 'HEAD' }).catch(() => null);
  // Ett senare hopp eller ett annat avsnitt har hunnit före – detta svar gäller inte längre
  if (seq !== M.seekSeq || M.spoken !== s) return;
  M.sfile = f;
  M.transcoded = head?.headers.get('x-transcoded') === '1';
  M.soff = M.transcoded ? local : 0;
  a.src = M.transcoded ? f.url + (f.url.includes('?') ? '&' : '?') + 'ss=' + local : f.url;
  a.addEventListener('loadedmetadata', () => { if (!M.transcoded && local > 0) a.currentTime = local; a.playbackRate = M.spoken?.speed || 1; }, { once: true });
  a.play().catch(() => {});
}
function spokenTick() {
  const s = M.spoken, t = spokenPos();
  $('#mcurt').textContent = fmtTime(t); $('#mdur').textContent = fmtTime(s.duration || 0);
  if (s.duration) $('#mfill').style.width = Math.min(100, t / s.duration * 100) + '%';
  const ch = (s.chapters || []).filter(c => c.start <= t).pop();
  if (ch && s.chapters.length > 1) $('#martist').textContent = `${s.sub ? s.sub + ' · ' : ''}${ch.title}`;
  if (Date.now() - s.lastSave > 15000 && !M.audio.paused) spokenSave();
}
function spokenSave(final) {
  const s = M.spoken; if (!s) return;
  s.lastSave = Date.now();
  const position = final ? s.duration : spokenPos();
  if (!final && position < 5) return;
  const url = s.kind === 'book' ? `/api/audiobooks/book/${s.id}/progress` : `/api/podcasts/episodes/${s.id}/progress`;
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position, speed: s.speed }), keepalive: true })
    .then(r => r.json()).then(d => { if (d.screenTime) screenBadge(d.screenTime); if (d.stop && M.spoken === s && !M.audio.paused) { M.audio.pause(); toast(d.screenTime?.message || 'Tiden är slut för idag'); } }).catch(() => {});
}
function spokenEnded() {
  const s = M.spoken, i = s.files.indexOf(M.sfile);
  if (i >= 0 && i + 1 < s.files.length) spokenSeek(s.files[i + 1].offset + 0.01);
  else { spokenSave(true); setSleep(0); toast(s.kind === 'book' ? 'Boken är slut' : 'Avsnittet är slut'); }
}
window.addEventListener('pagehide', () => { if (M.spoken) spokenSave(); });
function seekTo(t) {
  if (M.spoken) return spokenSeek(t);
  const a = M.audio;
  // Omkodade strömmar saknar Range – starta om på rätt position
  if (M.transcoded) { M.offset = t; a.src = M.url + (M.url.includes('?') ? '&' : '?') + 'ss=' + t; a.play().catch(() => {}); }
  else { M.offset = 0; a.currentTime = t; }
}
function playQueue(tracks, i) {
  if (!tracks.length) return;
  ensureBar();
  if (M.spoken) { spokenSave(); M.spoken = null; }
  setBarMode(false);
  closeAllPlayers();
  ensureGainNode(); // i användarens klick – annars får ljudsammanhanget inte starta
  loadListenPrefs();
  M.queue = tracks; loadTrack(i);
}
async function loadTrack(i) {
  const t = M.queue[i]; if (!t) return;
  M.idx = i; M.cur = t;
  const a = M.audio, bar = $('#mbar');
  bar.hidden = false; document.body.classList.add('hasbar');
  M.url = `/api/music/tracks/${t.id}/stream?a=${audioCaps()}`;
  M.offset = 0; M.transcoded = false; // inte föregående spårs (eller bokens) värden
  applyVolume(); // spårets egen ljudnivå
  loadLyrics();
  a.src = M.url;
  a.play().catch(() => {});
  fetch(M.url, { method: 'HEAD' }).then(r => { if (M.cur === t) M.transcoded = r.headers.get('x-transcoded') === '1'; }).catch(() => {});
  $('#mcov').innerHTML = cover(t.albumId, t.cover, 'small');
  $('#mtitle').textContent = t.title;
  $('#martist').textContent = t.artist || ''; $('#martist').href = t.artistId ? `#/artist/${t.artistId}` : '#';
  $$('tr[data-ti]').forEach(r => r.classList.toggle('playing', r.dataset.tid === String(t.id)));
  if (navigator.mediaSession && window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || '', album: t.album || '',
    artwork: t.cover ? [{ src: `/api/music/cover/${t.albumId}`, sizes: '600x600', type: 'image/jpeg' }] : [] });
  fetch(`/api/music/tracks/${t.id}/played`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
}
function nextTrack(auto) {
  // Sovtimer "när låten tar slut": stanna i stället för att gå vidare
  if (auto && SLEEP.end) { M.audio.pause(); setSleep(0); return; }
  if (M.idx + 1 < M.queue.length) loadTrack(M.idx + 1);
  else if (M.repeat) loadTrack(0);
  else if (auto) { M.audio.pause(); }
}
function showQueue() {
  const d = document.createElement('dialog');
  d.innerHTML = `<h2>Kö</h2><div style="max-height:60vh;overflow:auto">${trackRows(M.queue, { showCover: true })}</div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" id="cl">Stäng</button></div>`;
  document.body.append(d); d.showModal();
  $$('tr[data-ti]', d).forEach(r => { if (+r.dataset.ti === M.idx) r.classList.add('playing'); keyClick(r).onclick = (e) => { if (e.target.closest('button')) return; loadTrack(+r.dataset.ti); d.close(); d.remove(); }; });
  $('#cl', d).onclick = () => { d.close(); d.remove(); };
}

// ================= LYSSNING: inställningar, jämn ljudnivå, sovtimer, låttexter och smarta listor =================
let LPREFS = { normalize: true, skipBack: 15, skipForward: 30, skipSilence: false, choices: { skipBack: [5, 10, 15, 30, 45, 60], skipForward: [10, 15, 30, 45, 60, 90] } };
// Hämtas när uppspelning startar (kan ha ändrats i en annan app eller profil)
function loadListenPrefs() {
  return api('/me/listening', { bg: true }).then(p => {
    LPREFS = p;
    if (M.audio) { if (M.spoken) setBarMode(true); else applyVolume(); }
    return p;
  }).catch(() => LPREFS);
}
async function renderListenPrefs(box) {
  const gen = routeGen;
  const p = await api('/me/listening');
  if (gen !== routeGen || !box.isConnected) return;
  const opts = (list, v) => list.map(n => `<option value="${n}" ${n === v ? 'selected' : ''}>${n} sekunder</option>`).join('');
  box.innerHTML = `<h2>Lyssning</h2>
    <label class="row"><input type="checkbox" id="lpnorm" ${p.normalize ? 'checked' : ''} style="width:auto"> Jämn ljudnivå i musik</label>
    <p class="muted small" style="margin:4px 0 12px">Låtar spelas lika högt med hjälp av ReplayGain-taggar, eller med ljudstyrka som servern mäter i bakgrunden efter skanning. I Safari på iPhone/iPad kan webbsidan inte ändra volymen – använd appen där.</p>
    <div class="row"><div><label>Hopp bakåt (ljudböcker och poddar)</label><select id="lpback">${opts(p.choices.skipBack, p.skipBack)}</select></div>
      <div><label>Hopp framåt</label><select id="lpfwd">${opts(p.choices.skipForward, p.skipForward)}</select></div></div>
    <label class="row" style="margin-top:12px"><input type="checkbox" id="lpsil" ${p.skipSilence ? 'checked' : ''} style="width:auto"> Hoppa över tystnad i poddar</label>
    <p class="muted small" style="margin:4px 0 0">Fungerar i Android-appen (och i bilen). Webben och iPhone/Apple TV saknar ett säkert sätt att korta tystnad utan att den sparade positionen blir fel.</p>`;
  const save = act(async () => {
    LPREFS = await api('/me/listening', { method: 'PUT', body: { normalize: $('#lpnorm').checked, skipBack: +$('#lpback').value, skipForward: +$('#lpfwd').value, skipSilence: $('#lpsil').checked }, bg: true });
    if (M.audio) { if (LPREFS.normalize && M.cur && !M.spoken) ensureGainNode(); if (M.spoken) setBarMode(true); else applyVolume(); }
    toast('Sparat');
  });
  for (const id of ['#lpnorm', '#lpback', '#lpfwd', '#lpsil']) $(id, box).onchange = save;
}

// ---------- jämn ljudnivå ----------
// Web Audio (GainNode) kan även höja tysta låtar. iOS-Safari pausar Web Audio när skärmen låses, så där används den inte
// (och där går det inte heller att ändra volymen – normaliseringen gör då ingenting).
const NORM = { ctx: null, node: null, failed: false };
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function ensureGainNode() {
  if (NORM.node || NORM.failed || !LPREFS.normalize || !M.audio) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || isIOS()) { NORM.failed = true; return; }
  try {
    const ctx = new AC(), src = ctx.createMediaElementSource(M.audio), node = ctx.createGain();
    src.connect(node); node.connect(ctx.destination);
    NORM.ctx = ctx; NORM.node = node;
  } catch { NORM.failed = true; }
}
/** Spårets förstärkning (linjär) mot referensen -18 LUFS; aldrig så mycket att toppen klipps, högst +12 dB. */
function trackGain() {
  const t = M.cur;
  if (M.spoken || !LPREFS.normalize || !t || t.gain == null) return 1;
  let g = 10 ** (t.gain / 20);
  if (t.peak > 0) g = Math.min(g, 1 / t.peak);
  return Math.min(g, 4);
}
/** Volym = reglaget × (bara dämpning om Web Audio saknas) × sovtimerns nedtoning */
function applyVolume() {
  const a = M.audio; if (!a) return;
  const g = trackGain(), vol = +store.get('mvol', 1), fade = M.fade ?? 1;
  if (NORM.node) { NORM.node.gain.value = g; a.volume = Math.max(0, Math.min(1, vol * fade)); }
  else a.volume = Math.max(0, Math.min(1, vol * Math.min(1, g) * fade));
}

// ---------- sovtimer ----------
const SLEEP = { until: 0, end: false, timer: null };
const SLEEP_FADE = 10; // sekunder nedtoning före paus
function setSleep(v) { // v: 0 = av, antal minuter eller 'end' (när låten/kapitlet/avsnittet tar slut)
  clearInterval(SLEEP.timer); SLEEP.timer = null;
  SLEEP.end = v === 'end';
  SLEEP.until = typeof v === 'number' && v > 0 ? Date.now() + v * 60e3 : 0;
  M.fade = 1; applyVolume();
  if (SLEEP.end || SLEEP.until) SLEEP.timer = setInterval(sleepTick, 250);
  sleepLabel();
}
function sleepLeft() {
  const a = M.audio;
  if (!SLEEP.end) return (SLEEP.until - Date.now()) / 1000;
  const rate = a.playbackRate || 1;
  if (M.spoken) {
    const s = M.spoken, t = spokenPos();
    let end = s.duration || 0;
    if (s.kind === 'book' && (s.chapters || []).length > 1) { const ch = s.chapters.filter(c => c.start <= t).pop(); if (ch?.end) end = end ? Math.min(end, ch.end) : ch.end; }
    return end ? (end - t) / rate : Infinity;
  }
  const d = M.cur?.duration || a.duration;
  return d ? (d - (a.currentTime + (M.offset || 0))) / rate : Infinity;
}
function sleepTick() {
  const a = M.audio;
  if (!a || (!M.cur && !M.spoken)) return setSleep(0);
  const left = sleepLeft();
  M.fade = left < SLEEP_FADE ? Math.max(0, left / SLEEP_FADE) : 1;
  applyVolume();
  // Pausen sparar positionen (ljudböcker/poddar) via onpause
  if (left <= 0.3) { a.pause(); setSleep(0); toast('Sovtimern pausade uppspelningen'); return; }
  sleepLabel(left);
}
function sleepLabel(left) {
  const b = $('#msleep'); if (!b) return;
  b.classList.toggle('on', !!(SLEEP.until || SLEEP.end));
  b.textContent = SLEEP.until ? `☾ ${Math.max(1, Math.ceil((left ?? sleepLeft()) / 60))} min` : SLEEP.end ? '☾ slut' : '☾';
}
function sleepDialog() {
  const what = M.spoken ? (M.spoken.kind === 'book' ? 'kapitlet' : 'avsnittet') : 'låten';
  const d = document.createElement('dialog');
  d.innerHTML = `<h2>Sovtimer</h2><p class="muted small">Ljudet tonas ner och pausas – positionen i ljudböcker och poddar sparas.</p>
    <div class="plpick">${[15, 30, 45, 60].map(m => `<button class="ghost" data-sl="${m}">${m} minuter</button>`).join('')}
    <button class="ghost" data-sl="end">När ${what} tar slut</button>${SLEEP.until || SLEEP.end ? '<button class="ghost" data-sl="0">Stäng av sovtimern</button>' : ''}</div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" id="cl">Stäng</button></div>`;
  document.body.append(d); d.showModal();
  const close = () => { d.close(); d.remove(); };
  $('#cl', d).onclick = close;
  $$('[data-sl]', d).forEach(b => b.onclick = () => {
    const v = b.dataset.sl;
    setSleep(v === 'end' ? 'end' : +v);
    if (v !== '0') toast(v === 'end' ? `Pausar när ${what} tar slut` : `Pausar om ${v} minuter`);
    close();
  });
}

// ---------- låttexter ----------
const LY = { open: false, data: null, tid: null, idx: -1, seq: 0 };
function ensureLyricsPanel() {
  if ($('#lyrics')) return;
  const p = document.createElement('div'); p.id = 'lyrics'; p.hidden = true;
  p.innerHTML = `<div class="lyhead"><b id="lytitle"></b><button class="ghost small" id="lyx" title="Stäng">✕</button></div><div id="lybody"></div>`;
  document.body.append(p);
  $('#lyx').onclick = () => showLyrics(false);
}
function showLyrics(on) {
  LY.open = on;
  const p = $('#lyrics'); if (p) p.hidden = !on;
  $('#mlyr')?.classList.toggle('on', on);
  if (on) { LY.tid = null; loadLyrics(); }
}
const toggleLyrics = () => showLyrics(!LY.open);
async function loadLyrics() {
  const t = M.cur;
  if (!LY.open || !t?.id || M.spoken || LY.tid === t.id) return;
  LY.tid = t.id; LY.data = null; LY.idx = -1;
  const seq = ++LY.seq;
  $('#lytitle').textContent = t.title;
  $('#lybody').innerHTML = '<div class="spin"></div>';
  let d;
  try { d = await api(`/music/tracks/${t.id}/lyrics`, { bg: true }); } catch { d = { lines: [] }; }
  if (seq !== LY.seq) return; // en annan låt hann starta
  LY.data = d;
  $('#lybody').innerHTML = d.lines.length ? d.lines.map((l, i) => `<p data-ly="${i}" class="${d.synced ? 'sync' : ''}">${esc(l.text) || '&nbsp;'}</p>`).join('')
    : '<p class="muted">Ingen text hittades. Lägg en .lrc-fil med samma namn bredvid ljudfilen, eller bädda in texten i filens taggar.</p>';
  if (d.synced) $$('[data-ly]', $('#lybody')).forEach(p => keyClick(p).onclick = () => seekTo(d.lines[+p.dataset.ly].t));
  lyricsTick();
}
function lyricsTick() {
  const d = LY.data;
  if (!LY.open || !d?.synced || M.spoken) return;
  const t = M.audio.currentTime + (M.offset || 0) + 0.2;
  let lo = 0, hi = d.lines.length - 1, i = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (d.lines[mid].t <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
  if (i === LY.idx) return;
  LY.idx = i;
  const box = $('#lybody');
  box.querySelector('.on')?.classList.remove('on');
  const el = i >= 0 ? box.querySelector(`[data-ly="${i}"]`) : null;
  if (el) { el.classList.add('on'); box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' }); }
}

// ---------- smarta spellistor ----------
function smartCard(lid, x) {
  const c = x.covers || [];
  const art = c.length >= 4 ? `<div class="cover smartmosaic">${c.slice(0, 4).map(id => `<img loading="lazy" src="/api/music/cover/${+id}" alt="" data-fb="1">`).join('')}</div>`
    : cover(c[0] || x.id, !!c.length);
  return `<a class="card mcard" href="#/smart/${+lid}/${encodeURIComponent(x.id)}">${art}<div class="t">${esc(x.name)}</div><div class="s">${x.count} låtar</div></a>`;
}
views.smart = async (lid, sid) => {
  const p = await api(`/music/${encodeURIComponent(lid)}/smart/${encodeURIComponent(sid)}`);
  main.innerHTML = `<div class="mhero"><div class="cover big plcover">✦</div><div><div class="muted small">SMART LISTA</div><h1>${esc(p.name)}</h1>
    <div class="meta"><span>${p.trackList.length} låtar · ${fmtDur(p.trackList.reduce((s, t) => s + (t.duration || 0), 0))}</span><span>Uppdateras automatiskt</span></div>
    <div class="row"><button class="primary" id="pp">▶ Spela</button><button class="ghost" id="sp">⤨ Blanda</button><button class="ghost" id="ap">+ Spellista</button></div></div></div>
    ${p.trackList.length ? trackRows(p.trackList, { showCover: true }) : '<p class="muted">Listan är tom just nu.</p>'}`;
  bindTracks(p.trackList);
  $('#pp').onclick = () => playQueue(p.trackList, 0);
  $('#sp').onclick = () => playQueue(shuffle(p.trackList), 0);
  $('#ap').onclick = act(() => addToPlaylist(p.trackList.map(t => t.id)));
};

// ---------- skärmtid, följda serier och automatisk nedladdning ----------
Object.assign(EVENTS, { screentime_changed: 'Skärmtid ändrad', screentime_extra: 'Extra skärmtid', history_imported: 'Tittarhistorik importerad' });
let screenSt = null;
const fmtMin = (s) => { const m = Math.max(0, Math.round((s || 0) / 60)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const screenText = (s) => !s ? 'Ingen skärmtid är inställd.' : `Idag har ${fmtMin(s.used)} använts${s.daily != null ? ` av ${s.daily + s.extra} min` : ''}${s.extra ? ` (varav ${s.extra} min extra)` : ''}.${s.from || s.until ? ` Tillåten tid: ${s.from || '00:00'}–${s.until || '24:00'}.` : ''} ${s.allowed ? (s.left != null ? `Kvar just nu: ${fmtMin(s.left)}.` : '') : s.message}`;
/** Märke i menyraden med kvarvarande tid (bara för profiler med skärmtid) */
function screenBadge(s) {
  screenSt = s || null;
  let b = $('#stbadge');
  if (!s?.limited) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('a'); b.id = 'stbadge'; b.href = '#/timeup'; b.className = 'stbadge'; $('.usermenu').before(b); }
  b.textContent = s.allowed ? (s.left != null ? `⏱ ${fmtMin(s.left)} kvar` : '⏱ Skärmtid') : '🌙 Slut för idag';
  b.title = screenText(s);
  b.classList.toggle('low', !s.allowed || (s.left != null && s.left < 600));
}
function refreshScreen() {
  if (!me || !(me.screenTime || me.kid || screenSt)) return;
  api('/screentime', { bg: true }).then(screenBadge).catch(() => {});
}
function timeUp() { if (location.hash === '#/timeup') route(); else location.hash = '#/timeup'; }
views.timeup = async () => {
  const s = await api('/screentime');
  screenBadge(s);
  if (!s.limited) { main.innerHTML = '<div class="empty"><h2>Ingen skärmtid är inställd</h2><p><a class="btn" href="#/">Till startsidan</a></p></div>'; return; }
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
function screenPing(v, key, alive, stop) {
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
async function screenDialog(p) {
  if (!p) return;
  const D0 = await api('/screentime/' + p.id, { bg: true });
  const r = D0.rules || {};
  const DAYS = [[1, 'Måndag'], [2, 'Tisdag'], [3, 'Onsdag'], [4, 'Torsdag'], [5, 'Fredag'], [6, 'Lördag'], [0, 'Söndag']];
  const v = (x) => x == null ? '' : esc(String(x));
  const dlg = document.createElement('dialog'); dlg.className = 'wide';
  dlg.innerHTML = `<h2>Skärmtid – ${esc(p.name)}</h2>
    <p class="muted small" id="stnow">${esc(screenText(D0.status))}</p>
    <div class="row" style="align-items:flex-end"><div><label>Max minuter per dag</label><input id="std" type="number" min="0" max="1440" value="${v(r.daily)}" placeholder="Ingen gräns" style="width:150px"></div>
      <div><label>Tillåtet från</label><input id="stf" type="time" value="${v(r.from)}"></div><div><label>Till</label><input id="stu" type="time" value="${v(r.until)}"></div></div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type="checkbox" id="sta" ${r.audio ? 'checked' : ''}> Gäller även ljud (musik, ljudböcker och poddar)</label>
    <details style="margin-top:12px"><summary>Andra tider vissa veckodagar</summary><p class="muted small">Tomma fält = samma som ovan.</p>
      <table><tr><th></th><th>Minuter</th><th>Från</th><th>Till</th></tr>${DAYS.map(([i, n]) => { const o = r.days?.[i] || {};
        return `<tr><td>${n}</td><td><input data-dd="${i}" type="number" min="0" max="1440" value="${v(o.daily)}" style="width:90px"></td><td><input data-df="${i}" type="time" value="${v(o.from)}"></td><td><input data-du="${i}" type="time" value="${v(o.until)}"></td></tr>`; }).join('')}</table></details>
    <h3 style="font-size:15px;margin:16px 0 6px">Extra tid idag</h3>
    <div class="row"><button class="ghost small" data-ex="15">+15 min</button><button class="ghost small" data-ex="30">+30 min</button><button class="ghost small" data-ex="60">+1 timme</button>
      <button class="ghost small" data-ex="-15">−15 min</button><button class="ghost small" data-exr="1">Nollställ dagens tid</button></div>
    <p class="muted small">Tiden räknas när film, serier, live-TV eller inspelningar spelas (inte när de är pausade) på alla enheter, och två samtidiga strömmar räknas inte dubbelt. När tiden är slut stoppas uppspelningen. Klockslagen följer serverns tid. Extra tid förlänger även dagens sluttid. Nedladdat i appen som ses utan nät räknas inte.</p>
    <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="ghost" id="stc">Stäng</button><button class="danger" id="stoff">Ingen gräns</button><button class="primary" id="sts">Spara</button></div>`;
  document.body.append(dlg); dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());
  const close = () => dlg.close();
  $('#stc', dlg).onclick = close;
  const save = async (body) => { const res = await api('/screentime/' + p.id, { method: 'PUT', body, bg: true }); toast(res.rules ? 'Skärmtiden är sparad' : `${p.name} har ingen skärmtid`); close(); };
  $('#sts', dlg).onclick = act(() => save({ daily: $('#std', dlg).value, from: $('#stf', dlg).value, until: $('#stu', dlg).value, audio: $('#sta', dlg).checked,
    days: Object.fromEntries(DAYS.map(([i]) => [i, { daily: $(`[data-dd="${i}"]`, dlg).value, from: $(`[data-df="${i}"]`, dlg).value, until: $(`[data-du="${i}"]`, dlg).value }])) }));
  $('#stoff', dlg).onclick = act(() => save({}));
  $$('[data-ex],[data-exr]', dlg).forEach(b => b.onclick = act(async () => {
    const res = await api(`/screentime/${p.id}/extra`, { method: 'POST', body: b.dataset.exr ? { reset: true } : { minutes: +b.dataset.ex }, bg: true });
    $('#stnow', dlg).textContent = screenText(res.status); toast('Sparat');
  }));
}
function bindFollow(it) {
  const b = $('#follow'), sel = $('#fsync'); if (!b) return;
  if (sel) sel.value = it.sync == null ? '' : String(it.sync);
  b.onclick = act(async () => {
    const r = await api(`/items/${it.id}/follow`, { method: 'POST', body: { follow: !it.following } });
    it.following = r.following; it.sync = r.sync;
    b.textContent = it.following ? '🔔 Följer' : '🔕 Följ';
    if (sel) sel.hidden = !it.following;
    toast(it.following ? `Du följer ${it.title} – nya avsnitt visas under Nytt för dig` : `Du följer inte längre ${it.title}`);
  });
  if (sel) sel.onchange = act(async () => { const r = await api(`/items/${it.id}/follow`, { method: 'POST', body: { follow: true, sync: sel.value } }); it.sync = r.sync; toast('Sparat'); });
}
/** Paneler under Mitt konto: följda serier, personliga notiser och automatisk nedladdning i appen */
async function accountExtras() {
  let N, S, F;
  try { [N, S, F] = await Promise.all([api('/me/notify'), api('/me/offline-sync'), api('/follows')]); }
  catch (e) { if (e.aborted) throw e; return; }
  main.insertAdjacentHTML('beforeend', `
  <div class="panel"><h2>Serier jag följer</h2>
    <p class="muted small">Nya avsnitt av serier du följer visas under <b>Nytt för dig</b> på startsidan. Du följer en serie med knappen Följ på serien, och automatiskt när du lägger den i Min lista eller ser klart ett avsnitt. Slutar du följa en serie följs den inte automatiskt igen.</p>
    ${F.length ? `<table>${F.map(f => `<tr><td><a href="#/item/${f.id}">${esc(f.title)}</a></td><td class="muted small">${f.sync == null ? '' : f.sync === 0 ? 'Laddas inte ner i appen' : `Håll ${f.sync} nedladdade i appen`}</td>
      <td class="r"><button class="ghost small" data-unf="${f.id}">Sluta följa</button></td></tr>`).join('')}</table>` : '<p class="muted">Du följer inga serier ännu.</p>'}</div>
  ${N.allowed ? `<div class="panel"><h2>Notiser om nya avsnitt</h2>
    <p class="muted small">Få en notis i mobilen när nya avsnitt av serier du följer kommer – flera avsnitt samlas i en notis. Använd t.ex. appen <b>ntfy</b> (adress som https://ntfy.sh/ett-hemligt-ämne) eller en egen webhook som tar emot JSON. Adressen måste gå att nå via internet; adresser i hemnätet tillåts inte.</p>
    <div class="row" style="align-items:flex-end"><div><label>Typ</label><select id="nk"><option value="none">Av</option><option value="ntfy">ntfy</option><option value="webhook">Webhook (JSON)</option></select></div>
      <div style="flex:1;min-width:220px"><label>Adress</label><input id="nu" value="${esc(N.url)}" placeholder="https://ntfy.sh/mitt-hemliga-amne" maxlength="500"></div>
      <div><label>Token (valfri)</label><input id="nt" type="password" autocomplete="off" placeholder="${N.hasToken ? '(sparad)' : ''}"></div></div>
    <div class="row" style="margin-top:12px"><button class="primary" id="nsave">Spara</button><button class="ghost" id="ntest" ${N.kind === 'none' ? 'disabled' : ''}>Skicka testnotis</button></div></div>` : ''}
  <div class="panel"><h2>Automatisk nedladdning i appen</h2>
    <p class="muted small">iPhone/iPad- och Android-appen håller de närmaste osedda avsnitten nedladdade, så att de finns när du saknar nät. Appen synkar när den öppnas och tar bort avsnitt som den själv laddat ner när du har sett dem. Per serie kan du ändra antalet på seriens sida.</p>
    <div class="row" style="align-items:flex-end">
      <div><label>Avsnitt per serie</label><select id="sc"><option value="0">Av</option>${[1, 2, 3, 5, 10].map(n => `<option value="${n}">${n}</option>`).join('')}</select></div>
      <div><label>Vilka serier</label><select id="ss"><option value="follows">Serier jag följer</option><option value="continue">Fortsätt titta (senaste 30 dagarna)</option></select></div>
      <div><label>Kvalitet</label><select id="sq"><option value="480">480p (minst)</option><option value="720">720p</option><option value="1080">1080p</option><option value="orig">Original</option></select></div>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="sw"> Bara på Wi-Fi</label></div>
    <div class="row" style="margin-top:12px"><button class="primary" id="ssave">Spara</button></div></div>`);
  $$('[data-unf]').forEach(b => b.onclick = act(async () => { await api(`/items/${b.dataset.unf}/follow`, { method: 'POST', body: { follow: false } }); route(); }));
  if ($('#nk')) {
    $('#nk').value = N.kind;
    $('#nsave').onclick = act(async () => {
      const t = $('#nt').value;
      const r = await api('/me/notify', { method: 'PUT', body: { kind: $('#nk').value, url: $('#nu').value, ...(t ? { token: t } : {}) } });
      $('#ntest').disabled = r.kind === 'none'; $('#nt').value = ''; $('#nt').placeholder = r.hasToken ? '(sparad)' : ''; toast('Sparat');
    });
    $('#ntest').onclick = act(async () => { await api('/me/notify/test', { method: 'POST' }); toast('Testnotisen skickades'); });
  }
  $('#sc').value = String(S.count); $('#ss').value = S.scope; $('#sq').value = S.quality; $('#sw').checked = S.wifiOnly;
  $('#ssave').onclick = act(async () => {
    await api('/me/offline-sync', { method: 'PUT', body: { count: +$('#sc').value, scope: $('#ss').value, quality: $('#sq').value, wifiOnly: $('#sw').checked } });
    toast('Sparat – appen synkar nästa gång den öppnas');
  });
}

// ---------- routing ----------
async function loadLibs() {
  libs = await api('/libraries');
  $('#libnav').innerHTML = `<a href="#/">Hem</a>` + libs.map(l => `<a href="#/${{ music: 'music', audiobook: 'books' }[l.type] || 'lib'}/${l.id}">${esc(l.name)}</a>`).join('')
    + (me?.liveTv ? '<a href="#/live">Live-TV</a>' : '') + (me?.streaming ? '<a href="#/streaming">Strömmande</a>' : '') + (!me?.kid ? '<a href="#/podcasts">Poddar</a>' : '');
}
function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k) { try { sessionStorage.setItem(k, '1'); } catch {} }
async function boot() {
  const st = await api('/status');
  status = st; me = st.user;
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
async function route() {
  const gen = ++routeGen;
  // Stoppa timers/slingor från föregående vy
  for (const f of [...leaveFns]) { try { f(); } catch {} }
  leaveFns.clear();
  const h = location.hash.slice(2) || '';
  const [name, arg, arg2] = h.split('/');
  if (!me && name !== 'login') { location.hash = '#/login'; return; }
  closeAllPlayers();
  $$('#libnav a').forEach(a => { const hr = a.getAttribute('href'); a.classList.toggle('on', hr === '#/' ? h === '' : ('#/' + h + '/').startsWith(hr + '/')); });
  const v = views[name || 'home'];
  if (!v) { location.hash = '#/'; return; }
  // Inloggning och profilval döljer menyn – visa den igen när man navigerar därifrån (även med Bakåt)
  $('#top').hidden = !me || name === 'login' || name === 'profiles';
  main.innerHTML = '<div class="spin"></div>';
  if (me && name !== 'timeup') refreshScreen();
  try { await v(arg, arg2); if (gen !== routeGen) return; window.scrollTo(0, 0); fillWatch(); }
  catch (e) { if (gen !== routeGen || e?.aborted) return; if (me) main.innerHTML = `<div class="empty"><h2>Något gick fel</h2><p>${esc(e.message)}</p></div>`; }
}
window.addEventListener('hashchange', route);

$('#userbtn').onclick = (e) => { e.stopPropagation(); $('#usermenu').hidden = !$('#usermenu').hidden; };
document.addEventListener('click', () => { $('#usermenu').hidden = true; });
$('#logout').onclick = async () => { stopAudio(); await api('/logout', { method: 'POST' }).catch(() => {}); me = null; location.hash = '#/login'; };
let qt;
$('#q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { const q = e.target.value.trim(); location.hash = q ? '#/search/' + encodeURIComponent(q) : '#/'; }, 300); };

(async () => {
  try { await boot(); } catch {}
  if (!me) { location.hash = '#/login'; if (location.hash === '#/login') route(); }
  else { if (location.hash === '#/login') location.hash = '#/'; else route(); }
})();
