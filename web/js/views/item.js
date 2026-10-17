// Vyer: film-, avsnitts- och seriesidor med trailers, metadataverktyg, undertextsökning och följ-knapp
import { $, $$, act, api, esc, fmtDur, fmtSize, fmtTime, leaveFns, main, me, onLeave, resLabel, store, sxe, toast, views } from '../core.js';
import { capsQuery } from '../player/caps.js';
import { LP, RP } from '../player/live.js';
import { stopVideo } from '../player/overlay.js';
import { P, startPlay } from '../player/video.js';
import { route } from '../router.js';
import { art, card, castShelf, shelf } from '../ui/cards.js';

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
