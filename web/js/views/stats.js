// Vy: statistik och aktivitet (administratör)
import { $, $$, act, api, esc, fmtDate, later, main, me, toast, views } from '../core.js';
import { route } from '../router.js';
import { diskTable } from './admin-ops.js';

views.stats = async () => {
  if (!me.adminHere) { location.hash = '#/'; return; }
  const [S, B, OF] = await Promise.all([api('/stats'), api('/backups'), api('/offsite')]);
  const L = S.library;
  const gb = (b) => b > 1e12 ? (b / 1e12).toFixed(1) + ' TB' : (b / 1e9).toFixed(0) + ' GB';
  const hrs = (x) => Math.round(x / 3600);
  const maxDay = Math.max(1, ...S.days.map(d => d.n));
  const modeName = { direct: 'Direkt', remux: 'Remux', transcode: 'Omkodning' };
  main.innerHTML = `
  <div class="toolbar"><h1>Statistik</h1><span class="muted">Senaste 30 dagarna</span><a class="btn small" href="#/wrapped/${new Date().getFullYear()}">Årssammanfattning</a></div>
  <div class="panel"><h2>Spelas nu <span class="muted small" id="nowcount"></span></h2><div id="now"><div class="spin"></div></div></div>
  <div class="tiles">
    <div class="tile"><b>${L.movies}</b><span>filmer</span></div><div class="tile"><b>${L.shows}</b><span>serier</span></div>
    <div class="tile"><b>${L.episodes}</b><span>avsnitt</span></div><div class="tile"><b>${gb(L.bytes)}</b><span>media</span></div>
    <div class="tile"><b>${hrs(L.seconds).toLocaleString('sv-SE')} h</b><span>speltid</span></div>
    <div class="tile"><b>${S.days.reduce((a, d) => a + d.n, 0)}</b><span>uppspelningar</span></div>
  </div>
  <div class="panel"><h2>Uppspelningar per dag</h2>
    <div class="bars">${S.days.map(d => `<div class="bar" title="${esc(d.day)}: ${d.n}"><i style="height:${Math.max(4, d.n / maxDay * 100)}%"></i><span>${esc(d.day.slice(8))}</span></div>`).join('') || '<p class="muted">Inga uppspelningar ännu.</p>'}</div></div>
  <div class="grid2">
    <div class="panel"><h2>Mest sett</h2><table>${S.top.map((t, i) => `<tr><td class="muted">${i + 1}</td><td><a href="#/item/${t.id}">${esc(t.title)}</a></td><td class="r">${t.plays} ggr · ${t.viewers} pers</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table></div>
    <div class="panel"><h2>Användare</h2><table>${S.users.map(u => `<tr><td>${esc(u.name)}</td><td class="r">${u.plays} uppspelningar · ${hrs(u.watched_seconds)} h sett</td></tr>`).join('')}</table></div>
    <div class="panel"><h2>Uppspelningsläge</h2><table>${S.modes.map(m => `<tr><td>${esc(modeName[m.mode] || m.mode)}</td><td class="r">${m.n}</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table>
      <p class="muted small">Remux och direktuppspelning belastar servern minst.</p></div>
    <div class="panel"><h2>Enheter</h2><table>${S.devices.map(d => `<tr><td>${esc(d.device || '?')}</td><td class="r">${d.n}</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table></div>
  </div>
  ${S.disk?.at ? `<div class="panel"><h2>Diskutrymme</h2>${diskTable(S.disk)}</div>` : ''}
  <div class="panel"><h2>Senaste uppspelningar</h2><table>${S.recent.map(r => `<tr><td class="muted small">${fmtDate(r.ts)}</td><td>${esc(r.user)}</td><td>${esc(r.title)}</td><td class="muted small">${esc(modeName[r.mode] || r.mode || '')}${r.remote ? ' · utifrån' : ''} · ${esc(r.device || '')}</td></tr>`).join('') || '<tr><td class="muted">–</td></tr>'}</table></div>
  <div class="panel"><h2>Säkerhetskopior</h2>
    <p class="muted small">Databasen (konton, tittarhistorik, inställningar) kopieras automatiskt varje natt kl. 03 till <code>${esc(B.dir)}</code>. ${B.keep} kopior sparas.</p>
    <div class="row" style="margin-bottom:10px"><label class="switch"><input type="checkbox" id="bken" ${B.enabled ? 'checked' : ''}> Automatisk säkerhetskopiering</label>
      <input id="bkkeep" type="number" min="1" max="365" value="${B.keep}" style="width:90px"> <span class="muted small">kopior</span>
      <button class="ghost small" id="bksave">Spara</button><button class="primary small" id="bknow">Säkerhetskopiera nu</button></div>
    <table>${B.files.map(f => `<tr><td>${esc(f.name)}</td><td class="muted small">${fmtDate(f.mtime)}</td><td class="muted small">${(f.size / 1e6).toFixed(1)} MB</td><td class="r"><a class="btn small" href="/api/backups/${encodeURIComponent(f.name)}">Ladda ner</a> <button class="ghost small" data-rlocal="${esc(f.name)}">Återställ</button></td></tr>`).join('') || '<tr><td class="muted">Inga kopior ännu.</td></tr>'}</table>
    ${OF.restorePending ? `<p class="warn-badge" style="display:inline-block;margin-top:10px">En återställning väntar – starta om containern i Unraid för att använda den.</p> <button class="ghost small" id="rcancel">Avbryt återställningen</button>` : ''}
  </div>
  <div class="panel"><h2>Extern säkerhetskopia ${OF.kind !== 'none' ? (OF.state.error ? '<span class="warn-badge">Fel</span>' : OF.state.last ? '<span class="ok-badge">OK</span>' : '') : ''}</h2>
    <p class="muted small">Skickar en <b>krypterad</b> kopia av databasen varje natt efter den lokala – till en annan disk eller NAS (lägg till en sökvägsmappning i Unraid, t.ex. <code>/backup</code>) eller till S3-kompatibel molnlagring som Backblaze B2, Wasabi, Cloudflare R2, MinIO eller AWS. Ingen hos lagringstjänsten kan läsa kopian utan din lösenfras – och <b>inte du heller om du tappar bort den</b>.</p>
    <form id="ofform"><div class="row"><div><label>Mål</label><select id="ofk"><option value="none">Av</option><option value="folder">Mapp (annan disk/NAS)</option><option value="s3">S3-kompatibel lagring</option></select></div>
      <div style="flex:1;min-width:200px"><label>Lösenfras (minst 12 tecken)</label><input id="ofp" type="password" autocomplete="new-password" placeholder="${OF.passSet ? '•••••• (sparad)' : ''}"></div>
      <div><label>Antal kopior</label><input id="ofkeep" type="number" min="1" max="365" value="${OF.keep}" style="width:90px"></div></div>
      <div id="ofdir"><label>Mapp i containern</label><input id="ofd" value="${esc(OF.dir)}" placeholder="/backup"></div>
      <div id="ofs3"><div class="row"><div style="flex:2;min-width:220px"><label>Adress (endpoint)</label><input id="ofe" value="${esc(OF.endpoint)}" placeholder="https://s3.eu-central-003.backblazeb2.com"></div>
        <div style="flex:1;min-width:120px"><label>Region</label><input id="ofr" value="${esc(OF.region)}"></div></div>
        <div class="row"><div style="flex:1;min-width:150px"><label>Bucket</label><input id="ofb" value="${esc(OF.bucket)}"></div><div style="flex:1;min-width:150px"><label>Mapp i bucketen</label><input id="ofpre" value="${esc(OF.prefix)}"></div></div>
        <div class="row"><div style="flex:1;min-width:180px"><label>Nyckel-id (access key)</label><input id="ofa" value="${esc(OF.accessKey)}" autocomplete="off"></div>
        <div style="flex:1;min-width:180px"><label>Hemlig nyckel</label><input id="ofs" type="password" autocomplete="off" placeholder="${OF.secretSet ? '•••••• (sparad)' : ''}"></div></div>
        <label class="switch"><input type="checkbox" id="ofv" ${OF.vhost ? 'checked' : ''}> Bucket i värdnamnet (virtual-hosted – krävs av vissa tjänster)</label></div>
      <div class="row" style="margin-top:12px"><button class="ghost">Spara</button><button type="button" class="ghost" id="oftest">Testa anslutningen</button><button type="button" class="primary" id="ofrun">Skicka en kopia nu</button></div></form>
    <p class="muted small">${OF.state.last ? 'Senast skickad ' + new Date(OF.state.last).toLocaleString('sv-SE') + ' (' + esc(OF.state.lastName || '') + ')' : ''}${OF.state.error ? ' · Fel: ' + esc(OF.state.error) : ''}</p>
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
  $('#ofform').onsubmit = async (e) => { e.preventDefault(); try { await ofSave(); toast('Sparat'); route(); } catch (er) { toast(er.message); } };
  $('#oftest').onclick = async () => { try { await ofSave(); await api('/offsite/test', { method: 'POST' }); toast('Anslutningen fungerar'); } catch (er) { toast(er.message); } };
  $('#ofrun').onclick = async () => { $('#ofrun').disabled = true; try { await ofSave(); const r = await api('/offsite/run', { method: 'POST' }); toast('Skickade ' + r.name); route(); } catch (er) { toast(er.message); $('#ofrun').disabled = false; } };
  const restore = async (body, label) => {
    if (!confirm(`Återställ ${label}? Allt som ändrats efter kopian (tittarhistorik, konton, inställningar) försvinner. Den nuvarande databasen sparas och återställningen sker när containern startas om.`)) return;
    try { await api('/restore', { method: 'POST', body }); toast('Klart – starta om containern i Unraid'); route(); } catch (e) { toast(e.message); }
  };
  $$('[data-rlocal]').forEach(b => b.onclick = () => restore({ local: b.dataset.rlocal }, b.dataset.rlocal));
  if ($('#rcancel')) $('#rcancel').onclick = act(async () => { await api('/restore', { method: 'DELETE' }); route(); });
  if (OF.kind !== 'none') api('/offsite/list').then(list => {
    if (!$('#oflist')) return;
    $('#oflist').innerHTML = list.length ? `<table>${list.map(f => `<tr><td>${esc(f.name)}</td><td class="muted small">${fmtDate(f.mtime)}</td><td class="muted small">${(f.size / 1e6).toFixed(1)} MB</td><td class="r"><button class="ghost small" data-rremote="${esc(f.name)}">Återställ</button></td></tr>`).join('')}</table>` : '<p class="muted small">Inga externa kopior ännu.</p>';
    $$('[data-rremote]').forEach(b => b.onclick = () => restore({ remote: b.dataset.rremote }, b.dataset.rremote));
  }).catch(e => { if (!e.aborted && $('#oflist')) $('#oflist').innerHTML = `<p class="err small">${esc(e.message)}</p>`; });
  $('#bknow').onclick = async () => { try { const r = await api('/backups', { method: 'POST' }); toast('Skapade ' + r.name); route(); } catch (e) { toast(e.message); } };
  $('#bksave').onclick = act(async () => { await api('/settings', { method: 'PUT', body: { backupEnabled: $('#bken').checked, backupKeep: $('#bkkeep').value } }); toast('Sparat'); });
  // En enda uppdateringsslinga: nytt anrop avbryter den schemalagda och gamla svar ignoreras
  let nowSeq = 0, cancelNow = null;
  const loadNow = async () => {
    const seq = ++nowSeq;
    if (cancelNow) { cancelNow(); cancelNow = null; }
    try {
      const A = await api('/activity');
      if (seq !== nowSeq || !$('#now')) return;
      $('#nowcount').textContent = A.length ? `(${A.length})` : '';
      $('#now').innerHTML = A.length ? `<table>${A.map(a => `<tr><td><b>${esc(a.user)}</b><div class="muted small">${esc(a.device)} · ${esc(a.ip)}${a.remote ? ' · utifrån' : ''}</div></td>
        <td>${esc(a.title)}<div class="prog" style="max-width:260px"><i style="width:${a.duration ? Math.min(100, a.position / a.duration * 100) : 0}%"></i></div></td>
        <td class="muted small">${esc(modeName[a.mode] || a.mode)}${a.quality && a.quality !== 'orig' ? ' · ' + esc(a.quality) + 'p' : ''}${a.paused ? ' · pausad' : ''}<div>${esc((a.reasons || []).join(', '))}</div></td>
        <td class="r"><button class="danger small" data-stop="${esc(a.key)}">Stoppa</button></td></tr>`).join('')}</table>` : '<p class="muted">Ingen tittar just nu.</p>';
      $$('[data-stop]').forEach(b => b.onclick = act(async () => { if (confirm('Stoppa uppspelningen?')) { await api(`/activity/${b.dataset.stop}/stop`, { method: 'POST' }); loadNow(); } }));
    } catch (e) { if (e?.aborted) return; }
    if (seq === nowSeq) cancelNow = later(loadNow, 5000);
  };
  loadNow();
};
