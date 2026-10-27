// Filmer och serier från IPTV-leverantörer (Xtream Codes): hyllor per kategori, sökning, kategori i rutnät,
// titelsida med handling och avsnitt, och uppspelning som fortsätter där man var (player/iptv.js).
// #/vod (filmer), #/vod/series, #/vod/movie?cat=… / ?q=…, #/vod/item/<id>
// @lazy – laddas vid behov (LAZY i js/router.js)
import { $, $$, act, api, esc, fmtDur, fmtTime, main, views } from '../core.js';
import { playVod } from '../player/iptv.js';
import { emptyState } from '../ui/states.js';
import { tabsHtml, bindTabs } from '../ui/tabs.js';

const query = () => new URLSearchParams(location.hash.split('?')[1] || '');
const cover = (it) => it.cover ? `<img src="/api/iptv/vod/${it.id}/cover.jpg" alt="" loading="lazy" decoding="async" data-fb="1">` : '';
const card = (it) => `<a class="vcard" href="#/vod/item/${it.id}" title="${esc(it.name)}"><span class="vcov">${cover(it)}<i>${esc(it.name.slice(0, 40))}</i>
  ${it.progress && !it.progress.watched && it.progress.duration ? `<span class="vprog"><b style="width:${Math.min(100, it.progress.position / it.progress.duration * 100)}%"></b></span>` : ''}</span>
  <b>${esc(it.name)}</b><span class="muted small">${[it.year, it.rating ? '★ ' + it.rating : ''].filter(Boolean).join(' · ')}</span></a>`;
const kindTabs = (kind) => tabsHtml({ label: 'Filmer eller serier', current: kind, items: [{ key: 'movie', label: 'Filmer', href: '#/vod' }, { key: 'series', label: 'Serier', href: '#/vod/series' }] });
const toolbar = (kind, q = '') => `<div class="toolbar"><h1>Filmer &amp; serier</h1>${kindTabs(kind)}
  <form id="vsearch" role="search" class="row"><input id="vq" type="search" value="${esc(q)}" placeholder="Sök ${kind === 'series' ? 'serier' : 'filmer'}…" aria-label="Sök" autocomplete="off"></form>
  <a class="btn ghost small" href="#/epg">TV-guide</a></div>`;
function bindSearch(kind) {
  $('#vsearch').onsubmit = (e) => { e.preventDefault(); const q = $('#vq').value.trim(); location.hash = q ? `#/vod/${kind}?q=${encodeURIComponent(q)}` : (kind === 'series' ? '#/vod/series' : '#/vod'); };
}

views.vod = async (arg, arg2) => {
  if (arg === 'item') return item(+arg2);
  const kind = arg === 'series' ? 'series' : 'movie';
  const q = query();
  if (q.get('q') || q.has('cat')) return grid(kind, q);
  const D = await api(`/iptv/vod?kind=${kind}&shelves=1`);
  main.innerHTML = toolbar(kind) + (D.shelves.length ? D.shelves.map(s => `<section class="section vsec"><div class="vsechead"><h2>${esc(s.title)}</h2>
      ${s.key === 'cat' ? `<a class="btn ghost small" href="#/vod/${kind}?cat=${encodeURIComponent(s.category ?? '')}">Visa alla${s.count ? ` (${s.count})` : ''}</a>` : ''}</div>
      <div class="vshelf">${s.items.map(card).join('')}</div></section>`).join('')
    + (D.categories.length > 14 ? `<section class="section"><h2>Alla kategorier</h2><div class="vcats">${D.categories.map(c => `<a class="btn ghost small" href="#/vod/${kind}?cat=${encodeURIComponent(c.name ?? '')}">${esc(c.name || 'Övrigt')} <span class="muted">${c.count}</span></a>`).join('')}</div></section>` : '')
    : emptyState({ icon: '🎬', title: kind === 'series' ? 'Inga serier' : 'Inga filmer', text: 'Filmer och serier hämtas från Xtream-källor (Administration → IPTV). Det kan ta en stund efter att källan lagts till.' }));
  bindSearch(kind);
};

async function grid(kind, q) {
  const params = new URLSearchParams({ kind, limit: '60' });
  if (q.get('q')) params.set('q', q.get('q')); else params.set('category', q.get('cat') || '');
  const sort = q.get('sort') || 'added';
  if (!q.get('q')) params.set('sort', sort);
  let offset = 0;
  const D = await api('/iptv/vod?' + params);
  const title = q.get('q') ? `Sökresultat för ”${q.get('q')}”` : (q.get('cat') || 'Övrigt');
  main.innerHTML = toolbar(kind, q.get('q') || '') + `<div class="vsechead"><h2>${esc(title)} <span class="muted small">${D.total}</span></h2>
    ${q.get('q') ? '' : `<select id="vsort" aria-label="Sortera">${[['added', 'Senast tillagda'], ['name', 'Namn'], ['rating', 'Betyg'], ['year', 'År']].map(([k, l]) => `<option value="${k}"${k === sort ? ' selected' : ''}>${l}</option>`).join('')}</select>`}</div>
    ${D.items.length ? `<div class="vgrid" id="vgrid">${D.items.map(card).join('')}</div>` : emptyState({ icon: '🔍', title: 'Inget hittades', compact: true })}
    <div class="row" style="justify-content:center;margin:16px 0"><button class="ghost" id="vmore" ${D.items.length < D.total && !q.get('q') ? '' : 'hidden'}>Visa fler</button></div>`;
  bindSearch(kind);
  if ($('#vsort')) $('#vsort').onchange = () => { const p = query(); p.set('sort', $('#vsort').value); location.hash = `#/vod/${kind}?${p}`; };
  $('#vmore').onclick = act(async () => {
    offset += 60; params.set('offset', String(offset));
    const d = await api('/iptv/vod?' + params);
    $('#vgrid').insertAdjacentHTML('beforeend', d.items.map(card).join(''));
    $('#vmore').hidden = offset + d.items.length >= d.total;
  });
}

async function item(id) {
  const v = await api('/iptv/vod/' + id);
  const meta = [v.year, v.genre, v.duration ? fmtDur(v.duration) : '', v.rating ? '★ ' + v.rating : ''].filter(Boolean).join(' · ');
  const resume = v.progress && !v.progress.watched && v.progress.position > 60;
  main.innerHTML = `<div class="vhero">${v.backdrop ? `<img class="vbg" src="/api/iptv/vod/${v.id}/backdrop.jpg" alt="" data-fb="1">` : ''}
    <div class="vhero-in"><span class="vcov big">${cover(v)}<i>${esc(v.name.slice(0, 40))}</i></span><div>
      <p class="muted small"><a href="${v.kind === 'series' ? '#/vod/series' : '#/vod'}">${v.kind === 'series' ? 'Serier' : 'Filmer'}</a>${v.category ? ' · ' + esc(v.category) : ''}${v.source ? ' · ' + esc(v.source) : ''}</p>
      <h1>${esc(v.name)}</h1>${meta ? `<p class="muted">${esc(meta)}</p>` : ''}
      ${v.kind === 'movie' ? `<div class="row" style="margin:12px 0"><button class="primary" id="vplay">▶ ${resume ? 'Fortsätt (' + fmtTime(v.progress.position) + ')' : 'Spela'}</button>${resume ? '<button class="ghost" id="vstart">Från början</button>' : ''}</div>` : ''}
      ${v.plot ? `<p class="vplot">${esc(v.plot)}</p>` : ''}
      ${v.cast ? `<p class="small"><span class="muted">Medverkande:</span> ${esc(v.cast)}</p>` : ''}${v.director ? `<p class="small"><span class="muted">Regi:</span> ${esc(v.director)}</p>` : ''}
    </div></div></div><div id="veps"></div>`;
  if (v.kind === 'movie') {
    const go = (pos) => playVod('movie', v.id, { title: v.name, sub: v.year ? String(v.year) : '', duration: v.duration, position: pos });
    $('#vplay').onclick = () => go(resume ? v.progress.position : 0);
    if ($('#vstart')) $('#vstart').onclick = () => go(0);
    $('#vplay').focus();
    return;
  }
  const seasons = [...new Set(v.episodes.map(e => e.season ?? 0))];
  if (!v.episodes.length) { $('#veps').innerHTML = emptyState({ icon: '📺', title: 'Inga avsnitt', text: 'Leverantören har inga avsnitt för serien just nu.', compact: true }); return; }
  // Första säsongen med ett påbörjat/osett avsnitt
  const next = v.episodes.find(e => e.progress && !e.progress.watched) || v.episodes.find(e => !e.progress?.watched) || v.episodes[0];
  let cur = next.season ?? 0;
  const renderEps = () => {
    $('#veps-list').innerHTML = v.episodes.filter(e => (e.season ?? 0) === cur).map(e => `<div class="vep">
      ${e.image ? `<img src="/api/iptv/episodes/${e.id}/image.jpg" alt="" loading="lazy" data-fb="1">` : '<span class="vep-ph"></span>'}
      <div class="vep-t"><b>${e.episode ? e.episode + '. ' : ''}${esc(e.title || 'Avsnitt')}</b><span class="muted small">${e.duration ? fmtDur(e.duration) : ''}${e.progress?.watched ? ' · ✓ sett' : e.progress?.position ? ' · ' + fmtTime(e.progress.position) : ''}</span>
      ${e.plot ? `<p class="small muted">${esc(e.plot)}</p>` : ''}</div><button class="ghost small" data-ep="${e.id}" aria-label="Spela ${esc(e.title || 'avsnittet')}">▶</button></div>`).join('');
    for (const b of $$('[data-ep]')) b.onclick = () => {
      const e = v.episodes.find(x => x.id === +b.dataset.ep);
      playVod('episode', e.id, { title: v.name, sub: `S${e.season ?? '?'}E${e.episode ?? '?'}${e.title ? ' · ' + e.title : ''}`, duration: e.duration,
        position: e.progress && !e.progress.watched ? e.progress.position : 0 });
    };
  };
  $('#veps').innerHTML = `<section class="section">${seasons.length > 1 ? tabsHtml({ id: 'vst', label: 'Säsonger', panel: 'veps-list', current: String(cur),
    items: seasons.map(s => ({ key: String(s), label: s ? 'Säsong ' + s : 'Övrigt' })) }) : '<h2>Avsnitt</h2>'}<div id="veps-list" role="tabpanel"></div></section>`;
  bindTabs($('#vst'), (k) => { cur = +k; renderEps(); });
  renderEps();
  $('[data-ep]')?.focus();
}
