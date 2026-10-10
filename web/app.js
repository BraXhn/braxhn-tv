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
// Trasiga bilder tas bort (ersätter inline onerror, som CSP blockerar)
document.addEventListener('error', (e) => { if (e.target?.tagName === 'IMG' && e.target.dataset.fb) e.target.remove(); }, true);

async function api(path, opts = {}) {
  const o = { headers: {}, ...opts };
  if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers['Content-Type'] = 'application/json'; }
  const r = await fetch('/api' + path, o);
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (r.status === 401 && !path.startsWith('/login')) { me = null; location.hash = '#/login'; throw new Error('Inte inloggad'); }
  if (!r.ok) throw new Error(data?.error || `Fel ${r.status}`);
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 3200);
}
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
async function passkeyRegister(password, name) {
  const o = await api('/me/passkeys/options', { method: 'POST', body: { password } });
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
  if (d.continue.length) html += `<section class="section"><h2>Fortsätt titta</h2><div class="shelf wide">${d.continue.map(i => card(i, true)).join('')}</div></section>`;
  html += shelf('Min lista', d.watchlist, false, '<a href="#/watchlist">Visa alla</a>');
  html += shelf('Rekommenderat för dig', d.recommended);
  if (cols.length) html += `<section class="section"><h2>Samlingar</h2><div class="shelf">${cols.map(colCard).join('')}</div></section>`;
  for (const r of d.rows) if (r.items.length)
    html += `<section class="section"><h2>${esc(r.title)} <a href="#/lib/${r.library.id}">Visa alla</a></h2><div class="shelf">${r.items.map(i => card(i)).join('')}</div></section>`;
  if (libs.length && !d.rows.some(r => r.items.length)) {
    const s = await api('/scan');
    html += `<div class="empty"><h2>${s.running ? 'Skannar bibliotek…' : 'Inget innehåll hittades'}</h2><p>${s.running ? esc(s.phase) + ' ' + s.done + '/' + s.total : 'Kontrollera sökvägarna under Administration.'}</p></div>`;
    if (s.running) setTimeout(() => location.hash === '#/' && route(), 3000);
  }
  main.innerHTML = html;
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
  if ($('#q').value !== q) $('#q').value = q;
  const r = q.length >= 1 ? await api('/search?q=' + encodeURIComponent(q)) : [];
  const top = r.filter(i => i.kind !== 'episode'), eps = r.filter(i => i.kind === 'episode');
  main.innerHTML = `<div class="toolbar"><h1>Sök: ”${esc(q)}”</h1></div>
    ${top.length ? `<section class="section"><h2>Filmer och serier</h2><div class="grid">${top.map(i => card(i)).join('')}</div></section>` : ''}
    ${eps.length ? `<section class="section"><h2>Avsnitt</h2><div class="grid">${eps.map(i => card(i, true)).join('')}</div></section>` : ''}
    ${!r.length ? '<div class="empty">Inga träffar.</div>' : ''}`;
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
    ${it.overview ? `<p class="overview">${esc(it.overview)}</p>` : ''}${extra}</div></div></div>`;
}

views.item = async (id) => {
  const it = await api('/items/' + id);
  if (it.kind === 'show') return showView(it);
  const resume = it.position > 30;
  const actions = `<div class="row">
    ${resume ? `<button class="primary" data-play="${it.position}">▶ Fortsätt från ${fmtTime(it.position)}</button><button class="ghost" data-play="0">Börja om</button>`
      : `<button class="primary" data-play="0">▶ Spela</button>`}
    <button class="ghost" id="seen">${it.watched ? 'Markera som osedd' : 'Markera som sedd'}</button>
    <button class="ghost" id="wl">${it.inWatchlist ? '✓ I Min lista' : '+ Min lista'}</button>
    <a class="btn" href="/api/stream/${it.id}/download" download>Ladda ner</a>
    ${me.is_admin ? `<button class="ghost" id="refresh">Uppdatera metadata</button><button class="ghost" id="edit">Redigera</button>` : ''}</div>`;
  const back = it.kind === 'episode' ? `<p><a class="muted" href="#/item/${it.show}">← ${esc(it.showTitle)}</a> · ${sxe(it)}</p>` : '';
  main.innerHTML = heroHtml(it, back + actions) + `<div class="tech">
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
  api(`/items/${it.id}/playback?${capsQuery()}`).then(p => {
    const m = { direct: 'Direktuppspelning', remux: 'Remux', transcode: 'Omkodning' }[p.mode];
    $('#pbinfo').textContent = m + (p.reasons.length ? ' (' + p.reasons.join(', ') + ')' : '');
  }).catch(() => {});
  $('#subsearch').onclick = () => subSearch(it);
  bindWatchlist(it);
  if (it.collectionInfo && it.collectionInfo.items.length > 1) main.insertAdjacentHTML('beforeend', shelf(`Del av ${it.collectionInfo.name}`, it.collectionInfo.items, false, `<a href="#/collection/${it.collectionInfo.id}">Visa samlingen</a>`));
  main.insertAdjacentHTML('beforeend', shelf('Liknande', it.similar));
  if ($('#markers')) $('#markers').onclick = () => editMarkers(it);
  $$('[data-play]').forEach(b => b.onclick = () => play(it.id, +b.dataset.play));
  $('#seen').onclick = async () => { await api(`/items/${it.id}/watched`, { method: 'POST', body: { watched: !it.watched } }); route(); };
  if (me.is_admin) {
    $('#refresh').onclick = () => refreshMeta(it);
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
    <button class="ghost" id="wl">${it.inWatchlist ? '✓ I Min lista' : '+ Min lista'}</button>
    ${me.is_admin ? `<button class="ghost" id="refresh">Uppdatera metadata</button><button class="ghost" id="edit">Redigera</button>` : ''}</div>`;
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
    $$('[data-play]', $('#eps')).forEach(b => b.onclick = () => play(+b.dataset.play, +b.dataset.pos));
    $$('[data-seen]').forEach(b => b.onclick = async () => { await api(`/items/${b.dataset.seen}/watched`, { method: 'POST', body: { watched: b.dataset.w !== '1' } }); route(); });
    $('#seasonSeen').onclick = async () => { await api(`/items/${it.id}/watched?season=${cur}`, { method: 'POST', body: { watched: !allSeen } }); route(); };
  };
  renderEps();
  bindWatchlist(it);
  main.insertAdjacentHTML('beforeend', shelf('Liknande serier', it.similar));
  $$('#tabs button').forEach(b => b.onclick = () => {
    cur = +b.dataset.s; store.set('season.' + it.id, cur);
    $$('#tabs button').forEach(x => x.classList.toggle('on', x === b)); renderEps();
  });
  if (nx) $('#playnext').onclick = () => play(nx.id, nx.position);
  $('#seen').onclick = async () => { await api(`/items/${it.id}/watched`, { method: 'POST', body: { watched: !it.watched } }); route(); };
  if (me.is_admin) { $('#refresh').onclick = () => refreshMeta(it); $('#edit').onclick = () => editItem(it); }
}

function bindWatchlist(it) {
  const b = $('#wl'); if (!b) return;
  b.onclick = async () => {
    it.inWatchlist = !it.inWatchlist;
    await api(`/items/${it.id}/watchlist`, { method: 'POST', body: { add: it.inWatchlist } });
    b.textContent = it.inWatchlist ? '✓ I Min lista' : '+ Min lista';
    toast(it.inWatchlist ? 'Tillagd i Min lista' : 'Borttagen från Min lista');
  };
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
  if (first) $('#playfirst').onclick = () => play(first.id, first.position || 0);
};

// ---------- Profiler: "Vem tittar?" ----------
views.profiles = async () => {
  const d = await api('/profiles');
  $('#top').hidden = true;
  main.innerHTML = `<div class="profiles"><h1>Vem tittar?</h1><div class="plist">${d.profiles.map(p => {
    const h = hue(p.name);
    return `<button class="pcard" data-pid="${p.id}" data-pin="${p.hasPin ? 1 : 0}" data-kid="${p.kid ? 1 : 0}">
      <span class="pav" style="background:${esc(p.color) || `hsl(${h} 55% 45%)`}">${esc(p.name.slice(0, 1).toUpperCase())}</span>
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
      await boot(); location.hash = '#/';
    };
    attempt();
  });
};

async function refreshMeta(it) {
  toast('Uppdaterar…');
  try { await api(`/items/${it.id}/refresh`, { method: 'POST', body: {} }); toast('Klart'); route(); }
  catch (e) { toast(e.message); }
}
function editItem(it) {
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog"><h2>Redigera</h2>
    <label>Titel</label><input id="et" value="${esc(it.title)}">
    <label>År</label><input id="ey" type="number" value="${it.year || ''}">
    <label>Beskrivning</label><textarea id="eo" rows="4">${esc(it.overview || '')}</textarea>
    ${it.kind !== 'episode' ? `<label>Åldersgräns (år, tomt = okänd)</label><input id="eage" type="number" min="0" max="18" value="${it.age ?? ''}">` : ''}
    ${it.kind !== 'episode' ? `<label>Matcha mot TMDB-id (valfritt, kräver TMDB-nyckel)</label><input id="ei" placeholder="t.ex. 603">` : ''}
    <div class="row" style="margin-top:18px;justify-content:flex-end"><button value="cancel" class="ghost">Avbryt</button><button value="ok" class="primary">Spara</button></div></form>`;
  document.body.append(d); d.showModal();
  d.onclose = async () => {
    if (d.returnValue === 'ok') {
      try {
        const tid = $('#ei', d)?.value.trim();
        if (tid) await api(`/items/${it.id}/refresh`, { method: 'POST', body: { tmdbId: tid } });
        else await api(`/items/${it.id}`, { method: 'PUT', body: { title: $('#et', d).value, year: $('#ey', d).value, overview: $('#eo', d).value, ...($('#eage', d) ? { age: $('#eage', d).value } : {}) } });
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
  const [tfa, sess, pks] = await Promise.all([api('/me/2fa'), api('/me/sessions'), api('/me/passkeys')]);
  main.innerHTML = `
  <div class="panel"><h2>Mitt konto – ${esc(me.name)}</h2>
    <h3 style="font-size:15px;margin:0 0 4px">Byt lösenord</h3>
    <form id="pw"><label>Nuvarande lösenord</label><input type="password" id="c" autocomplete="current-password" required>
    <label>Nytt lösenord</label><input type="password" id="n1" autocomplete="new-password" minlength="10" required>
    <p class="muted small" style="margin:6px 0 0">Minst 10 tecken med tre olika teckentyper, eller en lösenfras på minst 14 tecken. Andra enheter loggas ut.</p>
    <div class="row" style="margin-top:12px"><button class="primary">Byt lösenord</button></div></form>
  </div>
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
  $$('[data-rev]').forEach(b => b.onclick = async () => { await api('/me/sessions/' + b.dataset.rev, { method: 'DELETE' }); route(); });
  $$('[data-pkdel]').forEach(b => b.onclick = async () => { if (confirm('Ta bort passkeyn?')) { await api('/me/passkeys/' + encodeURIComponent(b.dataset.pkdel), { method: 'DELETE' }); route(); } });
  if ($('#pkadd')) $('#pkadd').onclick = async () => {
    const password = prompt('Ange ditt lösenord för att lägga till en passkey:'); if (!password) return;
    const name = prompt('Namn på passkeyn (t.ex. "iPhone" eller "Jobbdator"):', device(navigator.userAgent)) || 'Passkey';
    try { await passkeyRegister(password, name); toast('Passkey tillagd'); route(); }
    catch (e) { toast(e.name === 'NotAllowedError' ? 'Avbrutet' : e.name === 'InvalidStateError' ? 'Den här enheten har redan en passkey för kontot' : e.message); }
  };
  if ($('#proflist')) {
    const P2 = await api('/profiles');
    $('#proflist').innerHTML = `<table>${P2.profiles.map(p => `<tr><td>${esc(p.name)}${p.owner ? ' <span class="muted small">(huvudkonto)</span>' : ''}</td>
      <td class="muted small">${p.kid ? (p.maxAge === 0 ? 'Barntillåten' : 'max ' + p.maxAge + ' år') : 'Vuxen'}${p.hasPin ? ' · PIN' : ''}</td>
      <td class="r"><button class="ghost small" data-ppin="${p.id}">${p.hasPin ? 'Byt/ta bort PIN' : 'Sätt PIN'}</button>
      ${p.owner ? '' : `<button class="danger small" data-pdel="${p.id}">Ta bort</button>`}</td></tr>`).join('')}</table>`;
    $$('[data-ppin]').forEach(b => b.onclick = async () => {
      const pin = prompt('Ny PIN (4–8 siffror). Lämna tomt för att ta bort PIN:'); if (pin === null) return;
      try { await api('/profiles/' + b.dataset.ppin, { method: 'PUT', body: { pin } }); toast('Sparat'); route(); } catch (e) { toast(e.message); }
    });
    $$('[data-pdel]').forEach(b => b.onclick = async () => { if (confirm('Ta bort profilen och dess tittarhistorik?')) { await api('/profiles/' + b.dataset.pdel, { method: 'DELETE' }); route(); } });
    $('#addprof').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/profiles', { method: 'POST', body: { name: $('#pn').value, maxAge: $('#pa').value, pin: $('#pp').value } }); toast('Profil skapad'); route(); }
      catch (er) { toast(er.message); }
    };
  }
  $('#revall').onclick = async () => { if (confirm('Logga ut alla andra enheter, inklusive appar?')) { await api('/me/sessions/revoke-others', { method: 'POST' }); toast('Utloggade'); route(); } };
  if ($('#on')) $('#on').onclick = async () => {
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
  };
  if ($('#off')) $('#off').onclick = async () => {
    const password = prompt('Ange ditt lösenord för att stänga av tvåstegsverifiering:'); if (!password) return;
    const code = prompt('Ange en kod från autentiseringsappen (eller en reservkod):'); if (!code) return;
    try { await api('/me/2fa/disable', { method: 'POST', body: { password, code } }); toast('Tvåstegsverifiering avstängd'); route(); } catch (e) { toast(e.message); }
  };
  if ($('#newrc')) $('#newrc').onclick = async () => {
    const password = prompt('Ange ditt lösenord:'); if (!password) return;
    try { const r = await api('/me/2fa/recovery', { method: 'POST', body: { password } }); showCodes(r.recoveryCodes); } catch (e) { toast(e.message); }
  };
};


views.stats = async () => {
  if (!me.adminHere) { location.hash = '#/'; return; }
  const [S, B] = await Promise.all([api('/stats'), api('/backups')]);
  const L = S.library;
  const gb = (b) => b > 1e12 ? (b / 1e12).toFixed(1) + ' TB' : (b / 1e9).toFixed(0) + ' GB';
  const hrs = (x) => Math.round(x / 3600);
  const maxDay = Math.max(1, ...S.days.map(d => d.n));
  const modeName = { direct: 'Direkt', remux: 'Remux', transcode: 'Omkodning' };
  main.innerHTML = `
  <div class="toolbar"><h1>Statistik</h1><span class="muted">Senaste 30 dagarna</span></div>
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
  <div class="panel"><h2>Senaste uppspelningar</h2><table>${S.recent.map(r => `<tr><td class="muted small">${fmtDate(r.ts)}</td><td>${esc(r.user)}</td><td>${esc(r.title)}</td><td class="muted small">${esc(modeName[r.mode] || r.mode || '')}${r.remote ? ' · utifrån' : ''} · ${esc(r.device || '')}</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table></div>
  <div class="panel"><h2>Säkerhetskopior</h2>
    <p class="muted small">Databasen (konton, tittarhistorik, inställningar) kopieras automatiskt varje natt kl. 03 till <code>${esc(B.dir)}</code>. ${B.keep} kopior sparas.</p>
    <div class="row" style="margin-bottom:10px"><label class="switch"><input type="checkbox" id="bken" ${B.enabled ? 'checked' : ''}> Automatisk säkerhetskopiering</label>
      <input id="bkkeep" type="number" min="1" max="365" value="${B.keep}" style="width:90px"> <span class="muted small">kopior</span>
      <button class="ghost small" id="bksave">Spara</button><button class="primary small" id="bknow">Säkerhetskopiera nu</button></div>
    <table>${B.files.map(f => `<tr><td>${esc(f.name)}</td><td class="muted small">${fmtDate(f.mtime)}</td><td class="muted small">${(f.size / 1e6).toFixed(1)} MB</td><td class="r"><a class="btn small" href="/api/backups/${encodeURIComponent(f.name)}">Ladda ner</a></td></tr>`).join('') || '<tr><td class="muted">Inga kopior ännu.</td></tr>'}</table>
    <p class="muted small">Återställ: stoppa containern, kopiera en fil till <code>/config/braxhn-tv.db</code> och starta igen.</p>
  </div>`;
  $('#bknow').onclick = async () => { try { const r = await api('/backups', { method: 'POST' }); toast('Skapade ' + r.name); route(); } catch (e) { toast(e.message); } };
  $('#bksave').onclick = async () => { await api('/settings', { method: 'PUT', body: { backupEnabled: $('#bken').checked, backupKeep: $('#bkkeep').value } }); toast('Sparat'); };
  const loadNow = async () => {
    if (location.hash !== '#/stats') return;
    try {
      const A = await api('/activity');
      $('#nowcount').textContent = A.length ? `(${A.length})` : '';
      $('#now').innerHTML = A.length ? `<table>${A.map(a => `<tr><td><b>${esc(a.user)}</b><div class="muted small">${esc(a.device)} · ${esc(a.ip)}${a.remote ? ' · utifrån' : ''}</div></td>
        <td>${esc(a.title)}<div class="prog" style="max-width:260px"><i style="width:${a.duration ? Math.min(100, a.position / a.duration * 100) : 0}%"></i></div></td>
        <td class="muted small">${esc(modeName[a.mode] || a.mode)}${a.quality && a.quality !== 'orig' ? ' · ' + esc(a.quality) + 'p' : ''}${a.paused ? ' · pausad' : ''}<div>${esc((a.reasons || []).join(', '))}</div></td>
        <td class="r"><button class="danger small" data-stop="${esc(a.key)}">Stoppa</button></td></tr>`).join('')}</table>` : '<p class="muted">Ingen tittar just nu.</p>';
      $$('[data-stop]').forEach(b => b.onclick = async () => { if (confirm('Stoppa uppspelningen?')) { await api(`/activity/${b.dataset.stop}/stop`, { method: 'POST' }); loadNow(); } });
    } catch {}
    setTimeout(loadNow, 5000);
  };
  loadNow();
};

views.admin = async () => {
  if (!me.is_admin) { location.hash = '#/'; return; }
  if (!me.adminHere) { main.innerHTML = '<div class="empty"><h2>Administration är spärrad härifrån</h2><p>Av säkerhetsskäl kan servern bara administreras från hemnätverket eller via VPN (t.ex. NetBird).</p></div>'; return; }
  const [L, U, S, SC, AU, AC] = await Promise.all([api('/libraries'), api('/users'), api('/settings'), api('/security-check'), api('/audit?limit=60'), api('/acme')]);
  const lvl = { ok: '✓', info: 'ℹ', warn: '!', bad: '✕' };
  main.innerHTML = `
  <div class="panel"><h2>Säkerhetskontroll</h2>
    <div class="checks">${SC.map(i => `<div class="check ${i.level}"><span class="dot">${lvl[i.level]}</span><div><b>${esc(i.title)}</b>${i.detail ? `<div class="muted small">${esc(i.detail)}</div>` : ''}</div></div>`).join('')}</div>
  </div>
  <div class="panel"><h2>Bibliotek</h2>
    <table><tr><th>Namn</th><th>Typ</th><th>Mapp</th><th>Titlar</th><th></th></tr>
    ${L.map(l => `<tr><td>${esc(l.name)}</td><td>${{ movie: 'Filmer', show: 'Serier', music: 'Musik' }[l.type]}</td><td class="muted">${esc(l.path)}</td><td>${l.count}</td>
      <td class="r"><button class="ghost small" data-scan="${l.id}">Skanna</button> <button class="danger small" data-del="${l.id}">Ta bort</button></td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">Inga bibliotek ännu.</td></tr>'}</table>
    <div id="scanst" class="muted" style="margin-top:12px"></div>
    <h3 style="margin:22px 0 4px;font-size:15px">Lägg till bibliotek</h3>
    <form id="addlib"><div class="row"><div style="flex:1;min-width:180px"><label>Namn</label><input id="ln" placeholder="Filmer" required></div>
      <div><label>Typ</label><select id="lt"><option value="movie">Filmer</option><option value="show">Serier</option><option value="music">Musik</option></select></div></div>
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
      $$('#fsb [data-p]').forEach(el => el.onclick = () => browse(el.dataset.p));
    } catch (e) { $('#fsb').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  browse(S.mediaRoot);
  $('#addlib').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/libraries', { method: 'POST', body: { name: $('#ln').value, type: $('#lt').value, path: $('#lp').value } }); toast('Bibliotek tillagt – skannar'); await loadLibs(); route(); }
    catch (er) { toast(er.message); }
  };
  $('#scanall').onclick = async () => { await api('/scan', { method: 'POST' }); toast('Skanning startad'); };
  $$('[data-scan]').forEach(b => b.onclick = async () => { await api(`/libraries/${b.dataset.scan}/scan`, { method: 'POST' }); toast('Skanning startad'); });
  $$('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Ta bort biblioteket? Filerna på disken påverkas inte.')) return;
    await api('/libraries/' + b.dataset.del, { method: 'DELETE' }); await loadLibs(); route();
  });
  $('#adduser').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/users', { method: 'POST', body: { name: $('#un').value, password: $('#up').value, isAdmin: $('#ua').checked, remoteAllowed: $('#ur').checked } }); toast('Användare skapad'); route(); }
    catch (er) { toast(er.message); }
  };
  $$('[data-udel]').forEach(b => b.onclick = async () => { if (confirm('Ta bort användaren?')) { await api('/users/' + b.dataset.udel, { method: 'DELETE' }); route(); } });
  $$('[data-remote]').forEach(b => b.onchange = async () => { await api('/users/' + b.dataset.remote, { method: 'PUT', body: { remoteAllowed: b.checked } }); toast('Sparat'); });
  $$('[data-r2fa]').forEach(b => b.onclick = async () => { if (confirm('Återställ tvåstegsverifiering för användaren?')) { await api('/users/' + b.dataset.r2fa, { method: 'PUT', body: { reset2fa: true } }); route(); } });
  $$('[data-lout]').forEach(b => b.onclick = async () => { if (confirm('Logga ut användaren från alla enheter?')) { await api('/users/' + b.dataset.lout, { method: 'PUT', body: { logoutAll: true } }); toast('Utloggad'); } });
  $('#secform').onsubmit = async (e) => {
    e.preventDefault();
    const body = { require2faRemote: $('#s2fa').checked, trustedNetworks: $('#stn').value, maxTranscodes: $('#smt').value, maxTranscodesUser: $('#smu').value,
      allowUnrated: $('#sunr').checked, watchEnabled: $('#swatch').checked, trickplay: $('#strick').checked, detectRecap: $('#srecap').checked };
    if (!$('#sadm').disabled) body.adminAnywhere = $('#sadm').checked;
    if (!$('#svpn').disabled) body.trustVpnRange = $('#svpn').checked;
    if (body.require2faRemote && !me.totp) { if (!confirm('Du har själv inte tvåstegsverifiering. Du kommer inte kunna logga in utifrån förrän du aktiverat den. Fortsätta?')) return; }
    try { await api('/settings', { method: 'PUT', body }); toast('Sparat'); route(); } catch (er) { toast(er.message); }
  };
  const acSave = () => api('/acme', { method: 'PUT', body: { domain: $('#acd').value, email: $('#ace').value, staging: $('#acs').checked, auto: $('#aca').checked } });
  $('#acmeform').onsubmit = async (e) => { e.preventDefault(); try { await acSave(); toast('Sparat'); } catch (er) { toast(er.message); } };
  const acPoll = async () => {
    if (location.hash !== '#/admin' || !$('#aclog')) return;
    const a = await api('/acme').catch(() => null); if (!a) return;
    $('#aclog').style.display = ''; $('#aclog').textContent = a.log.join('\n');
    if (a.running) setTimeout(acPoll, 1500);
    else { $('#acgo').disabled = false; toast(a.error ? 'Certifikatet kunde inte hämtas: ' + a.error : 'Certifikatet är klart – HTTPS är igång'); if (!a.error) setTimeout(route, 1500); }
  };
  $('#acgo').onclick = async () => {
    try { await acSave(); await api('/acme/obtain', { method: 'POST' }); $('#acgo').disabled = true; setTimeout(acPoll, 800); } catch (er) { toast(er.message); }
  };
  $$('[data-adm]').forEach(b => b.onclick = async () => { await api('/users/' + b.dataset.adm, { method: 'PUT', body: { isAdmin: b.dataset.v === '1' } }); route(); });
  $$('[data-pw]').forEach(b => b.onclick = async () => {
    const pw = prompt('Nytt lösenord (minst 10 tecken). Användaren loggas ut från alla enheter:'); if (!pw) return;
    try { await api('/users/' + b.dataset.pw, { method: 'PUT', body: { password: pw } }); toast('Lösenord ändrat'); } catch (er) { toast(er.message); }
  });
  $('#settings').onsubmit = async (e) => {
    e.preventDefault();
    const body = { language: $('#lang').value, scanInterval: $('#si').value, osUser: $('#osu').value, subLangs: $('#osl').value,
      remoteQuality: $('#rq').value, publicUrl: $('#pu').value };
    if ($('#tk').value.trim()) body.tmdbKey = $('#tk').value.trim();
    if ($('#osk').value.trim()) body.osKey = $('#osk').value.trim();
    if ($('#osp').value) body.osPass = $('#osp').value;
    await api('/settings', { method: 'PUT', body }); toast('Sparat'); route();
  };
  $('#remark').onclick = async () => { await api('/settings', { method: 'PUT', body: { resetMarkers: true } }); await api('/scan', { method: 'POST' }); toast('Analyserar intro/eftertexter i bakgrunden'); };
  $('#remeta').onclick = async () => { await api('/settings', { method: 'PUT', body: { resetMeta: true } }); await api('/scan', { method: 'POST' }); toast('Hämtar om metadata i bakgrunden'); };

  // Skanningsstatus
  const poll = async () => {
    if (location.hash !== '#/admin') return;
    try {
      const s = await api('/scan');
      const el = $('#scanst'); if (!el) return;
      el.innerHTML = s.running ? `Skannar <b>${esc(s.library)}</b>: ${esc(s.phase)} ${s.done}/${s.total}<div class="prog"><i style="width:${s.total ? s.done / s.total * 100 : 0}%"></i></div>`
        : s.last ? `Senaste skanning: ${new Date(s.last * 1000).toLocaleString('sv-SE')}` : '';
      setTimeout(poll, s.running ? 1500 : 6000);
    } catch {}
  };
  poll();
};

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
  $('#ssc', d).onclick = () => { d.close(); d.remove(); };
  try {
    const r = await api(`/items/${it.id}/subsearch`);
    $('#ssm', d).textContent = r.length ? `${r.length} träffar – ✓ = exakt matchning mot din fil` : 'Inga träffar.';
    $('#ssr', d).innerHTML = `<table>${r.slice(0, 40).map((x, i) => `<tr><td>${x.hashMatch ? '✓ ' : ''}<b>${esc(x.lang)}</b></td><td style="word-break:break-all">${esc(x.name)}${x.hi ? ' <span class="muted">(HI)</span>' : ''}</td>
      <td class="muted">${esc(x.downloads)}</td><td class="r"><button class="primary small" data-i="${i}">Hämta</button></td></tr>`).join('')}</table>`;
    $$('[data-i]', d).forEach(b => b.onclick = async () => {
      const x = r[+b.dataset.i]; b.disabled = true; b.textContent = '…';
      try { const res = await api(`/items/${it.id}/subdownload`, { method: 'POST', body: { fileId: x.fileId, lang: x.lang } }); b.textContent = '✓'; toast(`Undertext sparad${res.remaining != null ? ` – ${res.remaining} nedladdningar kvar idag` : ''}`); }
      catch (e) { b.textContent = 'Fel'; toast(e.message); }
    });
  } catch (e) { $('#ssm', d).textContent = e.message; }
  d.addEventListener('close', () => { d.remove(); if (!P) route(); });
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
  $('#redo', d).onclick = async () => { await api(`/items/${it.id}/markers/redetect`, { method: 'POST' }); toast('Analyserar i bakgrunden'); d.close(); };
  d.onclose = async () => {
    if (d.returnValue === 'ok') {
      await api(`/items/${it.id}/markers`, { method: 'PUT', body: { introStart: sec($('#is', d).value), introEnd: sec($('#ie', d).value), creditsStart: sec($('#cs', d).value) } });
      toast('Sparat'); route();
    }
    d.remove();
  };
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
  const p = await api(`/items/${it.id}/playback?` + new URLSearchParams({ c: 'mp4,webm', v: 'h264,vp8,vp9', a: 'aac,mp3,opus,flac', hdr: '0', cast: '1', audio: P?.audio || '', q: P?.q === 'auto' ? '' : (P?.q || '') }));
  const origin = status.publicUrl || location.origin;
  const mi = new chrome.cast.media.MediaInfo(origin + p.url, p.mime);
  mi.streamType = chrome.cast.media.StreamType.BUFFERED;
  if (p.mode !== 'direct') { mi.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat.TS; mi.hlsVideoSegmentFormat = chrome.cast.media.HlsVideoSegmentFormat.MPEG2_TS; }
  mi.metadata = new chrome.cast.media.GenericMediaMetadata();
  mi.metadata.title = it.kind === 'episode' ? `${it.showTitle} – ${sxe(it)} ${it.title}` : it.title;
  if (it.thumb || it.poster) mi.metadata.images = [new chrome.cast.Image(`${origin}/api/image/${it.id}/${it.poster ? 'poster' : 'thumb'}?t=${p.token}`)];
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
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  const add = (src) => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = () => ok(window.Hls); s.onerror = no; document.head.append(s); });
  return add('/vendor/hls.min.js');
}

async function play(id, start = 0, opts = {}) {
  const partyId = opts.party || (P && P.party) || null;
  const keepParty = P && P.party && P.party === partyId ? P.es : null;
  if (keepParty) P.es = null; // behåll anslutningen till rummet vid byte av avsnitt
  const it = await api('/items/' + id);
  if (M.audio && !M.audio.paused) M.audio.pause();
  if (P) closePlayer(false);
  const el = $('#player');
  const audios = it.audio, defAudio = audios.find(a => a.default) || audios[0];
  const subPref = store.get('sublang', '');
  const textSubs = it.subtitles.filter(s => !s.bitmap);
  const defSub = textSubs.find(s => s.forced) || (subPref && textSubs.find(s => s.lang === subPref));
  P = { it, el, q: store.get('quality', 'auto'), audio: defAudio ? String(defAudio.index) : '', sub: defSub ? defSub.id : '', offset: 0, hls: null, lastSent: 0, nextTimer: null, pb: null,
    party: partyId, es: keepParty, applying: false };
  const title = it.kind === 'episode' ? `${esc(it.showTitle)} · ${sxe(it)} · ${esc(it.title)}` : esc(it.title);
  el.innerHTML = `<video id="vid" controls autoplay playsinline x-webkit-airplay="allow"></video>
    <div class="pbar"><button class="ghost small" id="pclose">← Tillbaka</button><span class="title">${title}</span><span class="muted small" id="pmode"></span>
      <select id="pq" title="Kvalitet"><option value="auto">Auto</option><option value="orig">Original</option><option value="1080">1080p (8 Mbit/s)</option><option value="720">720p (4 Mbit/s)</option><option value="480">480p (1,5 Mbit/s)</option><option value="360">360p (0,8 Mbit/s)</option></select>
      ${audios.length > 1 ? `<select id="pa" title="Ljudspår">${audios.map(a => `<option value="${a.index}">${esc([a.lang || 'Ljud', a.title, a.codec, a.channels ? a.channels + 'ch' : ''].filter(Boolean).join(' · '))}</option>`).join('')}</select>` : ''}
      <select id="ps" title="Undertexter"><option value="">Inga undertexter</option>${it.subtitles.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}</select>
      <span id="poff" class="row" hidden><button class="ghost small" data-off="-0.5" title="Undertext tidigare">−</button><span class="small" id="poffv">0,0 s</span><button class="ghost small" data-off="0.5" title="Undertext senare">+</button></span>
      <button class="ghost small castbtn" id="pcast" ${castReady ? '' : 'hidden'} title="Casta till Chromecast">📺 Casta</button>
      ${canAirPlay() ? '<button class="ghost small" id="pair" title="AirPlay">AirPlay</button>' : ''}
      <button class="ghost small" id="pparty" title="Titta tillsammans med någon annanstans">👥 ${partyId ? 'Rummet' : 'Titta tillsammans'}</button>
      ${it.nextId ? '<button class="ghost small" id="pnext">Nästa ⏭</button>' : ''}</div>
    <div class="partybox" id="partybox" hidden><div class="row" style="justify-content:space-between"><b>Titta tillsammans</b><button class="ghost small" id="pbclose">✕</button></div>
      <div class="muted small" id="pmembers"></div><div class="row" style="margin:6px 0"><input id="plink" readonly><button class="ghost small" id="pcopy">Kopiera</button></div>
      <div class="pchat" id="pchat"></div><input id="pmsg" placeholder="Skriv ett meddelande…" maxlength="300"></div>
    <button class="skip" id="pskip" hidden></button>
    <div class="scrub" id="scrub"><div class="preview" id="prev" hidden><div class="pimg" id="pimg"></div><span id="ptime"></span></div>
      <div class="track" id="track"><i id="tfill"></i></div></div>`;
  el.hidden = false; document.body.style.overflow = 'hidden';
  $('#pq').value = P.q; if ($('#pa')) $('#pa').value = P.audio; $('#ps').value = P.sub;
  $('#pclose').onclick = () => closePlayer();
  $('#pq').onchange = (e) => { P.q = e.target.value; store.set('quality', P.q); reload(); };
  if ($('#pa')) $('#pa').onchange = (e) => { P.audio = e.target.value; reload(); };
  $('#ps').onchange = (e) => {
    const prev = it.subtitles.find(x => x.id === P.sub), s = it.subtitles.find(x => x.id === e.target.value);
    P.sub = e.target.value; store.set('sublang', s?.lang || ''); P.offset = 0;
    // Bildundertexter bränns in av servern => ny ström. Textundertexter byts direkt.
    if (s?.bitmap || prev?.bitmap) reload(); else setSubs();
  };
  $$('[data-off]').forEach(b => b.onclick = () => { P.offset = Math.round((P.offset + +b.dataset.off) * 10) / 10; setSubs(); });
  if ($('#pcast')) $('#pcast').onclick = () => castItem(it, $('#vid').currentTime);
  if ($('#pair')) $('#pair').onclick = () => $('#vid').webkitShowPlaybackTargetPicker();
  if ($('#pnext')) $('#pnext').onclick = () => { sendProgress(true); goNext(it.nextId); };
  $('#pparty').onclick = async () => {
    if (!P.party) {
      try { const r = await api('/party', { method: 'POST', body: { itemId: it.id } }); P.party = r.id; pushState(); joinParty(); toast('Rum skapat – dela länken'); }
      catch (e) { return toast(e.message); }
    }
    $('#partybox').hidden = !$('#partybox').hidden;
  };
  $('#pbclose').onclick = () => { $('#partybox').hidden = true; };
  $('#pcopy').onclick = () => { navigator.clipboard?.writeText($('#plink').value).then(() => toast('Länken kopierad')); };
  $('#pmsg').onkeydown = (e) => { if (e.key === 'Enter' && e.target.value.trim()) { api(`/party/${P.party}/chat`, { method: 'POST', body: { text: e.target.value } }).catch(() => {}); e.target.value = ''; } };
  // Lokala händelser skickas till rummet (men inte de som kommer från rummet självt)
  const pushState = () => { if (P?.party && !P.applying) api(`/party/${P.party}/state`, { method: 'POST', body: { playing: !$('#vid').paused, position: $('#vid').currentTime } }).catch(() => {}); };
  ['play', 'pause', 'seeked'].forEach(ev => $('#vid').addEventListener(ev, pushState));
  if (P.party) joinParty();
  const v = $('#vid');
  v.addEventListener('timeupdate', () => {
    if (!P) return; if (Date.now() - P.lastSent > 10000) sendProgress(); markers();
    const d = P.it.duration || v.duration; if (d) $('#tfill').style.width = Math.min(100, v.currentTime / d * 100) + '%';
  });
  // Spolningslist med förhandsbilder
  api(`/items/${it.id}/trickplay`).then(tp => { if (P && P.it.id === it.id) P.tp = tp; }).catch(() => {});
  const track = $('#track'), prev = $('#prev');
  const tAt = (e) => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (P.it.duration || v.duration || 0); };
  track.onmousemove = (e) => {
    if (!P) return;
    const t = tAt(e), r = track.getBoundingClientRect();
    $('#ptime').textContent = fmtTime(t);
    const tp = P.tp, img = $('#pimg');
    if (tp) {
      const i = Math.min(tp.count - 1, Math.floor(t / tp.interval)), per = tp.cols * tp.rows, sheet = Math.floor(i / per) + tp.first, k = i % per;
      Object.assign(img.style, { width: tp.w + 'px', height: tp.h + 'px', backgroundImage: `url(/api/items/${P.it.id}/trickplay/${sheet})`,
        backgroundPosition: `-${(k % tp.cols) * tp.w}px -${Math.floor(k / tp.cols) * tp.h}px`, display: 'block' });
    } else img.style.display = 'none';
    prev.hidden = false;
    prev.style.left = Math.max(0, Math.min(r.width - prev.offsetWidth, e.clientX - r.left - prev.offsetWidth / 2)) + 'px';
  };
  track.onmouseleave = () => { prev.hidden = true; };
  track.onclick = (e) => { v.currentTime = tAt(e); };
  v.addEventListener('pause', () => P && sendProgress());
  v.addEventListener('ended', () => P && onEnded());
  v.addEventListener('error', () => {
    if (P && P.pb?.mode === 'direct' && !P.forceHls) { toast('Webbläsaren kunde inte spela filen direkt – byter läge'); P.forceHls = true; reload(); }
  });
  let idle; const wake = () => { el.classList.remove('idle'); clearTimeout(idle); idle = setTimeout(() => P && !v.paused && el.classList.add('idle'), 3000); };
  el.onmousemove = wake; el.ontouchstart = wake; wake();
  document.addEventListener('keydown', keys);
  await load(start);
}

function markers() {
  const v = $('#vid'), b = $('#pskip'), pb = P.pb; if (!v || !b || !pb) return;
  const t = v.currentTime;
  if (pb.recap && t >= pb.recap.start && t < pb.recap.end - 1) {
    if (b.dataset.k !== 'recap') { b.dataset.k = 'recap'; b.textContent = 'Hoppa över sammanfattning ⏭'; b.onclick = () => { v.currentTime = pb.recap.end; b.hidden = true; }; }
    b.hidden = false;
  } else if (pb.intro && t >= pb.intro.start && t < pb.intro.end - 1) {
    if (b.dataset.k !== 'intro') { b.dataset.k = 'intro'; b.textContent = 'Hoppa över intro ⏭'; b.onclick = () => { v.currentTime = pb.intro.end; b.hidden = true; }; }
    b.hidden = false;
  } else if (pb.credits && P.it.nextId && t >= pb.credits && t < pb.credits + 60) {
    if (b.dataset.k !== 'credits') { b.dataset.k = 'credits'; b.textContent = 'Nästa avsnitt ⏭'; b.onclick = () => { sendProgress(true); play(P.it.nextId, 0); }; }
    b.hidden = false;
  } else { b.hidden = true; b.dataset.k = ''; }
}

function keys(e) {
  if (!P || e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  const v = $('#vid');
  if (e.key === 'Escape' && !document.fullscreenElement) closePlayer();
  else if (e.key === ' ' || e.key === 'k') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
  else if (e.key === 'ArrowRight') v.currentTime += 10;
  else if (e.key === 'ArrowLeft') v.currentTime -= 10;
  else if (e.key === 's' && !$('#pskip').hidden) $('#pskip').click();
  else if (e.key === 'f') document.fullscreenElement ? document.exitFullscreen() : $('#player').requestFullscreen?.();
}

async function load(start) {
  const { it } = P, v = $('#vid');
  if (P.hls) { P.hls.destroy(); P.hls = null; }
  const sub = it.subtitles.find(s => s.id === P.sub);
  const extra = { q: P.q === 'auto' ? '' : P.q, audio: P.audio, sub: sub?.bitmap ? sub.id : '' };
  if (P.forceHls) extra.force = 'hls';
  if (canAirPlay()) extra.cast = '1'; // AirPlay-mottagaren hämtar strömmen själv och behöver token i URL:en
  let pb;
  try { pb = await api(`/items/${it.id}/playback?${capsQuery(extra)}`); } catch (e) { toast(e.message); return; }
  if (!P) return;
  P.pb = pb;
  const label = { direct: 'Direkt', remux: 'Remux', transcode: 'Omkodning' }[pb.mode];
  $('#pmode').textContent = `${label}${pb.quality && pb.quality !== 'orig' ? ' · ' + pb.quality + 'p' : ''}${pb.tonemap ? ' · HDR→SDR' : ''}${pb.remote ? ' · utanför hemmet' : ''}`;
  $('#pmode').title = pb.reasons.join(', ');
  if (pb.mode === 'direct' || v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = pb.url;
  } else {
    try {
      const Hls = await loadHls();
      if (!Hls.isSupported()) throw new Error();
      P.hls = new Hls({ startPosition: start, maxBufferLength: 40, xhrSetup: (x) => { x.withCredentials = true; } });
      P.hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { if (d.type === 'networkError') P.hls.startLoad(); else if (d.type === 'mediaError') P.hls.recoverMediaError(); else toast('Uppspelningsfel: ' + d.details); } });
      P.hls.loadSource(pb.url); P.hls.attachMedia(v);
    } catch { toast('Kunde inte ladda HLS-spelaren'); return; }
  }
  v.addEventListener('loadedmetadata', () => { if (start > 0 && Math.abs(v.currentTime - start) > 2) v.currentTime = start; setSubs(); }, { once: true });
  v.play().catch(() => {});
}
function reload() { const v = $('#vid'); load(v.currentTime || 0); }

function setSubs() {
  const v = $('#vid'); if (!v || !P) return;
  $$('track', v).forEach(t => t.remove());
  const sub = P.pb?.subtitles.find(s => s.id === P.sub);
  $('#poff').hidden = !sub;
  $('#poffv').textContent = (P.offset > 0 ? '+' : '') + P.offset.toFixed(1).replace('.', ',') + ' s';
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
  const v = $('#vid'); if (!v || !v.duration || v.currentTime < 1) return;
  P.lastSent = Date.now();
  const body = JSON.stringify({ position: v.currentTime, duration: P.it.duration || v.duration });
  if (final && navigator.sendBeacon) navigator.sendBeacon(`/api/items/${P.it.id}/progress`, new Blob([body], { type: 'application/json' }));
  else fetch(`/api/items/${P.it.id}/progress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    .then(r => r.json()).then(d => { if (d.stop && P) { toast('Uppspelningen stoppades av administratören'); closePlayer(); } }).catch(() => {});
}

function onEnded() {
  sendProgress(true);
  const { it } = P;
  if (!it.nextId) return closePlayer();
  const box = document.createElement('div'); box.className = 'next';
  let n = 8;
  box.innerHTML = `<b>Nästa avsnitt om <span id="cd">${n}</span> s</b><div class="row"><button class="primary small" id="go">Spela nu</button><button class="ghost small" id="stay">Avbryt</button></div>`;
  P.el.append(box);
  P.nextTimer = setInterval(() => { n--; const cd = $('#cd'); if (cd) cd.textContent = n; if (n <= 0) { clearInterval(P.nextTimer); goNext(it.nextId); } }, 1000);
  $('#go').onclick = () => { clearInterval(P.nextTimer); goNext(it.nextId); };
  $('#stay').onclick = () => { clearInterval(P.nextTimer); box.remove(); };
}

async function goNext(nextId) {
  const party = P?.party;
  await play(nextId, 0);
  // I ett rum byter alla till nästa avsnitt
  if (party) api(`/party/${party}/state`, { method: 'POST', body: { itemId: nextId, playing: true, position: 0 } }).catch(() => {});
}
function joinParty() {
  const rid = P.party;
  $('#plink').value = `${status.publicUrl || location.origin}/#/party/${rid}`;
  $('#pparty').textContent = '👥 Rummet';
  if (P.es) return;
  const es = P.es = new EventSource(`/api/party/${rid}/events`);
  const apply = (st) => {
    const v = $('#vid'); if (!v || !P) return;
    const target = st.position + (st.playing ? (Date.now() - st.at) / 1000 : 0);
    P.applying = true;
    if (Math.abs(v.currentTime - target) > 1.5) v.currentTime = target;
    if (st.playing && v.paused) v.play().catch(() => {});
    if (!st.playing && !v.paused) v.pause();
    setTimeout(() => { if (P) P.applying = false; }, 600);
  };
  const members = (m) => { const el = $('#pmembers'); if (el) el.textContent = 'Här nu: ' + m.map(x => x.name).join(', '); };
  const addChat = (c) => { const el = $('#pchat'); if (!el) return; el.insertAdjacentHTML('beforeend', `<div><b>${esc(c.name)}:</b> ${esc(c.text)}</div>`); el.scrollTop = 1e9; };
  es.addEventListener('hello', (e) => { const d = JSON.parse(e.data); members(d.members); d.chat.forEach(addChat); if (d.state.by !== me.name || d.state.position > 0) apply(d.state); });
  es.addEventListener('state', (e) => { const st = JSON.parse(e.data); if (st.by !== me.name) apply(st); });
  es.addEventListener('members', (e) => members(JSON.parse(e.data)));
  es.addEventListener('chat', (e) => { const c = JSON.parse(e.data); addChat(c); if (c.name !== me.name && $('#partybox').hidden) toast(`${c.name}: ${c.text}`); });
  es.addEventListener('item', (e) => { const d = JSON.parse(e.data); if (P && P.it.id !== d.itemId) { toast(`${d.by} bytte till nästa avsnitt`); play(d.itemId, 0); } });
  es.addEventListener('closed', () => { toast('Rummet stängdes'); es.close(); if (P) { P.party = null; P.es = null; } });
}
views.party = async (rid) => {
  try {
    const r = await api('/party/' + rid);
    const pos = r.state.position + (r.state.playing ? (Date.now() - r.state.at) / 1000 : 0);
    location.hash = '#/item/' + r.itemId;
    setTimeout(() => play(r.itemId, pos, { party: rid }), 50);
  } catch (e) { main.innerHTML = `<div class="empty"><h2>Rummet finns inte längre</h2><p>${esc(e.message)}</p></div>`; }
};

function closePlayer(refresh = true) {
  if (!P) return;
  if (P.es) { P.es.close(); P.es = null; }
  sendProgress(true);
  clearInterval(P.nextTimer);
  if (P.hls) P.hls.destroy();
  const v = $('#vid'); const id = P.it.id;
  const el = P.el;
  P = null;
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  fetch(`/api/stream/${id}/stop`, { method: 'POST' }).catch(() => {});
  document.removeEventListener('keydown', keys);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  el.hidden = true; el.innerHTML = ''; document.body.style.overflow = '';
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
  return `<table class="tracks">${tracks.map((t, i) => `<tr data-ti="${i}" class="${M.cur && M.cur.id === t.id ? 'playing' : ''}">
    <td class="muted num">${opts.showCover ? cover(t.albumId, t.cover, 'tiny') : (t.track || i + 1)}</td>
    <td><b>${esc(t.title)}</b>${opts.showArtist || opts.showCover ? `<div class="muted small">${esc(t.artist || '')}${opts.showCover && t.album ? ' · ' + esc(t.album) : ''}</div>` : ''}</td>
    <td class="r muted">${fmtTime(t.duration)}</td>
    <td class="r"><button class="ghost small fav" data-fav="${t.id}" title="Favorit">${t.favorite ? '♥' : '♡'}</button>
    <button class="ghost small" data-addpl="${t.id}" title="Lägg till i spellista">+</button></td></tr>`).join('')}</table>`;
}
function bindTracks(tracks, root = main) {
  $$('[data-ti]', root).forEach(r => r.ondblclick = r.onclick = (e) => { if (e.target.closest('button')) return; playQueue(tracks, +r.dataset.ti); });
  $$('[data-fav]', root).forEach(b => b.onclick = async () => {
    const on = b.textContent !== '♥'; b.textContent = on ? '♥' : '♡';
    await api(`/music/tracks/${b.dataset.fav}/favorite`, { method: 'POST', body: { on } });
  });
  $$('[data-addpl]', root).forEach(b => b.onclick = () => addToPlaylist([+b.dataset.addpl]));
}
async function addToPlaylist(ids) {
  const pls = await api('/music/playlists');
  const d = document.createElement('dialog');
  d.innerHTML = `<h2>Lägg till i spellista</h2><div class="plpick">${pls.map(p => `<button class="ghost" data-pl="${p.id}">${esc(p.name)} <span class="muted small">${p.tracks} låtar</span></button>`).join('')}</div>
    <div class="row" style="margin-top:12px"><input id="newpl" placeholder="Ny spellista…"><button class="primary" id="mkpl">Skapa</button></div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" id="cl">Stäng</button></div>`;
  document.body.append(d); d.showModal();
  $('#cl', d).onclick = () => { d.close(); d.remove(); };
  $$('[data-pl]', d).forEach(b => b.onclick = async () => { await api(`/music/playlists/${b.dataset.pl}/tracks`, { method: 'POST', body: { trackIds: ids } }); toast('Tillagd'); d.close(); d.remove(); });
  $('#mkpl', d).onclick = async () => { const n = $('#newpl', d).value.trim(); if (!n) return; await api('/music/playlists', { method: 'POST', body: { name: n, trackIds: ids } }); toast('Spellista skapad'); d.close(); d.remove(); };
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
  if ($('#mknpl')) $('#mknpl').onclick = async () => { const n = $('#npl').value.trim(); if (!n) return; await api('/music/playlists', { method: 'POST', body: { name: n } }); route(); };
};
function musicHeader(lid, tabs, tab) {
  const lib = libs.find(l => l.id === +lid);
  return `<div class="toolbar"><h1>${esc(lib?.name || 'Musik')}</h1><input id="msearch" placeholder="Sök artist, album, låt (Enter)" style="max-width:280px"></div>
    <div class="tabs">${tabs.map(([k, n]) => `<a class="tabbtn ${k === tab ? 'on' : ''}" href="#/music/${lid}/${k}">${n}</a>`).join('')}</div>`;
}
document.addEventListener('keydown', async (e) => {
  if (e.target.id !== 'msearch' || e.key !== 'Enter') return;
  const lid = location.hash.split('/')[2], q = e.target.value.trim(); if (!q) return;
  const r = await api(`/music/${lid}/search?q=${encodeURIComponent(q)}`);
  const box = document.createElement('div');
  box.innerHTML = `<section class="section"><h2>Sökresultat för ”${esc(q)}”</h2>
    ${r.artists.length ? `<div class="row" style="margin-bottom:10px">${r.artists.map(a => `<a class="btn small" href="#/artist/${a.id}">${esc(a.name)}</a>`).join('')}</div>` : ''}
    ${r.albums.length ? `<div class="shelf" style="margin-bottom:14px">${r.albums.map(albumCard).join('')}</div>` : ''}
    ${r.tracks.length ? trackRows(r.tracks, { showCover: true }) : ''}${!r.artists.length && !r.albums.length && !r.tracks.length ? '<p class="muted">Inga träffar.</p>' : ''}</section>`;
  $$('.msearchres').forEach(x => x.remove()); box.className = 'msearchres';
  $('.tabs').after(box); bindTracks(r.tracks, box);
});

views.album = async (id) => {
  const a = await api('/music/albums/' + id);
  main.innerHTML = `<div class="mhero">${cover(a.id, a.cover, 'big')}<div><div class="muted small">ALBUM</div><h1>${esc(a.title)}</h1>
    <div class="meta"><a href="#/artist/${a.artistId}">${esc(a.artist || '')}</a>${a.year ? `<span>${a.year}</span>` : ''}<span>${a.tracks} låtar · ${fmtDur(a.duration)}</span>${a.genre ? `<span>${esc(a.genre)}</span>` : ''}</div>
    <div class="row"><button class="primary" id="pa">▶ Spela</button><button class="ghost" id="sa">⤨ Blanda</button><button class="ghost" id="aa">+ Spellista</button></div></div></div>
    ${trackRows(a.trackList, { showArtist: a.trackList.some(t => t.artist !== a.artist) })}`;
  bindTracks(a.trackList);
  $('#pa').onclick = () => playQueue(a.trackList, 0);
  $('#sa').onclick = () => playQueue(shuffle(a.trackList), 0);
  $('#aa').onclick = () => addToPlaylist(a.trackList.map(t => t.id));
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
    b.onclick = async () => { const ids = p.trackList.map(t => t.id); ids.splice(i, 1); await api('/music/playlists/' + id, { method: 'PUT', body: { trackIds: ids } }); route(); };
    r.lastElementChild.append(b); });
  $('#pp').onclick = () => playQueue(p.trackList, 0);
  $('#sp').onclick = () => playQueue(shuffle(p.trackList), 0);
  $('#rn').onclick = async () => { const n = prompt('Nytt namn:', p.name); if (n) { await api('/music/playlists/' + id, { method: 'PUT', body: { name: n } }); route(); } };
  $('#dl').onclick = async () => { if (confirm('Ta bort spellistan?')) { await api('/music/playlists/' + id, { method: 'DELETE' }); history.back(); } };
};
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------- musikspelare (följer med mellan sidor) ----------
const M = { queue: [], idx: -1, cur: null, audio: null, repeat: false };
function ensureBar() {
  if ($('#mbar')) return;
  const bar = document.createElement('div'); bar.id = 'mbar'; bar.hidden = true;
  bar.innerHTML = `<audio id="maudio" preload="auto"></audio>
    <div class="mleft"><div id="mcov"></div><div class="mtxt"><b id="mtitle"></b><a id="martist" class="muted small"></a></div></div>
    <div class="mmid"><div class="row mctl"><button class="ghost small" id="mprev">⏮</button><button class="primary" id="mplay">⏸</button><button class="ghost small" id="mnext">⏭</button>
      <button class="ghost small" id="mrep" title="Upprepa">🔁</button></div>
      <div class="mseek"><span id="mcurt" class="small muted">0:00</span><div class="track" id="mtrack"><i id="mfill"></i></div><span id="mdur" class="small muted">0:00</span></div></div>
    <div class="mright"><input type="range" id="mvol" min="0" max="1" step="0.05" value="${store.get('mvol', 1)}"><button class="ghost small" id="mq">Kö</button><button class="ghost small" id="mx" title="Stäng">✕</button></div>`;
  document.body.append(bar);
  const a = M.audio = $('#maudio');
  a.volume = store.get('mvol', 1);
  a.ontimeupdate = () => { $('#mcurt').textContent = fmtTime(a.currentTime); const d = M.cur?.duration || a.duration; if (d) { $('#mfill').style.width = (a.currentTime / d * 100) + '%'; $('#mdur').textContent = fmtTime(d); } };
  a.onended = () => nextTrack(true);
  a.onplay = () => { $('#mplay').textContent = '⏸'; if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'; };
  a.onpause = () => { $('#mplay').textContent = '▶'; if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'; };
  a.onerror = () => toast('Kunde inte spela låten');
  $('#mplay').onclick = () => a.paused ? a.play() : a.pause();
  $('#mnext').onclick = () => nextTrack(false);
  $('#mprev').onclick = () => { if (a.currentTime > 3) a.currentTime = 0; else if (M.idx > 0) loadTrack(M.idx - 1); };
  $('#mrep').onclick = () => { M.repeat = !M.repeat; $('#mrep').classList.toggle('on', M.repeat); };
  $('#mvol').oninput = (e) => { a.volume = +e.target.value; store.set('mvol', a.volume); };
  $('#mtrack').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(), d = M.cur?.duration || a.duration; if (d) seekTo((e.clientX - r.left) / r.width * d); };
  $('#mx').onclick = () => { a.pause(); a.removeAttribute('src'); bar.hidden = true; document.body.classList.remove('hasbar'); M.cur = null; };
  $('#mq').onclick = showQueue;
  if (navigator.mediaSession) {
    navigator.mediaSession.setActionHandler('play', () => a.play());
    navigator.mediaSession.setActionHandler('pause', () => a.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack(false));
    navigator.mediaSession.setActionHandler('previoustrack', () => $('#mprev').click());
    try { navigator.mediaSession.setActionHandler('seekto', (d) => seekTo(d.seekTime)); } catch {}
  }
}
function seekTo(t) {
  const a = M.audio;
  // Omkodade strömmar saknar Range – starta om på rätt position
  if (M.transcoded) { M.offset = t; a.src = M.url + (M.url.includes('?') ? '&' : '?') + 'ss=' + t; a.play(); }
  else a.currentTime = t;
}
function playQueue(tracks, i) {
  if (!tracks.length) return;
  ensureBar();
  if (P) closePlayer(false);
  M.queue = tracks; loadTrack(i);
}
async function loadTrack(i) {
  const t = M.queue[i]; if (!t) return;
  M.idx = i; M.cur = t;
  const a = M.audio, bar = $('#mbar');
  bar.hidden = false; document.body.classList.add('hasbar');
  M.url = `/api/music/tracks/${t.id}/stream?a=${audioCaps()}`;
  a.src = M.url;
  a.play().catch(() => {});
  fetch(M.url, { method: 'HEAD' }).then(r => { M.transcoded = r.headers.get('x-transcoded') === '1'; }).catch(() => {});
  $('#mcov').innerHTML = cover(t.albumId, t.cover, 'small');
  $('#mtitle').textContent = t.title;
  $('#martist').textContent = t.artist || ''; $('#martist').href = t.artistId ? `#/artist/${t.artistId}` : '#';
  $$('tr[data-ti]').forEach(r => r.classList.remove('playing'));
  if (navigator.mediaSession && window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || '', album: t.album || '',
    artwork: t.cover ? [{ src: `/api/music/cover/${t.albumId}`, sizes: '600x600', type: 'image/jpeg' }] : [] });
  fetch(`/api/music/tracks/${t.id}/played`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
}
function nextTrack(auto) {
  if (M.idx + 1 < M.queue.length) loadTrack(M.idx + 1);
  else if (M.repeat) loadTrack(0);
  else if (auto) { M.audio.pause(); }
}
function showQueue() {
  const d = document.createElement('dialog');
  d.innerHTML = `<h2>Kö</h2><div style="max-height:60vh;overflow:auto">${trackRows(M.queue, { showCover: true })}</div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="ghost" id="cl">Stäng</button></div>`;
  document.body.append(d); d.showModal();
  $$('tr[data-ti]', d).forEach(r => { if (+r.dataset.ti === M.idx) r.classList.add('playing'); r.onclick = (e) => { if (e.target.closest('button')) return; loadTrack(+r.dataset.ti); d.close(); d.remove(); }; });
  $('#cl', d).onclick = () => { d.close(); d.remove(); };
}

// ---------- routing ----------
async function loadLibs() {
  libs = await api('/libraries');
  $('#libnav').innerHTML = `<a href="#/">Hem</a>` + libs.map(l => `<a href="#/${l.type === 'music' ? 'music' : 'lib'}/${l.id}">${esc(l.name)}</a>`).join('');
}
async function boot() {
  const st = await api('/status');
  status = st; me = st.user;
  if (!me) return false;
  $('#top').hidden = false;
  $('#userbtn').textContent = (me.kid ? '🧸 ' : '') + me.name + ' ▾';
  $$('[data-profiles]').forEach(e => e.hidden = me.profiles < 2);
  $$('[data-admin]').forEach(e => e.hidden = !me.adminHere);
  await loadLibs();
  return true;
}
async function route() {
  const h = location.hash.slice(2) || '';
  const [name, arg, arg2] = h.split('/');
  if (!me && name !== 'login') { location.hash = '#/login'; return; }
  if (P && name !== 'play') closePlayer(false);
  $$('#libnav a').forEach(a => { const hr = a.getAttribute('href'); a.classList.toggle('on', hr === '#/' ? h === '' : ('#/' + h + '/').startsWith(hr + '/')); });
  const v = views[name || 'home'];
  if (!v) { location.hash = '#/'; return; }
  main.innerHTML = '<div class="spin"></div>';
  try { await v(arg, arg2); window.scrollTo(0, 0); }
  catch (e) { if (me) main.innerHTML = `<div class="empty"><h2>Något gick fel</h2><p>${esc(e.message)}</p></div>`; }
}
window.addEventListener('hashchange', route);

$('#userbtn').onclick = (e) => { e.stopPropagation(); $('#usermenu').hidden = !$('#usermenu').hidden; };
document.addEventListener('click', () => { $('#usermenu').hidden = true; });
$('#logout').onclick = async () => { await api('/logout', { method: 'POST' }).catch(() => {}); me = null; location.hash = '#/login'; };
let qt;
$('#q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { const q = e.target.value.trim(); location.hash = q ? '#/search/' + encodeURIComponent(q) : '#/'; }, 300); };

(async () => {
  try { await boot(); } catch {}
  if (!me) { location.hash = '#/login'; if (location.hash === '#/login') route(); }
  else { if (location.hash === '#/login') location.hash = '#/'; else route(); }
})();
