// Vy: statistik och aktivitet (administratör)
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, fmtDate, later, main, me, toast, views, toastErr, t, locale } from '../core.js';
import { route } from '../router.js';
import { diskTable } from './admin-ops.js';
import { confirmDialog } from '../ui/dialog.js';
import { emptyState, errorState, loadingState } from '../ui/states.js';

views.stats = async () => {
  if (!me.adminHere) { location.hash = '#/'; return; }
  const [S, B, OF] = await Promise.all([api('/stats'), api('/backups'), api('/offsite')]);
  const L = S.library;
  const gb = (b) => b > 1e12 ? (b / 1e12).toFixed(1) + ' TB' : (b / 1e9).toFixed(0) + ' GB';
  const hrs = (x) => Math.round(x / 3600);
  const maxDay = Math.max(1, ...S.days.map(d => d.n));
  const modeName = { direct: t('Direkt'), remux: 'Remux', transcode: t('Omkodning') };
  main.innerHTML = `
  <div class="toolbar"><h1>${t('Statistik')}</h1><span class="muted">${t('Senaste 30 dagarna')}</span>${t('<a class="btn small" href="#/playstats">Tittarstatistik och historik</a><a class="btn small" href="#/wrapped/{v}">Årssammanfattning</a>', { v: new Date().getFullYear() })}</div>
  <div class="panel"><h2>${t('Spelas nu')} <span class="muted small" id="nowcount"></span></h2><div id="now">${loadingState({ kind: 'inline' })}</div></div>
  <div class="tiles">
    <div class="tile"><b>${L.movies}</b><span>${t('filmer')}</span></div><div class="tile"><b>${L.shows}</b><span>${t('serier')}</span></div>
    <div class="tile"><b>${L.episodes}</b><span>${t('avsnitt')}</span></div><div class="tile"><b>${gb(L.bytes)}</b><span>media</span></div>
    <div class="tile"><b>${hrs(L.seconds).toLocaleString(locale)} h</b><span>${t('speltid')}</span></div>
    <div class="tile"><b>${S.days.reduce((a, d) => a + d.n, 0)}</b><span>${t('uppspelningar')}</span></div>
  </div>
  <div class="panel"><h2>${t('Uppspelningar per dag')}</h2>
    <div class="bars">${S.days.map(d => `<div class="bar" title="${esc(d.day)}: ${d.n}"><i style="height:${Math.max(4, d.n / maxDay * 100)}%"></i><span>${esc(d.day.slice(8))}</span></div>`).join('') || t('<p class="muted">Inga uppspelningar ännu.</p>')}</div></div>
  <div class="grid2">
    <div class="panel"><h2>${t('Mest sett')}</h2><table>${S.top.map((t, i) => `<tr><td class="muted">${i + 1}</td><td><a href="#/item/${t.id}">${esc(t.title)}</a></td><td class="r">${t.plays} ggr · ${t.viewers} pers</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table></div>
    <div class="panel"><h2>${t('Användare')}</h2><table>${S.users.map(u => `<tr><td>${esc(u.name)}</td><td class="r">${t('{plays} uppspelningar · {watched_seconds} h sett', { plays: u.plays, watched_seconds: hrs(u.watched_seconds) })}</td></tr>`).join('')}</table></div>
    <div class="panel"><h2>${t('Uppspelningsläge')}</h2><table>${S.modes.map(m => `<tr><td>${esc(modeName[m.mode] || m.mode)}</td><td class="r">${m.n}</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table>
      <p class="muted small">${t('Remux och direktuppspelning belastar servern minst.')}</p></div>
    <div class="panel"><h2>${t('Enheter')}</h2><table>${S.devices.map(d => `<tr><td>${esc(d.device || '?')}</td><td class="r">${d.n}</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table></div>
  </div>
  ${S.disk?.at ? `<div class="panel"><h2>${t('Diskutrymme')}</h2>${diskTable(S.disk)}</div>` : ''}
  <div class="panel"><h2>${t('Senaste uppspelningar')}</h2><table>${S.recent.map(r => `<tr><td class="muted small">${fmtDate(r.ts)}</td><td>${esc(r.user)}</td><td>${esc(r.title)}</td><td class="muted small">${esc(modeName[r.mode] || r.mode || '')}${r.remote ? t(' · utifrån') : ''} · ${esc(r.device || '')}</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table></div>
  <div class="panel"><h2>${t('Säkerhetskopior')}</h2>
    <p class="muted small">${t('Databasen (konton, tittarhistorik, inställningar) kopieras automatiskt varje natt kl. 03 till <code>{dir}</code>. {keep} kopior sparas.', { dir: esc(B.dir), keep: B.keep })}</p>
    <div class="row" style="margin-bottom:10px"><label class="switch"><input type="checkbox" id="bken" ${B.enabled ? 'checked' : ''}> ${t('Automatisk säkerhetskopiering')}</label>
      <input id="bkkeep" aria-label="${t('Antal kopior att behålla')}" type="number" min="1" max="365" value="${B.keep}" style="width:90px"> <span class="muted small">${t('kopior')}</span>
      <button class="ghost small" id="bksave">${t('Spara')}</button><button class="primary small" id="bknow">${t('Säkerhetskopiera nu')}</button></div>
    <table>${B.files.map(f => `<tr><td>${esc(f.name)}</td><td class="muted small">${fmtDate(f.mtime)}</td><td class="muted small">${(f.size / 1e6).toFixed(1)} MB</td><td class="r">${t('<a class="btn small" href="/api/backups/{name}">Ladda ner</a>', { name: encodeURIComponent(f.name) })} <button class="ghost small" data-rlocal="${esc(f.name)}">${t('Återställ')}</button></td></tr>`).join('') || t('<tr><td class="muted">Inga kopior ännu.</td></tr>')}</table>
    ${OF.restorePending ? `<p class="warn-badge" style="display:inline-block;margin-top:10px">${t('En återställning väntar – starta om containern i Unraid för att använda den.')}</p> <button class="ghost small" id="rcancel">${t('Avbryt återställningen')}</button>` : ''}
  </div>
  <div class="panel"><h2>${t('Extern säkerhetskopia {v}', { v: OF.kind !== 'none' ? (OF.state.error ? t('<span class="warn-badge">Fel</span>') : OF.state.last ? '<span class="ok-badge">OK</span>' : '') : '' })}</h2>
    <p class="muted small">${t('Skickar en <b>krypterad</b> kopia av databasen varje natt efter den lokala – till en annan disk eller NAS (lägg till en sökvägsmappning i Unraid, t.ex. <code>/backup</code>) eller till S3-kompatibel molnlagring som Backblaze B2, Wasabi, Cloudflare R2, MinIO eller AWS. Ingen hos lagringstjänsten kan läsa kopian utan din lösenfras – och <b>inte du heller om du tappar bort den</b>.')}</p>
    <form id="ofform"><div class="row"><div><label for="ofk">${t('Mål')}</label><select id="ofk"><option value="none">${t('Av')}</option><option value="folder">${t('Mapp (annan disk/NAS)')}</option><option value="s3">${t('S3-kompatibel lagring')}</option></select></div>
      <div style="flex:1;min-width:200px"><label for="ofp">${t('Lösenfras (minst 12 tecken)')}</label><input id="ofp" type="password" autocomplete="new-password" placeholder="${OF.passSet ? t('•••••• (sparad)') : ''}"></div>
      <div><label for="ofkeep">${t('Antal kopior')}</label><input id="ofkeep" type="number" min="1" max="365" value="${OF.keep}" style="width:90px"></div></div>
      <div id="ofdir"><label for="ofd">${t('Mapp i containern')}</label><input id="ofd" value="${esc(OF.dir)}" placeholder="/backup"></div>
      <div id="ofs3"><div class="row"><div style="flex:2;min-width:220px"><label for="ofe">${t('Adress (endpoint)')}</label><input id="ofe" value="${esc(OF.endpoint)}" placeholder="https://s3.eu-central-003.backblazeb2.com"></div>
        <div style="flex:1;min-width:120px"><label for="ofr">Region</label><input id="ofr" value="${esc(OF.region)}"></div></div>
        <div class="row"><div style="flex:1;min-width:150px"><label for="ofb">Bucket</label><input id="ofb" value="${esc(OF.bucket)}"></div><div style="flex:1;min-width:150px"><label for="ofpre">${t('Mapp i bucketen')}</label><input id="ofpre" value="${esc(OF.prefix)}"></div></div>
        <div class="row"><div style="flex:1;min-width:180px"><label for="ofa">${t('Nyckel-id (access key)')}</label><input id="ofa" value="${esc(OF.accessKey)}" autocomplete="off"></div>
        <div style="flex:1;min-width:180px"><label for="ofs">${t('Hemlig nyckel')}</label><input id="ofs" type="password" autocomplete="off" placeholder="${OF.secretSet ? t('•••••• (sparad)') : ''}"></div></div>
        <label class="switch"><input type="checkbox" id="ofv" ${OF.vhost ? 'checked' : ''}> ${t('Bucket i värdnamnet (virtual-hosted – krävs av vissa tjänster)')}</label></div>
      <div class="row" style="margin-top:12px"><button class="ghost">${t('Spara')}</button><button type="button" class="ghost" id="oftest">${t('Testa anslutningen')}</button><button type="button" class="primary" id="ofrun">${t('Skicka en kopia nu')}</button></div></form>
    <p class="muted small">${OF.state.last ? t('Senast skickad ') + new Date(OF.state.last).toLocaleString(locale) + ' (' + esc(OF.state.lastName || '') + ')' : ''}${OF.state.error ? t(' · Fel: ') + esc(OF.state.error) : ''}</p>
    <div id="oflist"></div>
  </div>`;
  $('#ofk').value = OF.kind;
  const ofShow = () => { $('#ofdir').hidden = $('#ofk').value !== 'folder'; $('#ofs3').hidden = $('#ofk').value !== 's3'; };
  $('#ofk').onchange = ofShow; ofShow();
  const ofSave = () => {
    const body = { kind: $('#ofk').value, keep: $('#ofkeep').value, dir: $('#ofd').value, endpoint: $('#ofe').value, region: $('#ofr').value, bucket: $('#ofb').value, prefix: $('#ofpre').value, accessKey: $('#ofa').value, vhost: $('#ofv').checked };
    if ($('#ofp').value) body.passphrase = $('#ofp').value;
    if ($('#ofs').value) body.secretKey = $('#ofs').value;
    return api('/offsite', { method: 'PUT', body });
  };
  $('#ofform').onsubmit = async (e) => { e.preventDefault(); try { await ofSave(); toast(t('Sparat')); route(); } catch (er) { toastErr(er); } };
  $('#oftest').onclick = async () => { try { await ofSave(); await api('/offsite/test', { method: 'POST' }); toast(t('Anslutningen fungerar')); } catch (er) { toastErr(er); } };
  $('#ofrun').onclick = async () => { $('#ofrun').disabled = true; try { await ofSave(); const r = await api('/offsite/run', { method: 'POST' }); toast(t('Skickade ') + r.name); route(); } catch (er) { toastErr(er); $('#ofrun').disabled = false; } };
  const restore = async (body, label) => {
    if (!await confirmDialog(t('Allt som ändrats efter kopian (tittarhistorik, konton, inställningar) försvinner. Den nuvarande databasen sparas och återställningen sker när containern startas om.'), { title: t('Återställ {label}?', { label }), okLabel: t('Återställ'), danger: true })) return;
    try { await api('/restore', { method: 'POST', body }); toast(t('Klart – starta om containern i Unraid')); route(); } catch (e) { toastErr(e); }
  };
  $$('[data-rlocal]').forEach(b => b.onclick = () => restore({ local: b.dataset.rlocal }, b.dataset.rlocal));
  if ($('#rcancel')) $('#rcancel').onclick = act(async () => { await api('/restore', { method: 'DELETE' }); route(); });
  if (OF.kind !== 'none') api('/offsite/list').then(list => {
    if (!$('#oflist')) return;
    $('#oflist').innerHTML = list.length ? `<table>${list.map(f => `<tr><td>${esc(f.name)}</td><td class="muted small">${fmtDate(f.mtime)}</td><td class="muted small">${(f.size / 1e6).toFixed(1)} MB</td><td class="r"><button class="ghost small" data-rremote="${esc(f.name)}">${t('Återställ')}</button></td></tr>`).join('')}</table>` : t('<p class="muted small">Inga externa kopior ännu.</p>');
    $$('[data-rremote]').forEach(b => b.onclick = () => restore({ remote: b.dataset.rremote }, b.dataset.rremote));
  }).catch(e => { if (!e.aborted && $('#oflist')) $('#oflist').innerHTML = errorState(e, { compact: true }); });
  $('#bknow').onclick = async () => { try { const r = await api('/backups', { method: 'POST' }); toast(t('Skapade ') + r.name); route(); } catch (e) { toastErr(e); } };
  $('#bksave').onclick = act(async () => { await api('/settings', { method: 'PUT', body: { backupEnabled: $('#bken').checked, backupKeep: $('#bkkeep').value } }); toast(t('Sparat')); });
  // En enda uppdateringsslinga: nytt anrop avbryter den schemalagda och gamla svar ignoreras
  let nowSeq = 0, cancelNow = null;
  const loadNow = async () => {
    const seq = ++nowSeq;
    if (cancelNow) { cancelNow(); cancelNow = null; }
    try {
      const A = await api('/activity');
      if (seq !== nowSeq || !$('#now')) return;
      $('#nowcount').textContent = A.length ? `(${A.length})` : '';
      $('#now').innerHTML = A.length ? `<table>${A.map(a => `<tr><td><b>${esc(a.user)}</b><div class="muted small">${esc(a.device)} · ${esc(a.ip)}${a.remote ? t(' · utifrån') : ''}</div></td>
        <td>${esc(a.title)}<div class="prog" style="max-width:260px"><i style="width:${a.duration ? Math.min(100, a.position / a.duration * 100) : 0}%"></i></div></td>
        <td class="muted small">${esc(modeName[a.mode] || a.mode)}${a.quality && a.quality !== 'orig' ? ' · ' + esc(a.quality) + 'p' : ''}${a.paused ? t(' · pausad') : ''}<div>${esc((a.reasons || []).join(', '))}</div></td>
        <td class="r"><button class="danger small" data-stop="${esc(a.key)}">${t('Stoppa')}</button></td></tr>`).join('')}</table>` : emptyState({ compact: true, text: t('Ingen tittar just nu.') });
      $$('[data-stop]').forEach(b => b.onclick = act(async () => { if (await confirmDialog(t('Stoppa uppspelningen?'), { okLabel: t('Stoppa'), danger: true })) { await api(`/activity/${b.dataset.stop}/stop`, { method: 'POST' }); loadNow(); } }));
    } catch (e) { if (e?.aborted) return; }
    if (seq === nowSeq) cancelNow = later(loadNow, 5000);
  };
  loadNow();
};
