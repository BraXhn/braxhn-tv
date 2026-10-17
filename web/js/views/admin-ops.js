// Administration – drift: diskutrymme, import från Plex/Jellyfin, DLNA och Prometheus
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
export async function adminOps() {
  if (!$('#opsp')) return;
  const O = await api('/ops');
  const el = $('#opsp'); if (!el) return;
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
      <div class="row" style="margin-top:12px"><button class="primary">Spara</button></div></form>
  </div>
  <div class="panel"><h2>Prometheus-mätvärden ${O.metrics.enabled ? '<span class="ok-badge">På</span>' : ''}</h2>
    <p class="muted small"><code>GET /metrics</code> i Prometheus-format: uppspelningar, ffmpeg, skanning, bibliotek, inloggningsfel, tuners, inspelningar, diskutrymme och minne. Kräver <code>Authorization: Bearer &lt;token&gt;</code>; utan token är adressen avstängd.</p>
    ${O.metrics.fromEnv ? '<p class="small">En token är satt med miljövariabeln <code>METRICS_TOKEN</code>.</p>' : ''}
    <div class="row"><button type="button" class="ghost" id="mtnew">${O.metrics.enabled && !O.metrics.fromEnv ? 'Skapa ny token' : 'Skapa token'}</button>${O.metrics.enabled && !O.metrics.fromEnv ? '<button type="button" class="danger" id="mtoff">Stäng av</button>' : ''}</div>
    <div id="mttok"></div>
  </div>`;

  const showDisk = (D) => { const d = $('#opdisk'); if (d) d.innerHTML = diskTable(D); };
  $('#opdiskf').onsubmit = act(async (e) => { e.preventDefault(); const r = await api('/ops', { method: 'PUT', body: { diskMinPct: $('#opdp').value, diskMinGb: $('#opdg').value } }); showDisk(r.disk); toast('Sparat'); });
  $('#opdchk').onclick = act(async () => showDisk(await api('/ops/disk/check', { method: 'POST' })));

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
    await api('/ops', { method: 'PUT', body: { dlnaEnabled: $('#dlen').checked, dlnaName: $('#dlname').value, dlnaMaxAge: $('#dlage').value } });
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
