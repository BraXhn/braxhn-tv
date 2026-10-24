// Vy: administration
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, act, api, esc, fmtDate, keyClick, later, main, me, toast, views, toastErr } from '../core.js';
import { boot, loadLibs, route } from '../router.js';
import { EVENTS } from './account.js';
import { adminOps } from './admin-ops.js';
import { confirmDialog, promptDialog } from '../ui/dialog.js';
import { emptyState, errorState } from '../ui/states.js';

views.admin = async () => {
  if (!me.is_admin) { location.hash = '#/'; return; }
  if (!me.adminHere) { main.innerHTML = emptyState({ icon: '🔒', title: 'Administration är spärrad härifrån', text: 'Av säkerhetsskäl kan servern bara administreras från hemnätverket eller via VPN (t.ex. NetBird).' }); return; }
  const [IN, LT, L, U, S, SC, AU, AC, NO, UP] = await Promise.all([api('/integrations'), api('/live/tuners'), api('/libraries'), api('/users'), api('/settings'), api('/security-check'), api('/audit?limit=60'), api('/acme'), api('/notify'), api('/updates')]);
  const lvl = { ok: '✓', info: 'ℹ', warn: '!', bad: '✕' };
  main.innerHTML = `
  <div class="panel"><h2>Säkerhetskontroll</h2>
    <div class="checks">${SC.map(i => `<div class="check ${i.level}"><span class="dot">${lvl[i.level]}</span><div><b>${esc(i.title)}</b>${i.detail ? `<div class="muted small">${esc(i.detail)}</div>` : ''}</div></div>`).join('')}</div>
  </div>
  <div class="panel"><h2>Bibliotek</h2>
    <table><tr><th>Namn</th><th>Typ</th><th>Mapp</th><th>Titlar</th><th></th></tr>
    ${L.map(l => `<tr><td>${esc(l.name)}</td><td>${{ movie: 'Filmer', show: 'Serier', music: 'Musik', audiobook: 'Ljudböcker' }[l.type]}${l.type === 'show' ? ` <label class="small muted" title="Absolut avsnittsnumrering (t.ex. One Piece - 1071) mappas till säsonger"><input type="checkbox" data-anime="${l.id}" ${l.anime ? 'checked' : ''}> anime</label>` : ''}</td><td class="muted">${esc(l.path)}</td><td>${l.count}</td>
      <td class="r"><button class="ghost small" data-scan="${l.id}">Skanna</button> <button class="danger small" data-del="${l.id}">Ta bort</button></td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">Inga bibliotek ännu.</td></tr>'}</table>
    <div id="scanst" class="muted" style="margin-top:12px"></div>
    <h3 style="margin:22px 0 4px;font-size:15px">Lägg till bibliotek</h3>
    <form id="addlib"><div class="row"><div style="flex:1;min-width:180px"><label>Namn</label><input id="ln" placeholder="Filmer" required></div>
      <div><label>Typ</label><select id="lt"><option value="movie">Filmer</option><option value="show">Serier</option><option value="music">Musik</option><option value="audiobook">Ljudböcker</option></select></div></div>
      <label class="switch" id="lanimew" hidden><input type="checkbox" id="lanime"> Anime (absolut avsnittsnumrering som "Serie - 1071" mappas till säsonger)</label>
      <label>Mapp (under ${esc(S.mediaRoot)})</label><input id="lp" value="${esc(S.mediaRoot)}" required>
      <div class="fsb" id="fsb"></div>
      <div class="row" style="margin-top:14px"><button class="primary">Lägg till och skanna</button><button type="button" class="ghost" id="scanall">Skanna alla nu</button></div></form>
  </div>
  <div class="panel"><h2>Användare</h2>
    <table><tr><th>Namn</th><th>Roll</th><th>2FA</th><th>Utanför hemmet</th><th>Senast aktiv</th><th></th></tr>
    ${U.map(u => `<tr><td>${esc(u.name)}</td><td>${u.is_admin ? 'Admin' : 'Användare'}</td>
      <td>${u.totp_enabled ? '<span class="ok-badge">På</span>' : '<span class="warn-badge">Av</span>'}</td>
      <td><label class="switch"><input type="checkbox" data-remote="${u.id}" ${u.remote_allowed ? 'checked' : ''}> Tillåten</label></td>
      <td class="muted small">${fmtDate(u.last_seen)}</td>
      <td class="r"><button class="ghost small" data-pw="${u.id}">Nytt lösenord</button>
      ${u.totp_enabled && u.id !== me.id ? `<button class="ghost small" data-r2fa="${u.id}">Återställ 2FA</button>` : ''}
      <button class="ghost small" data-lout="${u.id}">Logga ut överallt</button>
      ${u.id !== me.id ? `<button class="ghost small" data-adm="${u.id}" data-v="${u.is_admin ? 0 : 1}">${u.is_admin ? 'Ta bort admin' : 'Gör till admin'}</button>
      <button class="danger small" data-udel="${u.id}">Ta bort</button>` : ''}</td></tr>`).join('')}</table>
    <form id="adduser" class="row" style="margin-top:14px;align-items:flex-end">
      <div style="flex:1;min-width:140px"><label>Namn</label><input id="un" required maxlength="64"></div>
      <div style="flex:1;min-width:140px"><label>Lösenord (minst 10 tecken)</label><input id="up" type="password" minlength="10" required autocomplete="new-password"></div>
      <label style="display:flex;gap:6px;align-items:center;margin:0 0 10px"><input type="checkbox" id="ua"> Admin</label>
      <label style="display:flex;gap:6px;align-items:center;margin:0 0 10px"><input type="checkbox" id="ur" checked> Får titta utanför hemmet</label>
      <button class="primary">Lägg till</button></form>
  </div>
  <div class="panel"><h2>Säkerhet</h2><form id="secform">
    <label class="switch"><input type="checkbox" id="s2fa" ${S.require2faRemote ? 'checked' : ''}> Kräv tvåstegsverifiering för inloggning utanför hemmet</label>
    <label class="switch"><input type="checkbox" id="sqc" ${S.quickConnect !== false ? 'checked' : ''}> Tillåt inloggning med kod på TV (en inloggad användare godkänner koden från mobilen)</label>
    <label class="switch"><input type="checkbox" id="sadm" ${S.adminAnywhere ? 'checked' : ''} ${S.youAreLocal ? '' : 'disabled'}> Tillåt administration från internet <span class="muted">(rekommenderas inte)</span></label>
    <label class="switch"><input type="checkbox" id="svpn" ${S.trustVpnRange ? 'checked' : ''} ${S.youAreLocal ? '' : 'disabled'}> Räkna VPN-nätet 100.64.0.0/10 (NetBird/Tailscale) som hemma <span class="muted">(behövs normalt inte om VPN:et routas via routern)</span></label>
    <label>Extra betrodda nät utöver hemnätet, t.ex. 10.8.0.0/24 (minst /16)</label><input id="stn" value="${esc(S.trustedNetworks)}" placeholder="kommaseparerade CIDR">
    <label class="switch"><input type="checkbox" id="sunr" ${S.allowUnrated ? 'checked' : ''}> Barnprofiler får se titlar utan känd åldersgräns</label>
    <label class="switch"><input type="checkbox" id="strick" ${S.trickplay ? 'checked' : ''}> Skapa förhandsbilder för spolning (kräver lite diskutrymme och tid vid skanning)</label>
    <label class="switch"><input type="checkbox" id="srecap" ${S.detectRecap ? 'checked' : ''}> Leta efter "tidigare i serien" (analyserar hela föregående avsnitt)</label>
    <label class="switch"><input type="checkbox" id="swatch" ${S.watchEnabled ? 'checked' : ''}> Skanna direkt när filer läggs till (filbevakning – ${S.watching} bibliotek bevakas)</label>
    <div class="row"><div style="flex:1"><label>Max samtidiga omkodningar (totalt)</label><input id="smt" type="number" min="1" max="32" value="${S.maxTranscodes}"></div>
    <div style="flex:1"><label>Max samtidiga omkodningar per användare</label><input id="smu" type="number" min="1" max="16" value="${S.maxTranscodesUser}"></div></div>
    <div class="row" style="margin-top:14px"><button class="primary">Spara säkerhetsinställningar</button></div></form>
  </div>
  <div class="panel"><h2>Version ${esc(UP.current)} ${UP.available ? `<span class="warn-badge">${esc(UP.latest)} finns</span>` : UP.latest ? '<span class="ok-badge">Senaste</span>' : ''}</h2>
    ${UP.available ? `<p>Uppdatera i Unraid: <b>Docker → BraXhn TV → Check for updates → Apply update</b>. Databasen uppgraderas automatiskt.</p>${UP.notes ? `<pre class="small" style="white-space:pre-wrap;max-height:240px;overflow:auto">${esc(UP.notes)}</pre>` : ''}` : ''}
    <p class="muted small">${UP.checked ? 'Senast kontrollerat ' + new Date(UP.checked).toLocaleString('sv-SE') : 'Inte kontrollerat än'}${UP.error ? ' – fel: ' + esc(UP.error) : ''}. Servern hämtar bara versionsnumret från GitHub (${esc(UP.repo)}) och skickar ingenting om dig.</p>
    <div class="row"><label class="switch" style="margin:0"><input type="checkbox" id="upen" ${UP.enabled ? 'checked' : ''}> Leta efter nya versioner</label><button class="ghost small" id="upchk">Kontrollera nu</button></div>
  </div>
  <div class="panel"><h2>Live-TV och inspelning</h2>
    <p class="muted small"><b>HDHomeRun</b> (antenn/kabel) eller <b>IPTV</b> med en M3U-lista. TV-guide från en XMLTV-adress (t.ex. från din IPTV-leverantör eller <i>xmltv.se</i>) – HDHomeRun har egen guide om ingen anges. Inspelningar sparas i <code>${esc(LT.settings.dvrDir)}</code> – lägg till sökvägen <code>/recordings</code> i Unraid-mallen.</p>
    ${LT.tuners.length ? `<table>${LT.tuners.map(t => `<tr><td><b>${esc(t.name)}</b><div class="muted small">${t.kind === 'hdhr' ? 'HDHomeRun' : 'IPTV'} · ${esc(t.url)}${t.epg_url ? ' · guide: ' + esc(t.epg_url) : ''}</div>${t.error ? `<div class="err small">${esc(t.error)}</div>` : ''}</td>
      <td>${t.channels} kanaler · ${LT.inUse[t.id] || 0}/${t.tuner_count} tuners används</td>
      <td class="r"><button class="ghost small" data-trf="${t.id}">Uppdatera</button><button class="ghost small" data-tepg="${t.id}">TV-guide…</button><button class="danger small" data-tdel="${t.id}">Ta bort</button></td></tr>`).join('')}</table>` : ''}
    <form id="ltadd" style="margin-top:12px"><div class="row" style="align-items:flex-end"><div><label>Källa</label><select id="ltk"><option value="hdhr">HDHomeRun</option><option value="m3u">IPTV (M3U)</option></select></div>
      <div style="flex:2;min-width:220px"><label id="ltul">IP-adress till HDHomeRun</label><input id="ltu" placeholder="192.168.1.50" required></div>
      <div style="flex:2;min-width:220px"><label>TV-guide, XMLTV (valfri)</label><input id="lte" placeholder="https://…/guide.xml.gz"></div>
      <div id="ltnw" hidden><label>Samtidiga strömmar</label><input id="ltn" type="number" min="1" max="20" value="2" style="width:80px"></div></div>
      <div class="row" style="margin-top:10px"><button class="primary">Lägg till</button><button type="button" class="ghost" id="ltdisc">Sök efter HDHomeRun</button><button type="button" class="ghost" id="ltgr">Uppdatera TV-guiden</button></div></form>
    ${LT.channels.length ? `<details style="margin-top:12px"><summary>Kanaler (${LT.channels.length}) – dölj eller markera favoriter</summary><table>${LT.channels.map(c => `<tr><td>${esc(c.number || '')}</td><td>${esc(c.name)}</td><td class="muted small">${c.now ? esc(c.now.title) : 'ingen guide'}${c.epgId ? '' : ' · <span class="warn-badge">ej kopplad</span>'}</td>
      <td><label class="small"><input type="checkbox" data-chfav="${c.id}" ${c.favorite ? 'checked' : ''}> favorit</label> <label class="small"><input type="checkbox" data-chhide="${c.id}" ${c.hidden ? 'checked' : ''}> dold</label> <button class="ghost small" data-chepg="${c.id}" data-epgid="${esc(c.epgId || '')}">Guide-id</button></td></tr>`).join('')}</table></details>` : ''}
    <form id="ltset" class="row" style="margin-top:12px;align-items:flex-end"><div style="flex:1;min-width:160px"><label>Inspelningsmapp</label><input id="lsd" value="${esc(LT.settings.dvrDir)}"></div>
      <div><label>Starta före (s)</label><input id="lsb" type="number" min="0" value="${LT.settings.padBefore}" style="width:90px"></div><div><label>Sluta efter (s)</label><input id="lsa" type="number" min="0" value="${LT.settings.padAfter}" style="width:90px"></div>
      <div><label>Live-omkodning</label><select id="lst"><option value="auto" ${LT.settings.liveTranscode === 'auto' ? 'selected' : ''}>Bara vid behov</option><option value="always" ${LT.settings.liveTranscode === 'always' ? 'selected' : ''}>Alltid</option></select></div>
      <div><label title="Hur långt bakåt man kan pausa och spola i live-TV (0 = av)">Timeshift (min)</label><input id="lsts" type="number" min="0" max="720" value="${LT.settings.timeshiftMinutes ?? 120}" style="width:90px"></div>
      <div><label title="Högsta diskanvändning för timeshift, alla kanaler tillsammans">Timeshift max (GB)</label><input id="lstg" type="number" min="0.5" step="0.5" value="${LT.settings.timeshiftMaxGb ?? 20}" style="width:90px"></div>
      <label class="small"><input type="checkbox" id="lscs" ${LT.settings.comskip ? 'checked' : ''}> Leta reklamavbrott i inspelningar</label>
      <label class="small"><input type="checkbox" id="lsca" ${LT.settings.comskipAutoSkip ? 'checked' : ''}> Hoppa över reklam automatiskt (standard)</label>
      <button class="ghost">Spara</button></form>
  </div>
  <div class="panel"><h2>Sonarr, Radarr och Trakt</h2>
    <p class="muted small"><b>Direkt skanning:</b> lägg till en webhook i Sonarr och Radarr (Settings → Connect → + → Webhook, händelser <i>On Import</i>, <i>On Upgrade</i>, <i>On Rename</i> och <i>On Delete</i>) med adressen nedan. Då dyker nya avsnitt upp direkt efter nedladdning.</p>
    <div class="row"><input id="whurl" readonly value="${esc((S.publicUrl || location.origin) + IN.webhookPath)}" style="flex:1"><button type="button" class="ghost small" id="whcopy">Kopiera</button><button type="button" class="ghost small" id="whnew">Ny nyckel</button></div>
    <form id="inform">
      <label>Sökvägar i Sonarr/Radarr → här (om de skiljer sig), t.ex. <code>/tv=/media/Serier,/movies=/media/Filmer</code></label><input id="inpm" value="${esc(IN.pathMap)}">
      ${['radarr', 'sonarr'].map(k => `<h3 style="margin:18px 0 0;font-size:15px">${k === 'radarr' ? 'Radarr (filmer)' : 'Sonarr (serier)'}</h3>
      <div class="row"><div style="flex:2;min-width:200px"><label>Adress</label><input id="${k}u" value="${esc(IN[k + 'Url'])}" placeholder="http://192.168.1.10:${k === 'radarr' ? 7878 : 8989}"></div>
      <div style="flex:1;min-width:160px"><label>API-nyckel</label><input id="${k}k" type="password" autocomplete="off" placeholder="${IN[k + 'KeySet'] ? '•••••• (sparad)' : 'Settings → General'}"></div></div>
      <div class="row"><div style="flex:1"><label>Kvalitetsprofil</label><select id="${k}p"><option value="0">Första</option></select></div>
      <div style="flex:1"><label>Rotmapp</label><select id="${k}r"><option value="">Första</option></select></div><button type="button" class="ghost small" data-arrload="${k}">Hämta från ${k === 'radarr' ? 'Radarr' : 'Sonarr'}</button></div>`).join('')}
      <label class="switch"><input type="checkbox" id="inre" ${IN.requestsEnabled ? 'checked' : ''}> Användare kan önska filmer och serier</label>
      <label class="switch"><input type="checkbox" id="inra" ${IN.requestsAuto ? 'checked' : ''}> Godkänn önskemål automatiskt (annars godkänner en administratör)</label>
      <h3 style="margin:18px 0 0;font-size:15px">Trakt</h3>
      <p class="muted small">Skapa en gratis app på <a href="https://trakt.tv/oauth/applications" target="_blank" rel="noopener">trakt.tv/oauth/applications</a> (Redirect URI: <code>urn:ietf:wg:oauth:2.0:oob</code>). Varje användare kopplar sedan sitt konto under Mitt konto.</p>
      <div class="row"><div style="flex:1;min-width:180px"><label>Client ID</label><input id="trid" value="${esc(IN.traktClientId)}" autocomplete="off"></div>
      <div style="flex:1;min-width:180px"><label>Client Secret</label><input id="trsec" type="password" autocomplete="off" placeholder="${IN.traktSecretSet ? '•••••• (sparad)' : ''}"></div></div>
      <h3 style="margin:18px 0 0;font-size:15px">Last.fm (scrobbling av musik)</h3>
      <p class="muted small">Skapa ett API-konto på <a href="https://www.last.fm/api/account/create" target="_blank" rel="noopener">last.fm/api/account/create</a> (Callback URL kan lämnas tom). Varje användare kopplar sedan sitt Last.fm-konto under Mitt konto. ListenBrainz behöver ingen nyckel här.</p>
      <div class="row"><div style="flex:1;min-width:180px"><label>API key</label><input id="lfkey" value="${esc(IN.lastfmApiKey || '')}" autocomplete="off"></div>
      <div style="flex:1;min-width:180px"><label>Shared secret</label><input id="lfsec" type="password" autocomplete="off" placeholder="${IN.lastfmSecretSet ? '•••••• (sparad)' : ''}"></div></div>
      <div class="row" style="margin-top:12px"><button class="primary">Spara</button></div></form>
  </div>
  <div class="panel"><h2>Notiser till mobilen</h2>
    <p class="muted small">Få larm vid t.ex. attacker, spärrade konton, certifikatproblem och misslyckade säkerhetskopior. Enklast är <b>ntfy</b>: installera ntfy-appen, hitta på ett långt hemligt ämnesnamn och ange <code>https://ntfy.sh/ditt-ämne</code> (eller din egen ntfy-server).</p>
    <form id="noform"><div class="row"><div><label>Tjänst</label><select id="nok">${NO.kinds.map(k => `<option value="${k}" ${k === NO.kind ? 'selected' : ''}>${{ none: 'Av', ntfy: 'ntfy', pushover: 'Pushover', gotify: 'Gotify', discord: 'Discord', telegram: 'Telegram', webhook: 'Webhook (JSON)' }[k]}</option>`).join('')}</select></div>
      <div style="flex:2;min-width:220px"><label>Adress <span class="muted small">(ntfy/Gotify/Discord/webhook)</span></label><input id="nou" value="${esc(NO.url)}" placeholder="https://ntfy.sh/mitt-hemliga-amne"></div></div>
      <div class="row"><div style="flex:1;min-width:180px"><label>Token/nyckel <span class="muted small">(Pushover app-token, Telegram bot-token, Gotify app-token)</span></label><input id="not" type="password" placeholder="${NO.tokenSet ? '•••••• (sparad)' : ''}" autocomplete="off"></div>
      <div style="flex:1;min-width:180px"><label>Mottagare <span class="muted small">(Pushover user key / Telegram chat-id)</span></label><input id="nous" value="${esc(NO.user)}"></div></div>
      <label>Skicka notis vid</label>${Object.entries(NO.allEvents).map(([k, v]) => `<label class="switch"><input type="checkbox" data-nev="${k}" ${NO.events.includes(k) ? 'checked' : ''}> ${esc(v)}</label>`).join('')}
      <div class="row" style="margin-top:12px"><button class="primary">Spara</button><button type="button" class="ghost" id="notest">Skicka testnotis</button></div></form>
    ${NO.recent.length ? `<details style="margin-top:10px"><summary class="muted small">Senaste notiser</summary><table>${NO.recent.map(n => `<tr><td class="muted small">${new Date(n.at).toLocaleString('sv-SE')}</td><td>${esc(n.title)}</td><td class="muted small">${esc(n.message)}</td></tr>`).join('')}</table></details>` : ''}
  </div>
  <div class="panel"><h2>HTTPS med Let's Encrypt ${AC.cert ? `<span class="ok-badge">${AC.cert.daysLeft} dagar kvar</span>` : '<span class="warn-badge">Inget certifikat</span>'}</h2>
    <p class="muted small">Inbyggt gratis certifikat som förnyas automatiskt. Kräver ett domännamn som pekar på din publika IP (t.ex. via DuckDNS eller din DNS-leverantör) och att port <b>80</b> i routern vidarebefordras till BraXhn TV:s port 8420 under valideringen. HTTPS serveras på port ${AC.httpsPort} – vidarebefordra 443 dit. Använder du redan en omvänd proxy (Nginx Proxy Manager, SWAG) behövs inte detta.</p>
    ${AC.cert ? `<p class="small">Certifikat för <b>${esc(AC.cert.san || AC.cert.subject)}</b> från ${esc(AC.cert.issuer || '')}, gäller till ${esc(AC.cert.validTo)}.</p>` : ''}
    <form id="acmeform"><div class="row"><div style="flex:1;min-width:180px"><label>Domän</label><input id="acd" value="${esc(AC.domain)}" placeholder="tv.dindomän.se"></div>
      <div style="flex:1;min-width:180px"><label>E-post för påminnelser (valfri)</label><input id="ace" type="email" value="${esc(AC.email)}"></div></div>
      <label class="switch"><input type="checkbox" id="acs" ${AC.staging ? 'checked' : ''}> Testmiljö (staging) – prova först utan att riskera Let's Encrypts gränser</label>
      <label class="switch"><input type="checkbox" id="aca" ${AC.auto ? 'checked' : ''}> Förnya automatiskt (30 dagar före utgång)</label>
      <div class="row" style="margin-top:12px"><button class="ghost">Spara</button><button type="button" class="primary" id="acgo" ${AC.running ? 'disabled' : ''}>${AC.cert ? 'Förnya nu' : 'Hämta certifikat'}</button></div></form>
    <pre id="aclog" class="small muted" style="white-space:pre-wrap;margin-top:10px;${AC.log.length ? '' : 'display:none'}">${esc(AC.log.join('\n'))}</pre>
  </div>
  <div id="opsp"></div>
  <div class="panel"><h2>Säkerhetslogg</h2>
    <div style="max-height:360px;overflow:auto"><table><tr><th>Tid</th><th>Händelse</th><th>Användare</th><th>IP</th><th>Detaljer</th></tr>
    ${AU.map(a => `<tr class="${/fail|denied|locked/.test(a.event) ? 'warnrow' : ''}"><td class="muted small">${fmtDate(a.ts)}</td><td>${esc(EVENTS[a.event] || a.event)}</td><td>${esc(a.user_name || '–')}</td><td class="muted small">${esc(a.ip || '')}</td><td class="muted small">${esc(a.detail || '')}</td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">Inga händelser ännu.</td></tr>'}</table></div>
  </div>
  <div class="panel"><h2>Inställningar</h2><form id="settings">
    <label>TMDB API-nyckel (gratis på themoviedb.org – ger affischer, beskrivningar och betyg)</label>
    <input id="tk" type="password" placeholder="${S.tmdbKeySet ? (S.tmdbFromEnv ? 'Satt via miljövariabel' : '•••••••• (sparad – lämna tomt för att behålla)') : 'Ingen nyckel – endast filnamn och miniatyrer används'}">
    <div class="row"><div style="flex:1"><label>Språk för metadata</label><select id="lang">
      ${[['sv-SE', 'Svenska'], ['en-US', 'Engelska'], ['nb-NO', 'Norska'], ['da-DK', 'Danska'], ['fi-FI', 'Finska'], ['de-DE', 'Tyska']].map(([v, n]) => `<option value="${v}" ${S.language === v ? 'selected' : ''}>${n}</option>`).join('')}
    </select></div><div style="flex:1"><label>Automatisk skanning (minuter, 0 = av)</label><input id="si" type="number" min="0" value="${S.scanInterval}"></div></div>
    <h3 style="margin:22px 0 0;font-size:15px">Undertexter (OpenSubtitles.com)</h3>
    <p class="muted" style="font-size:13px;margin:4px 0 0">Gratis API-nyckel under <i>API Consumers</i> på opensubtitles.com. Konto ger fler nedladdningar per dygn.</p>
    <label>API-nyckel</label><input id="osk" type="password" placeholder="${S.osKeySet ? '•••••••• (sparad)' : 'Ingen nyckel'}">
    <div class="row"><div style="flex:1"><label>Användarnamn (valfritt)</label><input id="osu" value="${esc(S.osUser || '')}" autocomplete="off"></div>
    <div style="flex:1"><label>Lösenord</label><input id="osp" type="password" autocomplete="new-password" placeholder="${S.osPassSet ? '•••••••• (sparat)' : ''}"></div></div>
    <label>Språk att söka (kommaseparerade, t.ex. sv,en)</label><input id="osl" value="${esc(S.subLangs)}">
    <label class="switch"><input type="checkbox" id="osa" ${S.subAuto ? 'checked' : ''}> Hämta undertexter automatiskt vid skanning när de saknas</label>
    <div class="row"><div style="flex:1"><label>Språk att hämta automatiskt</label><input id="osal" value="${esc(S.subAutoLangs)}"></div>
    <div><label>Max per skanning</label><input id="osam" type="number" min="1" max="100" value="${S.subAutoMax}" style="width:110px"></div></div>
    <label class="switch"><input type="checkbox" id="osah" ${S.subAutoHash ? 'checked' : ''}> Bara exakta träffar (filhash) – rekommenderas, annars kan tiderna vara fel</label>
    <p class="muted small" style="margin:4px 0 0">Hämtade hittills: ${S.subAutoStats.downloaded}${S.subAutoStats.error ? ' · senaste fel: ' + esc(S.subAutoStats.error) : ''}. Gratiskonton får ett begränsat antal nedladdningar per dygn – resten hämtas vid nästa skanning.</p>
    <h3 style="margin:22px 0 0;font-size:15px">Ljudböcker</h3>
    <label class="switch"><input type="checkbox" id="bmeta" ${S.bookMeta ? 'checked' : ''}> Hämta beskrivning, omslag, serie och kapitel från nätet (Google Books, Open Library, Audnexus)</label>
    <p class="muted small" style="margin:4px 0 0">Körs i bakgrunden efter skanningen, en bok i taget. Matchade böcker hämtas inte om – använd <i>Fel bok?</i> på bokens sida.${S.bookMetaStatus?.running ? ` Pågår: ${esc(S.bookMetaStatus.library || '')} ${S.bookMetaStatus.done}/${S.bookMetaStatus.total}.` : ''}${S.bookMetaStatus?.error ? ' Senaste fel: ' + esc(S.bookMetaStatus.error) : ''}</p>
    <h3 style="margin:22px 0 0;font-size:15px">Utanför hemmet</h3>
    <div class="row"><div style="flex:1"><label>Maxkvalitet utanför hemmet (automatisk)</label><select id="rq">
      ${[['orig', 'Original (ingen gräns)'], ['1080', '1080p – 8 Mbit/s'], ['720', '720p – 4 Mbit/s'], ['480', '480p – 1,5 Mbit/s'], ['360', '360p – 0,8 Mbit/s']].map(([v, n]) => `<option value="${v}" ${S.remoteQuality === v ? 'selected' : ''}>${n}</option>`).join('')}
    </select></div><div style="flex:1"><label>Publik adress (används för Chromecast och appar)</label><input id="pu" placeholder="https://tv.dindomän.se" value="${esc(S.publicUrl || '')}"></div></div>
    <p class="muted" style="font-size:13px;margin:8px 0 0">Du är just nu ansluten ${S.youAreLocal ? '<b>från hemnätverket</b>' : '<b>utifrån</b>'} via ${S.https ? 'HTTPS ✓' : 'HTTP (okrypterat)'}${S.tlsBuiltin ? ' · inbyggd HTTPS aktiv på port 8443' : ''}. Se README → <i>Titta utanför hemmet</i>.</p>
    <p class="muted" style="font-size:13px;margin:14px 0 0">Hårdvaruomkodning: <b>${esc(S.hwaccel)}</b> (sätts med miljövariabeln HWACCEL) · Pågående omkodningar: ${S.activeTranscodes} · Version ${esc(S.version)}</p>
    <div class="row" style="margin-top:16px"><button class="primary">Spara</button><button type="button" class="ghost" id="remeta">Hämta om all metadata</button><button type="button" class="ghost" id="remark">Leta intro igen</button></div></form></div>`;

  // Mappväljare
  const browse = async (p) => {
    try {
      const r = await api('/fs?path=' + encodeURIComponent(p));
      $('#lp').value = r.path;
      $('#fsb').innerHTML = (r.parent ? `<div data-p="${esc(r.parent)}">⬆ ..</div>` : '') + r.dirs.map(d => `<div data-p="${esc(r.path + '/' + d)}">📁 ${esc(d)}</div>`).join('')
        || '<div class="muted" role="status">Inga undermappar</div>';
      $$('#fsb [data-p]').forEach(el => keyClick(el).onclick = () => browse(el.dataset.p));
    } catch (e) { if (!e.aborted && $('#fsb')) $('#fsb').innerHTML = errorState(e, { compact: true }); }
  };
  browse(S.mediaRoot);
  $('#addlib').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/libraries', { method: 'POST', body: { name: $('#ln').value, type: $('#lt').value, path: $('#lp').value, anime: $('#lanime').checked } }); toast('Bibliotek tillagt – skannar'); await loadLibs(); route(); }
    catch (er) { toastErr(er); }
  };
  $('#lt').onchange = () => { $('#lanimew').hidden = $('#lt').value !== 'show'; };
  $('#lanimew').hidden = $('#lt').value !== 'show';
  $$('[data-anime]').forEach(b => b.onchange = act(async () => { await api('/libraries/' + b.dataset.anime, { method: 'PUT', body: { anime: b.checked } }); toast('Sparat – serierna matchas om'); }));
  $('#scanall').onclick = act(async () => { await api('/scan', { method: 'POST' }); toast('Skanning startad'); poll(); });
  $$('[data-scan]').forEach(b => b.onclick = act(async () => { await api(`/libraries/${b.dataset.scan}/scan`, { method: 'POST' }); toast('Skanning startad'); poll(); }));
  $$('[data-del]').forEach(b => b.onclick = act(async () => {
    const name = L.find(l => l.id === +b.dataset.del)?.name || 'biblioteket';
    if (!await confirmDialog('Filerna på disken påverkas inte, men titlarna och tittarhistoriken för dem försvinner ur BraXhn TV.', { title: `Ta bort ${name}?`, okLabel: 'Ta bort', danger: true })) return;
    await api('/libraries/' + b.dataset.del, { method: 'DELETE' }); await loadLibs(); route();
  }));
  $('#adduser').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/users', { method: 'POST', body: { name: $('#un').value, password: $('#up').value, isAdmin: $('#ua').checked, remoteAllowed: $('#ur').checked } }); toast('Användare skapad'); route(); }
    catch (er) { toastErr(er); }
  };
  $$('[data-udel]').forEach(b => b.onclick = act(async () => { if (await confirmDialog(`Ta bort användaren ${U.find(u => u.id === +b.dataset.udel)?.name || ''}?`, { okLabel: 'Ta bort', danger: true })) { await api('/users/' + b.dataset.udel, { method: 'DELETE' }); route(); } }));
  $$('[data-remote]').forEach(b => b.onchange = act(async () => { await api('/users/' + b.dataset.remote, { method: 'PUT', body: { remoteAllowed: b.checked } }); toast('Sparat'); }));
  $$('[data-r2fa]').forEach(b => b.onclick = act(async () => { if (await confirmDialog('Återställ tvåstegsverifiering för användaren?', { okLabel: 'Återställ', danger: true })) { await api('/users/' + b.dataset.r2fa, { method: 'PUT', body: { reset2fa: true } }); route(); } }));
  $$('[data-lout]').forEach(b => b.onclick = act(async () => { if (await confirmDialog('Logga ut användaren från alla enheter?', { okLabel: 'Logga ut' })) { await api('/users/' + b.dataset.lout, { method: 'PUT', body: { logoutAll: true } }); toast('Utloggad'); } }));
  $('#secform').onsubmit = async (e) => {
    e.preventDefault();
    const body = { require2faRemote: $('#s2fa').checked, quickConnect: $('#sqc').checked, trustedNetworks: $('#stn').value, maxTranscodes: $('#smt').value, maxTranscodesUser: $('#smu').value,
      allowUnrated: $('#sunr').checked, watchEnabled: $('#swatch').checked, trickplay: $('#strick').checked, detectRecap: $('#srecap').checked };
    if (!$('#sadm').disabled) body.adminAnywhere = $('#sadm').checked;
    if (!$('#svpn').disabled) body.trustVpnRange = $('#svpn').checked;
    if (body.require2faRemote && !me.totp) { if (!await confirmDialog('Du har själv inte tvåstegsverifiering. Du kommer inte kunna logga in utifrån förrän du aktiverat den. Fortsätta?', { okLabel: 'Fortsätt' })) return; }
    try { await api('/settings', { method: 'PUT', body }); toast('Sparat'); route(); } catch (er) { toastErr(er); }
  };
  $('#upen').onchange = act(async () => { await api('/updates', { method: 'PUT', body: { enabled: $('#upen').checked } }); toast('Sparat'); });
  $('#upchk').onclick = act(async () => { const u = await api('/updates/check', { method: 'POST' }); toast(u.error ? 'Kunde inte kontrollera: ' + u.error : u.available ? `Version ${u.latest} finns` : 'Du har senaste versionen'); route(); });
  const noSave = () => { const body = { kind: $('#nok').value, url: $('#nou').value, user: $('#nous').value, events: $$('[data-nev]').filter(x => x.checked).map(x => x.dataset.nev) };
    if ($('#not').value) body.token = $('#not').value; return api('/notify', { method: 'PUT', body }); };
  $('#noform').onsubmit = async (e) => { e.preventDefault(); try { await noSave(); toast('Sparat'); } catch (er) { toastErr(er); } };
  $('#notest').onclick = async () => { try { await noSave(); await api('/notify/test', { method: 'POST' }); toast('Testnotis skickad'); } catch (er) { toastErr(er); } };
  $('#ltk').onchange = () => { const h = $('#ltk').value === 'hdhr'; $('#ltul').textContent = h ? 'IP-adress till HDHomeRun' : 'Adress till M3U-listan (eller fil under /config)'; $('#ltu').placeholder = h ? '192.168.1.50' : 'https://…/playlist.m3u'; $('#ltnw').hidden = h; };
  $('#ltadd').onsubmit = async (e) => {
    e.preventDefault(); const b = $('#ltadd button'); b.disabled = true; b.textContent = 'Hämtar kanaler…';
    try { const r = await api('/live/tuners', { method: 'POST', body: { kind: $('#ltk').value, url: $('#ltu').value, epgUrl: $('#lte').value, tuners: $('#ltn').value } }); toast('Tillagd'); await boot(); route(); void r; }
    catch (er) { toastErr(er); b.disabled = false; b.textContent = 'Lägg till'; }
  };
  $('#ltdisc').onclick = act(async () => { toast('Söker…'); const r = await api('/live/discover', { method: 'POST' }); if (r.found.length) { $('#ltk').value = 'hdhr'; $('#ltk').onchange(); $('#ltu').value = r.found[0]; toast('Hittade ' + r.found.join(', ')); } else toast('Ingen hittades – ange IP-adressen (sökning kräver host-nätverk i Docker)'); });
  $('#ltgr').onclick = async () => { toast('Uppdaterar guiden…'); try { await api('/live/guide/refresh', { method: 'POST' }); toast('Guiden uppdaterad'); route(); } catch (er) { toastErr(er); } };
  $$('[data-trf]').forEach(b => b.onclick = async () => { try { const r = await api(`/live/tuners/${b.dataset.trf}/refresh`, { method: 'POST' }); toast(`${r.channels} kanaler`); route(); } catch (er) { toastErr(er); } });
  $$('[data-tdel]').forEach(b => b.onclick = act(async () => { if (await confirmDialog('Ta bort källan och dess kanaler?', { okLabel: 'Ta bort', danger: true })) { await api('/live/tuners/' + b.dataset.tdel, { method: 'DELETE' }); await boot(); route(); } }));
  $$('[data-tepg]').forEach(b => b.onclick = async () => { const u = await promptDialog('Adress till XMLTV-guiden', { title: 'TV-guide', inputmode: 'url', hint: 'Tomt = ingen guide (HDHomeRun använder då sin egen).', value: LT.tuners.find(t => t.id === +b.dataset.tepg)?.epg_url || '', okLabel: 'Spara' }); if (u === null) return; try { await api('/live/tuners/' + b.dataset.tepg, { method: 'PUT', body: { epgUrl: u } }); await api(`/live/tuners/${b.dataset.tepg}/refresh`, { method: 'POST' }); toast('Sparat'); route(); } catch (er) { toastErr(er); } });
  $$('[data-chfav]').forEach(b => b.onchange = act(() => api('/live/channels/' + b.dataset.chfav, { method: 'PUT', body: { favorite: b.checked } })));
  $$('[data-chhide]').forEach(b => b.onchange = act(() => api('/live/channels/' + b.dataset.chhide, { method: 'PUT', body: { hidden: b.checked } })));
  $$('[data-chepg]').forEach(b => b.onclick = act(async () => { const v = await promptDialog('Kanalens id i XMLTV-guiden', { title: 'Guide-id', placeholder: 'svt1.svt.se', value: b.dataset.epgid, okLabel: 'Spara' }); if (v === null) return; await api('/live/channels/' + b.dataset.chepg, { method: 'PUT', body: { epgId: v } }); toast('Sparat – uppdatera guiden'); }));
  $('#ltset').onsubmit = async (e) => { e.preventDefault(); try { await api('/live/settings', { method: 'PUT', body: { dvrDir: $('#lsd').value, padBefore: $('#lsb').value, padAfter: $('#lsa').value, liveTranscode: $('#lst').value,
    timeshiftMinutes: $('#lsts').value, timeshiftMaxGb: $('#lstg').value, comskip: $('#lscs').checked, comskipAutoSkip: $('#lsca').checked } }); toast('Sparat'); } catch (er) { toastErr(er); } };
  $('#whcopy').onclick = () => navigator.clipboard?.writeText($('#whurl').value).then(() => toast('Kopierat'));
  $('#whnew').onclick = act(async () => { if (!await confirmDialog('Skapa ny nyckel? Webhooks i Sonarr/Radarr måste uppdateras.', { okLabel: 'Skapa ny nyckel', danger: true })) return; await api('/integrations', { method: 'PUT', body: { newWebhookKey: true } }); route(); });
  for (const k of ['radarr', 'sonarr']) {
    const prof = IN[k + 'Profile'], root = IN[k + 'Root'];
    if (prof) $('#' + k + 'p').innerHTML += `<option value="${prof}" selected>Profil ${prof}</option>`;
    if (root) $('#' + k + 'r').innerHTML += `<option value="${esc(root)}" selected>${esc(root)}</option>`;
  }
  $$('[data-arrload]').forEach(b => b.onclick = async () => {
    const k = b.dataset.arrload;
    try {
      await api('/integrations', { method: 'PUT', body: { [k + 'Url']: $('#' + k + 'u').value, [k + 'Key']: $('#' + k + 'k').value } });
      const o = await api('/integrations/arr-options?kind=' + (k === 'radarr' ? 'movie' : 'show'));
      $('#' + k + 'p').innerHTML = o.profiles.map(p => `<option value="${p.id}" ${p.id === IN[k + 'Profile'] ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
      $('#' + k + 'r').innerHTML = o.roots.map(r => `<option value="${esc(r.path)}" ${r.path === IN[k + 'Root'] ? 'selected' : ''}>${esc(r.path)} (${Math.round(r.free / 1e9)} GB ledigt)</option>`).join('');
      toast('Ansluten');
    } catch (e) { toastErr(e); }
  });
  $('#inform').onsubmit = async (e) => {
    e.preventDefault();
    const body = { pathMap: $('#inpm').value, requestsEnabled: $('#inre').checked, requestsAuto: $('#inra').checked, traktClientId: $('#trid').value };
    if ($('#trsec').value) body.traktSecret = $('#trsec').value;
    body.lastfmApiKey = $('#lfkey').value; if ($('#lfsec').value) body.lastfmSecret = $('#lfsec').value;
    for (const k of ['radarr', 'sonarr']) { body[k + 'Url'] = $('#' + k + 'u').value; if ($('#' + k + 'k').value) body[k + 'Key'] = $('#' + k + 'k').value; body[k + 'Profile'] = $('#' + k + 'p').value; body[k + 'Root'] = $('#' + k + 'r').value; }
    try { await api('/integrations', { method: 'PUT', body }); toast('Sparat'); } catch (er) { toastErr(er); }
  };
  const acSave = () => api('/acme', { method: 'PUT', body: { domain: $('#acd').value, email: $('#ace').value, staging: $('#acs').checked, auto: $('#aca').checked } });
  $('#acmeform').onsubmit = async (e) => { e.preventDefault(); try { await acSave(); toast('Sparat'); } catch (er) { toastErr(er); } };
  let cancelAc = null;
  const acPoll = async () => {
    cancelAc = null;
    if (!$('#aclog')) return;
    const a = await api('/acme').catch(e => { if (e.aborted) throw e; return null; }); if (!a || !$('#aclog')) return;
    $('#aclog').style.display = ''; $('#aclog').textContent = a.log.join('\n');
    if (a.running) cancelAc = later(acPoll, 1500);
    else { $('#acgo').disabled = false; toast(a.error ? 'Certifikatet kunde inte hämtas: ' + a.error : 'Certifikatet är klart – HTTPS är igång'); if (!a.error) later(route, 1500); }
  };
  $('#acgo').onclick = async () => {
    try { await acSave(); await api('/acme/obtain', { method: 'POST' }); $('#acgo').disabled = true; if (cancelAc) cancelAc(); cancelAc = later(acPoll, 800); } catch (er) { toastErr(er); }
  };
  $$('[data-adm]').forEach(b => b.onclick = act(async () => { await api('/users/' + b.dataset.adm, { method: 'PUT', body: { isAdmin: b.dataset.v === '1' } }); route(); }));
  $$('[data-pw]').forEach(b => b.onclick = async () => {
    const pw = await promptDialog('Nytt lösenord', { title: `Nytt lösenord för ${U.find(u => u.id === +b.dataset.pw)?.name || 'användaren'}`, type: 'password', autocomplete: 'new-password', minlength: 10, required: true, hint: 'Minst 10 tecken. Användaren loggas ut från alla enheter.', okLabel: 'Byt lösenord' }); if (!pw) return;
    try { await api('/users/' + b.dataset.pw, { method: 'PUT', body: { password: pw } }); toast('Lösenord ändrat'); } catch (er) { toastErr(er); }
  });
  $('#settings').onsubmit = act(async (e) => {
    e.preventDefault();
    const body = { language: $('#lang').value, scanInterval: $('#si').value, osUser: $('#osu').value, subLangs: $('#osl').value,
      remoteQuality: $('#rq').value, publicUrl: $('#pu').value,
      subAuto: $('#osa').checked, subAutoLangs: $('#osal').value, subAutoMax: $('#osam').value, subAutoHash: $('#osah').checked, bookMeta: $('#bmeta').checked };
    if ($('#tk').value.trim()) body.tmdbKey = $('#tk').value.trim();
    if ($('#osk').value.trim()) body.osKey = $('#osk').value.trim();
    if ($('#osp').value) body.osPass = $('#osp').value;
    await api('/settings', { method: 'PUT', body }); toast('Sparat'); route();
  });
  $('#remark').onclick = act(async () => { await api('/settings', { method: 'PUT', body: { resetMarkers: true } }); await api('/scan', { method: 'POST' }); toast('Analyserar intro/eftertexter i bakgrunden'); });
  $('#remeta').onclick = act(async () => { await api('/settings', { method: 'PUT', body: { resetMeta: true } }); await api('/scan', { method: 'POST' }); toast('Hämtar om metadata i bakgrunden'); });

  // Skanningsstatus – en enda slinga per vy (knuten till navigeringen via later())
  let pollSeq = 0, cancelPoll = null;
  async function poll() {
    const seq = ++pollSeq;
    if (cancelPoll) { cancelPoll(); cancelPoll = null; }
    try {
      const s = await api('/scan');
      const el = $('#scanst'); if (!el || seq !== pollSeq) return;
      const bar = (x) => `<div class="prog"><i style="width:${x.total ? x.done / x.total * 100 : 0}%"></i></div>`;
      const a = s.analysis;
      el.innerHTML = (s.running ? `Skannar <b>${esc(s.library || '')}</b>: ${esc(s.phase)} ${s.done}/${s.total}${s.queued ? ` · ${s.queued} till i kö` : ''}${bar(s)}`
        : s.last ? `Senaste skanning: ${new Date(s.last * 1000).toLocaleString('sv-SE')}` : '')
        // Tunga analyser körs för sig och hindrar inte skanning eller metadata
        + (a?.running ? `<div class="muted small" style="margin-top:8px">I bakgrunden: <b>${esc(a.library || '')}</b> – ${esc(a.phase)} ${a.done}/${a.total}${a.queued ? ` · ${a.queued} bibliotek till i kö` : ''}${bar(a)}</div>` : '');
      cancelPoll = later(poll, s.running || a?.running ? 1500 : 6000);
    } catch {}
  }
  poll();
  adminOps().catch(e => { toastErr(e); });
};
