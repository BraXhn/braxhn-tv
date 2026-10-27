// Administration – drift: diskutrymme, snabbstart (startcache), import från Plex/Jellyfin, DLNA och Prometheus
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, later, toast } from '../core.js';
import { confirmDialog } from '../ui/dialog.js';
import { errorState, loadingState } from '../ui/states.js';

// ---------- Drift: diskutrymme, import från Plex/Jellyfin, DLNA och Prometheus ----------
const DISK_LEVEL = { ok: ['OK', 'ok-badge'], low: ['Lite plats', 'warn-badge'], critical: ['Nästan fullt', 'warn-badge'], unknown: ['', ''] };
const fmtGb = (b) => b >= 1e12 ? (b / 1e12).toFixed(1) + ' TB' : b >= 1e10 ? Math.round(b / 1e9) + ' GB' : (b / 1e9).toFixed(1) + ' GB';
export function diskTable(D) {
  if (!D?.at) return '<p class="muted small">Kontrolleras strax efter start.</p>';
  return `<table>${D.entries.map(e => {
    const [txt, cls] = DISK_LEVEL[e.level] || DISK_LEVEL.unknown;
    const used = e.total ? Math.min(100, Math.max(0, 100 - e.free / e.total * 100)) : 0;
    return `<tr><td>${esc(e.label)}<div class="muted small">${esc(e.path)}</div></td>
      <td>${e.error ? `<span class="muted small">${esc(e.error)}</span>` : `${fmtGb(e.free)} ledigt av ${fmtGb(e.total)} (${Math.round(e.free / e.total * 100)} %)<div class="prog"><i style="width:${used.toFixed(1)}%"></i></div>`}</td>
      <td class="r">${txt ? `<span class="${cls}">${txt}</span>` : ''}</td></tr>`;
  }).join('')}</table>`;
}
// Snabbstart: början av troliga titlar på cache-poolen så att filmen startar medan arraydisken vaknar
const fmtBytes = (b) => b >= 1e9 ? fmtGb(b) : Math.round(b / 1e6) + ' MB';
export function prestartHtml(P) {
  if (!P.dir) return `<p class="small">Ingen mapp vald. Fyll i <i>Snabbstart (startcache)</i> i Docker-mallen (Avancerad vy) med en mapp på cache-poolen, t.ex. <code>/mnt/cache/appdata/braxhn-tv/prestart</code>, eller sätt <code>PRESTART_DIR</code> – se README, <i>Snabbstart när diskarna sover</i>. Väckning av disken när en titelsida öppnas fungerar ändå${P.on ? '' : ' (avstängd)'}.</p>`;
  const pct = P.maxGb ? Math.min(100, P.used / (P.maxGb * 1e9) * 100) : 0;
  return `<div class="tiles"><div class="tile"><b>${esc(fmtBytes(P.used))}</b><span>av ${esc(String(P.maxGb).replace('.', ','))} GB</span></div>
    <div class="tile"><b>${+P.entries}</b><span>titlar</span></div>
    <div class="tile"><b>${P.hitRate == null ? '–' : esc(String(P.hitRate).replace('.', ',')) + ' %'}</b><span>träffgrad (${+P.hits} av ${+P.hits + +P.misses})</span></div>
    <div class="tile"><b>${+P.wakes}</b><span>väckningar</span></div></div>
    <div class="prog" style="margin-top:8px"><i style="width:${pct.toFixed(1)}%"></i></div>
    <p class="muted small">Mapp: <code>${esc(P.dir)}</code>${P.free != null ? ` · ${esc(fmtBytes(P.free))} ledigt` : ''} · ${+P.seconds} s av början per titel${P.running ? ' · <b>kopierar…</b>' : ''}${P.lastFill ? ` · senast: ${esc(P.lastFill.title)}` : ''}</p>
    ${P.error ? `<p class="err small">${esc(P.error)}</p>` : ''}
    ${P.items.length ? `<details><summary class="muted small">Cachade titlar (${+P.entries})</summary><table>${P.items.map(x => `<tr><td>${esc(x.title)}<div class="muted small">${esc(x.why)}</div></td><td class="r">${esc(fmtBytes(x.bytes))}</td></tr>`).join('')}</table></details>` : ''}`;
}
export async function adminOps() {
  if (!$('#opsp')) return;
  const [O, L, P] = await Promise.all([api('/ops'), api('/libraries'), api('/ops/prestart')]);
  const el = $('#opsp'); if (!el) return;
  // DLNA visar alla bibliotek (null) eller bara de valda (rättigheter för hela hemnätet – DLNA har ingen inloggning)
  const dlLibs = O.dlna.libraries;
  const dlLibOpts = L.map(l => `<label class="switch"><input type="checkbox" data-dllib="${+l.id}" ${dlLibs == null || dlLibs.includes(l.id) ? 'checked' : ''}> ${esc(l.name)}</label>`).join('');
  const userOpts = O.users.map(u => `<label class="switch"><input type="checkbox" data-impu="${+u.id}"> ${u.parent_id ? '&nbsp;&nbsp;↳ ' : ''}${esc(u.name)}</label>`).join('');
  el.innerHTML = `
  <div class="panel"><h2>Diskutrymme</h2>
    <p class="muted small">Ledigt utrymme kontrolleras var 5:e minut. Notis skickas när något går under gränsen (och högst en påminnelse per dygn) – kryssa i <i>Lågt diskutrymme</i> under Notiser. När omkodningsmappen nästan är full rensas inaktiva uppspelningar tidigare.</p>
    <div id="opdisk">${diskTable(O.disk)}</div>
    <form id="opdiskf"><div class="row" style="margin-top:10px"><div><label>Varna under (% ledigt)</label><input id="opdp" type="number" min="0" max="50" step="0.5" value="${esc(O.diskMinPct)}" style="width:110px"></div>
      <div><label>eller under (GB ledigt)</label><input id="opdg" type="number" min="0" step="1" value="${esc(O.diskMinGb)}" style="width:110px"></div>
      <button class="ghost">Spara</button><button type="button" class="ghost" id="opdchk">Kontrollera nu</button></div>
      <p class="muted small">0 stänger av gränsen. Kritiskt = under en fjärdedel av gränsen.</p></form>
  </div>
  <div class="panel"><h2>Snabbstart när diskarna sover ${P.active ? '<span class="ok-badge">På</span>' : ''}</h2>
    <p class="muted small">Arraydiskar som sover tar 5–15 s att snurra upp. Början av det som troligen spelas härnäst (Fortsätt titta, nästa avsnitt, nyligen tillagt) kopieras därför till snabb lagring, så att filmen startar direkt medan disken vaknar. Kopieringen sker bara när disken ändå är vaken. När en titelsida öppnas eller pekaren hamnar på Spela väcks disken i förväg.</p>
    <div id="opps">${prestartHtml(P)}</div>
    <form id="oppf"><div class="row" style="margin-top:10px"><label class="switch"><input type="checkbox" id="oppon" ${P.on ? 'checked' : ''}> Snabbstart på</label>
      ${P.dir ? `<div><label for="oppgb">Största storlek (GB)</label><input id="oppgb" type="number" min="0.1" max="10000" step="0.1" value="${esc(P.maxGb)}" style="width:110px"></div>` : ''}
      <button class="ghost">Spara</button>${P.dir ? '<button type="button" class="ghost" id="oppfill" title="Kopierar direkt och väcker diskarna">Fyll nu</button><button type="button" class="ghost" id="oppclr">Töm cachen</button>' : ''}</div></form>
  </div>
  <div class="panel"><h2>Importera tittarhistorik från Plex eller Jellyfin</h2>
    <p class="muted small">Hämtar vad som är sett och hur långt du kommit i påbörjade filmer och avsnitt och för in det på valda användare här. Titlar matchas i första hand på TMDB/IMDb/TVDB-id, sedan på filsökväg och sist på titel och år (serier: säsong och avsnitt). Inget ändras förrän du klickar på <i>Importera</i>.</p>
    <form id="impf"><div class="row"><div><label>Källa</label><select id="imps"><option value="plex">Plex</option><option value="jellyfin">Jellyfin / Emby</option></select></div>
      <div style="flex:2;min-width:220px"><label>Adress</label><input id="impu" placeholder="http://192.168.1.10:32400"></div></div>
      <div class="row" id="impplex"><div style="flex:1;min-width:220px"><label>X-Plex-Token <span class="muted small">(historiken för kontot som äger token)</span></label><input id="impt" type="password" autocomplete="off"></div></div>
      <div class="row" id="impjf" hidden><div style="flex:1;min-width:180px"><label>API-nyckel <span class="muted small">(Instrumentpanel → API-nycklar)</span></label><input id="impk" type="password" autocomplete="off"></div>
        <div style="flex:1;min-width:160px"><label>Användare i Jellyfin</label><select id="impjfu"><option value="">Hämta först…</option></select></div>
        <button type="button" class="ghost small" id="impjfl">Hämta användare</button></div>
      <label>Sökvägsmappning om filerna ligger på olika ställen (en per rad), t.ex. <code>/data/movies=/media/Filmer</code></label><textarea id="impm" rows="2" style="width:100%"></textarea>
      <div class="row" style="margin-top:12px"><button class="primary">Förhandsvisa</button></div></form>
    <div id="impres"></div>
  </div>
  <div class="panel"><h2>DLNA – smart-TV utan app ${O.dlna.enabled ? (O.dlna.running ? '<span class="ok-badge">Aktiv</span>' : O.dlna.error ? '<span class="warn-badge">Fel</span>' : '<span class="warn-badge">Startar</span>') : ''}</h2>
    <p class="muted small">Smart-TV, spelkonsoler och mediaspelare (VLC, Kodi) hittar biblioteket under <i>Medieservrar</i> och spelar filerna direkt, utan omkodning – formatet måste alltså stödjas av TV:n. <b>Ingen inloggning:</b> alla enheter på hemnätet kan se och spela det som visas här, därför finns en åldersgräns. Nås aldrig via omvänd proxy eller utifrån. I Docker krävs nätverkstypen <b>host</b> (eller macvlan/br0 med egen IP) för att TV:n ska hitta servern.</p>
    ${O.dlna.error ? `<p class="err small">${esc(O.dlna.error)}</p>` : ''}${O.dlna.running && O.dlna.addresses.length ? `<p class="muted small">Annonseras på ${esc(O.dlna.addresses.join(', '))}.</p>` : ''}
    <form id="dlnaf"><label class="switch"><input type="checkbox" id="dlen" ${O.dlna.enabled ? 'checked' : ''}> Dela biblioteket med DLNA</label>
      <div class="row"><div style="flex:1;min-width:180px"><label>Namn på TV:n</label><input id="dlname" value="${esc(O.dlna.name)}" maxlength="60"></div>
      <div><label>Högsta åldersgräns <span class="muted small">(tomt = som huvudkontot${O.dlna.effectiveMaxAge == null ? ': allt' : ''})</span></label><input id="dlage" value="${esc(O.dlna.maxAge)}" placeholder="t.ex. 11" style="width:140px"></div></div>
      ${L.length ? `<fieldset class="libpick"><legend>Bibliotek som visas</legend>${dlLibOpts}</fieldset>` : ''}
      <div class="row" style="margin-top:12px"><button class="primary">Spara</button></div></form>
  </div>
  <div class="panel"><h2>Prometheus-mätvärden ${O.metrics.enabled ? '<span class="ok-badge">På</span>' : ''}</h2>
    <p class="muted small"><code>GET /metrics</code> i Prometheus-format: uppspelningar, ffmpeg, skanning, bibliotek, inloggningsfel, tuners, inspelningar, diskutrymme och minne. Kräver <code>Authorization: Bearer &lt;token&gt;</code>; utan token är adressen avstängd.</p>
    ${O.metrics.fromEnv ? '<p class="small">En token är satt med miljövariabeln <code>METRICS_TOKEN</code>.</p>' : ''}
    <div class="row"><button type="button" class="ghost" id="mtnew">${O.metrics.enabled && !O.metrics.fromEnv ? 'Skapa ny token' : 'Skapa token'}</button>${O.metrics.enabled && !O.metrics.fromEnv ? '<button type="button" class="danger" id="mtoff">Stäng av</button>' : ''}</div>
    <div id="mttok"></div>
  </div>
  <div class="panel"><h2>Serverlogg</h2>
    <p class="muted small">De senaste händelserna i servern, även fel som uppstått i webbappen hos användarna. Sparas också som en fil per dag i <code>/config/logs</code> (sju dagar). Nycklar och lösenord maskeras.</p>
    <div class="row"><div><label for="lglvl">Visa</label><select id="lglvl"><option value="info">Allt</option><option value="warn">Varningar och fel</option><option value="error">Bara fel</option></select></div>
      <div style="flex:1;min-width:160px"><label for="lgq">Filtrera</label><input id="lgq" type="search" placeholder="t.ex. hls, ffmpeg, webb"></div>
      <a class="btn ghost" href="/api/logs/diagnostics" download>Ladda ner diagnostik</a></div>
    <pre id="lgout" class="logview small" tabindex="0" aria-label="Serverlogg"></pre>
  </div>`;

  // Loggen: hämtas när vyn öppnas och fylls på var 5:e sekund med nya rader
  let lastId = 0;
  const LV = { warn: 'lw', error: 'le' };
  const fmtLine = (l) => `<span class="${LV[l.level] || ''}">${esc(new Date(l.t).toLocaleTimeString('sv-SE'))} ${esc(l.msg)}</span>`;
  const loadLog = async (reset) => {
    const out = $('#lgout'); if (!out) return;
    if (reset) { lastId = 0; out.innerHTML = ''; }
    const r = await api(`/logs?level=${$('#lglvl').value}&q=${encodeURIComponent($('#lgq').value)}&after=${lastId}&limit=400`).catch(() => null);
    if (!r || !$('#lgout')) return;
    const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 20;
    if (r.lines.length) { out.querySelector(':scope > .muted')?.remove(); lastId = r.lines.at(-1).id; out.insertAdjacentHTML('beforeend', r.lines.map(fmtLine).join('\n') + '\n'); }
    while (out.childElementCount > 1500) out.firstElementChild.remove();
    if (!out.childElementCount) out.innerHTML = '<span class="muted">Inga rader.</span>';
    if (atEnd || reset) out.scrollTop = out.scrollHeight;
  };
  const tick = () => later(async () => { await loadLog(false); tick(); }, 5000);
  let qt = null;
  $('#lglvl').onchange = () => loadLog(true);
  $('#lgq').oninput = () => { clearTimeout(qt); qt = setTimeout(() => loadLog(true), 300); };
  loadLog(true).then(tick);

  const showDisk = (D) => { const d = $('#opdisk'); if (d) d.innerHTML = diskTable(D); };
  $('#opdiskf').onsubmit = act(async (e) => { e.preventDefault(); const r = await api('/ops', { method: 'PUT', body: { diskMinPct: $('#opdp').value, diskMinGb: $('#opdg').value } }); showDisk(r.disk); toast('Sparat'); });
  $('#opdchk').onclick = act(async () => showDisk(await api('/ops/disk/check', { method: 'POST' })));

  // Snabbstart
  const showPs = (R) => { const d = $('#opps'); if (d) d.innerHTML = prestartHtml(R); };
  $('#oppf').onsubmit = act(async (e) => {
    e.preventDefault();
    showPs(await api('/ops/prestart', { method: 'PUT', body: { on: $('#oppon').checked, ...($('#oppgb') ? { maxGb: $('#oppgb').value } : {}) } }));
    toast('Sparat');
  });
  const poll = () => later(async () => { const R = await api('/ops/prestart').catch(() => null); if (!R) return; showPs(R); if (R.running) poll(); }, 2000);
  if ($('#oppfill')) $('#oppfill').onclick = act(async () => { showPs(await api('/ops/prestart/fill', { method: 'POST' })); toast('Kopierar i bakgrunden'); poll(); });
  if ($('#oppclr')) $('#oppclr').onclick = act(async () => {
    if (!await confirmDialog('Tömma startcachen? Titlarna kopieras igen när diskarna är vakna.', { okLabel: 'Töm', danger: true })) return;
    showPs(await api('/ops/prestart/clear', { method: 'POST' })); toast('Cachen är tömd');
  });

  // Import
  const src = () => $('#imps').value;
  $('#imps').onchange = () => { $('#impplex').hidden = src() !== 'plex'; $('#impjf').hidden = src() === 'plex'; $('#impu').placeholder = src() === 'plex' ? 'http://192.168.1.10:32400' : 'http://192.168.1.10:8096'; };
  const fillJfUsers = (users) => { $('#impjfu').innerHTML = users.map(u => `<option value="${esc(u.name)}">${esc(u.name)}</option>`).join('') || '<option value="">Inga användare</option>'; };
  $('#impjfl').onclick = act(async () => fillJfUsers(await api('/import/users', { method: 'POST', body: { url: $('#impu').value, apiKey: $('#impk').value } })));
  $('#impf').onsubmit = async (e) => {
    e.preventDefault();
    const b = $('#impf button.primary'); b.disabled = true; b.textContent = 'Hämtar…';
    $('#impres').innerHTML = loadingState({ kind: 'inline', label: 'Hämtar tittarhistorik…' });
    try {
      const P = await api('/import/preview', { method: 'POST', body: { source: src(), url: $('#impu').value, token: $('#impt').value, apiKey: $('#impk').value, user: $('#impjfu').value, pathMap: $('#impm').value } });
      if (!$('#impres')) return;
      $('#impres').innerHTML = `<div class="tiles" style="margin-top:14px"><div class="tile"><b>${+P.total}</b><span>sedda/påbörjade</span></div><div class="tile"><b>${+P.matched}</b><span>matchade</span></div><div class="tile"><b>${+P.unmatched}</b><span>saknas här</span></div></div>
        <p class="muted small">Matchade på id: ${+P.byMethod.id} · filsökväg: ${+P.byMethod.path} · titel: ${+P.byMethod.title}. Att importera: ${+P.watched} sedda och ${+P.inProgress} påbörjade.</p>
        ${P.unmatchedSample.length ? `<details><summary class="muted small">Omatchade (${+P.unmatched}${P.unmatched > P.unmatchedSample.length ? `, visar ${P.unmatchedSample.length}` : ''})</summary><table>${P.unmatchedSample.map(u => `<tr><td>${esc(u.title)}</td><td class="muted small" style="word-break:break-all">${esc(u.path || '')}</td></tr>`).join('')}</table></details>` : ''}
        ${P.matched ? `<label style="margin-top:10px">För in på</label>${userOpts}
        <label class="switch"><input type="checkbox" id="impow"> Skriv över nyare positioner här (sedda titlar avmarkeras aldrig)</label>
        <div class="row" style="margin-top:10px"><button class="primary" id="imprun">Importera</button></div>` : ''}`;
      const run = $('#imprun');
      if (run) run.onclick = act(async () => {
        const users = $$('[data-impu]').filter(x => x.checked).map(x => +x.dataset.impu);
        if (!users.length) return toast('Välj minst en användare');
        run.disabled = true;
        try {
          const r = await api('/import/run', { method: 'POST', body: { id: P.id, users, overwrite: $('#impow').checked } });
          $('#impres').innerHTML = `<p class="ok-badge" style="display:inline-block;margin-top:12px">Klart: ${+r.watched} markerade som sedda, ${+r.progress} påbörjade, ${+r.skipped} oförändrade (${+r.users} användare).</p>`;
        } finally { if ($('#imprun')) run.disabled = false; }
      });
    } catch (er) {
      if (er.aborted) return;
      if ($('#impres')) $('#impres').innerHTML = errorState(er, { compact: true });
    } finally { b.disabled = false; b.textContent = 'Förhandsvisa'; }
  };

  // DLNA
  $('#dlnaf').onsubmit = act(async (e) => {
    e.preventDefault();
    const picked = $$('[data-dllib]').filter(b => b.checked).map(b => +b.dataset.dllib);
    // Alla ikryssade = alla bibliotek (även sådana som läggs till senare)
    const dlnaLibraries = picked.length === L.length ? null : picked;
    await api('/ops', { method: 'PUT', body: { dlnaEnabled: $('#dlen').checked, dlnaName: $('#dlname').value, dlnaMaxAge: $('#dlage').value, dlnaLibraries } });
    toast('Sparat'); later(adminOps, 1500);
  });

  // Prometheus
  $('#mtnew').onclick = act(async () => {
    if (O.metrics.enabled && !O.metrics.fromEnv && !await confirmDialog('Skapa ny token? Den gamla slutar gälla.', { okLabel: 'Skapa ny token', danger: true })) return;
    const r = await api('/ops', { method: 'PUT', body: { metricsToken: 'new' } });
    $('#mttok').innerHTML = `<p class="small" style="margin-top:10px">Ny token (visas bara nu – lägg in den i Prometheus):</p><input readonly id="mttokv" style="width:100%">
      <pre class="small muted" style="white-space:pre-wrap">scrape_configs:\n  - job_name: braxhn-tv\n    authorization:\n      credentials: &lt;token&gt;\n    static_configs:\n      - targets: ['${esc(location.host)}']</pre>`;
    $('#mttokv').value = r.token;
  });
  if ($('#mtoff')) $('#mtoff').onclick = act(async () => { if (!await confirmDialog('Stäng av /metrics?', { okLabel: 'Stäng av', danger: true })) return; await api('/ops', { method: 'PUT', body: { metricsToken: 'off' } }); toast('Avstängt'); await adminOps(); });
}
