// Vy: webhooks för händelser (#/webhooks = profilens egna, #/webhooks/server = serverns, administratören).
// Lägg till adresser (Home Assistant, Discord, ntfy, n8n …), välj händelser och format, testa och se senaste leveranserna.
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, fmtDate, main, me, toast, views, t } from '../core.js';
import { openDialog, confirmDialog } from '../ui/dialog.js';
import { emptyState } from '../ui/states.js';
import { route } from '../router.js';

function secretDialog(secret, name) {
  openDialog({
    title: t('Hemlig nyckel – {name}', { name }),
    body: `<p>${t('Med nyckeln kan mottagaren kontrollera att anropet kommer från BraXhn TV: rubriken <code>X-BraXhn-Signature</code> är\n      <code>sha256=</code> följt av HMAC-SHA256 av kroppen med nyckeln. <b>Nyckeln visas bara nu</b> – kopiera den om du vill kontrollera signaturen.')}</p>
      <p class="whsecret" id="whsec">${esc(secret)}</p>`,
    actions: [{ label: t('Kopiera'), kind: 'ghost', onClick: async () => { try { await navigator.clipboard.writeText(secret); toast(t('Kopierad')); } catch { toast(t('Markera och kopiera nyckeln själv')); } return false; } },
      { label: t('Klar'), kind: 'primary' }]
  });
}

function hookForm(M, server, h = null) {
  const ev = h?.events || ['media.play', 'media.stop'];
  return `<label for="whname">${t('Namn')}</label><input id="whname" maxlength="80" value="${esc(h?.name || '')}" placeholder="Home Assistant">
    <label for="whurl">${t('Adress')}</label><input id="whurl" type="url" maxlength="2000" ${h ? t('placeholder="{url} (oförändrad)"', { url: esc(h.url) }) : 'required placeholder="https://…"'}>
    <p class="muted small">${t('{v}Home Assistant: <code>http://homeassistant.local:8123/api/webhook/&lt;id&gt;</code> · Discord: kanalens webhook-adress · ntfy: <code>https://ntfy.sh/ditt-ämne</code>.', { v: h ? t('Lämna tomt för att behålla adressen (den visas inte i sin helhet eftersom den ofta innehåller en hemlig del). ') : '' })}</p>
    <label for="whfmt">Format</label><select id="whfmt">${Object.entries(M.formats).map(([k, t]) => `<option value="${k}" ${k === (h?.format || 'json') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
    <fieldset class="plain"><legend>${t('Skicka vid')}</legend>${Object.entries(M.events).map(([k, t]) => `<label class="switch"><input type="checkbox" data-wev="${k}" ${ev.includes(k) ? 'checked' : ''}> ${esc(t)} <span class="muted small">${k}</span></label>`).join('')}</fieldset>
    ${server ? `<label class="switch"><input type="checkbox" id="whlocal" ${h?.allowLocal ? 'checked' : ''}> ${t('Tillåt adress i hemnätet')}</label>
      <p class="muted small">${t('Behövs för t.ex. Home Assistant på hemnätet (192.168.x.x, 10.x.x.x). Som standard spärras lokala adresser så att en webhook inte kan användas för att nå andra apparater i nätet. Servern själv (127.0.0.1) och länklokala adresser spärras alltid. Slå bara på för adresser du litar på.')}</p>` : ''}
    ${h ? `<label class="switch"><input type="checkbox" id="whon" ${h.enabled ? 'checked' : ''}> ${t('På')}</label>` : ''}`;
}
function readForm(d, server, h) {
  const b = { name: d.$('#whname').value, url: d.$('#whurl').value.trim(), format: d.$('#whfmt').value, events: $$('[data-wev]', d.el).filter(x => x.checked).map(x => x.dataset.wev) };
  if (server) b.allowLocal = d.$('#whlocal').checked;
  if (h) b.enabled = d.$('#whon').checked;
  return b;
}

views.webhooks = async (scope) => {
  const server = scope === 'server';
  if (server && !me.adminHere) { location.hash = '#/webhooks'; return; }
  if (me.kid) { main.innerHTML = emptyState({ icon: '🔒', title: t('Inte tillgängligt i barnprofiler') }); return; }
  const base = server ? '/admin/webhooks' : '/webhooks';
  const D = await api(base);
  main.innerHTML = `<div id="whroot"><div class="toolbar"><h1>${server ? t('Webhooks för servern') : t('Mina webhooks')}</h1><button class="primary small" id="whadd">${t('Ny webhook')}</button>
    ${server ? t('<a class="btn small" href="#/playstats">Tittarstatistik</a>') : me.adminHere ? t('<a class="btn small" href="#/webhooks/server">Serverns webhooks</a>') : ''}</div>
    <div class="panel"><p class="muted small">${t('{v}\n      Varje anrop signeras (<code>X-BraXhn-Signature</code>) och misslyckade anrop försöks igen med ökande väntetid i upp till ett dygn.', { v: server
      ? t('Skickar händelser från hela servern – uppspelningar för alla profiler, nya titlar, skanningar, önskningar, inspelningar och nya versioner – som JSON till t.ex. Home Assistant, n8n eller egna skript, eller som meddelanden till Discord och ntfy.')
      : t('Skickar dina egna händelser – när du börjar, pausar, fortsätter och slutar titta och när något nytt kommer – till t.ex. Home Assistant (dimma ljuset när filmen startar), n8n, Discord eller ntfy. Adressen måste gå att nå via internet; adresser i hemnätet kan bara administratören tillåta.') })}</p>
    ${D.hooks.length ? `<div class="tablewrap"><table>${D.hooks.map(h => `<tr><td><b>${esc(h.name)}</b><div class="muted small">${esc(h.url)}</div></td>
      <td class="muted small">${h.events.map(e => esc(e)).join(', ')}<div>${esc(D.formats[h.format] || h.format)}${h.allowLocal ? t(' · hemnätet tillåtet') : ''}</div></td>
      <td>${!h.enabled ? t('<span class="muted small">Av</span>') : h.lastError ? `<span class="warn-badge" title="${esc(h.lastError)}">${t('Fel')}</span>` : h.lastOk ? '<span class="ok-badge">OK</span>' : ''}${h.queued ? `<div class="muted small">${t('{queued} i kö', { queued: h.queued })}</div>` : ''}</td>
      <td class="r"><button class="ghost small" data-test="${h.id}">${t('Testa')}</button> <button class="ghost small" data-edit="${h.id}">${t('Ändra')}</button>
        <button class="ghost small" data-sec="${h.id}">${t('Ny nyckel')}</button> <button class="danger small" data-rm="${h.id}">${t('Ta bort')}</button></td></tr>`).join('')}</table></div>`
      : emptyState({ compact: true, icon: '🔔', title: t('Inga webhooks ännu'), text: t('Lägg till en adress med Ny webhook.') })}</div>
    <div class="panel"><h2>${t('Senaste leveranser')}</h2>${D.log.length ? `<div class="tablewrap"><table>${D.log.map(l => `<tr><td class="muted small nowrap">${fmtDate(l.ts)}</td><td>${esc(l.hook)}</td><td class="muted small">${esc(l.event)}${l.attempt > 1 ? ` ${t('· försök {attempt}', { attempt: l.attempt })}` : ''}</td>
      <td>${l.ok ? '<span class="ok-badge">OK</span>' : t('<span class="warn-badge">Fel</span>')} <span class="muted small">${l.status || ''} ${l.ms != null ? l.ms + ' ms' : ''}</span>${l.error ? `<div class="muted small">${esc(l.error)}</div>` : ''}</td></tr>`).join('')}</table></div>` : t('<p class="muted">Inget skickat ännu.</p>')}</div>
    <details class="panel"><summary>${t('Så ser JSON-formatet ut')}</summary><pre class="small" style="white-space:pre-wrap">${esc(JSON.stringify({ event: 'media.play', ts: '2026-10-24T19:30:00.000Z', server: { name: 'BraXhn TV', version: '…' },
      user: { id: 2, name: 'anna' }, player: { device: 'Apple TV', ip: '192.168.1.20', local: true },
      metadata: { id: 812, type: 'episode', title: 'Pilot', year: 2008, show: 'Breaking Bad', showId: 800, season: 1, episode: 1, showTmdbId: 1396, tmdbId: 62085, library: { id: 2, name: t('Serier') }, duration: 3480, position: 0, progress: 0, resolution: '1080p' },
      playback: { mode: 'transcode', transcode: true, quality: '720', kbps: 4000, reasons: [t('ljudet (DTS)')] }, text: t('anna började titta på …') }, null, 2))}</pre></details></div>`;
  const edit = (h) => {
    const d = openDialog({ title: h ? t('Ändra {name}', { name: h.name }) : t('Ny webhook'), size: 'wide', form: true, body: hookForm(D, server, h),
      actions: [{ label: t('Avbryt') }, { label: h ? t('Spara') : t('Lägg till'), kind: 'primary', submit: true, onClick: async () => {
        const r = await api(h ? `${base}/${h.id}` : base, { method: h ? 'PUT' : 'POST', body: readForm(d, server, h) });
        if (!h) setTimeout(() => secretDialog(r.secret, r.name), 0);
        toast(h ? t('Sparat') : t('Webhooken är tillagd'));
      } }],
      onClose: (v) => { if (v !== 'route') route(); } });
  };
  $('#whadd').onclick = () => edit(null);
  $('#whroot').onclick = act(async (e) => {
    const b = e.target.closest('[data-test],[data-edit],[data-sec],[data-rm]'); if (!b) return;
    const h = D.hooks.find(x => String(x.id) === (b.dataset.test || b.dataset.edit || b.dataset.sec || b.dataset.rm));
    if (!h) return;
    if (b.dataset.edit) return edit(h);
    if (b.dataset.test) {
      b.disabled = true;
      try { const r = await api(`${base}/${h.id}/test`, { method: 'POST' }); toast(r.ok ? t('Testet gick fram ({status}, {ms} ms)', { status: r.status, ms: r.ms }) : t('Testet misslyckades: {error}', { error: r.error }), { error: !r.ok }); }
      finally { b.disabled = false; }
      return route();
    }
    if (b.dataset.sec) {
      if (!await confirmDialog(t('Den gamla nyckeln slutar gälla direkt. Mottagaren måste få den nya för att kunna kontrollera signaturen.'), { title: t('Byta hemlig nyckel?'), okLabel: t('Byt nyckel') })) return;
      const r = await api(`${base}/${h.id}/secret`, { method: 'POST' });
      return secretDialog(r.secret, h.name);
    }
    if (b.dataset.rm) {
      if (!await confirmDialog(t('Webhooken {name} och dess leveranslogg tas bort.', { name: h.name }), { title: t('Ta bort webhooken?'), okLabel: t('Ta bort'), danger: true })) return;
      await api(`${base}/${h.id}`, { method: 'DELETE' }); toast(t('Borttagen')); route();
    }
  });
};
