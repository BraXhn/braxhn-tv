// Vy: installationsguiden (#/setup/<steg>) – leder en ny administratör genom språk, metadata, bibliotek,
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
// hårdvaruomkodning, åtkomst utanför hemmet och hushållet. Läget (aktuellt steg, klarade/överhoppade steg och
// om guiden är klar) sparas på servern: server/routes/setup.js. Kan köras igen från Administration.
// Fungerar med fjärrkontroll/tangentbord: ↑/↓ flyttar mellan kontrollerna, ←/→ mellan stegen i stegindikatorn.
import { $, $$, act, api, esc, keyClick, later, main, me, toast, toastErr, views, t, locale } from '../core.js';
import { boot, loadLibs } from '../router.js';
import { confirmDialog } from '../ui/dialog.js';
import { emptyState, errorState, bindRetry, loadingState } from '../ui/states.js';

const STEPS = [
  { id: 'welcome', title: t('Välkommen') }, { id: 'metadata', title: 'Metadata' }, { id: 'libraries', title: t('Bibliotek') },
  { id: 'hardware', title: t('Omkodning') }, { id: 'remote', title: t('Utanför hemmet') }, { id: 'household', title: t('Hushållet') }, { id: 'done', title: t('Klart') }];
const TYPES = { movie: t('Filmer'), show: t('Serier'), music: t('Musik'), audiobook: t('Ljudböcker'), photo: t('Foton'), ebook: t('E-böcker') };
const LANGS = [['sv-SE', t('Svenska')], ['en-US', t('Engelska')], ['nb-NO', t('Norska')], ['da-DK', t('Danska')], ['fi-FI', t('Finska')], ['de-DE', t('Tyska')]];
const REPO = 'https://github.com/BraXhn/braxhn-tv';
const ext = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const yes = (ok, text) => `<span class="${ok ? 'ok-badge' : 'warn-badge'}">${esc(text)}</span>`;

views.setup = async (step) => {
  if (!me.is_admin) { location.hash = '#/'; return; }
  if (!me.adminHere) {
    main.innerHTML = emptyState({ icon: '🔒', title: t('Installationen görs från hemnätverket'), text: t('Av säkerhetsskäl kan servern bara ställas in från hemnätverket eller via VPN.'), action: { label: t('Till startsidan'), href: '#/' } });
    return;
  }
  const S = await api('/setup');
  const idx = STEPS.findIndex(s => s.id === step);
  if (idx < 0) { location.replace('#/setup/' + S.current); return; }
  if (S.current !== step) api('/setup', { method: 'PUT', body: { current: step }, bg: true }).catch(() => {});
  const cur = STEPS[idx];
  const mark = (id, status) => api('/setup', { method: 'PUT', body: { step: id, status } }).then(r => { S.state = r.state; });
  const go = (i) => { location.hash = '#/setup/' + STEPS[Math.max(0, Math.min(STEPS.length - 1, i))].id; };
  const last = idx === STEPS.length - 1;

  main.innerHTML = `<div class="setup">
    <div class="setup-head"><h1>${t('Kom igång med BraXhn TV')}</h1><button type="button" class="ghost small" id="stskipall">${t('Hoppa över guiden')}</button></div>
    <nav aria-label="${t('Steg i installationen')}"><ol class="setup-steps">${STEPS.map((s, i) => {
      const st = S.state[s.id];
      return `<li><a href="#/setup/${s.id}" class="${st || ''}" ${i === idx ? 'aria-current="step"' : ''} aria-label="${t('Steg {v}: {title}{v2}', { v: i + 1, title: esc(s.title), v2: st === 'done' ? t(' (klart)') : st === 'skipped' ? t(' (överhoppat)') : '' })}">
        <span class="n" aria-hidden="true">${st === 'done' ? '✓' : i + 1}</span><span class="t">${esc(s.title)}</span></a></li>`;
    }).join('')}</ol></nav>
    <p class="setup-count muted small" aria-hidden="true">${t('Steg {v} av {STEPSN} · {title}', { v: idx + 1, STEPSN: STEPS.length, title: esc(cur.title) })}</p>
    <section class="panel setup-body" aria-labelledby="sttitle"><h2 id="sttitle" tabindex="-1">${esc(cur.title)}</h2><div id="stbody">${loadingState({ kind: 'inline' })}</div></section>
    <div class="setup-nav">
      <button type="button" class="ghost" id="stback" ${idx === 0 ? 'hidden' : ''}>${t('← Tillbaka')}</button><span class="sp"></span>
      ${last ? '' : t('<button type="button" class="ghost" id="stskip">Hoppa över</button>')}
      <button type="button" class="primary" id="stnext">${last ? t('Slutför och gå till startsidan') : idx === 0 ? t('Sätt igång →') : t('Nästa →')}</button></div></div>`;

  $('#stback').onclick = () => go(idx - 1);
  if ($('#stskip')) $('#stskip').onclick = act(async () => { await mark(cur.id, 'skipped'); go(idx + 1); });
  $('#stnext').onclick = act(async () => {
    if (last) { await finish(false); return; }
    await mark(cur.id, 'done'); go(idx + 1);
  });
  $('#stskipall').onclick = act(async () => {
    if (!await confirmDialog(t('Du kan köra guiden när som helst under Administration → Kör guiden igen.'), { title: t('Hoppa över installationsguiden?'), okLabel: t('Hoppa över') })) return;
    await finish(true);
  });
  bindKeys();

  const body = $('#stbody');
  try { await STEP[cur.id](body, S, { mark, go: () => go(idx + 1) }); }
  catch (e) { if (e.aborted) throw e; body.innerHTML = errorState(e, { retry: true, compact: true }); bindRetry(body, () => views.setup(step)); }
  // Fokus på stegets rubrik (skärmläsare läser upp den, fjärrkontrollen går vidare med ↓)
  $('#sttitle')?.focus({ preventScroll: true });
};

async function finish(skipped) {
  await api('/setup', { method: 'PUT', body: { done: true, skipped } });
  await boot();
  toast(skipped ? t('Guiden hoppades över – du hittar den under Administration') : t('Klart! Välkommen till BraXhn TV'));
  location.hash = '#/';
}

// ↑/↓ flyttar fokus mellan kontrollerna i guiden (TV-fjärrkontroller utan egen navigering), ←/→ i stegindikatorn
function bindKeys() {
  const root = $('.setup');
  root.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || document.querySelector('dialog[open]')) return;
    const t = e.target;
    const inStepper = t.closest('.setup-steps');
    if (inStepper && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const links = $$('.setup-steps a'); const i = links.indexOf(t);
      links[Math.max(0, Math.min(links.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))]?.focus(); e.preventDefault(); return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    // Listor, radioknappar, sifferfält och textrutor använder själva ↑/↓
    if (t.matches('select, textarea, input[type=number], input[type=radio]')) return;
    const all = $$('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]', root).filter(el => el.offsetParent !== null && !el.closest('[hidden]'));
    const i = all.indexOf(t);
    const n = all[i + (e.key === 'ArrowDown' ? 1 : -1)] || (i < 0 ? all[0] : null);
    if (n) { e.preventDefault(); n.focus(); n.scrollIntoView({ block: 'nearest' }); }
  });
}

// Liten resultatrad under en knapp (role=status så att skärmläsare läser upp den)
const result = (el, ok, html) => { el.className = 'setup-res ' + (ok === null ? 'muted' : ok ? 'ok' : 'bad'); el.innerHTML = html; };

const STEP = {
  // ---------- 1. Välkommen + språk/region ----------
  async welcome(el, S) {
    const set = await api('/settings');
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    let serverTime = '';
    try { serverTime = new Date().toLocaleString(locale, { timeZone: S.timezone, dateStyle: 'medium', timeStyle: 'short' }); } catch {}
    el.innerHTML = `<p>${t('Hej {name}! Guiden tar ungefär fem minuter och hjälper dig att hitta dina filmer, serier, musik och ljudböcker,\n      få snygga affischer och beskrivningar, och ge resten av hushållet egna konton. Allt går att ändra senare under <b>Administration</b>.', { name: esc(me.name) })}</p>
      <label for="stlang">${t('Språk för titlar, beskrivningar och affischer')}</label>
      <select id="stlang">${LANGS.map(([v, n]) => `<option value="${v}" ${set.language === v ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <p class="muted small">${t('Svenska är standard. Saknas en svensk beskrivning används den engelska. Appens eget språk väljer var och en under Mitt konto.')}</p>
      <h3>${t('Tidszon')}</h3>
      <p>${t('Servern använder <b>{timezone}</b>{v}. Den används för TV-guiden, inspelningar, kalendern och loggen.', { timezone: esc(S.timezone), v: serverTime ? ` ${t('(klockan är {serverTime} där)', { serverTime: esc(serverTime) })}` : '' })}</p>
      ${browserTz && browserTz !== S.timezone ? `<p class="setup-res bad">${t('Din enhet använder {browserTz}. Sätt variabeln <code>TZ</code> i Unraid-mallen (Docker → BraXhn TV → Edit), t.ex. <code>TZ=Europe/Stockholm</code>, och starta om containern.', { browserTz: esc(browserTz) })}</p>` : t('<p class="setup-res ok">✓ Samma tidszon som din enhet.</p>')}
      <p class="muted small">${t('Mediamappen i containern: <code>{mediaRoot}</code>.', { mediaRoot: esc(S.mediaRoot) })}</p>`;
    $('#stlang').onchange = act(async () => { await api('/settings', { method: 'PUT', body: { language: $('#stlang').value } }); toast(t('Språket sparat')); });
  },

  // ---------- 2. Metadata (TMDB) ----------
  async metadata(el, S, { mark }) {
    const c = S.checks;
    el.innerHTML = `<p>${t('<b>TMDB</b> (The Movie Database) är en gratis filmdatabas. Med en egen nyckel hämtar BraXhn TV affischer, bakgrundsbilder,\n      beskrivningar, betyg, åldersgränser, skådespelare och trailers. Nyckeln är gratis och tar ett par minuter att skaffa.')}</p>
      <ol class="setup-list"><li>${t('Skapa ett konto på {v}.', { v: ext('https://www.themoviedb.org/signup', 'themoviedb.org') })}</li>
      <li>${t('Gå till {v} och ansök om en nyckel (välj <i>Personal</i>/privat bruk).', { v: ext('https://www.themoviedb.org/settings/api', t('Inställningar → API')) })}</li>
      <li>${t('Kopiera <b>API-nyckel</b> (v3) eller <b>API-läsåtkomsttoken</b> och klistra in här.')}</li></ol>
      <p>${t('Läge: {v}', { v: c.tmdb ? yes(true, c.tmdbFromEnv ? t('Nyckel satt via miljövariabel') : t('Nyckel sparad')) : yes(false, t('Ingen nyckel')) })}</p>
      <label for="sttk">${t('TMDB-nyckel')}</label>
      <input id="sttk" type="password" autocomplete="off" spellcheck="false" placeholder="${c.tmdb ? t('Lämna tomt för att testa den sparade') : t('Klistra in nyckeln')}">
      <div class="row" style="margin-top:12px"><button type="button" class="ghost" id="sttest">${t('Testa')}</button><button type="button" class="primary" id="stsave">${t('Testa och spara')}</button></div>
      <p id="sttres" role="status" class="setup-res muted"></p>
      <details class="setup-more"><summary>${t('Vad får jag utan nyckel?')}</summary>
      <p>${t('BraXhn TV fungerar ändå: titlar och år tas från fil- och mappnamnen, bilderna blir stillbilder ur själva videon, och musik och ljudböcker\n      använder taggarna och omslagen i filerna. Det som saknas är affischer, beskrivningar, betyg, skådespelare, trailers, svensk åldersgräns\n      (barnprofiler ser då bara titlar utan känd gräns om du tillåter det), sidan Strömmande och datum för kommande avsnitt.')}</p></details>`;
    const test = async () => {
      const r = $('#sttres'); result(r, null, t('Frågar TMDB…'));
      try { await api('/setup/tmdb-test', { method: 'POST', body: { key: $('#sttk').value } }); result(r, true, t('✓ TMDB godkände nyckeln.')); return true; }
      catch (e) { if (e.aborted) throw e; result(r, false, esc(e.message)); return false; }
    };
    $('#sttest').onclick = act(test);
    $('#stsave').onclick = act(async () => {
      const key = $('#sttk').value.trim();
      if (!key) { if (c.tmdb) await test(); else result($('#sttres'), false, t('Klistra in nyckeln först.')); return; }
      if (!await test()) return;
      await api('/settings', { method: 'PUT', body: { tmdbKey: key } });
      $('#sttk').value = ''; c.tmdb = true;
      if (c.libraries.length) await api('/scan', { method: 'POST' }).catch(() => {});
      result($('#sttres'), true, t('✓ Nyckeln är sparad.{v}', { v: c.libraries.length ? t(' Metadata hämtas nu i bakgrunden.') : t(' Metadata hämtas när du lagt till bibliotek.') }));
      await mark('metadata', 'done');
    });
  },

  // ---------- 3. Bibliotek ----------
  async libraries(el, S, { mark }) {
    el.innerHTML = `<p>${t('Ett bibliotek är en mapp med en sorts innehåll. BraXhn TV har letat i <code>{mediaRoot}</code> och gissat vad mapparna innehåller\n      – från namnet (Filmer/Movies, Serier/TV, Musik/Music, Ljudböcker/Audiobooks) och från filerna (avsnitt som <code>S01E02</code> blir serier).', { mediaRoot: esc(S.mediaRoot) })}</p>
      <div id="stlibs"></div>
      <h3>${t('Förslag')}</h3><div id="stsug">${loadingState({ kind: 'inline', label: t('Letar efter mappar…') })}</div>
      <details class="setup-more" id="stother"><summary>${t('Välj en annan mapp')}</summary>
        <div class="row"><div style="flex:1;min-width:160px"><label for="ston">${t('Namn')}</label><input id="ston" placeholder="${t('Filmer')}"></div>
        <div><label for="stot">${t('Typ')}</label><select id="stot">${Object.entries(TYPES).map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></div></div>
        <label for="stop">${t('Mapp')}</label><input id="stop" value="${esc(S.mediaRoot)}">
        <div class="fsb" id="stfsb"></div>
        <div class="row" style="margin-top:12px"><button type="button" class="primary" id="stoadd">${t('Lägg till och skanna')}</button></div></details>
      <div id="stscan" class="setup-scan" role="status" aria-live="polite"></div>
      <p class="muted small">${t('Hittar du inte mappen? Lägg till den som en sökväg i Unraid-mallen (t.ex. <code>/mnt/user/Filmer</code> → <code>{mediaRoot}/Filmer</code>) och starta om containern.\n      Hur filerna bör heta står i README under <i>Namnge filer</i>.', { mediaRoot: esc(S.mediaRoot) })}</p>`;
    let libs = S.checks.libraries;
    const drawLibs = () => {
      $('#stlibs').innerHTML = libs.length ? `<h3>${t('Dina bibliotek')}</h3><ul class="setup-libs">${libs.map(l => `<li><b>${esc(l.name)}</b> <span class="muted">${l.home_video ? t('Hemvideor') : TYPES[l.type] || ''} · ${(l.paths || [l.path]).map(p => `<code>${esc(p)}</code>`).join(', ')}</span> <span class="ok-badge">${+l.count || 0} ${l.type === 'music' ? 'album' : l.type === 'audiobook' ? t('böcker') : l.type === 'photo' ? t('foton') : l.type === 'ebook' ? t('böcker') : t('titlar')}</span></li>`).join('')}</ul>` : '';
    };
    drawLibs();
    const add = async (name, type, p, homeVideo = false) => {
      await api('/libraries', { method: 'POST', body: { name, type, path: p, homeVideo: homeVideo && type === 'movie' } });
      toast(t('{name} tillagt – skannar', { name }));
      await loadLibs(); await mark('libraries', 'done');
      await suggest(); poll();
    };
    const suggest = async () => {
      const box = $('#stsug');
      let r;
      try { r = await api('/setup/suggest'); } catch (e) { if (e.aborted) throw e; box.innerHTML = errorState(e, { retry: true, compact: true }); bindRetry(box, suggest); return; }
      if (!r.suggestions.length) {
        box.innerHTML = emptyState({ icon: '📂', compact: true, title: t('Inga mappar under {root}', { root: r.root }), text: t('Lägg till dina mediamappar som sökvägar i Unraid-mallen och starta om containern – eller välj en mapp nedan.') });
        return;
      }
      box.innerHTML = `<ul class="setup-sug">${r.suggestions.map((s, i) => `<li>
        <div class="info"><b>📁 ${esc(s.name)}</b><div class="muted small">${esc(s.reason)}${s.homeVideo ? t(' · läggs till som hemvideor (ingen TMDB, sorteras på datum)') : ''}</div></div>
        ${s.library ? `<span class="ok-badge">${t('Tillagd i {library}', { library: esc(s.library) })}</span>` : `<label class="sr-only" for="sgt${i}">${t('Typ för {name}', { name: esc(s.name) })}</label>
        <select id="sgt${i}" data-sgt="${i}">${s.type ? '' : t('<option value="">Välj typ…</option>')}${Object.entries(TYPES).map(([v, n]) => `<option value="${v}" ${s.type === v ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <label class="sr-only" for="sgd${i}">${t('Bibliotek för {name}', { name: esc(s.name) })}</label><select id="sgd${i}" data-sgd="${i}" hidden></select>
        <button type="button" class="${s.type ? 'primary' : 'ghost'} small" data-sga="${i}" ${s.type ? '' : 'disabled'}>${t('Lägg till')}</button>`}</li>`).join('')}</ul>`;
      // Samma sorts innehåll i en mapp till (t.ex. en andra disk med filmer): lägg till i ett befintligt bibliotek
      const targets = (i) => {
        const sel = $(`[data-sgd="${i}"]`); if (!sel) return;
        const type = $(`[data-sgt="${i}"]`).value, same = libs.filter(l => l.type === type && !!l.home_video === !!r.suggestions[i].homeVideo);
        sel.innerHTML = t('<option value="">Som nytt bibliotek</option>') + same.map(l => `<option value="${+l.id}">I ${esc(l.name)}</option>`).join('');
        sel.hidden = !same.length;
      };
      r.suggestions.forEach((_, i) => targets(i));
      $$('[data-sgt]').forEach(sel => sel.onchange = () => { const b = $(`[data-sga="${sel.dataset.sgt}"]`); b.disabled = !sel.value; targets(sel.dataset.sgt); });
      $$('[data-sga]').forEach(b => b.onclick = act(async () => {
        const i = +b.dataset.sga, s = r.suggestions[i], type = $(`[data-sgt="${i}"]`).value, into = $(`[data-sgd="${i}"]`)?.value;
        b.disabled = true;
        try {
          if (into) {
            await api(`/libraries/${+into}`, { method: 'PUT', body: { addPath: s.path } });
            toast(t('Mappen lades till i {v} – skannar', { v: libs.find(l => l.id === +into)?.name || t('biblioteket') }));
            await loadLibs(); await mark('libraries', 'done'); await suggest(); poll();
          } else await add(s.type === type ? s.suggestedName : TYPES[type], type, s.path, s.homeVideo);
        } finally { b.disabled = false; }
      }));
    };
    // Mappväljaren (samma som i Administration)
    const browse = async (p) => {
      try {
        const r = await api('/fs?path=' + encodeURIComponent(p));
        $('#stop').value = r.path;
        $('#stfsb').innerHTML = (r.parent ? `<div data-p="${esc(r.parent)}">⬆ ..</div>` : '') + r.dirs.map(d => `<div data-p="${esc(r.path + '/' + d)}">📁 ${esc(d)}</div>`).join('')
          || t('<div class="muted" role="status">Inga undermappar</div>');
        $$('#stfsb [data-p]').forEach(x => keyClick(x).onclick = () => browse(x.dataset.p));
      } catch (e) { if (!e.aborted && $('#stfsb')) $('#stfsb').innerHTML = errorState(e, { compact: true }); }
    };
    $('#stother').ontoggle = () => { if ($('#stother').open && !$('#stfsb').innerHTML) browse(S.mediaRoot); };
    $('#stoadd').onclick = act(async () => {
      const name = $('#ston').value.trim() || TYPES[$('#stot').value];
      await add(name, $('#stot').value, $('#stop').value);
    });
    // Skanningens förlopp live (samma källa som Administration)
    let seq = 0;
    const poll = async () => {
      const my = ++seq;
      const [s, L] = await Promise.all([api('/scan'), api('/libraries')]);
      const box = $('#stscan'); if (!box || my !== seq) return;
      libs = L.map(l => ({ ...l })); drawLibs();
      const bar = (x) => `<div class="prog" aria-hidden="true"><i style="width:${x.total ? x.done / x.total * 100 : 0}%"></i></div>`;
      const a = s.analysis;
      box.innerHTML = s.running ? `${t('⏳ Skannar <b>{v}</b>: {phase} {done}/{total}{v2}{s}', { v: esc(s.library || ''), phase: esc(s.phase), done: s.done, total: s.total, v2: s.queued ? ` ${t('· {queued} till i kö', { queued: s.queued })}` : '', s: bar(s) })}`
        : libs.length ? t('✓ Skanningen är klar.{v}', { v: a?.running ? '' : t(' Du kan gå vidare medan resten analyseras.') }) : '';
      if (a?.running) box.innerHTML += `<div class="muted small" style="margin-top:8px">${t('I bakgrunden: {v} – {phase} {done}/{total}{a}', { v: esc(a.library || ''), phase: esc(a.phase), done: a.done, total: a.total, a: bar(a) })}</div>`;
      later(poll, s.running || a?.running ? 1500 : 8000);
    };
    await suggest();
    poll().catch(e => { if (!e.aborted) console.warn(e); });
  },

  // ---------- 4. Hårdvaruomkodning ----------
  async hardware(el) {
    const h = await api('/setup/hw');
    const NAMES = { none: t('processorn'), vaapi: 'VAAPI (Intel/AMD)', qsv: 'Intel Quick Sync', nvenc: 'NVIDIA NVENC' };
    const works = h.active !== 'none', failed = h.wanted !== 'none' && h.active === 'none';
    const rec = h.recommend;
    let advice;
    if (works) advice = `<p class="setup-res ok">${t('✓ Hårdvaruomkodning med <b>{v}</b> fungerar. Filmer som måste konverteras kodas på grafikkretsen.', { v: esc(NAMES[h.active] || h.active) })}</p>`;
    else if (failed) advice = `<p class="setup-res bad">${t('✕ <code>HWACCEL={wanted}</code> är inställt men fungerar inte, så processorn används.<br>{v}', { wanted: esc(h.wanted), v: esc(h.error || '') })}</p>
      ${h.hint ? `<p><b>${t('Åtgärd:')}</b> ${esc(h.hint)}</p>` : ''}`;
    else if (rec !== 'none') advice = `<p class="setup-res">${t('Servern ser {v} men använder processorn. Sätt <b>Hårdvaruomkodning</b> (<code>HWACCEL</code>) till <code>{rec}</code> i Unraid – testa gärna först med knappen nedan.', { v: rec === 'nvenc' ? t('ett NVIDIA-kort') : t('en grafikkrets (<code>/dev/dri</code>)'), rec: esc(rec) })}</p>`;
    else advice = `<p class="setup-res">${t('Ingen grafikkrets syns i containern, så processorn används. Det räcker oftast: en modern processor klarar 1080p i realtid.\n      4K HDR är tungt utan grafikkrets.')}</p>`;
    const modes = [...new Set(['none', h.wanted, rec].filter(m => m && m !== 'none'))];
    el.innerHTML = `<p>${t('När en enhet inte kan spela filen som den är (t.ex. 4K HEVC på en äldre TV, eller låg bandbredd utanför hemmet) kodar servern om den\n      medan du tittar. Det går mycket lättare med en grafikkrets.')}</p>${advice}
      <table class="setup-hw"><tr><th scope="row">${t('Inställt (HWACCEL)')}</th><td>${t('<code>{wanted}</code> → används: <b>{v}</b>', { wanted: esc(h.wanted), v: esc(NAMES[h.active] || h.active) })}</td></tr>
      <tr><th scope="row">Intel/AMD (/dev/dri)</th><td>${h.dri.length ? esc(h.dri.join(', ')) : t('<span class="muted">saknas i containern</span>')}</td></tr>
      <tr><th scope="row">NVIDIA</th><td>${h.nvidia.device ? esc(h.nvidia.gpus.join(', ') || t('hittat')) : t('<span class="muted">saknas i containern</span>')}</td></tr>
      <tr><th scope="row">${t('ffmpeg kan')}</th><td>${esc(h.encoders.join(', ') || t('okänt'))}</td></tr>
      <tr><th scope="row">Processor</th><td>${t('{model} · {cores} kärnor', { model: esc(h.cpu.model), cores: h.cpu.cores })}</td></tr></table>
      <h3>${t('Testa omkodning')}</h3><p class="muted small">${t('Kodar en testbild i 720p i fyra sekunder. Ändrar ingenting.')}</p>
      <div class="row">${['none', ...modes].map(m => `<button type="button" class="ghost" data-hwt="${esc(m)}">${t('Testa {v}', { v: esc(NAMES[m] || m) })}</button>`).join('')}</div>
      <p id="sthwres" role="status" class="setup-res muted"></p>
      <details class="setup-more" ${rec !== 'none' && !works ? 'open' : ''}><summary>${t('Så ställer du in det i Unraid')}</summary>
      <ul class="setup-list">
        <li>${t('<b>Intel (iGPU) eller AMD:</b> Docker → BraXhn TV → <b>Edit</b>. Fyll i <b>GPU-enhet</b> med <code>/dev/dri</code> och sätt <b>Hårdvaruomkodning</b> till <code>qsv</code> (Intel) eller <code>vaapi</code> (Intel/AMD). Tryck <b>Apply</b>.')}</li>
        <li>${t('<b>NVIDIA:</b> installera pluginen <i>Nvidia-Driver</i> och starta om Unraid. Använd sedan mallen {v} – den har redan <code>HWACCEL=nvenc</code>,\n          <code>--runtime=nvidia</code> och <code>NVIDIA_VISIBLE_DEVICES=all</code>. Med den vanliga mallen ({v2}): sätt <i>Hårdvaruomkodning</i> till <code>nvenc</code>, slå på <i>Avancerad vy</i>, lägg till <code>--runtime=nvidia</code> under <i>Extra Parameters</i> och fyll i <i>NVIDIA: grafikkort</i> (<code>all</code>).', { v: ext(REPO + '/blob/main/braxhn-tv-nvidia.xml', 'braxhn-tv-nvidia.xml'), v2: ext(REPO + '/blob/main/braxhn-tv.xml', 'braxhn-tv.xml') })}</li>
        <li>${t('Fungerar hårdvaran inte går servern automatiskt över till processorn, och Administration → Säkerhetskontroll visar varför.')}</li></ul></details>`;
    $$('[data-hwt]').forEach(b => b.onclick = act(async () => {
      const m = b.dataset.hwt, r = $('#sthwres');
      $$('[data-hwt]').forEach(x => x.disabled = true);
      result(r, null, t('Testar {v}…', { v: esc(NAMES[m] || m) }));
      try {
        const tm = await api('/setup/hw-test', { method: 'POST', body: { mode: m } });
        if (tm.ok) result(r, true, t('✓ {v}: {fps} bilder/s i 720p – ungefär {v2} gånger realtid.{v3}', { v: esc(NAMES[m] || m), fps: tm.fps, v2: (tm.fps / 25).toFixed(1).replace('.', ','), v3: m !== 'none' && m !== h.active ? ` ${t('Sätt <code>HWACCEL={m}</code> i Unraid för att använda det.', { m: esc(m) })}` : '' }));
        else result(r, false, t('✕ {v} fungerar inte: {v2}{v3}', { v: esc(NAMES[m] || m), v2: esc(tm.error || ''), v3: tm.hint ? `<br><b>${t('Åtgärd:')}</b> ${esc(tm.hint)}` : '' }));
      } finally { $$('[data-hwt]').forEach(x => x.disabled = false); }
    }));
  },

  // ---------- 5. Åtkomst utanför hemmet ----------
  async remote(el, S) {
    const c = S.checks;
    el.innerHTML = `<p>${t('Hemma fungerar allt direkt. Vill ni titta i mobilen på resan, i bilen eller hos mormor finns tre vägar:')}</p>
      <ul class="setup-list"><li>${t('<b>VPN</b> (NetBird, Tailscale, WireGuard i routern) – enklast och säkrast: inget öppnas mot internet och telefonen räknas som hemma.')}</li>
      <li>${t('<b>Egen domän med HTTPS</b> via en omvänd proxy (Nginx Proxy Manager, SWAG) – krävs för bilen och Chromecast utanför hemmet.')}</li>
      <li>${t('<b>Inbyggd HTTPS</b> med ett gratis certifikat från Let\'s Encrypt, utan proxy.')}</li></ul>
      <fieldset class="setup-choice"><legend>${t('Hur ska ni nå servern utifrån?')}</legend>
        <label class="switch"><input type="radio" name="strm" value="vpn" ${c.publicUrl ? '' : 'checked'}> ${t('Bara hemma eller via VPN')}</label>
        <label class="switch"><input type="radio" name="strm" value="url" ${c.publicUrl ? 'checked' : ''}> ${t('Via en egen adress på internet')}</label></fieldset>
      <div id="sturlw" ${c.publicUrl ? '' : 'hidden'}><label for="stpu">${t('Publik adress')}</label><input id="stpu" type="url" inputmode="url" placeholder="${t('https://tv.dindomän.se')}" value="${esc(c.publicUrl)}">
        <p class="muted small">${t('Läge: {v} {v2}', { v: c.https ? yes(true, t('Du är ansluten med HTTPS')) : yes(false, t('Den här anslutningen är okrypterad')), v2: c.cert ? yes(true, t('Inbyggt certifikat finns')) : '' })}</p></div>
      <label class="switch"><input type="checkbox" id="st2fa" ${c.require2faRemote ? 'checked' : ''}> ${t('Kräv tvåstegsverifiering för inloggning utanför hemmet (rekommenderas)')}</label>
      <p class="muted small">${t('Ditt konto: {v}.\n        Varje konto kan också spärras till hemnätet under Hushållet eller Administration.', { v: c.my2fa ? yes(true, t('Tvåstegsverifiering på')) : `${t('{v} – <a href="#/account">aktivera den under Mitt konto</a> (autentiseringsapp eller passkey)', { v: yes(false, t('Ingen tvåstegsverifiering')) })}` })}</p>
      <div class="row" style="margin-top:12px"><button type="button" class="primary" id="strsave">${t('Spara')}</button></div>
      <p id="strres" role="status" class="setup-res muted"></p>
      <div class="row setup-links"><a class="btn ghost" href="#/admin/security">${t('Öppna säkerhetskontrollen')}</a><a class="btn ghost" href="#/admin/acme">${t('HTTPS med Let\'s Encrypt')}</a></div>
      <p class="muted small">${t('Administration går bara att nå hemifrån eller via VPN, oavsett vad du väljer här.')}</p>`;
    $$('[name=strm]').forEach(r => r.onchange = () => { $('#sturlw').hidden = $('[name=strm]:checked').value !== 'url'; });
    $('#strsave').onclick = act(async () => {
      const url = $('[name=strm]:checked').value === 'url' ? $('#stpu').value.trim() : '';
      const want2fa = $('#st2fa').checked;
      if (want2fa && !c.my2fa && !c.require2faRemote && !await confirmDialog(t('Du har själv inte tvåstegsverifiering. Utanför hemmet kan du inte logga in förrän du aktiverat den. Fortsätta?'), { okLabel: t('Fortsätt') })) return;
      try { await api('/settings', { method: 'PUT', body: { publicUrl: url, require2faRemote: want2fa } }); }
      catch (e) { if (e.aborted) throw e; result($('#strres'), false, esc(e.message)); return; }
      c.publicUrl = url; c.require2faRemote = want2fa;
      result($('#strres'), true, t('✓ Sparat.'));
    });
  },

  // ---------- 6. Hushållet ----------
  async household(el, S) {
    const c = S.checks;
    const draw = () => {
      el.innerHTML = `<p>${t('<b>Konton</b> har eget lösenord – ge varje vuxen ett eget. <b>Profiler</b> delar ditt konto, som på Netflix: man väljer profil under <i>Vem tittar?</i>.\n        En <b>barnprofil</b> ser bara filmer och serier inom åldersgränsen.')}</p>
        <ul class="setup-libs">${c.accounts.map(a => `<li>👤 <b>${esc(a.name)}</b> <span class="muted">${a.admin ? t('administratör') : t('konto')}</span></li>`).join('')}
          ${c.profiles.map(p => `<li>${p.kid ? '🧸' : '🙂'} <b>${esc(p.name)}</b> <span class="muted">${p.kid ? t('barnprofil, max {maxAge} år', { maxAge: +p.maxAge }) : t('profil')}</span></li>`).join('')}</ul>
        <div class="setup-forms">
        <form id="stuser" class="setup-form"><h3>${t('Nytt konto')}</h3>
          <label for="stun">${t('Namn')}</label><input id="stun" required maxlength="64" autocomplete="off">
          <label for="stup">${t('Lösenord (minst 10 tecken)')}</label><input id="stup" type="password" minlength="10" required autocomplete="new-password">
          <label class="switch"><input type="checkbox" id="stur" checked> ${t('Får titta utanför hemmet')}</label>
          <label class="switch"><input type="checkbox" id="stua"> ${t('Administratör')}</label>
          <button class="primary">${t('Skapa konto')}</button></form>
        <form id="stkid" class="setup-form"><h3>${t('Ny barnprofil')}</h3>
          <label for="stkn">${t('Namn')}</label><input id="stkn" required maxlength="40" autocomplete="off">
          <label for="stka">${t('Åldersgräns')}</label><select id="stka">${[[0, t('Barntillåtet')], [7, t('7 år')], [11, t('11 år')], [15, t('15 år')]].map(([v, n]) => `<option value="${v}" ${v === 7 ? 'selected' : ''}>${n}</option>`).join('')}</select>
          <label for="stkp">${t('PIN för att byta från profilen (valfri, 4–8 siffror)')}</label><input id="stkp" type="password" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" autocomplete="off">
          <button class="primary">${t('Skapa barnprofil')}</button></form></div>
        <h3>${t('Logga in på TV:n med kod')}</h3>
        ${c.quickConnect ? `<p>${t('Slipp skriva lösenord med fjärrkontrollen: välj <b>Logga in med kod</b> på TV:n (webbläsaren eller appen). En sexsiffrig kod visas –\n          godkänn den från telefonen under <b>Godkänn inloggning på TV</b> i menyn, eller skanna QR-koden. <a href="#/quickconnect">Godkänn en kod nu</a>.')}</p>`
          : t('<p>Snabbinloggning med kod är avstängd. <button type="button" class="ghost small" id="stqc">Slå på</button></p>')}
        <h3>${t('Appar')}</h3>
        <ul class="setup-list"><li>${t('<b>Webben</b> fungerar i alla webbläsare: <code>{origin}</code>{v}. På iPhone: Dela → <i>Lägg till på hemskärmen</i>; på Android: menyn → <i>Installera app</i>.', { origin: esc(location.origin), v: c.publicUrl ? ` ${t('eller <code>{publicUrl}</code>', { publicUrl: esc(c.publicUrl) })}` : '' })}</li>
          <li>${t('<b>iPhone, iPad och Apple TV:</b> appen finns i {v} och byggs med Xcode (se dess README).', { v: ext(REPO + '/tree/main/apps/apple', 'apps/apple') })}</li>
          <li>${t('<b>Google TV/Android TV och bilen (Android Automotive):</b> ladda ner APK-filen under {v} → <i>Android Automotive-app</i> → <i>Artifacts</i> (se {v2}).', { v: ext(REPO + '/actions', 'GitHub Actions'), v2: ext(REPO + '/tree/main/apps/automotive', 'apps/automotive') })}</li>
          <li>${t('<b>Smart-TV utan app:</b> slå på DLNA under Administration → Drift.')}</li></ul>`;
      $('#stuser').onsubmit = act(async (e) => {
        e.preventDefault();
        const name = $('#stun').value.trim();
        await api('/users', { method: 'POST', body: { name, password: $('#stup').value, isAdmin: $('#stua').checked, remoteAllowed: $('#stur').checked } });
        c.accounts.push({ name, admin: $('#stua').checked }); toast(t('Kontot {name} är skapat', { name })); draw(); $('#stun').focus();
      });
      $('#stkid').onsubmit = act(async (e) => {
        e.preventDefault();
        const name = $('#stkn').value.trim(), maxAge = +$('#stka').value;
        await api('/profiles', { method: 'POST', body: { name, maxAge, pin: $('#stkp').value || null } });
        c.profiles.push({ name, kid: true, maxAge }); toast(t('Barnprofilen {name} är skapad', { name })); await boot(); draw(); $('#stkn').focus();
      });
      if ($('#stqc')) $('#stqc').onclick = act(async () => { await api('/settings', { method: 'PUT', body: { quickConnect: true } }); c.quickConnect = true; draw(); });
    };
    draw();
  },

  // ---------- 7. Klart: sammanfattning ----------
  async done(el, S) {
    const c = S.checks, st = S.state;
    const items = c.libraries.reduce((n, l) => n + (+l.count || 0), 0);
    const rows = [
      [c.tmdb, t('Metadata från TMDB'), c.tmdb ? t('Språk {language}', { language: c.language }) : t('Ingen nyckel – titlar och bilder tas från filerna'), 'metadata'],
      [c.libraries.length > 0, t('Bibliotek'), c.libraries.length ? t('{librariesN} bibliotek ({v}), {items} titlar/album{v2}', { librariesN: c.libraries.length, v: c.libraries.map(l => l.name).join(', '), items, v2: c.scanning ? t(' – skannar fortfarande') : '' }) : t('Inga bibliotek ännu'), 'libraries'],
      [c.hw.active !== 'none' || c.hw.wanted === 'none', t('Omkodning'), c.hw.active !== 'none' ? t('Grafikkrets ({active})', { active: c.hw.active }) : c.hw.wanted !== 'none' ? t('HWACCEL={wanted} fungerar inte – processorn används', { wanted: c.hw.wanted }) : t('Processorn (ingen grafikkrets inställd)'), 'hardware'],
      [!c.publicUrl || c.publicUrl.startsWith('https://'), t('Utanför hemmet'), c.publicUrl ? c.publicUrl : t('Bara hemma eller via VPN'), 'remote'],
      [c.my2fa, t('Tvåstegsverifiering för dig'), c.my2fa ? t('På') : t('Av – rekommenderas, särskilt om servern nås från internet'), 'remote'],
      [c.accounts.length + c.profiles.length > 1, t('Hushållet'), t('{accountsN} konton, {profilesN} profiler{v}', { accountsN: c.accounts.length, profilesN: c.profiles.length, v: c.profiles.some(p => p.kid) ? t(' (varav barnprofiler)') : '' }), 'household']
    ];
    const left = rows.filter(r => !r[0]);
    el.innerHTML = `<p>${left.length ? t('Nästan klart! {v} kan du göra nu eller senare.', { v: left.length === 1 ? t('En sak') : left.length + t(' saker') }) : t('Allt är klart – mycket nöje!')}</p>
      <div class="checks">${rows.map(([ok, tm, d, step]) => `<div class="check ${ok ? 'ok' : 'warn'}"><span class="dot" aria-hidden="true">${ok ? '✓' : '!'}</span>
        <div><b>${esc(tm)}</b>${st[step] === 'skipped' && !ok ? t(' <span class="muted small">(hoppades över)</span>') : ''}<div class="muted small">${esc(d)}</div>
        ${ok ? '' : `${t('<a class="small" href="#/setup/{step}">Gå till steget</a>', { step })}`}</div></div>`).join('')}</div>
      <p class="muted small" style="margin-top:18px">${t('Mer finns under Administration: live-TV, Sonarr/Radarr, notiser, säkerhetskopior och undertexter. Guiden kan köras igen därifrån.')}</p>`;
  }
};
