// Reläets enkla admin: admintoken (sparas bara i fliken), parningskoder, status och borttagning av servrar
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtB = (b) => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' kB';
let token = sessionStorage.getItem('bxrelay') || '';

async function api(p, opts = {}) {
  const r = await fetch('/_relay/api/' + p, { ...opts, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || 'Fel ' + r.status);
  return b;
}
async function refresh() {
  try {
    const s = await api('status');
    $('#err').textContent = ''; $('#login').hidden = true; $('#app').hidden = false;
    $('#servers').innerHTML = s.servers.length ? s.servers.map(x => `<div class="card">
      <b>${esc(x.name)}</b> <span class="${x.connected ? 'ok' : 'bad'}">${x.connected ? '● ansluten' : '○ frånkopplad'}</span>
      <div>${x.hosts.length ? esc(x.hosts.join(', ')) : 'alla adresser (enda servern)'} · id ${esc(x.id)}</div>
      <div>${x.connected ? `sedan ${new Date(x.since).toLocaleString('sv-SE')} från ${esc(x.ip)} · ${x.active} pågående, ${x.requests} förfrågningar · ` : x.lastSeen ? `senast ${new Date(x.lastSeen).toLocaleString('sv-SE')} · ` : ''}
        ${fmtB(x.bytesFromHome)} ut, ${fmtB(x.bytesToHome)} in</div>
      <div class="row"><button class="danger" data-rm="${esc(x.id)}" aria-label="Ta bort ${esc(x.name)}">Ta bort</button></div></div>`).join('') : '<p>Inga servrar parade än.</p>';
    $('#meta').textContent = `Version ${s.version} · igång ${Math.round(s.uptime / 60)} min · minne ${fmtB(s.rss)}`;
    document.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Säker? Klicka igen'; return; }
      try { await api('servers/' + encodeURIComponent(b.dataset.rm), { method: 'DELETE' }); refresh(); } catch (e) { $('#err').textContent = e.message; }
    });
  } catch (e) {
    $('#err').textContent = token ? e.message : '';
    if (/token|avstängd/i.test(e.message)) { $('#login').hidden = false; $('#app').hidden = true; }
  }
}
$('#login').onsubmit = (e) => { e.preventDefault(); token = $('#tok').value.trim(); sessionStorage.setItem('bxrelay', token); refresh(); };
$('#newcode').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const c = await api('codes', { method: 'POST', body: JSON.stringify({ host: $('#host').value.trim() }) });
    const box = $('#code'); box.hidden = false;
    box.innerHTML = `<div>Parningskod (gäller till ${new Date(c.expires).toLocaleTimeString('sv-SE')}, en gång):</div><div class="code">${esc(c.code)}</div>
      <div>Ange den i BraXhn TV → Administration → Fjärråtkomst via relä, tillsammans med reläets adress <code>${esc(location.origin)}</code>.</div>`;
  } catch (er) { $('#err').textContent = er.message; }
};
if (token) refresh();
setInterval(() => { if (!$('#app').hidden) refresh(); }, 10000);
