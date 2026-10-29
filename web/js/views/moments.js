// Vy: Ögonblick (#/moments och #/moments/<id>) – hushållets klipp ur filmer och avsnitt (sparade i spelaren med
// ✂ Ögonblick, server/moments.js). Flödet visar miniatyr, titel, vem och när, reaktioner och antal kommentarer; ett
// ögonblick öppnas med klippet, "Spela filmen härifrån", kommentarer och – för den som sparat det (inte barnprofiler)
// – länkar att dela utanför hemmet som slutar gälla och kan återkallas.
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, api, esc, fmtDate, fmtSize, later, main, me, routeGen, toast, toastErr, views, t, tn } from '../core.js';
import { confirmDialog, openDialog } from '../ui/dialog.js';
import { emptyState, errorState, bindRetry } from '../ui/states.js';
import { iconButton } from '../ui/buttons.js';
import { startPlay } from '../lazy.js';

const secs = (n) => String(Math.round(n * 10) / 10).replace('.', ',') + ' s';
const HOURS = { 1: () => t('1 timme'), 24: () => t('1 dygn'), 168: () => t('1 vecka'), 720: () => t('30 dagar') };
const stateText = (m) => m.state === 'pending' ? t('Klippet görs…') : m.state === 'failed' ? t('Klippet kunde inte göras: {e}', { e: m.error || '' }) : '';

function reactions(m) {
  return `<div class="mreacts" role="group" aria-label="${t('Reaktioner')}">${m.reactions.map(r =>
    `<button type="button" class="mreact${r.mine ? ' on' : ''}" data-react="${esc(r.emoji)}" data-mid="${m.id}" aria-pressed="${r.mine}"
      aria-label="${esc(t('Reagera med {e} ({n})', { e: r.emoji, n: r.n }))}"><span aria-hidden="true">${esc(r.emoji)}</span>${r.n ? `<span class="n" aria-hidden="true">${r.n}</span>` : ''}</button>`).join('')}</div>`;
}
function card(m) {
  const ready = m.state === 'ready';
  return `<article class="mcard" data-mid="${m.id}">
    <a class="mthumb" href="#/moments/${m.id}" aria-label="${esc(t('Öppna ögonblicket {title}', { title: m.title }))}">
      ${ready ? `<img src="/api/moments/${m.id}/thumb" alt="" loading="lazy" decoding="async" width="480" height="270" data-fb="1">` : ''}
      <span class="mdur">${ready ? secs(m.duration) : esc(stateText(m))}</span></a>
    <div class="minfo"><h2 class="mtitle"><a href="#/moments/${m.id}">${esc(m.title)}</a></h2>
      <p class="muted small">${esc(m.source)} · ${esc(m.by.name)} · ${fmtDate(m.created)}</p>
      ${reactions(m)}
      <a class="small" href="#/moments/${m.id}">${tn(m.comments, '{n} kommentar', '{n} kommentarer')}</a></div></article>`;
}

async function react(b, list) {
  const m = list.find(x => x.id === +b.dataset.mid); if (!m) return;
  try {
    const r = await api(`/moments/${m.id}/reactions`, { method: 'POST', body: { emoji: b.dataset.react } });
    m.reactions = r.reactions;
    const box = b.closest('.mreacts');
    box.outerHTML = reactions(m);
    $(`[data-mid="${m.id}"] [data-react="${CSS.escape(b.dataset.react)}"]`)?.focus();
  } catch (e) { toastErr(e); }
}

views.moments = async (id) => {
  if (!me) { location.hash = '#/login'; return; }
  if (id) return detail(+id);
  main.innerHTML = `<section class="moments"><h1>${t('Ögonblick')}</h1>
    <p class="muted">${t('Klipp som hushållet sparat i spelaren med ✂ Ögonblick. Bara ni i hushållet ser dem – och bara det era profiler får se.')}</p>
    <p class="muted small" id="mstore"></p><div id="mlist"></div><div id="mmore"></div></section>`;
  const box = $('#mlist'), g = routeGen;
  let list = [], more = false;
  const draw = (r) => {
    if (r) $('#mstore').textContent = t('Lagring: {used} av {max}', { used: fmtSize(r.storage.used), max: fmtSize(r.storage.max) });
    box.innerHTML = list.length ? `<div class="mgrid">${list.map(card).join('')}</div>`
      : emptyState({ icon: '✂', title: t('Inga ögonblick än'), text: t('Starta en film eller ett avsnitt, tryck på ✂ Ögonblick och välj de senaste 30 sekunderna eller en egen start och ett eget slut.') });
    $('#mmore').innerHTML = more ? `<button class="ghost" id="mmorebtn">${t('Visa fler')}</button>` : '';
    if (more) $('#mmorebtn').onclick = () => load(list[list.length - 1].id);
    // Ögonblick som görs: fråga igen om en stund
    if (list.some(m => m.state === 'pending')) later(() => load(null, true), 3000);
  };
  const load = async (before = null, refresh = false) => {
    let r;
    try { r = await api('/moments' + (before ? '?before=' + before : '')); }
    catch (e) { if (g !== routeGen || e?.aborted) return; box.innerHTML = errorState(e, { retry: true }); bindRetry(box, () => load()); return; }
    if (g !== routeGen) return;
    if (before) list.push(...r.moments); else if (refresh) { const keep = list.slice(r.moments.length); list = [...r.moments, ...keep.filter(m => !r.moments.some(x => x.id === m.id))]; } else list = r.moments;
    more = r.more;
    const f = document.activeElement?.closest?.('[data-react]') ? null : document.activeElement;
    draw(r);
    if (f && !f.isConnected) $('#mlist a')?.focus();
  };
  box.onclick = (e) => { const b = e.target.closest('[data-react]'); if (b) react(b, list); };
  await load();
};

async function detail(id) {
  const g = routeGen;
  let m;
  const load = async () => {
    try { m = await api('/moments/' + id); }
    catch (e) {
      if (g !== routeGen || e?.aborted) return;
      main.innerHTML = `<section class="moments"><h1>${t('Ögonblick')}</h1><div id="merr"></div></section>`;
      $('#merr').innerHTML = e.message === t('Finns inte') ? emptyState({ icon: '✂', title: t('Ögonblicket finns inte'), text: t('Det kan ha tagits bort, eller så får den här profilen inte se titeln.'), action: { label: t('Till Ögonblick'), href: '#/moments' } })
        : errorState(e, { retry: true });
      bindRetry($('#merr'), load);
      return;
    }
    if (g === routeGen) draw();
  };
  const draw = () => {
    const ready = m.state === 'ready';
    const shares = (m.shares || []).filter(s => !s.revoked && !s.expired);
    main.innerHTML = `<section class="moments mdetail"><p><a href="#/moments">${t('← Alla ögonblick')}</a></p><h1>${esc(m.title)}</h1>
      ${ready ? `<video id="mvid" src="/api/moments/${m.id}/video" poster="/api/moments/${m.id}/thumb" controls playsinline preload="metadata" aria-label="${esc(m.title)}"></video>`
        : `<p class="mpending" role="status">${esc(stateText(m))}</p>`}
      <p class="muted">${esc(m.source)} · ${secs(m.duration)} · ${t('sparat av {name}', { name: esc(m.by.name) })} · ${fmtDate(m.created)}${m.mode === 'copy' ? ' · ' + t('originalkvalitet') : ''}</p>
      <div class="row mactions">
        <button class="primary" id="mplay" data-play="0">${t('Spela filmen härifrån')}</button>
        ${m.canShare ? `<button class="ghost" id="mshare" aria-haspopup="dialog">${t('Dela utanför hemmet…')}</button>` : ''}
        ${m.canDelete ? `<button class="ghost danger" id="mdel">${t('Ta bort')}</button>` : ''}</div>
      ${reactions(m)}
      ${m.canShare && shares.length ? `<h2>${t('Delade länkar')}</h2><ul class="mshares">${shares.map(s => `<li>${t('Gäller till {d}', { d: fmtDate(s.expires) })} · ${tn(s.views, 'visad {n} gång', 'visad {n} gånger')}
        <button class="ghost small" data-revoke="${s.id}">${t('Återkalla')}</button></li>`).join('')}</ul>` : ''}
      <h2>${t('Kommentarer')}</h2>
      <ul class="mcomments">${m.commentList.map(c => `<li><b>${esc(c.by.name)}</b> <span class="muted small">${fmtDate(c.created)}</span>
        ${c.canDelete ? iconButton({ icon: '✕', label: t('Ta bort kommentaren'), data: { cdel: c.id } }) : ''}<p>${esc(c.text)}</p></li>`).join('') || `<li class="muted">${t('Inga kommentarer än')}</li>`}</ul>
      <form id="mcform" class="mcform"><label class="sr-only" for="mctext">${t('Skriv en kommentar')}</label>
        <textarea id="mctext" maxlength="500" rows="2" placeholder="${t('Skriv en kommentar')}" required></textarea><button class="primary" type="submit">${t('Skicka')}</button></form></section>`;
    if (m.state === 'pending') later(load, 3000);
    $('#mplay').onclick = (e) => { $('#mvid')?.pause(); startPlay(e.currentTarget, m.itemId, m.start); };
    $('.mreacts').onclick = (e) => { const b = e.target.closest('[data-react]'); if (b) react(b, [m]); };
    $('#mcform').onsubmit = async (e) => {
      e.preventDefault();
      const text = $('#mctext').value.trim(); if (!text) return;
      try { m = await api(`/moments/${m.id}/comments`, { method: 'POST', body: { text } }); draw(); $('#mctext').focus(); } catch (err) { toastErr(err); }
    };
    $$('[data-cdel]').forEach(b => b.onclick = async () => {
      if (!await confirmDialog(t('Ta bort kommentaren?'), { okLabel: t('Ta bort'), danger: true })) return;
      try { m = await api(`/moments/${m.id}/comments/${b.dataset.cdel}`, { method: 'DELETE' }); draw(); $('#mctext').focus(); } catch (err) { toastErr(err); }
    });
    $$('[data-revoke]').forEach(b => b.onclick = async () => {
      if (!await confirmDialog(t('Återkalla länken? Den slutar fungera direkt för alla som fått den.'), { okLabel: t('Återkalla'), danger: true })) return;
      try { m = await api(`/moments/${m.id}/shares/${b.dataset.revoke}`, { method: 'DELETE' }); draw(); toast(t('Länken är återkallad')); } catch (err) { toastErr(err); }
    });
    if ($('#mdel')) $('#mdel').onclick = async () => {
      if (!await confirmDialog(t('Ta bort ögonblicket ”{title}”? Kommentarer, reaktioner och delade länkar försvinner också.', { title: m.title }), { okLabel: t('Ta bort'), danger: true })) return;
      try { await api('/moments/' + m.id, { method: 'DELETE' }); toast(t('Ögonblicket är borttaget')); location.hash = '#/moments'; } catch (err) { toastErr(err); }
    };
    if ($('#mshare')) $('#mshare').onclick = () => shareDialog();
  };
  const shareDialog = () => {
    const d = openDialog({
      title: t('Dela utanför hemmet'), form: true,
      body: `<p class="muted small">${t('Den som får länken ser bara det här klippet – inget annat på servern. Länken slutar gälla efter vald tid och kan återkallas.')}</p>
        <div class="field"><label for="mhours">${t('Länken gäller')}</label><select id="mhours">${[1, 24, 168, 720].map(h => `<option value="${h}"${h === 24 ? ' selected' : ''}>${HOURS[h]()}</option>`).join('')}</select></div>
        <div class="field" id="murlbox" hidden><label for="murl">${t('Länk')}</label><input id="murl" readonly></div>`,
      actions: [{ label: t('Stäng'), value: null }, { label: t('Skapa länk'), kind: 'primary', submit: true, id: 'mmake',
        onClick: async (h) => {
          if (!h.$('#murlbox').hidden) { navigator.clipboard?.writeText(h.$('#murl').value).then(() => toast(t('Länken kopierad')), () => {}); return false; }
          const r = await api(`/moments/${m.id}/shares`, { method: 'POST', body: { hours: +h.$('#mhours').value } });
          h.$('#murlbox').hidden = false; h.$('#murl').value = r.url; h.$('#mhours').disabled = true;
          h.$('#mmake').textContent = t('Kopiera');
          h.$('#murl').focus(); h.$('#murl').select();
          return false;
        } }],
      onClose: () => { if (g === routeGen) load(); }
    });
    return d;
  };
  await load();
}
