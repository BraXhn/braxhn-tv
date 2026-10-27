// Vy: Kommande (#/calendar) – avsnitt per dag från TMDB (och Sonarr), saknade avsnitt på seriesidan,
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
// hyllan "Kommer snart" på startsidan och kalenderprenumerationen (iCal) under Mitt konto.
import { $, $$, act, api, esc, hue, imgSrc, main, me, store, sxe, toast, toastErr, views } from '../core.js';
import { route } from '../router.js';
import { confirmDialog, openDialog } from '../ui/dialog.js';
import { dayLabel, hrefOf, timeOf } from '../ui/cards.js';
import { emptyState } from '../ui/states.js';
import { bindTabs, tabsHtml } from '../ui/tabs.js';

// ---------- datum ----------
// dayLabel, timeOf och hrefOf ligger i ui/cards.js (hyllan "Kommer snart" på startsidan behöver dem)
const ymd = (d) => d.toLocaleDateString('sv-SE');
const parse = (s) => new Date(s + 'T12:00:00');
const plus = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** Veckovyn: Idag/I morgon/I går, annars veckodagen (datumet står bredvid) */
const weekLabel = (s, today) => { const l = dayLabel(s, today); return /^(Idag|I morgon|I går)$/.test(l) ? l : cap(parse(s).toLocaleDateString('sv-SE', { weekday: 'long' })); };
const monday = (s) => { const d = parse(s); return plus(s, -((d.getDay() + 6) % 7)); };

// ---------- en rad ----------
const poster = (e, css = 46) => {
  const h = hue(e.show || '');
  const ph = `<div class="ph" aria-hidden="true" style="--h1:hsl(${h} 30% 30%);--h2:hsl(${(h + 50) % 360} 30% 16%)"></div>`;
  return `<div class="calp">${ph}${e.poster && e.showId ? `<img loading="lazy" decoding="async" ${imgSrc(`/api/image/${+e.showId}/poster`, css)} alt="" width="300" height="450" data-fb="1">` : ''}</div>`;
};
const badges = (e) => [e.inLibrary ? '<span class="ok-badge">I biblioteket</span>' : e.missing ? '<span class="warn-badge">Saknas</span>' : '',
  e.following ? '<span class="cal-follow">Följer</span>' : ''].filter(Boolean).join(' ');
function row(e) {
  const meta = [timeOf(e), e.network].filter(Boolean).map(esc).join(' · ');
  const inner = `${poster(e)}<div class="calb"><div class="calt"><b>${esc(e.show)}</b> <span class="muted">${sxe(e)}</span></div>
    ${e.name ? `<div class="caln cals">${esc(e.name)}</div>` : ''}<div class="cals muted">${meta}${meta && badges(e) ? ' ' : ''}${badges(e)}</div></div>`;
  const h = hrefOf(e);
  return h ? `<a class="calrow" href="${h}">${inner}</a>` : `<div class="calrow">${inner}</div>`;
}

// ---------- vyn ----------
views.calendar = async () => {
  const mine = store.get('cal.mine', false);
  const wide = innerWidth >= 1000;
  const mode = wide ? store.get('cal.mode', 'week') : 'list';
  const week = +store.get('cal.week', 0) || 0;
  const today = ymd(new Date());
  const from = mode === 'week' ? plus(monday(today), week * 7) : today;
  const to = mode === 'week' ? plus(from, 6) : plus(today, 27);
  const d = await api(`/calendar?from=${from}&to=${to}${mine ? '&mine=1' : ''}`);
  const head = `<div class="toolbar"><h1>Kommande</h1>
    ${tabsHtml({ id: 'calf', label: 'Vilka serier', current: mine ? 'mine' : 'all', items: [{ key: 'all', label: 'Alla serier' }, { key: 'mine', label: 'Serier jag följer' }] })}
    ${wide ? tabsHtml({ id: 'calm', label: 'Visning', current: mode, items: [{ key: 'week', label: 'Vecka' }, { key: 'list', label: 'Lista' }] }) : ''}
    <a class="btn small" href="#/account" title="Prenumerera i telefonens kalender (Mitt konto)">📅 Lägg till i kalendern</a></div>`;
  let body;
  if (!d.tmdb && !d.sonarr) {
    body = emptyState({ icon: '📅', title: 'Kalendern behöver en TMDB-nyckel',
      text: me.adminHere ? 'Sändningsdatum hämtas från TMDB. Lägg in en gratis API-nyckel från themoviedb.org under Administration → Inställningar, så fylls kalendern på inom några minuter.'
        : 'Sändningsdatum hämtas från TMDB, och servern har ingen TMDB-nyckel. Be administratören lägga in en (den är gratis).',
      action: me.adminHere ? { label: 'Till Administration', href: '#/admin' } : null });
  } else if (!d.items.length && !d.shows && !d.sonarr) {
    body = emptyState({ icon: '⏳', title: 'Kalendern fylls på', text: 'Avsnitt och sändningsdatum hämtas från TMDB i bakgrunden, en serie i taget. Titta in igen om en stund.' });
  } else if (mode === 'week') {
    const days = Array.from({ length: 7 }, (_, i) => plus(from, i));
    body = `<div class="row calnav"><button class="ghost small" id="calprev">← Förra veckan</button>
      <button class="ghost small" id="calnow" ${week === 0 ? 'disabled' : ''}>Den här veckan</button><button class="ghost small" id="calnext">Nästa vecka →</button>
      <span class="muted cals">${esc(parse(from).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long' }))} – ${esc(parse(to).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' }))}</span></div>
      <div class="calweek">${days.map(s => {
        const l = d.items.filter(e => e.date === s);
        return `<section class="calday${s === today ? ' today' : ''}" aria-label="${esc(dayLabel(s, today))}"><h2>${esc(weekLabel(s, today))} <span class="muted cals">${esc(parse(s).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' }))}</span></h2>
          ${l.map(row).join('') || '<p class="muted cals">–</p>'}</section>`;
      }).join('')}</div>`;
  } else {
    const by = new Map();
    for (const e of d.items) { if (!by.has(e.date)) by.set(e.date, []); by.get(e.date).push(e); }
    body = by.size ? [...by].map(([s, l]) => `<section class="callist"><h2>${esc(dayLabel(s, today))}</h2>${l.map(row).join('')}</section>`).join('')
      : emptyState({ icon: '📅', title: mine ? 'Inget nytt från serierna du följer' : 'Inga avsnitt de närmaste veckorna',
        text: mine ? 'Följ serier med knappen Följ på seriens sida, eller välj Alla serier.' : 'Pågående serier i biblioteket visas här när nya avsnitt har ett sändningsdatum.' });
  }
  main.innerHTML = head + body;
  bindTabs($('#calf'), (k) => { store.set('cal.mine', k === 'mine'); route(); });
  bindTabs($('#calm'), (k) => { store.set('cal.mode', k); route(); });
  if ($('#calprev')) {
    $('#calprev').onclick = () => { store.set('cal.week', week - 1); route(); };
    $('#calnext').onclick = () => { store.set('cal.week', week + 1); route(); };
    $('#calnow').onclick = () => { store.set('cal.week', 0); route(); };
  }
};

// ---------- seriesidan: saknade avsnitt ----------
/** Fyller el med "Saknas: S02E04–E06" och ev. knappen Sök i Sonarr */
export async function missingBox(el, showId) {
  if (!el) return;
  let m;
  try { m = await api(`/items/${+showId}/missing`); } catch (e) { if (e.aborted) throw e; return; }
  if (!m.known || !m.count || !el.isConnected) return;
  const label = m.ranges.length > 8 ? m.ranges.slice(0, 8).map(r => r.label).join(', ') + ` och ${m.ranges.length - 8} till` : m.label;
  el.innerHTML = `<div class="missing"><span class="warn-badge">Saknas</span> <span>${esc(label)}</span> <span class="muted cals">(${m.count} avsnitt)</span>
    ${m.canSearch ? '<button class="ghost small" id="sonarrsearch">Sök i Sonarr</button>' : ''}</div>`;
  el.hidden = false;
  if ($('#sonarrsearch')) $('#sonarrsearch').onclick = act(async (ev) => {
    const b = ev.currentTarget; b.disabled = true;
    try { const r = await api(`/items/${+showId}/missing/search`, { method: 'POST' }); toast(r.searched ? `Sonarr söker efter ${r.searched} avsnitt` : 'Sonarr har redan avsnitten'); }
    catch (e) { b.disabled = false; throw e; }
  });
}

// ---------- Mitt konto: prenumerera i kalendern ----------
/** Panelen "Kalender i telefonen" (iCal-länk med egen token som bara gäller kalendern) */
export async function calendarFeedPanel(el) {
  if (!el) return;
  let f;
  try { f = await api('/calendar/feed'); } catch (e) { if (e.aborted) throw e; el.hidden = true; return; }
  const fmt = (t) => t ? new Date(t * 1000).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) : 'aldrig';
  el.innerHTML = `<h2>Kalender i telefonen ${f.active ? '<span class="ok-badge">På</span>' : ''}</h2>
    <p class="muted small">Prenumerera på kommande avsnitt i telefonens eller datorns kalender (iPhone, Google Kalender, Outlook). Länken innehåller en egen nyckel som bara ger tillgång till kalendern – inget annat i ditt konto. Kalendern måste kunna nå servern; Google Kalender hämtar via internet.</p>
    ${f.active ? `<p class="cals">Länken skapades ${fmt(f.created)} · senast hämtad ${fmt(f.lastUsed)}. Av säkerhetsskäl visas den bara när den skapas – skapa en ny om du behöver den igen (den gamla slutar då fungera).</p>` : ''}
    <div class="row"><button class="primary" id="calnew">${f.active ? 'Skapa ny länk' : 'Skapa kalenderlänk'}</button>${f.active ? '<button class="danger" id="caloff">Återkalla länken</button>' : ''}</div>`;
  $('#calnew').onclick = act(async () => {
    if (f.active && !await confirmDialog('Skapa en ny länk? Den gamla slutar fungera i kalendrar där den har lagts till.', { okLabel: 'Skapa ny' })) return;
    const r = await api('/calendar/feed', { method: 'POST' });
    const url = location.origin + r.path, webcal = url.replace(/^https?:/, 'webcal:');
    const urlMine = url + '&mine=1';
    openDialog({
      title: 'Din kalenderlänk',
      body: `<p class="muted small">Kopiera länken och lägg till den som prenumererad kalender (iPhone: Inställningar → Kalender → Konton → Lägg till konto → Annat → Lägg till prenumererad kalender). Länken visas bara nu.</p>
        <label for="calurl">Alla serier i biblioteket</label><input readonly value="${esc(url)}" id="calurl" style="font-family:ui-monospace,monospace">
        <label for="calurl2">Bara serier jag följer</label><input readonly value="${esc(urlMine)}" id="calurl2" style="font-family:ui-monospace,monospace">
        <p style="margin-top:12px"><a class="btn" href="${esc(webcal)}">Öppna i kalenderappen</a></p>`,
      actions: [{ label: 'Kopiera', onClick: () => { navigator.clipboard?.writeText(url).then(() => toast('Kopierat'), () => toastErr(new Error('Kunde inte kopiera – markera länken och kopiera den själv'))); return false; } },
        { label: 'Klar', kind: 'primary' }],
      onClose: (v) => { if (v !== 'route') route(); }
    });
    for (const i of $$('#calurl, #calurl2')) i.onfocus = () => i.select();
  });
  if ($('#caloff')) $('#caloff').onclick = act(async () => {
    if (!await confirmDialog('Återkalla kalenderlänken? Kalendrar som prenumererar på den slutar uppdateras.', { okLabel: 'Återkalla', danger: true })) return;
    await api('/calendar/feed', { method: 'DELETE' }); toast('Kalenderlänken är återkallad'); route();
  });
}
