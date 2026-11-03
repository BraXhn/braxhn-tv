// @lazy – administration, drift: import av tittarhistorik från Plex (server eller databasfil) och Jellyfin/Emby,
// en rad per profil (koppla till en profil här, skapa ny/barnprofil eller hoppa över) och valfri löpande synk från Plex.
// Används av views/admin-ops.js. Token och PIN skickas bara till servern och visas aldrig igen.
import { $, $$, act, api, esc, fmtDate, toast, t } from '../core.js';
import { errorState, loadingState } from '../ui/states.js';

const KIND = { owner: () => t('Ägare'), home: () => t('Hemanvändare'), friend: () => t('Delad vän'), user: () => t('Konto') };
const AGES = [7, 11, 15];

export function importPanelHtml() {
  return `<div class="panel"><h2>${t('Importera tittarhistorik från Plex eller Jellyfin')}</h2>
    <p class="muted small">${t('Hämtar vad som är sett och hur långt varje profil kommit i påbörjade filmer och avsnitt. Titlar matchas i första hand på filsökväg och TMDB/IMDb/TVDB-id, sedan på mappnamn, titel och år (serier: filens säsong och avsnitt). Varje Plex-profil kopplas till en profil här eller skapas som ny. Inget ändras förrän du klickar på <i>Importera</i>, och nyare historik här skrivs inte över.')}</p>
    <form id="impf"><div class="row"><div><label for="imps">${t('Källa')}</label><select id="imps"><option value="plex">Plex</option><option value="jellyfin">Jellyfin / Emby</option></select></div>
      <div id="impmw"><label for="impmode">${t('Hämta från')}</label><select id="impmode"><option value="api">${t('Plex-servern (adress och token)')}</option><option value="db">${t('Plex databasfil (mest exakt)')}</option></select></div>
      <div style="flex:2;min-width:220px" id="impuw"><label for="impu">${t('Adress')}</label><input id="impu" placeholder="http://192.168.1.10:32400"></div></div>
      <div class="row" id="impplex"><div style="flex:1;min-width:220px"><label for="impt">X-Plex-Token <span class="muted small">${t('(ägarens token – hemanvändare och delade vänner hämtas också)')}</span></label><input id="impt" type="password" autocomplete="off"></div></div>
      <div id="impdb" hidden><label for="impdbp">${t('Sökväg till databasen i containern')}</label><input id="impdbp" style="width:100%" placeholder="/plex/Library/Application Support/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db">
        <p class="muted small">${t('Montera Plex appdata-mapp i Docker-mallen (gärna skrivskyddat, t.ex. <code>/mnt/user/appdata/plex</code> → <code>/plex</code>). Filen kopieras och läses skrivskyddat – Plex påverkas inte. Mappen räcker, filen letas upp.')}</p></div>
      <div class="row" id="impjf" hidden><div style="flex:1;min-width:180px"><label for="impk">${t('API-nyckel')} <span class="muted small">${t('(Instrumentpanel → API-nycklar)')}</span></label><input id="impk" type="password" autocomplete="off"></div>
        <div style="flex:1;min-width:160px"><label for="impjfu">${t('Användare i Jellyfin')}</label><select id="impjfu"><option value="">${t('Hämta först…')}</option></select></div>
        <button type="button" class="ghost small" id="impjfl">${t('Hämta användare')}</button></div>
      <label for="impm">${t('Sökvägsmappning om filerna ligger på olika ställen (en per rad), t.ex. <code>/data/movies=/media/Filmer</code>')}</label><textarea id="impm" rows="2" style="width:100%"></textarea>
      <div class="row" style="margin-top:12px"><button class="primary">${t('Förhandsvisa')}</button></div></form>
    <div id="impres"></div>
    <div id="impsync"></div>
  </div>`;
}

// Förvalt val per profil: sparad koppling → förslag (samma namn, ägaren = huvudkontot) → ny profil (hemanvändare) → hoppa över (vänner)
const defaultChoice = (p) => p.link ? (p.link.skip ? 'skip' : `link:${p.link.id}`) : p.suggest ? `link:${p.suggest.id}` : p.kind === 'friend' ? 'skip' : p.kid ? 'kid' : 'create';

function profileHtml(p, i, users) {
  const sel = defaultChoice(p);
  const opt = (v, label) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(label)}</option>`;
  const badges = [`<span class="ok-badge">${esc(KIND[p.kind]?.() || p.kind)}</span>`, p.kid ? `<span class="warn-badge">${t('Barn {v} år', { v: p.maxAge ?? '' })}</span>` : '',
    p.protected ? `<span class="warn-badge">PIN</span>` : ''].join(' ');
  const note = p.error ? `<p class="err small">${esc(p.error)}</p>`
    : p.needPin ? `<p class="small">${p.pinError ? t('<b>Fel PIN.</b> ') : ''}${t('Profilen har PIN i Plex. Ange den för att få med påbörjade titlar – utan PIN tas bara sedda titlar ur serverns historik.')}</p>
      <div class="row"><label for="imppin${i}" class="small">PIN</label><input id="imppin${i}" data-pin="${esc(p.key)}" type="password" inputmode="numeric" autocomplete="off" maxlength="12" style="width:110px"></div>`
    : p.partial ? `<p class="muted small">${t('Bara sedda titlar (Plex visar inte delade vänners påbörjade titlar).')}</p>` : '';
  return `<div class="impp" data-key="${esc(p.key)}" style="border-top:1px solid var(--line);padding:10px 0">
    <div class="row" style="justify-content:space-between"><div><b>${esc(p.name)}</b> ${badges}
      <div class="muted small">${t('{watched} sedda · {inProgress} påbörjade · {unmatched} saknas här', { watched: +p.watched, inProgress: +p.inProgress, unmatched: +p.unmatched })}</div></div>
      <div><label for="impa${i}" class="small">${t('Till profil')}</label><select id="impa${i}" data-act="${esc(p.key)}">
        ${users.map(u => opt(`link:${u.id}`, (u.parent_id ? '↳ ' : '') + t('Koppla till {name}', { name: u.name }))).join('')}
        ${opt('create', t('Skapa ny profil'))}${opt('kid', t('Skapa barnprofil'))}${opt('skip', t('Hoppa över'))}</select></div></div>
    <div class="row impnew" hidden style="margin-top:6px"><div style="flex:1;min-width:160px"><label for="impn${i}" class="small">${t('Namn på den nya profilen')}</label><input id="impn${i}" data-name="${esc(p.key)}" maxlength="40" value="${esc(p.name)}"></div>
      <div class="impage"><label for="impg${i}" class="small">${t('Åldersgräns')}</label><select id="impg${i}" data-age="${esc(p.key)}">${AGES.map(a => `<option value="${a}" ${a === (p.maxAge ?? 11) ? 'selected' : ''}>${t('{v} år', { v: a })}</option>`).join('')}</select></div></div>
    ${note}</div>`;
}

function syncHtml(S) {
  if (!S?.configured) return '';
  const res = S.result ? t('senast {at}: {watched} sedda och {progress} påbörjade på {profiles} profiler', { at: esc(fmtDate(S.result.at)), watched: +S.result.watched, progress: +S.result.progress, profiles: +S.result.profiles }) : '';
  return `<div style="border-top:1px solid var(--line);margin-top:14px;padding-top:10px"><h3>${t('Löpande synk från Plex {v}', { v: S.on ? t('<span class="ok-badge">På</span>') : '' })}</h3>
    <p class="muted small">${t('Hämtar bara det som ändrats i Plex sedan förra gången och för in det på de kopplade profilerna (envägs – inget skickas till Plex, inget här skrivs över). Källa: {src}.', { src: esc(S.mode === 'db' ? S.dbPath || '' : S.url || '') })}</p>
    ${S.error ? `<p class="err small">${esc(S.error)}</p>` : res ? `<p class="small">${res}</p>` : ''}
    ${S.links.length ? `<p class="muted small">${S.links.map(l => esc(l.name) + ' → ' + (l.userName ? esc(l.userName) : t('hoppas över'))).join(' · ')}</p>` : ''}
    <form id="impsf" class="row"><label class="switch"><input type="checkbox" id="impson" ${S.on ? 'checked' : ''}> ${t('Synka automatiskt')}</label>
      <div><label for="impsh" class="small">${t('var (timmar)')}</label><input id="impsh" type="number" min="1" max="168" value="${+S.hours}" style="width:90px"></div>
      <button class="ghost">${t('Spara')}</button><button type="button" class="ghost" id="impsnow" ${S.running ? 'disabled' : ''}>${t('Synka nu')}</button></form></div>`;
}

export function bindImport(O) {
  const src = () => $('#imps').value, mode = () => $('#impmode').value;
  const vis = () => {
    const plex = src() === 'plex', db = plex && mode() === 'db';
    $('#impmw').hidden = !plex; $('#impplex').hidden = !plex || db; $('#impdb').hidden = !db; $('#impjf').hidden = plex; $('#impuw').hidden = db;
    $('#impu').placeholder = plex ? 'http://192.168.1.10:32400' : 'http://192.168.1.10:8096';
  };
  $('#imps').onchange = vis; $('#impmode').onchange = vis;
  const fillJfUsers = (users) => { $('#impjfu').innerHTML = users.map(u => `<option value="${esc(u.name)}">${esc(u.name)}</option>`).join('') || t('<option value="">Inga användare</option>'); };
  $('#impjfl').onclick = act(async () => fillJfUsers(await api('/import/users', { method: 'POST', body: { url: $('#impu').value, apiKey: $('#impk').value } })));

  const showSync = async (S) => {
    S ||= await api('/import/sync').catch(() => null);
    const el = $('#impsync'); if (!el) return;
    el.innerHTML = syncHtml(S);
    if (!$('#impsf')) return;
    $('#impsf').onsubmit = act(async (e) => { e.preventDefault(); await showSync(await api('/import/sync', { method: 'PUT', body: { on: $('#impson').checked, hours: $('#impsh').value } })); toast(t('Sparat')); });
    $('#impsnow').onclick = act(async () => {
      $('#impsnow').disabled = true;
      try { const r = await api('/import/sync/run', { method: 'POST' }); await showSync(r); toast(r.ran?.busy ? t('Synken pågår redan') : t('Synkat: {watched} sedda, {progress} påbörjade', { watched: +r.ran.watched, progress: +r.ran.progress })); }
      finally { if ($('#impsnow')) $('#impsnow').disabled = false; }
    });
  };
  showSync();

  const pins = {};
  const doPreview = async () => {
    const b = $('#impf button.primary'); b.disabled = true; b.textContent = t('Hämtar…');
    $('#impres').innerHTML = loadingState({ kind: 'inline', label: t('Hämtar tittarhistorik…') });
    try {
      const P = await api('/import/preview', { method: 'POST', body: { source: src(), mode: mode(), url: $('#impu').value, token: $('#impt').value, apiKey: $('#impk').value,
        user: $('#impjfu').value, pathMap: $('#impm').value, dbPath: $('#impdbp').value, pins } });
      if ($('#impres')) render(P);
    } catch (er) {
      if (er.aborted) return;
      if ($('#impres')) $('#impres').innerHTML = errorState(er, { compact: true });
    } finally { b.disabled = false; b.textContent = t('Förhandsvisa'); }
  };
  $('#impf').onsubmit = (e) => { e.preventDefault(); doPreview(); };

  function render(P) {
    const plex = P.source === 'plex', anyMatched = P.profiles.length > 0; // även utan träffar: profilerna kan skapas
    $('#impres').innerHTML = `<div class="tiles" style="margin-top:14px"><div class="tile"><b>${+P.profiles.length}</b><span>${t('profiler')}</span></div><div class="tile"><b>${+P.total}</b><span>${t('sedda/påbörjade')}</span></div><div class="tile"><b>${+P.matched}</b><span>${t('matchade')}</span></div><div class="tile"><b>${+P.unmatched}</b><span>${t('saknas här')}</span></div></div>
      <p class="muted small">${t('Första profilen: matchade på filsökväg: {path} · id: {id} · mappnamn/titel: {title}.', { id: +P.byMethod.id, path: +P.byMethod.path, title: +P.byMethod.title })}</p>
      ${P.notes?.length ? P.notes.map(n => `<p class="muted small">${esc(n)}</p>`).join('') : ''}
      ${P.unmatchedSample.length ? `<details><summary class="muted small">${t('Omatchade ({unmatched}{v})', { unmatched: +P.unmatched, v: P.unmatched > P.unmatchedSample.length ? t(', visar {unmatchedSampleN}', { unmatchedSampleN: P.unmatchedSample.length }) : '' })}</summary><table>${P.unmatchedSample.map(u => `<tr><td>${esc(u.title)}</td><td class="muted small" style="word-break:break-all">${esc(u.path || '')}</td></tr>`).join('')}</table></details>` : ''}
      <div style="margin-top:10px">${P.profiles.map((p, i) => profileHtml(p, i, O.users)).join('')}</div>
      ${P.profiles.some(p => p.needPin) ? `<div class="row"><button type="button" class="ghost" id="imppins">${t('Hämta igen med PIN')}</button></div>` : ''}
      ${anyMatched ? `<label class="switch" style="margin-top:10px"><input type="checkbox" id="impow"> ${t('Skriv över nyare positioner här (sedda titlar avmarkeras aldrig)')}</label>
        ${plex ? `<div class="row"><label class="switch"><input type="checkbox" id="impsy"> ${t('Synka löpande från Plex')}</label><div><label for="impsyh" class="small">${t('var (timmar)')}</label><input id="impsyh" type="number" min="1" max="168" value="24" style="width:90px"></div></div>
          <p class="muted small">${t('Av som standard. Token sparas på servern bara medan synken är på.')}</p>` : ''}
        <div class="row" style="margin-top:10px"><button class="primary" id="imprun">${t('Importera')}</button></div>` : ''}`;
    // Namn och åldersgräns syns bara när en ny profil skapas
    const upd = (s) => { const box = s.closest('.impp'); box.querySelector('.impnew').hidden = !/^(create|kid)$/.test(s.value); box.querySelector('.impage').hidden = s.value !== 'kid'; };
    for (const s of $$('[data-act]')) { upd(s); s.onchange = () => upd(s); }
    if ($('#imppins')) $('#imppins').onclick = () => { for (const x of $$('[data-pin]')) if (x.value.trim()) pins[x.dataset.pin] = x.value.trim(); doPreview(); };
    const run = $('#imprun');
    if (run) run.onclick = act(async () => {
      const profiles = $$('[data-act]').map(s => {
        const key = s.dataset.act, v = s.value, box = s.closest('.impp');
        if (v.startsWith('link:')) return { key, action: 'link', userId: +v.slice(5) };
        if (v === 'skip') return { key, action: 'skip' };
        return { key, action: 'create', name: box.querySelector('[data-name]').value, maxAge: v === 'kid' ? +box.querySelector('[data-age]').value : null };
      });
      if (!profiles.some(p => p.action !== 'skip')) return toast(t('Välj minst en profil att importera till'));
      run.disabled = true;
      try {
        const r = await api('/import/run', { method: 'POST', body: { id: P.id, profiles, overwrite: $('#impow').checked, sync: plex ? { on: $('#impsy').checked, hours: $('#impsyh').value } : null } });
        $('#impres').innerHTML = `<p class="ok-badge" style="display:inline-block;margin-top:12px">${t('Klart: {watched} markerade som sedda, {progress} påbörjade, {skipped} oförändrade ({users} profiler).', { watched: +r.watched, progress: +r.progress, skipped: +r.skipped, users: +r.users })}</p>
          <ul class="small">${r.profiles.map(p => `<li>${esc(p.name)} → ${p.error ? `<span class="err">${esc(p.error)}</span>` : p.userName ? `${esc(p.userName)}${p.action === 'create' ? ` ${t('(ny profil)')}` : ''}: ${t('{watched} sedda, {progress} påbörjade', { watched: +p.watched, progress: +p.progress })}` : t('hoppas över')}</li>`).join('')}</ul>`;
        showSync();
      } finally { if ($('#imprun')) run.disabled = false; }
    });
  }
}
