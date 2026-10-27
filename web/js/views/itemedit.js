// @lazy – laddas vid behov (Redigera på titelsidan och i kortmenyn ⋮), förladdas inte från index.html (server/http/static.js)
// Dialogen "Redigera" för administratören: flikarna Allmänt (fälten med lås per fält, som i Plex), Bilder (TMDB:s
// affischer/bakgrunder/logotyper/stillbilder, egen bild, återställ) och Avancerat (låsen och matchningen).
// Ett fält som ändras låses automatiskt; låsta fält skrivs aldrig över av Uppdatera metadata, NFO eller omskanning.
import { $, $$, api, esc, toast, toastErr } from '../core.js';
import { route } from '../router.js';
import { iconButton, setIconButton } from '../ui/buttons.js';
import { openDialog } from '../ui/dialog.js';
import { emptyState, errorState, loadingState } from '../ui/states.js';
import { bindTabs, tabsHtml } from '../ui/tabs.js';

// Fälten i dialogen: API-namn → etikett och typ (bara de som servern säger gäller titeln visas)
const FIELDS = {
  title: { label: 'Titel', type: 'text', max: 300, required: true },
  sortTitle: { label: 'Sorteringstitel', type: 'text', max: 300, hint: 'Tomt = räknas fram ur titeln' },
  originalTitle: { label: 'Originaltitel', type: 'text', max: 300 },
  season: { label: 'Säsong', type: 'number', min: 0, max: 1000, required: true },
  episode: { label: 'Avsnitt', type: 'number', min: 0, max: 10000, required: true },
  year: { label: 'År', type: 'number', min: 1870, max: 2200 },
  released: { label: 'Premiärdatum', type: 'date' },
  tagline: { label: 'Tagline', type: 'text', max: 300 },
  overview: { label: 'Beskrivning', type: 'textarea', max: 10000 },
  genres: { label: 'Genrer', type: 'genres' },
  studio: { label: 'Studio', type: 'text', max: 200 },
  age: { label: 'Åldersgräns (år)', type: 'number', min: 0, max: 18, hint: 'Tomt = okänd' },
  rating: { label: 'Betyg (0–10)', type: 'number', min: 0, max: 10, step: 0.1 },
};
const IMG_LABEL = { poster: 'Affisch', backdrop: 'Bakgrund', logo: 'Logotyp', thumb: 'Miniatyr' };
const imgLabel = (t) => IMG_LABEL[t] || (/^season(\d+)$/.test(t) ? (t === 'season0' ? 'Specialavsnitt' : 'Säsong ' + t.slice(6)) : t);
const LANG = { sv: 'svenska', en: 'engelska', da: 'danska', no: 'norska', fi: 'finska', de: 'tyska', fr: 'franska', es: 'spanska', ja: 'japanska' };
const langName = (l) => l ? (LANG[l] || l) : 'utan text';
const lockIcon = (on) => on ? '🔒' : '🔓';
const lockLabel = (f, on) => on ? `${FIELDS[f].label}: låst – klicka för att låsa upp` : `${FIELDS[f].label}: lås fältet`;

/** Bilder som visas på sidan just nu för titeln hämtas om (de cachas ett dygn i webbläsaren) */
async function reloadImages(id) {
  const urls = new Set();
  const want = `/api/image/${+id}/`;
  for (const el of $$('img')) if (el.src.includes(want)) urls.add(el.src);
  for (const el of $$('[style*="background-image"]')) { const m = /url\(["']?([^"')]+)/.exec(el.style.backgroundImage); if (m && m[1].includes(want)) urls.add(m[1]); }
  await Promise.all([...urls].map(u => fetch(u, { cache: 'reload' }).catch(() => {})));
}

function fieldHtml(f, v, locked) {
  const d = FIELDS[f], id = 'me-' + f;
  const lock = iconButton({ icon: lockIcon(locked), label: lockLabel(f, locked), cls: 'ghost small melock', data: { lock: f }, pressed: locked });
  let input;
  if (d.type === 'textarea') input = `<textarea id="${id}" rows="5" maxlength="${d.max}">${esc(v || '')}</textarea>`;
  else if (d.type === 'genres') {
    input = `<div class="mechips" id="me-genres-list" aria-label="Valda genrer" role="list">${(v || []).map(chip).join('')}</div>
      <input id="${id}" list="me-genre-sugg" autocomplete="off" placeholder="Skriv en genre och tryck Enter" aria-describedby="${id}-h">
      <span class="muted small" id="${id}-h">Enter eller komma lägger till. Förslag från biblioteket.</span>`;
  } else {
    const attrs = [`id="${id}"`, `type="${d.type}"`, d.max && d.type === 'text' ? `maxlength="${d.max}"` : '', d.type === 'number' ? `min="${d.min}" max="${d.max}" step="${d.step || 1}" inputmode="${d.step ? 'decimal' : 'numeric'}"` : '',
      d.required ? 'required' : '', d.hint ? `aria-describedby="${id}-h"` : ''].filter(Boolean).join(' ');
    input = `<input ${attrs} value="${esc(v ?? '')}">${d.hint ? `<span class="muted small" id="${id}-h">${esc(d.hint)}</span>` : ''}`;
  }
  return `<div class="mefield${d.type === 'textarea' || d.type === 'genres' ? ' wide' : ''}" data-field="${f}"><div class="melabel"><label for="${id}">${esc(d.label)}</label>${lock}</div>${input}</div>`;
}
const chip = (g) => `<span class="mechip" role="listitem">${esc(g)}${iconButton({ icon: '✕', label: `Ta bort genren ${g}`, cls: 'ghost small', data: { genre: g } })}</span>`;

/**
 * Öppnar dialogen "Redigera".
 * @param {{ id: number, title: string }} it  titeln (från /api/items/:id eller ett kort)
 * @param {'general'|'images'|'advanced'} [tab]
 */
export async function openEditor(it, tab = 'general') {
  let m;
  try { m = await api(`/items/${+it.id}/metadata`, { bg: true }); } catch (e) { return toastErr(e); }
  const locked = new Set(m.locked), changed = new Set();
  let genres = [...m.values.genres], imgChanged = false, imgType = Object.keys(m.images)[0];
  const tabs = [{ key: 'general', label: 'Allmänt' }, { key: 'images', label: 'Bilder' }, { key: 'advanced', label: 'Avancerat' }];
  const panel = (k, html) => `<div class="mepanel" id="me-p-${k}" role="tabpanel" aria-label="${esc(tabs.find(t => t.key === k).label)}" tabindex="0"${k === tab ? '' : ' hidden'}>${html}</div>`;
  const general = `<div class="megrid">${Object.keys(FIELDS).filter(f => m.fields.includes(f)).map(f => fieldHtml(f, m.values[f], locked.has(f))).join('')}</div>
    <datalist id="me-genre-sugg">${m.genreSuggestions.map(g => `<option value="${esc(g)}"></option>`).join('')}</datalist>
    <p class="muted small">🔒 Låsta fält ändras aldrig av <i>Uppdatera metadata</i>, NFO-filer eller omskanning. Ett fält du ändrar låses automatiskt.</p>`;
  const images = `<div class="row meimgtypes" role="group" aria-label="Bildtyp">${Object.keys(m.images).map(t => `<button type="button" class="ghost small" data-imgtype="${esc(t)}" aria-pressed="${t === imgType}">${esc(imgLabel(t))}</button>`).join('')}</div>
    <div class="mecur" id="me-cur"></div><div id="me-opts" class="meopts" aria-live="polite"></div>`;
  const h = openDialog({ title: `Redigera – ${it.title || m.values.title}`, size: 'wide', form: true, className: 'metaedit',
    body: tabsHtml({ id: 'me-tabs', label: 'Redigera', current: tab, items: tabs }) + panel('general', general) + panel('images', images) + panel('advanced', ''),
    onClose: (v) => { if (v !== 'route' && (imgChanged || v === 'saved')) reloadImages(m.id).then(() => route()); },
    actions: [{ label: 'Avbryt' }, { label: 'Spara', kind: 'primary', submit: true, onClick: save }] });
  const d = h.el, q = (s) => d.querySelector(s);

  // ---- flikar ----
  bindTabs(q('#me-tabs'), (key) => {
    for (const t of tabs) q('#me-p-' + t.key).hidden = t.key !== key;
    if (key === 'images' && !q('#me-opts').childElementCount) showImages();
    if (key === 'advanced') renderAdvanced();
  });
  for (const t of $$('[role=tab]', d)) t.setAttribute('aria-controls', 'me-p-' + t.dataset.tabKey);

  // ---- Allmänt: lås och ändringar ----
  const setLock = (f, on) => {
    on ? locked.add(f) : locked.delete(f);
    const b = q(`[data-lock="${f}"]`);
    if (b) { setIconButton(b, lockIcon(on), lockLabel(f, on)); b.setAttribute('aria-pressed', on); b.classList.toggle('on', on); }
  };
  for (const f of locked) setLock(f, true);
  d.addEventListener('click', (e) => {
    const lb = e.target.closest('[data-lock]');
    if (lb) { setLock(lb.dataset.lock, !locked.has(lb.dataset.lock)); return; }
    const gb = e.target.closest('[data-genre]');
    if (gb) { genres = genres.filter(g => g !== gb.dataset.genre); markChanged('genres'); renderChips(); q('#me-genres')?.focus(); }
  });
  const markChanged = (f) => { changed.add(f); setLock(f, true); if (f === 'title') setLock('sortTitle', true); };
  for (const f of m.fields) if (f !== 'genres') q('#me-' + f)?.addEventListener('input', () => markChanged(f));
  const renderChips = () => { const l = q('#me-genres-list'); if (l) l.innerHTML = genres.map(chip).join(''); };
  const gIn = q('#me-genres');
  const addGenre = () => {
    for (const g of gIn.value.split(',').map(s => s.trim()).filter(Boolean)) if (!genres.some(x => x.toLowerCase() === g.toLowerCase()) && genres.length < 30) genres.push(g.slice(0, 60));
    gIn.value = ''; markChanged('genres'); renderChips();
  };
  if (gIn) {
    gIn.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ',') && gIn.value.trim()) { e.preventDefault(); addGenre(); } });
    gIn.addEventListener('change', () => { if (gIn.value.trim() && m.genreSuggestions.includes(gIn.value.trim())) addGenre(); });
  }

  async function save() {
    if (gIn?.value.trim()) addGenre();
    const values = {};
    for (const f of changed) {
      if (f === 'genres') { values.genres = genres; continue; }
      const el = q('#me-' + f), v = el.value.trim();
      if (FIELDS[f].required && !v) { el.focus(); throw new Error(`${FIELDS[f].label} får inte vara tomt`); }
      values[f] = FIELDS[f].type === 'number' ? (v === '' ? null : +v) : v;
    }
    const r = await api(`/items/${m.id}/metadata`, { method: 'PUT', body: { values, locked: [...locked] }, bg: true });
    toast(r.locked.length ? `Sparat – ${r.locked.length} ${r.locked.length === 1 ? 'fält är låst' : 'fält är låsta'}` : 'Sparat');
    return 'saved';
  }

  // ---- Avancerat ----
  function renderAdvanced() {
    const list = m.fields.filter(f => locked.has(f));
    q('#me-p-advanced').innerHTML = `<h3 class="mesub">Låsta fält</h3>
      ${list.length ? `<ul class="melocks">${list.map(f => `<li>🔒 ${esc(FIELDS[f].label)}</li>`).join('')}</ul>` : '<p class="muted">Inga fält är låsta – allt hämtas automatiskt (NFO före TMDB).</p>'}
      <div class="row"><button type="button" class="ghost small" id="me-unlockall"${list.length ? '' : ' disabled'}>Lås upp alla fält</button></div>
      <p class="muted small">Upplåsta fält får sina värden från NFO-filen eller TMDB nästa gång metadatan uppdateras. Spara för att ändra låsen.</p>
      <h3 class="mesub">Källa</h3>
      <dl class="tech mesrc">${m.file ? `<dt>Fil</dt><dd>${esc(m.file)}</dd>` : ''}<dt>TMDB</dt><dd>${m.tmdbId ? `${+m.tmdbId}${m.matchLocked ? ' (låst matchning)' : ''}` : 'Inte matchad'}</dd>
      <dt>Bilder</dt><dd>${Object.entries(m.images).filter(([, v]) => v.lock).map(([k, v]) => `${esc(imgLabel(k))}: ${v.lock === 'upload' ? 'uppladdad' : 'vald från TMDB'}`).join(', ') || 'Automatiska'}</dd></dl>`;
    q('#me-unlockall').onclick = () => { for (const f of [...locked]) setLock(f, false); renderAdvanced(); toast('Alla fält är upplåsta – spara för att behålla det'); };
  }

  // ---- Bilder ----
  // Logotypen skalas inte (PNG); v= hämtar den nya bilden direkt efter ett byte
  const imgUrl = (t) => `/api/image/${m.id}/${t}?${t === 'logo' ? '' : 'w=320&'}v=${Date.now()}`;
  function renderCurrent() {
    const cur = m.images[imgType], wide = imgType === 'backdrop' || imgType === 'thumb' || imgType === 'logo';
    const status = !cur.has ? 'Ingen bild' : cur.lock === 'upload' ? 'Uppladdad bild (låst)' : cur.lock === 'tmdb' ? 'Vald från TMDB (låst)' : 'Automatisk';
    q('#me-cur').innerHTML = `<div class="meprev${wide ? ' wide' : ''}${imgType === 'logo' ? ' logo' : ''}">${cur.has ? `<img src="${imgUrl(imgType)}" alt="Nuvarande ${esc(imgLabel(imgType).toLowerCase())}">` : '<span class="muted">Ingen bild</span>'}</div>
      <div><p><b>${esc(imgLabel(imgType))}</b><br><span class="muted small">${esc(status)}</span></p>
      <div class="row"><label class="btn ghost small mefile">Ladda upp egen…<input type="file" id="me-file" accept="image/jpeg,image/png,image/webp" class="sr-only"></label>
      ${cur.lock ? '<button type="button" class="ghost small" id="me-reset">Återställ till automatisk</button>' : ''}</div>
      <p class="muted small">JPEG, PNG eller WebP, högst ${Math.round(m.uploadMax / 1048576)} MB. ${imgType === 'logo' ? 'Logotypen sparas som PNG med genomskinlighet.' : 'Sparas som JPEG.'}</p></div>`;
    q('#me-file').onchange = (e) => upload(e.target.files[0]);
    if (q('#me-reset')) q('#me-reset').onclick = reset;
  }
  const done = (r, msg) => { m.images = r.images; imgChanged = true; renderCurrent(); markOn(); toast(msg); };
  async function upload(file) {
    if (!file) return;
    if (file.size > m.uploadMax) return toast(`Bilden är för stor (högst ${Math.round(m.uploadMax / 1048576)} MB)`, { error: true });
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return toast('Bara JPEG, PNG och WebP', { error: true });
    q('#me-cur .meprev').innerHTML = loadingState({ kind: 'inline', label: 'Laddar upp…' });
    try { done(await api(`/items/${m.id}/images/${imgType}`, { method: 'PUT', body: file, headers: { 'Content-Type': file.type }, bg: true }), 'Bilden är uppladdad'); }
    catch (e) { toastErr(e); renderCurrent(); }
  }
  async function reset() {
    try { done(await api(`/items/${m.id}/images/${imgType}`, { method: 'DELETE', bg: true }), 'Automatisk bild igen'); } catch (e) { toastErr(e); }
  }
  let opts = [];
  const markOn = () => { const lock = m.images[imgType].lock; for (const b of $$('[data-opt]', d)) b.setAttribute('aria-pressed', String(lock === 'tmdb' && b.dataset.path === m.images[imgType].path)); };
  async function showImages() {
    renderCurrent();
    const box = q('#me-opts');
    box.innerHTML = loadingState({ kind: 'inline', label: 'Hämtar bilder från TMDB…' });
    let r;
    try { r = await api(`/items/${m.id}/images/${imgType}`, { bg: true }); }
    catch (e) { if (d.isConnected) box.innerHTML = errorState(e, { compact: true }); return; }
    if (!d.isConnected || r.type !== imgType) return;
    opts = r.options;
    const shape = imgType === 'logo' ? 'logo' : imgType === 'backdrop' || imgType === 'thumb' ? 'land' : 'port';
    box.innerHTML = r.error ? errorState(new Error(r.error), { compact: true })
      : !opts.length ? emptyState({ compact: true, title: 'Inga bilder från TMDB', text: m.tmdb ? 'TMDB har inga bilder av den här typen. Ladda upp en egen.' : 'Titeln är inte matchad mot TMDB (eller TMDB-nyckel saknas). Ladda upp en egen bild.' })
      : `<p class="muted small">${opts.length} ${opts.length === 1 ? 'bild' : 'bilder'} från TMDB – välj en.</p><div class="megallery ${shape}">${opts.map((o, i) => `<button type="button" class="meopt" data-opt="${i}" data-path="${esc(o.path)}" aria-pressed="false"
          aria-label="${esc(imgLabel(imgType))} ${i + 1} av ${opts.length}, ${esc(langName(o.lang))}${o.width ? `, ${+o.width}×${+o.height}` : ''}">
          <img src="https://image.tmdb.org/t/p/${shape === 'land' ? 'w300' : 'w185'}${esc(o.path)}" alt="" loading="lazy" decoding="async">
          <span class="melang">${esc(o.lang ? o.lang.toUpperCase() : '–')}</span></button>`).join('')}</div>`;
    markOn();
  }
  q('#me-opts').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-opt]'); if (!b) return;
    const o = opts[+b.dataset.opt];
    b.disabled = true; b.classList.add('busy');
    try { done(await api(`/items/${m.id}/images/${imgType}`, { method: 'POST', body: { tmdbPath: o.path }, bg: true }), 'Bilden är vald'); }
    catch (err) { toastErr(err); }
    finally { b.disabled = false; b.classList.remove('busy'); }
  });
  for (const b of $$('[data-imgtype]', d)) b.onclick = () => {
    imgType = b.dataset.imgtype;
    for (const x of $$('[data-imgtype]', d)) x.setAttribute('aria-pressed', String(x === b));
    showImages();
  };
  if (tab === 'images') showImages();
  if (tab === 'advanced') renderAdvanced();
  return h;
}
