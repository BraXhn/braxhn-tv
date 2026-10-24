// Vyer: ljudböcker och poddar
import { $, $$, act, api, coverImg, esc, fmtDate, fmtDur, fmtTime, hue, keyClick, libs, main, store, toast, views, toastErr } from '../core.js';
import { M, playSpoken, spokenPos, spokenSeek } from '../audio.js';
import { audioCaps } from '../player/caps.js';
import { loadLibs, route } from '../router.js';
import { emptyState, errorState, loadingState, noLib } from '../ui/states.js';
import { iconButton } from '../ui/buttons.js';
import { confirmDialog, promptDialog } from '../ui/dialog.js';

// ---------- ljudböcker ----------
const bookCover = (b, cls = '') => `<div class="cover book ${cls}" style="--h1:hsl(${hue(String(b.id))} 35% 30%);--h2:hsl(${(hue(String(b.id)) + 60) % 360} 40% 15%)">${b.cover ? coverImg(`/api/audiobooks/cover/${+b.id}`, cls) : `<span>${esc((b.title || '').slice(0, 40))}</span>`}</div>`;
const bookCard = (b) => `<a class="card mcard" href="#/book/${b.id}">${bookCover(b)}${b.duration && b.position ? `<div class="prog"><i style="width:${Math.min(100, b.position / b.duration * 100)}%"></i></div>` : ''}
  <div class="t">${esc(b.title)}</div><div class="s">${esc(b.author || '')}${b.finished ? ' · ✓' : ''}</div></a>`;
views.books = async (lid) => {
  // Utan bibliotek-id (t.ex. #/books): första ljudboksbiblioteket, annars en hänvisning
  if (!lid) { const l = libs.find(x => x.type === 'audiobook'); if (!l) return noLib('ljudböcker', 'Ljudböcker'); location.hash = `#/books/${l.id}`; return; }
  const sort = store.get('booksort', 'title');
  const B = await api(`/audiobooks/${lid}?sort=${sort}`);
  main.innerHTML = `<div class="toolbar"><h1>${esc(B.library.name)}</h1><span class="muted">${B.books.length} böcker</span>
    <select id="bsort" style="margin-left:auto">${[['title', 'Titel'], ['author', 'Författare'], ['added', 'Senast tillagda'], ['recent', 'Senast lyssnade']].map(([v, n]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    ${B.continue.length ? `<section class="section"><h2>Fortsätt lyssna</h2><div class="shelf">${B.continue.map(bookCard).join('')}</div></section>` : ''}
    ${B.books.length ? `<div class="grid">${B.books.map(bookCard).join('')}</div>` : emptyState({ icon: '📚', title: 'Inga ljudböcker ännu', html: 'Lägg dem i mappar som <code>Författare/Boktitel/</code> – en .m4b-fil eller flera mp3-filer per bok.' })}`;
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
    ${b.bookmarks.length ? `<section class="section"><h2>Bokmärken</h2><table>${b.bookmarks.map(m => `<tr><td><button class="ghost small" data-bm="${m.position}">${fmtTime(m.position)}</button></td><td>${esc(m.note || '')}</td><td class="muted small">${fmtDate(m.created)}</td><td class="r">${iconButton({ icon: '✕', label: `Ta bort bokmärket vid ${fmtTime(m.position)}`, data: { bmdel: m.id } })}</td></tr>`).join('')}</table></section>` : ''}
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
    const note = await promptDialog('Anteckning (valfri)', { title: `Bokmärke vid ${fmtTime(pos)}`, maxlength: 200, okLabel: 'Spara bokmärke' }); if (note === null) return;
    await api(`/audiobooks/book/${b.id}/bookmarks`, { method: 'POST', body: { position: pos, note } }); route();
  });
  if ($('#bdone')) $('#bdone').onclick = act(async () => { await api(`/audiobooks/book/${b.id}/progress`, { method: 'POST', body: { position: b.duration } }); route(); });
};

// ---------- poddar ----------
const podCover = (p, cls = '') => `<div class="cover ${cls}" style="--h1:hsl(${hue('p' + p.id)} 40% 30%);--h2:hsl(${(hue('p' + p.id) + 60) % 360} 45% 16%)">🎙${p.image ? coverImg(`/api/podcasts/${+p.id}/image`, cls) : ''}</div>`;
const epRows = (eps, showPod) => `<table class="tracks">${eps.map((e, i) => `<tr data-ep="${i}"><td style="width:100%"><b>${esc(e.title)}</b>${e.played ? ' <span class="muted">✓</span>' : ''}
  <div class="muted small">${showPod ? esc(e.podcastTitle || '') + ' · ' : ''}${fmtDate(e.published)}${e.duration ? ' · ' + fmtDur(e.duration) : ''}${e.position > 0 && !e.played ? ` · ${fmtDur((e.duration || 0) - e.position)} kvar` : ''}${e.downloaded ? ' · nedladdat' : e.downloading ? ' · laddas ner…' : ''}</div></td>
  <td class="r" style="white-space:nowrap">${iconButton({ icon: '▶', label: `Spela ${e.title}`, data: { epplay: i } })} ${iconButton({ icon: e.played ? '↺' : '✓', label: `${e.played ? 'Markera som ej lyssnad' : 'Markera som lyssnad'}: ${e.title}`, data: { epdone: i } })}</td></tr>`).join('')}</table>`;
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
    ${D.canAdd ? `<form id="padd" class="row panel" style="align-items:flex-end" role="search"><div style="flex:1;min-width:220px"><label for="purl">Hitta en podd – sök på namnet eller klistra in RSS-adressen</label><input id="purl" type="search" style="width:100%" placeholder="t.ex. Sommar i P1 eller https://…/feed.xml" autocomplete="off"></div><button class="primary">Sök</button></form>
      <div id="pres" aria-live="polite"></div>
      <p class="muted small">De senaste avsnitten laddas ner automatiskt när du prenumererar.</p>` : ''}
    ${D.podcasts.length ? `<div class="grid">${D.podcasts.map(p => `<a class="card mcard" href="#/podcast/${p.id}">${podCover(p)}<div class="t">${esc(p.title || '…')}</div><div class="s">${p.unplayed ? `${p.unplayed} nya` : esc(p.author || '')}${p.error ? ' · ⚠' : ''}</div></a>`).join('')}</div>` : emptyState({ icon: '🎙', title: 'Inga poddar ännu', text: D.canAdd ? 'Sök efter en podd ovan och tryck Prenumerera.' : '' })}
    ${D.latest.length ? `<section class="section"><h2>Senaste avsnitten</h2>${epRows(D.latest, true)}</section>` : ''}`;
  bindEps(D.latest);
  const subscribe = async (url, b) => {
    const txt = b.textContent; b.disabled = true; b.textContent = 'Hämtar…';
    try { const r = await api('/podcasts', { method: 'POST', body: { url } }); location.hash = '#/podcast/' + r.id; }
    catch (er) { toastErr(er); b.disabled = false; b.textContent = txt; }
  };
  if ($('#padd')) $('#padd').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('#purl').value.trim(), b = $('#padd button');
    if (!q) return;
    // En adress prenumereras direkt, annars söks namnet i Apples poddkatalog (som Audiobookshelf)
    if (/^https?:\/\//i.test(q)) return subscribe(q, b);
    b.disabled = true; $('#pres').innerHTML = loadingState({ kind: 'list' });
    try {
      const res = await api('/podcasts/search?q=' + encodeURIComponent(q));
      const have = new Set(D.podcasts.map(p => p.url));
      $('#pres').innerHTML = res.length ? `<section class="section"><h2>Sökträffar</h2><div class="list">${res.map((p, i) => `<div class="row podhit">
        ${p.art ? `<img class="cover small" loading="lazy" src="/api/podcasts/search/art?u=${encodeURIComponent(p.art)}" alt="" width="52" height="52">` : '<div class="cover small" aria-hidden="true">🎙</div>'}
        <div style="flex:1;min-width:0"><div class="t">${esc(p.title)}</div><div class="s muted small">${esc([p.author, p.genre, p.episodes ? `${p.episodes} avsnitt` : ''].filter(Boolean).join(' · '))}</div></div>
        ${have.has(p.feed) ? '<span class="muted small">Prenumererar</span>' : `<button class="ghost" data-psub="${i}">Prenumerera</button>`}</div>`).join('')}</div></section>`
        : emptyState({ icon: '🔍', title: 'Inga poddar hittades', text: 'Prova ett annat namn, eller klistra in RSS-adressen från poddens webbplats.' });
      $$('[data-psub]').forEach(x => x.onclick = () => subscribe(res[+x.dataset.psub].feed, x));
    } catch (er) { if (!er?.aborted) $('#pres').innerHTML = errorState(er); }
    finally { b.disabled = false; }
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
  $('#prf').onclick = async () => { try { await api(`/podcasts/${id}/refresh`, { method: 'POST' }); toast('Uppdaterad'); route(); } catch (e) { toastErr(e); } };
  $('#pkeep').onchange = act(async (e) => { await api('/podcasts/' + id, { method: 'PUT', body: { keep: e.target.value } }); toast('Sparat'); });
  $('#pdel').onclick = async () => { if (await confirmDialog('Avsluta prenumerationen och ta bort nedladdade avsnitt?', { okLabel: 'Avsluta', danger: true })) { try { await api('/podcasts/' + id, { method: 'DELETE' }); location.hash = '#/podcasts'; } catch (e) { toastErr(e); } } };
};
