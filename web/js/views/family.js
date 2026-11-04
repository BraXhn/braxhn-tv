// Vy: Föräldraöversikt (#/family och #/family/<profil>) – för huvudkontot: vad barnprofilerna tittat och lyssnat på,
// tid per dag, mest sett, kvällstittande, vad som spelas just nu (med Stoppa) och dagens skärmtid med extra tid.
// Data från /api/parents* (server/routes/parents.js); skärmtiden ändras med /api/screentime/:uid som i Mitt konto.
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, fmtDur, imgSrc, later, main, onLeave, store, toast, views, t, tn, locale } from '../core.js';
import { screenDialog } from '../screentime.js';
import { familyProfileDialog } from '../familyprefs.js';
import { confirmDialog } from '../ui/dialog.js';
import { emptyState } from '../ui/states.js';
import { tabsHtml, bindTabs } from '../ui/tabs.js';
import { barChart } from './history.js';

const REFRESH = 30e3; // Spelas nu och skärmtiden uppdateras medan sidan är öppen
const dur = (s) => s >= 30 ? fmtDur(s) : '0 min'; // fmtDur avrundar till hela minuter (minst 1)
const clock = (ts) => new Date(ts * 1000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
const dayName = (d) => {
  const x = new Date(d + 'T12:00:00'), today = new Date(); today.setHours(12, 0, 0, 0);
  const diff = Math.round((today - x) / 86400e3);
  return diff === 0 ? t('Idag') : diff === 1 ? t('Igår') : x.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
};
const localDay = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Kort text om dagens skärmtid ("45 min kvar av 60", "Slut för idag") */
function screenLine(s) {
  if (!s) return t('Ingen skärmtid inställd');
  if (!s.allowed) return s.reason === 'limit' ? t('Tiden är slut för idag') : t('Utanför tillåten tid just nu');
  return s.left != null ? t('{left} kvar idag', { left: dur(s.left) }) : t('Ingen daglig gräns');
}
function nowHtml(list, name) {
  if (!list?.length) return `<p class="muted small">${t('{name} tittar inte på något just nu.', { name: esc(name) })}</p>`;
  return `<ul class="fam-now">${list.map(n => `<li><span class="fam-live" aria-hidden="true"></span><span><b>${esc(n.title)}</b>
    <span class="muted small">${[n.paused ? t('pausad') : t('spelas'), n.device ? esc(n.device) : '', n.remote ? t('utanför hemmet') : '',
      n.duration ? t('{pos} av {dur}', { pos: dur(n.position), dur: dur(n.duration) }) : ''].filter(Boolean).join(' · ')}</span></span></li>`).join('')}</ul>
    <button class="danger small" id="famstop">${t('Stoppa uppspelningen')}</button>`;
}
function screenHtml(s) {
  if (!s) return `<p class="muted small">${t('Ingen skärmtid är inställd. Ställ in minuter per dag och tillåtna klockslag så stoppas uppspelningen av sig själv på alla enheter.')}</p>`;
  const limit = s.daily != null ? (s.daily + s.extra) * 60 : null;
  const pct = limit ? Math.min(100, Math.round(s.used / limit * 100)) : null;
  return `<p class="fam-big${s.allowed ? '' : ' off'}">${esc(screenLine(s))}</p>
    ${pct != null ? `<div class="fam-meter${pct >= 90 ? ' low' : ''}" role="img" aria-label="${esc(t('{used} av {limit} använda', { used: dur(s.used), limit: dur(limit) }))}"><span style="width:${pct}%"></span></div>` : ''}
    <p class="muted small">${t('Använt idag: {used}', { used: dur(s.used) })}${s.extra ? ' · ' + t('{extra} min extra', { extra: s.extra }) : ''}${s.from || s.until ? ' · ' + t('Tillåten tid: {v}–{v2}.', { v: s.from || '00:00', v2: s.until || '24:00' }) : ''}</p>`;
}

views.family = async (arg) => {
  const D = await api('/parents');
  if (!D.owner) {
    main.innerHTML = emptyState({ icon: '👪', title: t('Föräldraöversikten finns i huvudkontot'), text: t('Byt till huvudkontot för att se vad barnprofilerna har tittat på och ändra deras skärmtid.'),
      action: { label: t('Byt profil'), href: '#/profiles', kind: 'ghost' } });
    return;
  }
  if (!D.kids.length) {
    main.innerHTML = `<h1 class="sr-only">${t('Föräldraöversikt')}</h1>` + emptyState({ icon: '🧸', title: t('Inga barnprofiler ännu'),
      text: t('Skapa en profil med åldersgräns under Mitt konto → Profiler. Här ser du sedan vad barnen tittat på, hur länge och när – och kan ge extra skärmtid eller stoppa en film på distans.'),
      action: { label: t('Till Mitt konto'), href: '#/account' } });
    return;
  }
  const kid = D.kids.find(k => k.id === +arg) || D.kids.find(k => k.id === store.get('family.kid')) || D.kids[0];
  store.set('family.kid', kid.id);
  let days = [7, 30].includes(store.get('family.days')) ? store.get('family.days') : 7;
  const tabs = D.kids.length > 1 ? tabsHtml({ id: 'famkids', label: t('Barn'), panel: 'fampanel', current: kid.id,
    items: D.kids.map(k => ({ key: k.id, href: `#/family/${k.id}`, label: `${k.name} · ${dur(k.today.video + k.today.audio)}` })) }) : '';
  main.innerHTML = `<div class="toolbar"><h1>${t('Föräldraöversikt')}</h1></div>
    <p class="muted fam-intro">${t('Vad barnen har tittat och lyssnat på och hur länge. Bara du som huvudkonto ser översikten.')}</p>
    ${tabs}<div id="fampanel"${tabs ? ' role="tabpanel"' : ''}>
    <div class="fam-top2">
      <section class="panel fam-card" aria-labelledby="famsth"><h2 id="famsth">${t('Skärmtid idag')}</h2><div id="famst"></div>
        <div class="row fam-ex"><button class="ghost small" data-ex="15">${t('+15 min')}</button><button class="ghost small" data-ex="30">${t('+30 min')}</button><button class="ghost small" data-ex="-15">${t('−15 min')}</button></div>
        <div class="row"><button class="small" id="famrules">${t('Ändra skärmtid…')}</button><button class="ghost small" id="famff">${t('Familjefilter…')}</button></div></section>
      <section class="panel fam-card" aria-labelledby="famnowh"><h2 id="famnowh">${t('Just nu')}</h2><div id="famnow"></div></section>
    </div>
    <div id="famdetail"></div></div>`;
  bindTabs($('#famkids'));

  let last = kid;
  const drawLive = (k) => {
    last = k;
    const n = $('#famnow'), s = $('#famst'); if (!n || !s) return;
    n.innerHTML = nowHtml(k.now, k.name);
    s.innerHTML = screenHtml(k.screen);
    $$('[data-ex]').forEach(b => b.hidden = !k.screen || (k.screen.daily == null && !k.screen.until));
    const stop = $('#famstop');
    if (stop) stop.onclick = act(async () => {
      if (!await confirmDialog(t('Stoppa det {name} tittar på nu?', { name: k.name }), { okLabel: t('Stoppa'), danger: true })) return;
      const r = await api(`/parents/${k.id}/stop`, { method: 'POST' });
      toast(r.stopped ? t('Uppspelningen stoppas inom några sekunder') : t('Inget spelades längre'));
      refresh();
    });
  };
  const refresh = async () => {
    const d = await api('/parents', { bg: true }).catch(() => null);
    const k = d?.kids?.find(x => x.id === kid.id);
    if (k && $('#famnow')) drawLive(k);
  };
  const tick = () => later(async () => { await refresh(); tick(); }, REFRESH);
  drawLive(kid); tick();
  $$('[data-ex]').forEach(b => b.onclick = act(async () => {
    await api(`/screentime/${kid.id}/extra`, { method: 'POST', body: { minutes: +b.dataset.ex } });
    toast(+b.dataset.ex > 0 ? t('{name} fick {n} min extra idag', { name: kid.name, n: +b.dataset.ex }) : t('Sparat'));
    await refresh();
  }));
  $('#famrules').onclick = act(async () => { await screenDialog({ id: kid.id, name: kid.name }); });
  $('#famff').onclick = act(async () => {
    const P = await api('/profiles');
    await familyProfileDialog(P.profiles.find(p => p.id === kid.id), () => {});
  });
  // Dialogen för skärmtid stänger inte vid sidbyte – läs om dagens läge när den stängts
  const onClose = (e) => { if (e.target.matches?.('dialog') && $('#famst')) refresh(); };
  document.addEventListener('close', onClose, true);
  onLeave(() => document.removeEventListener('close', onClose, true));

  const drawDetail = async () => {
    const box = $('#famdetail'); if (!box) return;
    const d = await api(`/parents/${kid.id}?days=${days}`);
    if (!$('#famdetail')) return;
    const T = d.totals;
    const byDay = new Map();
    for (const r of d.recent) { const k = localDay(r.ts); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(r); }
    const every = Math.max(1, Math.ceil(d.perDay.length / 10));
    box.innerHTML = `${tabsHtml({ id: 'famdays', label: t('Period'), panel: 'famper', current: days, items: [{ key: 7, label: t('7 dagar') }, { key: 30, label: t('30 dagar') }] })}
    <div id="famper" role="tabpanel">
    <div class="tiles fam-tiles">
      <div class="tile"><b>${esc(dur(T.video))}</b><span>${t('film och serier')}</span></div>
      <div class="tile"><b>${esc(dur(T.audio))}</b><span>${t('ljudböcker')}</span></div>
      <div class="tile"><b>${esc(dur(T.avgPerDay))}</b><span>${t('i snitt per dag')}</span></div>
      <div class="tile"><b>${T.titles}</b><span>${t('olika titlar')}</span></div>
      <div class="tile${T.late ? ' warn' : ''}"><b>${T.late}</b><span>${t('gånger efter kl. {h}', { h: d.lateHour })}</span></div>
      <div class="tile"><b>${T.remote}</b><span>${t('gånger utanför hemmet')}</span></div>
    </div>
    <section class="panel"><h2>${t('Tid per dag')}</h2>
      ${T.video + T.audio ? barChart(d.perDay, { val: (x) => x.video + x.audio, label: (x) => x.day.slice(8).replace(/^0/, ''), every, name: t('Tid per dag de senaste {n} dagarna', { n: days }),
        tip: Object.assign((x) => `${dayName(x.day)}: ${dur(x.video + x.audio)}${x.audio ? ` (${t('varav ljudböcker {v}', { v: dur(x.audio) })})` : ''}`, { max: (m) => dur(m) }) })
        : `<p class="muted">${t('{name} har inte tittat eller lyssnat på något under perioden.', { name: esc(d.name) })}</p>`}
      <ul class="sr-only">${d.perDay.map(x => `<li>${esc(dayName(x.day))}: ${esc(dur(x.video + x.audio))}</li>`).join('')}</ul></section>
    ${d.top.length ? `<section class="panel"><h2>${t('Mest sett')}</h2><ol class="fam-list">${d.top.map(x => {
      const max = d.top[0].seconds || 1, sub = [dur(x.seconds), x.kind === 'show' && x.episodes ? tn(x.episodes, '{n} avsnitt', '{n} avsnitt') : '', tn(x.plays, '{n} gång', '{n} gånger')].filter(Boolean).join(' · ');
      const img = x.item?.poster ? `<img loading="lazy" decoding="async" ${imgSrc(`/api/image/${+x.id}/poster`, 48)} alt="" width="48" height="72" data-fb="1">` : '<span class="fam-ph" aria-hidden="true"></span>';
      const inner = `${img}<span class="fam-txt"><span class="fam-t">${esc(x.title)}</span><span class="muted small">${esc(sub)}</span><span class="fam-bar" aria-hidden="true"><span style="width:${Math.max(3, Math.round(x.seconds / max * 100))}%"></span></span></span>`;
      return `<li>${x.item ? `<a class="fam-row" href="#/item/${+x.id}">${inner}</a>` : `<div class="fam-row">${inner}</div>`}</li>`;
    }).join('')}</ol></section>` : ''}
    ${d.books.length ? `<section class="panel"><h2>${t('Ljudböcker')}</h2><ol class="fam-list">${d.books.map(b => `<li><a class="fam-row" href="#/book/${+b.id}"><span class="fam-ph" aria-hidden="true">🎧</span><span class="fam-txt"><span class="fam-t">${esc(b.title)}</span><span class="muted small">${esc(dur(b.seconds))}</span></span></a></li>`).join('')}</ol></section>` : ''}
    <section class="panel"><h2>${t('Senast tittat')}</h2>
      ${d.recent.length ? [...byDay].map(([k, rows]) => `<h3 class="fam-day">${esc(dayName(k))}</h3><ul class="fam-hist">${rows.map(r => `<li>
        <span class="fam-clock">${esc(clock(r.ts))}</span>
        <span class="fam-txt"><span>${r.itemId ? `<a href="#/item/${+r.itemId}">${esc(r.title)}</a>` : esc(r.title)}${r.late ? ` <span class="warn-badge">${t('Sent')}</span>` : ''}${r.remote ? ` <span class="ok-badge">${t('Utanför hemmet')}</span>` : ''}</span>
          <span class="muted small">${[dur(r.played), r.percent != null ? t('{p} % sett', { p: r.percent }) : '', r.device ? esc(r.device) : ''].filter(Boolean).join(' · ')}</span></span>
</li>`).join('')}</ul>`).join('')
        : `<p class="muted">${t('Inget under perioden.')}</p>`}
      <p class="muted small">${t('Historiken sparas lika länge som tittarhistoriken (Administration → Tittarstatistik). Ljudböcker räknas per dag, musik räknas inte.')}</p></section></div>`;
    bindTabs($('#famdays'), (key) => { days = +key; store.set('family.days', days); drawDetail().then(() => $(`#famdays [data-tab-key="${days}"]`)?.focus()).catch(() => {}); });
  };
  await drawDetail();
};

