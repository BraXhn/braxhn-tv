// Vy: årssammanfattning
import { $, api, esc, main, me, views } from '../core.js';
import { art } from '../ui/cards.js';
import { emptyState } from '../ui/states.js';

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
    ${empty ? emptyState({ icon: '📊', title: `Ingen statistik för ${year}`, text: 'Titta på film och serier eller lyssna på musik och ljudböcker så fylls sammanfattningen på.' }) : `
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
