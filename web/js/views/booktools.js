// Ljudböckernas verktyg i webben (laddas med views/books.js): privata RSS-flöden, lyssningsstatistik,
// kapitelredigeraren och administratörens filåtgärder (kapitel in i M4B-filen, slå ihop till M4B, ångra).
import { $, $$, act, api, esc, fmtDate, fmtDur, fmtNum, locale, me, toast, toastErr, t, tn } from '../core.js';
import { confirmDialog, openDialog } from '../ui/dialog.js';
import { emptyState, errorState, loadingState } from '../ui/states.js';
import { iconButton } from '../ui/buttons.js';

const when = (s) => s ? fmtDate(s) : t('aldrig');
const hours = (s) => s >= 3600 ? t('{h} h {m} min', { h: Math.floor(s / 3600), m: Math.floor(s / 60) % 60 }) : s >= 60 ? t('{m} min', { m: Math.round(s / 60) }) : t('{s} s', { s: Math.round(s) });
const copy = (url) => { navigator.clipboard?.writeText(url).then(() => toast(t('Kopierat')), () => toastErr(new Error(t('Kunde inte kopiera – markera länken och kopiera den själv')))); return false; };

// ---------- RSS-flöden ----------
/** Visa den nya flödesadressen (bara nu – sedan finns bara en hash på servern) */
function showFeedUrl(url) {
  const h = openDialog({ title: t('Din RSS-länk'),
    body: `<p class="muted small">${t('Lägg till länken i poddappen som en podd via adress (t.ex. Pocket Casts, Overcast, AntennaPod: Lägg till podd → Adress/RSS). Länken visas bara nu och fungerar utan inloggning – dela den inte. Poddappen måste kunna nå servern.')}</p>
      <label for="bfurl">${t('Flödets adress')}</label><input readonly id="bfurl" value="${esc(url)}" style="font-family:ui-monospace,monospace">`,
    actions: [{ label: t('Kopiera'), onClick: () => copy(url) }, { label: t('Klar'), kind: 'primary' }] });
  const i = h.$('#bfurl'); i.onfocus = () => i.select();
  return h;
}
const feedRows = (list) => `<table class="tracks">${list.map(f => `<tr><td>${esc(f.title || '')}<div class="muted small">${f.kind === 'series' ? t('Serie') : t('Bok')} · ${t('skapad {created} · senast hämtad {last}', { created: when(f.created), last: when(f.lastUsed) })}</div></td>
  <td class="r">${iconButton({ icon: '✕', label: t('Återkalla flödet för {title}', { title: f.title || '' }), data: { bfdel: f.id } })}</td></tr>`).join('')}</table>`;
function bindRevoke(box, reload) {
  $$('[data-bfdel]', box).forEach(b => b.onclick = act(async () => {
    if (!await confirmDialog(t('Återkalla flödet? Poddappar som prenumererar på det slutar fungera.'), { okLabel: t('Återkalla'), danger: true })) return;
    await api('/audiobooks/feeds/' + b.dataset.bfdel, { method: 'DELETE', bg: true }); toast(t('Flödet är återkallat')); reload();
  }));
}
/** RSS-flödet för en bok ({ book, title }) eller en serie ({ library, series }) */
export function feedDialog(o) {
  const q = o.book != null ? `book=${+o.book}` : `lib=${+o.library}&series=${encodeURIComponent(o.series)}`;
  const h = openDialog({ title: o.book != null ? t('Lyssna i en poddapp') : t('Serien i en poddapp'), size: 'wide',
    body: `<p class="muted small">${o.book != null ? t('Ett privat RSS-flöde gör boken till en podd som du kan lyssna på i vilken poddapp som helst, med kapitel. Flödet hör till din profil och kan återkallas när som helst.') : t('Ett privat RSS-flöde gör serien till en podd – ett avsnitt per bok i seriens ordning. Flödet hör till din profil och kan återkallas när som helst.')}</p>
      <div id="bfbox" aria-live="polite">${loadingState({ kind: 'inline' })}</div>`,
    actions: [{ label: t('Stäng') }, { label: t('Skapa RSS-länk'), kind: 'primary', id: 'bfnew', onClick: async () => {
      const r = await api('/audiobooks/feeds', { method: 'POST', bg: true, body: o.book != null ? { book: +o.book } : { library: +o.library, series: o.series } });
      load(); showFeedUrl(r.url || location.origin + r.path); return false;
    } }] });
  const box = h.$('#bfbox');
  const load = async () => {
    try {
      const r = await api('/audiobooks/feeds?' + q, { bg: true });
      if (!box.isConnected) return;
      h.$('#bfnew').hidden = !r.allowed;
      box.innerHTML = !r.allowed ? `<p class="err small">${esc(r.reason || '')}</p>`
        : r.feeds.length ? `<h3 class="small">${t('Dina flöden')}</h3>${feedRows(r.feeds)}` : `<p class="muted small">${t('Du har inget flöde här ännu.')}</p>`;
      bindRevoke(box, load);
    } catch (e) { if (box.isConnected) box.innerHTML = errorState(e, { compact: true }); }
  };
  load();
  return h;
}

// ---------- lyssningsstatistik ----------
export function statsDialog() {
  const h = openDialog({ title: t('Lyssningsstatistik'), size: 'wide', body: `<div id="bsbox">${loadingState({ kind: 'inline' })}</div>`, actions: [{ label: t('Stäng'), kind: 'primary' }] });
  const box = h.$('#bsbox');
  const load = async () => {
    try {
      const [s, f] = await Promise.all([api('/audiobooks/stats', { bg: true }), api('/audiobooks/feeds', { bg: true })]);
      if (!box.isConnected) return;
      const max = Math.max(1, ...s.days.map(d => d.seconds));
      const dayLabel = (d) => new Date(d + 'T12:00:00').toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
      box.innerHTML = `<div class="row"><div class="panel"><div class="muted small">${t('Lyssnat totalt')}</div><b>${hours(s.total)}</b></div>
          <div class="panel"><div class="muted small">${t('Utlästa böcker')}</div><b>${fmtNum(s.finished)}</b></div>
          <div class="panel"><div class="muted small">${t('Senaste 30 dagarna')}</div><b>${hours(s.days.reduce((a, d) => a + d.seconds, 0))}</b></div></div>
        ${s.days.length ? `<h3 class="small">${t('Per dag')}</h3><table class="tracks"><caption class="sr-only">${t('Lyssnad tid per dag')}</caption>${s.days.slice(-14).reverse().map(d => `<tr><th scope="row" class="small" style="width:9em;text-align:left;font-weight:normal">${esc(dayLabel(d.day))}</th>
          <td><span aria-hidden="true" style="display:inline-block;height:.6em;border-radius:3px;background:var(--accent);width:${Math.max(2, Math.round(d.seconds / max * 100))}%"></span></td><td class="r muted small">${hours(d.seconds)}</td></tr>`).join('')}</table>` : ''}
        <h3 class="small">${t('Per bok')}</h3>${s.books.length ? `<table class="tracks">${s.books.slice(0, 30).map(b => `<tr><td><a href="#/book/${+b.id}">${esc(b.title)}</a><div class="muted small">${esc(b.author || '')}${b.finished ? ` · ${t('utläst')}` : ''}</div></td><td class="r muted small">${hours(b.seconds)}</td></tr>`).join('')}</table>`
          : emptyState({ compact: true, title: t('Ingen lyssning ännu'), text: t('Tiden räknas när du lyssnar i webben eller apparna.') })}
        ${s.profiles ? `<h3 class="small">${t('Hushållet')}</h3><table class="tracks">${s.profiles.map(p => `<tr><td>${esc(p.name)}</td><td class="muted small">${tn(p.books, '{n} bok', '{n} böcker')} · ${tn(p.finished, '{n} utläst', '{n} utlästa')}</td><td class="r muted small">${hours(p.seconds)}</td></tr>`).join('')}</table>` : ''}
        <h3 class="small">${t('Mina RSS-flöden')}</h3>${f.feeds.length ? feedRows(f.feeds) : `<p class="muted small">${t('Inga flöden. Skapa ett med "Lyssna i poddapp" på en bok eller serie.')}</p>`}`;
      bindRevoke(box, load);
      $$('a', box).forEach(a => a.addEventListener('click', () => h.close()));
    } catch (e) { if (box.isConnected) box.innerHTML = errorState(e, { compact: true }); }
  };
  load();
  return h;
}

// ---------- kapitelredigeraren (administratör) ----------
const hms = (s) => {
  s = Math.max(0, +s || 0);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  const ss = (Math.round(sec * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
  return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${(sec < 10 ? '0' : '') + ss}`;
};
/** "1:02:03.5", "62:03" eller "3723" → sekunder (NaN om ogiltigt) */
export const parseHms = (v) => {
  const p = String(v).trim().replace(',', '.').split(':');
  if (!p.length || p.length > 3 || p.some(x => !/^\d+(\.\d+)?$/.test(x))) return NaN;
  return p.reduce((a, x) => a * 60 + parseFloat(x), 0);
};
/** b = bokens API-svar. pos() = spelarens position i boken (om boken spelas), annars null. */
export function chapterEditor(b, { pos = () => null, onSaved = () => {} } = {}) {
  let rows = b.chapters.map(c => ({ start: c.start, title: c.title }));
  const h = openDialog({ title: t('Kapitel – {title}', { title: b.title }), size: 'wide', closeOnRoute: true,
    body: `<p class="muted small">${t('Byt namn, ändra starttid (t.ex. 1:02:03), lägg till eller ta bort kapitel. Ändringen sparas i servern – filen skrivs inte om.')} ${b.chapterSource === 'redigerad' ? t('Kapitlen är redigerade.') : ''}</p>
      <div id="cebox"></div>
      <div class="row" style="margin-top:8px"><button type="button" class="ghost" id="ceadd">${t('+ Kapitel')}</button>
        <label class="sr-only" for="ceshift">${t('Förskjut alla kapitel (sekunder)')}</label><input id="ceshift" type="number" step="0.5" value="0" style="width:90px" title="${t('Förskjut alla kapitel (sekunder)')}">
        <button type="button" class="ghost" id="ceshiftb">${t('Förskjut alla')}</button>
        ${b.asin ? `<button type="button" class="ghost" id="ceax">${t('Hämta från Audnexus')}</button>` : `<span class="muted small">${t('Ange bokens ASIN under Redigera för att hämta kapitel från Audnexus.')}</span>`}</div>
      <p id="cemsg" class="small" aria-live="polite"></p>`,
    actions: [
      ...(b.chapterSource === 'redigerad' ? [{ label: t('Återställ filens kapitel'), onClick: async () => { onSaved(await api(`/audiobooks/book/${b.id}/chapters`, { method: 'PUT', body: { reset: true }, bg: true })); toast(t('Filens kapitel gäller igen')); } }] : []),
      ...(b.tools?.canEmbed ? [{ label: t('Skriv in i filen'), onClick: async () => {
        if (!await confirmDialog(t('Skriva in kapitlen i M4B-filen? Spara först. Filen kopieras med de nya kapitlen och originalet läggs i papperskorgen (kan ångras).'), { okLabel: t('Skriv in') })) return false;
        await api(`/audiobooks/book/${b.id}/chapters/embed`, { method: 'POST', bg: true }); toast(t('Kapitlen skrivs in i filen i bakgrunden')); onSaved(null);
      } }] : []),
      { label: t('Avbryt') },
      { label: t('Spara'), kind: 'primary', onClick: async () => {
        read();
        const bad = rows.findIndex(r => !Number.isFinite(r.start));
        if (bad >= 0) { msg(t('Ogiltig starttid i kapitel {n}', { n: bad + 1 }), true); return false; }
        onSaved(await api(`/audiobooks/book/${b.id}/chapters`, { method: 'PUT', body: { chapters: rows }, bg: true })); toast(t('Kapitlen sparade'));
      } }] });
  const box = h.$('#cebox');
  const msg = (s, err) => { const m = h.$('#cemsg'); m.textContent = s; m.className = 'small ' + (err ? 'err' : 'muted'); };
  const read = () => { rows = $$('[data-ce]', box).map(r => ({ start: parseHms($('[data-st]', r).value), title: $('[data-ti]', r).value.trim() })); };
  const render = () => {
    box.innerHTML = `<div class="scrollbox tall"><table class="tracks"><thead><tr><th scope="col">#</th><th scope="col">${t('Start')}</th><th scope="col">${t('Titel')}</th><th scope="col"><span class="sr-only">${t('Åtgärder')}</span></th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr data-ce="${i}"><td class="muted">${i + 1}</td>
        <td><input data-st value="${esc(hms(r.start))}" inputmode="decimal" style="width:7.5em" aria-label="${esc(t('Starttid för kapitel {n}', { n: i + 1 }))}"></td>
        <td><input data-ti value="${esc(r.title)}" maxlength="200" aria-label="${esc(t('Titel för kapitel {n}', { n: i + 1 }))}"></td>
        <td class="r" style="white-space:nowrap">${pos() != null ? iconButton({ icon: '⌖', label: t('Sätt kapitel {n} till nuvarande position', { n: i + 1 }), data: { cenow: i } }) : ''}${iconButton({ icon: '✕', label: t('Ta bort kapitel {n}', { n: i + 1 }), data: { cedel: i } })}</td></tr>`).join('')}
      </tbody></table></div>`;
    $$('[data-cedel]', box).forEach(x => x.onclick = () => { read(); rows.splice(+x.dataset.cedel, 1); render(); });
    $$('[data-cenow]', box).forEach(x => x.onclick = () => { read(); rows[+x.dataset.cenow].start = Math.round(pos() * 10) / 10; render(); });
  };
  render();
  h.$('#ceadd').onclick = () => {
    read();
    const p = pos(), lastStart = rows.length ? Math.max(...rows.map(r => r.start).filter(Number.isFinite)) : 0;
    const start = p != null ? Math.round(p * 10) / 10 : Math.round((lastStart + ((b.duration || lastStart) - lastStart) / 2) * 10) / 10;
    rows.push({ start, title: t('Kapitel {n}', { n: rows.length + 1 }) });
    rows.sort((a, c) => a.start - c.start); render();
    $$('[data-ti]', box)[rows.findIndex(r => r.start === start)]?.focus();
  };
  h.$('#ceshiftb').onclick = () => {
    read(); const d = parseFloat(h.$('#ceshift').value) || 0; if (!d) return;
    rows = rows.map((r, i) => ({ ...r, start: i === 0 && r.start === 0 ? 0 : Math.max(0, Math.round((r.start + d) * 1000) / 1000) })); render();
    msg(t('Alla kapitel utom det första flyttades {d} s', { d: String(d).replace('.', locale.startsWith('sv') ? ',' : '.') }));
  };
  if (h.$('#ceax')) h.$('#ceax').onclick = act(async () => {
    const r = await api(`/audiobooks/book/${b.id}/chapters/audnexus`, { bg: true });
    rows = r.chapters.map(c => ({ start: c.start, title: c.title })); render();
    msg(r.lengthOk ? t('{n} kapitel från Audnexus – kontrollera och spara.', { n: r.chapters.length })
      : t('Audnexus bok är {a} men filen {b} – kapitlen hamnar troligen fel. Kontrollera innan du sparar.', { a: fmtDur(r.total), b: fmtDur(r.duration) }), !r.lengthOk);
  });
  return h;
}

// ---------- filåtgärder (administratör) ----------
const STATE = { embed: t('Skriver in kapitlen i filen…'), merge: t('Slår ihop till M4B…'), restore: t('Lägger tillbaka originalen…') };
/** Rad med pågående/avslutad åtgärd och papperskorgen (HTML) */
export function toolsStatus(b) {
  const s = b.tools?.state, tr = b.tools?.trash;
  const parts = [];
  if (s?.running) parts.push(`<span>${esc(STATE[s.kind] || '')}</span>`);
  else if (s && !s.ok) parts.push(`<span class="err">${t('Åtgärden misslyckades: {error}', { error: esc(s.error || '') })}</span>`);
  if (tr && !s?.running) parts.push(`<span>${tr.kind === 'merge' ? t('Originalfilerna ({n}) ligger i papperskorgen till {date}.', { n: tr.files, date: fmtDate(tr.until) }) : t('Originalfilen ligger i papperskorgen till {date}.', { date: fmtDate(tr.until) })}</span> <button class="ghost small" id="brestore">${t('Ångra')}</button>`);
  return parts.length ? `<p class="small muted" id="btools" aria-live="polite">${parts.join(' ')}</p>` : '';
}
export async function mergeBook(b) {
  if (!await confirmDialog(t('Slå ihop bokens {n} filer till en M4B-fil med kapitel och omslag? Det kan ta en stund. Originalen läggs i papperskorgen och kan läggas tillbaka med Ångra.', { n: b.files.length }), { okLabel: t('Slå ihop') })) return false;
  await api(`/audiobooks/book/${b.id}/merge`, { method: 'POST' }); toast(t('Sammanslagningen har startat'));
  return true;
}
export async function restoreBook(b) {
  if (!await confirmDialog(t('Lägga tillbaka originalfilerna och ta bort den nya filen?'), { okLabel: t('Ångra'), danger: true })) return false;
  await api(`/audiobooks/book/${b.id}/restore`, { method: 'POST' }); return true;
}
export const isAdmin = () => !!me?.is_admin;
