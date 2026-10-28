// Diskrådgivaren (administratör på betrott nät, server/shrink.js): var platsen tar vägen, vad som aldrig setts,
// överflödiga versioner och uppskattad vinst med HEVC/AV1 – och omkodning i bakgrunden som administratören startar per
// titel eller regel, med kvalitetskontroll och papperskorg. #/shrink/<flik>; filter och sortering sparas per webbläsare.
// @lazy – laddas vid behov (LAZY i js/router.js)
import { $, act, api, esc, fmtDate, fmtSize, later, main, me, store, toast, views, t } from '../core.js';
import { openDialog } from '../ui/dialog.js';
import { emptyState } from '../ui/states.js';
import { tabsHtml } from '../ui/tabs.js';

const TABS = [['overview', t('Översikt')], ['titles', t('Titlar')], ['versions', t('Versioner')], ['jobs', t('Kö och papperskorg')], ['settings', t('Inställningar')]];
const SORT = [['size', t('Störst först')], ['gain', t('Störst vinst')], ['rate', t('Mest MB per minut')], ['seen', t('Längst sedan sedd')]];
const STATUS = { queued: ['muted', t('I kön')], running: ['ok-badge', t('Kodar')], done: ['ok-badge', t('Klar')], rejected: ['warn-badge', t('Original behållet')],
  failed: ['warn-badge hb-err', t('Misslyckades')], cancelled: ['muted', t('Avbruten')], restored: ['muted', t('Återställd')] };
const CODEC = { hevc: 'HEVC', av1: 'AV1' };
// Orsaker och fel från servern (server/shrink.js) är svenska – översätts här ("redan HEVC", "utanför tidsfönstret 01:00-06:00" …)
const why = (x) => !x ? x : /^redan [A-Z0-9]/.test(x) ? t('redan {v}', { v: x.slice(6) }) : /^utanför tidsfönstret /.test(x) ? t('utanför tidsfönstret {v}', { v: x.slice(21) }) : t(x);
const pad = (n) => String(n).padStart(2, '0');
const nameOf = (t) => t.kind === 'episode' ? `${t.show || ''} S${pad(t.season)}E${pad(t.episode)}` : `${t.title}${t.year ? ` (${t.year})` : ''}`;
const linkOf = (t) => t.kind === 'episode' ? t.showId : t.main;
const gb = (b) => b ? fmtSize(b) : '0 MB';
const ago = (tt) => !tt ? t('aldrig') : (() => { const d = Math.floor((Date.now() / 1000 - tt) / 86400); return d < 1 ? t('i dag') : d < 60 ? t('{d} dagar sedan', { d }) : d < 730 ? t('{v} mån sedan', { v: Math.round(d / 30) }) : t('{v} år sedan', { v: Math.round(d / 365) }); })();
const bar = (v, max) => `<span aria-hidden="true" style="display:inline-block;height:8px;border-radius:4px;background:currentColor;opacity:.45;width:${max ? Math.max(2, Math.round(v / max * 120)) : 0}px"></span>`;

views.shrink = async (tab = 'overview') => {
  if (!me.adminHere) { main.innerHTML = emptyState({ icon: '🔒', title: t('Bara för administratörer på hemnätet') }); return; }
  if (!TABS.some(([k]) => k === tab)) tab = 'overview';
  const sort = store.get('shrink.sort') || 'size', lib = store.get('shrink.lib') || '';
  const D = await api(`/admin/shrink?sort=${encodeURIComponent(sort)}${lib ? `&lib=${encodeURIComponent(lib)}` : ''}`);
  const R = D.report, s = D.settings, enc = D.encoders[s.codec], T = R.totals;
  const running = D.jobs.find(j => j.status === 'running'), queued = D.jobs.filter(j => j.status === 'queued').length;
  const status = running ? `${t('<b>Kodar {title}</b>{v}{v2}{v3}', { title: esc(running.title), v: running.progress != null ? ` – ${Math.round(running.progress * 100)} %` : '', v2: running.waiting ? ` ${t('· väntar: {waiting}', { waiting: esc(why(running.waiting)) })}` : '', v3: queued ? ` ${t('· {queued} i kön', { queued })}` : '' })}`
    : queued ? t('{queued} i kön{v}', { queued, v: D.waitReason ? ` ${t('– väntar: {waitReason}', { waitReason: esc(why(D.waitReason)) })}` : '' }) : t('Ingen omkodning pågår. Inget kodas om förrän du väljer titlar eller en regel.');
  main.innerHTML = `<div id="kroot"><div class="toolbar"><h1>${t('Diskrådgivaren')}</h1>
      <button class="primary small" id="krule">${t('Koda om enligt regel…')}</button><button class="ghost small" id="krun">${t('Kör kön nu')}</button>
      <a class="btn ghost small" href="#/admin">Administration</a></div>
    <div class="panel"><div class="row" style="gap:24px;flex-wrap:wrap">
      <div><div class="muted small">${t('Biblioteken')}</div><b>${gb(T.bytes)}</b> <span class="muted small">${t('{count} filer', { count: T.count })}</span></div>
      <div><div class="muted small">${t('Aldrig sett av någon')}</div><b>${gb(T.never.bytes)}</b> <span class="muted small">${t('{count} filer', { count: T.never.count })}</span></div>
      <div><div class="muted small">${t('Inte sett på {notSeenDays} dagar', { notSeenDays: R.notSeenDays })}</div><b>${gb(T.stale.bytes)}</b> <span class="muted small">${t('{count} filer', { count: T.stale.count })}</span></div>
      <div><div class="muted small">${t('Uppskattad vinst med {v}', { v: CODEC[R.codec] })}</div><b>${gb(T.saving)}</b>${R.calibration?.[R.codec] ? '' : ` <span class="muted small">${t('(okalibrerad)')}</span>`}</div>
      <div><div class="muted small">Papperskorgen</div><b>${gb(D.trash.bytes)}</b> <span class="muted small">${D.trash.count} original</span></div></div>
      <p class="small" style="margin-bottom:0">${status}</p>
      ${enc.use ? `<p class="muted small" style="margin:4px 0 0">${t('Kodare: {use}{v} · kvalitetskontroll med {v2}', { use: esc(enc.use), v: enc.hw ? t(' (grafikkortet)') : t(' (processorn – långsamt)'), v2: D.metric === 'vmaf' ? 'VMAF' : t('SSIM och PSNR') })}</p>`
        : `<p class="small" style="margin:4px 0 0"><span class="warn-badge">${t('Ingen kodare')}</span> ${t('Grafikkortet kan inte koda {v}. Tillåt processorn under Inställningar om du vill koda med den.', { v: CODEC[s.codec] })}</p>`}</div>
    <div class="toolbar">${tabsHtml({ label: t('Diskrådgivaren'), current: tab, items: TABS.map(([k, l]) => ({ key: k, label: l, href: '#/shrink/' + k })) })}</div>
    <div class="panel">${({ overview, titles, versions, jobs, settings: settingsTab })[tab](D, { sort, lib })}</div></div>`;

  const reload = () => views.shrink(tab);
  if (running || (queued && !D.waitReason)) later(() => { if ($('#kroot')) return reload(); }, 5000);
  $('#krun').onclick = act(async () => { await api('/admin/shrink/run', { method: 'POST', body: {} }); toast(t('Kön startar om det är fritt')); later(reload, 1500); });
  $('#krule').onclick = () => ruleDialog(D, reload);
  $('#ksort')?.addEventListener('change', (e) => { store.set('shrink.sort', e.target.value); reload(); });
  $('#klib')?.addEventListener('change', (e) => { store.set('shrink.lib', e.target.value); reload(); });
  $('#kset')?.addEventListener('submit', act(async (e) => {
    e.preventDefault();
    const v = (id) => $(id).value;
    await api('/admin/shrink/settings', { method: 'PUT', body: { codec: v('#kcodec'), allowCpu: $('#kcpu').checked, window: $('#kalways').checked ? '' : `${v('#kfrom')}-${v('#kto')}`,
      onlyIdle: $('#kidle').checked, paused: $('#kpause').checked, quality: v('#kq'), minVmaf: +v('#kvmaf'), minSsim: +v('#kssim'), minPsnr: +v('#kpsnr'),
      samples: +v('#ksamp'), trashDays: +v('#ktrash'), notSeenDays: +v('#knotseen') } });
    toast(t('Sparat')); reload();
  }));
  $('#kroot').addEventListener('click', act(async (e) => {
    const b = e.target.closest('[data-q],[data-cal],[data-cancel],[data-restore],[data-purge],#kqsel'); if (!b) return;
    if (b.id === 'kqsel') {
      const ids = [...document.querySelectorAll('[data-pick]:checked')].map(x => +x.dataset.pick);
      if (!ids.length) return toast(t('Markera titlar först'));
      return queue(ids, reload);
    }
    if (b.dataset.q) return queue([+b.dataset.q], reload, b.dataset.force === '1');
    if (b.dataset.cal) { toast(t('Provkodar en kort bit …')); const r = await api('/admin/shrink/calibrate', { method: 'POST', body: { item: +b.dataset.cal } }); toast(t('Kalibrerat: {v} % av originalets bild ({encoder})', { v: Math.round(r.measured * 100), encoder: r.encoder })); return reload(); }
    if (b.dataset.cancel) { await api(`/admin/shrink/jobs/${b.dataset.cancel}/cancel`, { method: 'POST', body: {} }); toast(t('Avbryts')); return later(reload, 800); }
    if (b.dataset.restore) return confirmDo(t('Ta tillbaka originalet?'), t('Originalet flyttas tillbaka från papperskorgen och den omkodade filen tas bort.'), t('Återställ'),
      async () => { await api(`/admin/shrink/jobs/${b.dataset.restore}/restore`, { method: 'POST', body: {} }); toast(t('Originalet är tillbaka')); reload(); });
    if (b.dataset.purge) return confirmDo(t('Töm papperskorgen för titeln?'), t('Originalfilen tas bort för gott. Den omkodade filen finns kvar.'), t('Ta bort original'),
      async () => { await api(`/admin/shrink/jobs/${b.dataset.purge}/trash`, { method: 'DELETE' }); toast(t('Originalet är borttaget')); reload(); }, 'danger');
  }));
};

function confirmDo(title, text, label, fn, kind = 'primary') {
  openDialog({ title, body: `<p>${esc(text)}</p>`, actions: [{ label: t('Avbryt') }, { label, kind, onClick: fn }] });
}
async function queue(ids, reload, force = false) {
  const r = await api('/admin/shrink/queue', { method: 'POST', body: { items: ids, force } });
  const skip = r.skipped.length ? ` ${t('– {skippedN} hoppades över ({v}{v2})', { skippedN: r.skipped.length, v: why(r.skipped[0].reason), v2: r.skipped.length > 1 ? ' …' : '' })}` : '';
  toast(r.queued.length ? t('{queuedN} i kön{skip}', { queuedN: r.queued.length, skip }) : t('Inget köades{skip}', { skip }));
  reload();
}

const groupTable = (rows, caption, link = null) => rows.length ? `<h2>${esc(caption)}</h2><div class="tablewrap"><table>
  <tr><th scope="col">${t('Namn')}</th><th scope="col">${t('Storlek')}</th><th scope="col"><span class="sr-only">${t('Andel')}</span></th><th scope="col">${t('Filer')}</th><th scope="col">${t('MB/min')}</th><th scope="col">${t('Senast sedd')}</th><th scope="col">${t('Vinst')}</th></tr>
  ${rows.map(g => `<tr><td>${link ? `<a href="#/item/${+g.id}">${esc(g.label)}</a>` : esc(g.label)}</td><td>${gb(g.bytes)}</td><td>${bar(g.bytes, rows[0].bytes)}</td><td>${g.count}</td>
    <td>${g.mbPerMin}</td><td class="small">${esc(ago(g.lastSeen))}</td><td>${gb(g.saving)}</td></tr>`).join('')}</table></div>` : '';

function overview(D) {
  const R = D.report;
  if (!R.totals.count) return emptyState({ compact: true, icon: '📦', title: t('Inga filmer eller serier än') });
  return `<p class="muted small">${t('Storlek, bithastighet (MB per minut) och när någon i hushållet senast tittade. Vinsten är en uppskattning ur bithastighet,\n      upplösning och codec – kalibrera den med <b>Provkoda</b> under Titlar.')}</p>
    ${groupTable(R.libraries, t('Per bibliotek'))}${groupTable(R.shows.slice(0, 25), t('Största serierna'), true)}${groupTable(R.resolutions, t('Per upplösning'))}${groupTable(R.codecs, t('Per codec'))}`;
}

function titles(D, { sort, lib }) {
  const R = D.report;
  const head = `<div class="row" style="align-items:flex-end;margin-bottom:8px">
      <div><label for="ksort">${t('Sortering')}</label><select id="ksort">${SORT.map(([k, l]) => `<option value="${k}" ${k === sort ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      <div><label for="klib">${t('Bibliotek')}</label><select id="klib"><option value="">${t('Alla bibliotek')}</option>${R.libraries.map(l => `<option value="${+l.key}" ${String(l.key) === lib ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}</select></div>
      <button class="primary small" id="kqsel">${t('Koda om markerade')}</button></div>`;
  if (!R.titles.length) return head + emptyState({ compact: true, icon: '📦', title: t('Inga titlar') });
  return head + `<ul class="hlist">${R.titles.map(tt => {
      const e = tt.estimate, j = tt.job, st = j && STATUS[j.status];
      const can = e.saving > 0 && !(j && ['queued', 'running'].includes(j.status));
      return `<li>${can ? `<input type="checkbox" data-pick="${tt.id}" aria-label="${t('Välj {v}', { v: esc(nameOf(tt)) })}">` : ''}
        <div class="hmain"><a href="#/item/${+linkOf(tt)}"><b>${esc(nameOf(tt))}</b></a>
          <div class="small">${t('{size} · {mbPerMin} MB/min · {res} {v}{v2} · sedd {v3}{v4}', { size: gb(tt.size), mbPerMin: tt.mbPerMin, res: esc(tt.res), v: esc(String(tt.vcodec || '').toUpperCase()), v2: tt.hdr ? ' HDR' : '', v3: esc(ago(tt.lastSeen)), v4: tt.wanted.length ? ` · <b>${esc(tt.wanted.join(', '))}</b>` : '' })}</div>
          <div class="small">${e.saving > 0 ? t('Vinst ca <b>{saving}</b> ({pct} %)', { saving: gb(e.saving), pct: Math.round(e.saving / tt.size * 100) }) : `<span class="muted">${esc(why(e.skip) || '–')}</span>`}${st ? ` · <span class="${st[0]}">${esc(st[1])}</span>${j.status === 'done' && j.saved > 0 ? ` ${t('{saved} sparat', { saved: gb(j.saved) })}` : ''}${j.status === 'rejected' && j.score != null ? ` ${esc(String(j.metric || '').toUpperCase())} ${j.score}` : ''}` : ''}</div>
          <div class="muted small">${esc(tt.library)} · ${esc(tt.file)}</div></div>
        <div class="hact">${can ? `<button class="ghost small" data-q="${tt.id}" ${j?.status === 'rejected' ? 'data-force="1"' : ''}>${j?.status === 'rejected' ? t('Försök igen') : t('Koda om')}</button>` : ''}
          ${e.saving > 0 ? `<button class="ghost small" data-cal="${tt.id}">${t('Provkoda')}</button>` : ''}</div></li>`;
    }).join('')}</ul>${R.more ? `<p class="muted small">${t('{more} titlar till visas inte – filtrera på bibliotek eller ändra sorteringen.', { more: R.more })}</p>` : ''}`;
}

function versions(D) {
  const V = D.report.versions;
  if (!V.length) return emptyState({ compact: true, icon: '🎞️', title: t('Inga filmer med flera versioner') });
  return `<p class="muted small">${t('Filmer som finns i flera filer. Den högsta upplösningen behålls; de mindre versionerna kan tas bort i Radarr eller i mappen om ingen\n      behöver dem (t.ex. en telefon eller bil som inte klarar 4K – annars kodar servern om när det behövs).')}</p>
    <div class="tablewrap"><table><tr><th scope="col">${t('Film')}</th><th scope="col">${t('Filer')}</th><th scope="col">${t('Kan frigöras')}</th></tr>
    ${V.map(v => `<tr><td><a href="#/item/${+v.main}">${esc(v.title)}${v.year ? ` (${v.year})` : ''}</a></td>
      <td class="small">${v.files.map(f => `${v.extra.includes(f.id) ? '<s>' : '<b>'}${esc(f.res)} ${esc(String(f.vcodec || '').toUpperCase())} ${gb(f.size)}${v.extra.includes(f.id) ? '</s>' : '</b>'} <span class="muted">${esc(f.file)}</span>`).join('<br>')}</td>
      <td>${v.reclaim ? gb(v.reclaim) : '–'}</td></tr>`).join('')}</table></div>`;
}

function jobs(D) {
  if (!D.jobs.length) return emptyState({ compact: true, icon: '🗂️', title: t('Inga omkodningar än'), text: t('Välj titlar under Titlar eller använd Koda om enligt regel.') });
  return `<p class="muted small">${t('Originalen ligger i papperskorgen (mappen .braxhn-papperskorg i biblioteksmappen) i {trashDays} dagar efter bytet och tas sedan bort automatiskt.', { trashDays: D.settings.trashDays })}</p>
    <ul class="hlist">${D.jobs.map(j => { const st = STATUS[j.status] || ['muted', j.status]; return `<li><span class="${st[0]}">${esc(st[1])}</span>
      <div class="hmain">${j.item ? `<a href="#/item/${+j.item}"><b>${esc(j.title)}</b></a>` : `<b>${esc(j.title)}</b>`}
        <div class="small">${esc(CODEC[j.codec] || j.codec)}${j.encoder ? ' · ' + esc(j.encoder) : ''}${j.srcSize ? ` · ${gb(j.srcSize)}` : ''}${j.outSize ? ` → ${gb(j.outSize)}` : ''}${j.progress != null ? ` · ${Math.round(j.progress * 100)} %` : ''}${j.score != null ? ` · ${esc(String(j.metric || '').toUpperCase())} ${j.score}${j.scores?.psnr != null ? `, PSNR ${j.scores.psnr} dB` : ''}` : ''}</div>
        ${j.waiting ? `<div class="muted small">${t('Väntar: {waiting}', { waiting: esc(why(j.waiting)) })}</div>` : ''}${j.error ? `<div class="muted small">${esc(why(j.error))}</div>` : ''}
        <div class="muted small">${esc(fmtDate(j.finished || j.created))}${j.status === 'done' && j.trash && j.trashUntil ? ` ${t('· originalet tas bort {v}', { v: esc(fmtDate(j.trashUntil)) })}` : ''}</div></div>
      <div class="hact">${['queued', 'running'].includes(j.status) ? `<button class="ghost small" data-cancel="${j.id}">${t('Avbryt')}</button>` : ''}
        ${j.status === 'done' && j.trash ? `<button class="ghost small" data-restore="${j.id}">${t('Återställ original')}</button><button class="danger small" data-purge="${j.id}">${t('Töm nu')}</button>` : ''}</div></li>`; }).join('')}</ul>`;
}

function settingsTab(D) {
  const s = D.settings, [from, to] = (s.window || '01:00-07:00').split('-'), e = D.encoders;
  const encLine = (c) => t('{v}: grafikkortet {v2}, processorn {v3}', { v: CODEC[c], v2: esc(e[c].hw || t('ingen')), v3: esc(e[c].cpu || t('ingen')) });
  return `<form id="kset"><p class="muted small">${encLine('hevc')} · ${encLine('av1')}</p>
    <div class="row" style="align-items:flex-end">
      <div><label for="kcodec">${t('Koda om till')}</label><select id="kcodec">${Object.entries(CODEC).map(([k, l]) => `<option value="${k}" ${k === s.codec ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div><label for="kq">${t('Kvalitet')}</label><select id="kq">${[['high', t('Hög (större filer)')], ['balanced', t('Balanserad')], ['small', t('Små filer')]].map(([k, l]) => `<option value="${k}" ${k === s.quality ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div><label for="knotseen">${t('"Inte sett" efter (dagar)')}</label><input id="knotseen" type="number" min="30" max="3650" value="${+s.notSeenDays}" style="width:100px"></div></div>
    <label class="switch"><input type="checkbox" id="kcpu" ${s.allowCpu ? 'checked' : ''}> ${t('Koda med processorn när grafikkortet inte kan (x265/SVT-AV1 – tar många timmar per film)')}</label>
    <label class="switch"><input type="checkbox" id="kidle" ${s.onlyIdle ? 'checked' : ''}> ${t('Bara när ingen tittar (pausar medan något spelas eller kodas om)')}</label>
    <label class="switch"><input type="checkbox" id="kpause" ${s.paused ? 'checked' : ''}> ${t('Pausa omkodningen')}</label>
    <label class="switch"><input type="checkbox" id="kalways" ${s.window ? '' : 'checked'}> ${t('Hela dygnet (annars bara inom tidsfönstret)')}</label>
    <div class="row" style="align-items:flex-end">
      <div><label for="kfrom">${t('Från')}</label><input id="kfrom" type="time" value="${esc(from)}"></div><div><label for="kto">${t('Till')}</label><input id="kto" type="time" value="${esc(to)}"></div>
      <div><label for="ktrash">${t('Dagar i papperskorgen')}</label><input id="ktrash" type="number" min="1" max="365" value="${+s.trashDays}" style="width:90px"></div>
      <div><label for="ksamp">${t('Stickprov')}</label><input id="ksamp" type="number" min="1" max="10" value="${+s.samples}" style="width:80px"></div></div>
    <div class="row" style="align-items:flex-end">
      <div><label for="kvmaf">${t('Lägsta VMAF')}</label><input id="kvmaf" type="number" min="50" max="100" step="0.5" value="${+s.minVmaf}" style="width:90px"></div>
      <div><label for="kssim">${t('Lägsta SSIM')}</label><input id="kssim" type="number" min="0.5" max="1" step="0.001" value="${+s.minSsim}" style="width:100px"></div>
      <div><label for="kpsnr">${t('Lägsta PSNR (dB)')}</label><input id="kpsnr" type="number" min="20" max="100" step="0.5" value="${+s.minPsnr}" style="width:90px"></div>
      <button class="small">${t('Spara')}</button></div>
    <p class="muted small">${t('Kvaliteten kontrolleras mot originalet på stickprov med {v}. Under gränsen behålls originalet och titeln markeras.\n      Alla ljud- och undertextspår, kapitel och metadata följer med. HDR, Dolby Vision och flätad bild hoppas över.', { v: D.metric === 'vmaf' ? 'VMAF' : t('SSIM och PSNR (ffmpeg saknar libvmaf)') })}</p></form>
    <h2>${t('Sonarr och Radarr')}</h2>
    <p class="small">${t('Radarr och Sonarr ser att filen ändrats. Med en kvalitetsprofil där <b>Upgrades Allowed</b> är på och en egen formatregel som ger x265/HEVC\n      minuspoäng kan de vilja "uppgradera" tillbaka och hämta en ny H.264-release. Undvik det genom att ge HEVC/AV1 samma eller högre poäng i\n      <i>Custom Formats</i> (eller ta bort regeln), eller stäng av <i>Upgrades Allowed</i> för profilen när kvaliteten redan är den du vill ha.\n      Filen behåller sitt namn{v}.', { v: D.arr.movie || D.arr.show ? '' : t(' (Radarr/Sonarr är inte kopplade här)') })}</p>`;
}

function ruleDialog(D, reload) {
  const libs = D.report.libraries, codecs = D.report.codecs.filter(c => !['hevc', 'av1', '?'].includes(c.key));
  const body = `<p class="muted small">${t('Alla titlar som matchar och ger vinst köas en gång (inte titlar som redan kodats om eller där kvaliteten inte räckte).')}</p>
    <label for="rlib">${t('Bibliotek')}</label><select id="rlib"><option value="">${t('Alla')}</option>${libs.map(l => `<option value="${+l.key}">${esc(l.label)}</option>`).join('')}</select>
    <fieldset style="border:0;padding:0;margin:8px 0"><legend class="small">${t('Codec')}</legend>${codecs.map(c => `<label class="switch"><input type="checkbox" data-rc="${esc(c.key)}" checked> ${esc(c.label)} (${gb(c.bytes)})</label>`).join('') || t('<span class="muted small">Inget att koda om</span>')}</fieldset>
    <div class="row"><div><label for="rmb">${t('Minst MB per minut')}</label><input id="rmb" type="number" min="0" step="1" value="0" style="width:100px"></div>
      <div><label for="rseen">${t('Inte sedd på (dagar, 0 = alla)')}</label><input id="rseen" type="number" min="0" value="0" style="width:100px"></div>
      <div><label for="rgain">${t('Minst vinst (%)')}</label><input id="rgain" type="number" min="0" max="95" value="20" style="width:90px"></div></div>
    <p id="rprev" class="small" aria-live="polite"></p>`;
  const rule = (h) => ({ library: +h.$('#rlib').value || null, codecs: [...h.el.querySelectorAll('[data-rc]:checked')].map(x => x.dataset.rc),
    minMbPerMin: +h.$('#rmb').value || 0, notSeenDays: +h.$('#rseen').value || 0, minGainPct: +h.$('#rgain').value || 0 });
  openDialog({ title: t('Koda om enligt regel'), body, actions: [{ label: t('Avbryt') },
    { label: t('Visa vad som matchar'), onClick: async (h) => {
      const r = await api('/admin/shrink/queue', { method: 'POST', body: { rule: rule(h), preview: true } });
      h.$('#rprev').innerHTML = r.matches ? `${t('<b>{matches} titlar</b>, uppskattad vinst {saving}: {v}{v2}', { matches: r.matches, saving: gb(r.saving), v: r.titles.slice(0, 8).map(t => esc(nameOf(t))).join(', '), v2: r.matches > 8 ? ' …' : '' })}` : t('Inga titlar matchar.');
      return false;
    } },
    { label: t('Lägg i kön'), kind: 'primary', onClick: async (h) => {
      const r = await api('/admin/shrink/queue', { method: 'POST', body: { rule: rule(h) } });
      toast(r.queued.length ? t('{queuedN} titlar i kön', { queuedN: r.queued.length }) : t('Inga titlar matchar')); reload();
    } }] });
}
