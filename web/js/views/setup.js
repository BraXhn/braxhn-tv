// Vy: installationsguiden (#/setup/<steg>) – leder en ny administratör genom språk, metadata, bibliotek,
// hårdvaruomkodning, åtkomst utanför hemmet och hushållet. Läget (aktuellt steg, klarade/överhoppade steg och
// om guiden är klar) sparas på servern: server/routes/setup.js. Kan köras igen från Administration.
// Fungerar med fjärrkontroll/tangentbord: ↑/↓ flyttar mellan kontrollerna, ←/→ mellan stegen i stegindikatorn.
import { $, $$, act, api, esc, keyClick, later, main, me, toast, toastErr, views } from '../core.js';
import { boot, loadLibs } from '../router.js';
import { confirmDialog } from '../ui/dialog.js';
import { emptyState, errorState, bindRetry, loadingState } from '../ui/states.js';

const STEPS = [
  { id: 'welcome', title: 'Välkommen' }, { id: 'metadata', title: 'Metadata' }, { id: 'libraries', title: 'Bibliotek' },
  { id: 'hardware', title: 'Omkodning' }, { id: 'remote', title: 'Utanför hemmet' }, { id: 'household', title: 'Hushållet' }, { id: 'done', title: 'Klart' }];
const TYPES = { movie: 'Filmer', show: 'Serier', music: 'Musik', audiobook: 'Ljudböcker' };
const LANGS = [['sv-SE', 'Svenska'], ['en-US', 'Engelska'], ['nb-NO', 'Norska'], ['da-DK', 'Danska'], ['fi-FI', 'Finska'], ['de-DE', 'Tyska']];
const REPO = 'https://github.com/BraXhn/braxhn-tv';
const ext = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const yes = (ok, text) => `<span class="${ok ? 'ok-badge' : 'warn-badge'}">${esc(text)}</span>`;

views.setup = async (step) => {
  if (!me.is_admin) { location.hash = '#/'; return; }
  if (!me.adminHere) {
    main.innerHTML = emptyState({ icon: '🔒', title: 'Installationen görs från hemnätverket', text: 'Av säkerhetsskäl kan servern bara ställas in från hemnätverket eller via VPN.', action: { label: 'Till startsidan', href: '#/' } });
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
    <div class="setup-head"><h1>Kom igång med BraXhn TV</h1><button type="button" class="ghost small" id="stskipall">Hoppa över guiden</button></div>
    <nav aria-label="Steg i installationen"><ol class="setup-steps">${STEPS.map((s, i) => {
      const st = S.state[s.id];
      return `<li><a href="#/setup/${s.id}" class="${st || ''}" ${i === idx ? 'aria-current="step"' : ''} aria-label="Steg ${i + 1}: ${esc(s.title)}${st === 'done' ? ' (klart)' : st === 'skipped' ? ' (överhoppat)' : ''}">
        <span class="n" aria-hidden="true">${st === 'done' ? '✓' : i + 1}</span><span class="t">${esc(s.title)}</span></a></li>`;
    }).join('')}</ol></nav>
    <p class="setup-count muted small" aria-hidden="true">Steg ${idx + 1} av ${STEPS.length} · ${esc(cur.title)}</p>
    <section class="panel setup-body" aria-labelledby="sttitle"><h2 id="sttitle" tabindex="-1">${esc(cur.title)}</h2><div id="stbody">${loadingState({ kind: 'inline' })}</div></section>
    <div class="setup-nav">
      <button type="button" class="ghost" id="stback" ${idx === 0 ? 'hidden' : ''}>← Tillbaka</button><span class="sp"></span>
      ${last ? '' : '<button type="button" class="ghost" id="stskip">Hoppa över</button>'}
      <button type="button" class="primary" id="stnext">${last ? 'Slutför och gå till startsidan' : idx === 0 ? 'Sätt igång →' : 'Nästa →'}</button></div></div>`;

  $('#stback').onclick = () => go(idx - 1);
  if ($('#stskip')) $('#stskip').onclick = act(async () => { await mark(cur.id, 'skipped'); go(idx + 1); });
  $('#stnext').onclick = act(async () => {
    if (last) { await finish(false); return; }
    await mark(cur.id, 'done'); go(idx + 1);
  });
  $('#stskipall').onclick = act(async () => {
    if (!await confirmDialog('Du kan köra guiden när som helst under Administration → Kör guiden igen.', { title: 'Hoppa över installationsguiden?', okLabel: 'Hoppa över' })) return;
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
  toast(skipped ? 'Guiden hoppades över – du hittar den under Administration' : 'Klart! Välkommen till BraXhn TV');
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
    try { serverTime = new Date().toLocaleString('sv-SE', { timeZone: S.timezone, dateStyle: 'medium', timeStyle: 'short' }); } catch {}
    el.innerHTML = `<p>Hej ${esc(me.name)}! Guiden tar ungefär fem minuter och hjälper dig att hitta dina filmer, serier, musik och ljudböcker,
      få snygga affischer och beskrivningar, och ge resten av hushållet egna konton. Allt går att ändra senare under <b>Administration</b>.</p>
      <label for="stlang">Språk för titlar, beskrivningar och affischer</label>
      <select id="stlang">${LANGS.map(([v, n]) => `<option value="${v}" ${set.language === v ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <p class="muted small">Svenska är standard. Saknas en svensk beskrivning används den engelska. Själva appen är på svenska.</p>
      <h3>Tidszon</h3>
      <p>Servern använder <b>${esc(S.timezone)}</b>${serverTime ? ` (klockan är ${esc(serverTime)} där)` : ''}. Den används för TV-guiden, inspelningar, kalendern och loggen.</p>
      ${browserTz && browserTz !== S.timezone ? `<p class="setup-res bad">Din enhet använder ${esc(browserTz)}. Sätt variabeln <code>TZ</code> i Unraid-mallen (Docker → BraXhn TV → Edit), t.ex. <code>TZ=Europe/Stockholm</code>, och starta om containern.</p>` : '<p class="setup-res ok">✓ Samma tidszon som din enhet.</p>'}
      <p class="muted small">Mediamappen i containern: <code>${esc(S.mediaRoot)}</code>.</p>`;
    $('#stlang').onchange = act(async () => { await api('/settings', { method: 'PUT', body: { language: $('#stlang').value } }); toast('Språket sparat'); });
  },

  // ---------- 2. Metadata (TMDB) ----------
  async metadata(el, S, { mark }) {
    const c = S.checks;
    el.innerHTML = `<p><b>TMDB</b> (The Movie Database) är en gratis filmdatabas. Med en egen nyckel hämtar BraXhn TV affischer, bakgrundsbilder,
      beskrivningar, betyg, åldersgränser, skådespelare och trailers. Nyckeln är gratis och tar ett par minuter att skaffa.</p>
      <ol class="setup-list"><li>Skapa ett konto på ${ext('https://www.themoviedb.org/signup', 'themoviedb.org')}.</li>
      <li>Gå till ${ext('https://www.themoviedb.org/settings/api', 'Inställningar → API')} och ansök om en nyckel (välj <i>Personal</i>/privat bruk).</li>
      <li>Kopiera <b>API-nyckel</b> (v3) eller <b>API-läsåtkomsttoken</b> och klistra in här.</li></ol>
      <p>Läge: ${c.tmdb ? yes(true, c.tmdbFromEnv ? 'Nyckel satt via miljövariabel' : 'Nyckel sparad') : yes(false, 'Ingen nyckel')}</p>
      <label for="sttk">TMDB-nyckel</label>
      <input id="sttk" type="password" autocomplete="off" spellcheck="false" placeholder="${c.tmdb ? 'Lämna tomt för att testa den sparade' : 'Klistra in nyckeln'}">
      <div class="row" style="margin-top:12px"><button type="button" class="ghost" id="sttest">Testa</button><button type="button" class="primary" id="stsave">Testa och spara</button></div>
      <p id="sttres" role="status" class="setup-res muted"></p>
      <details class="setup-more"><summary>Vad får jag utan nyckel?</summary>
      <p>BraXhn TV fungerar ändå: titlar och år tas från fil- och mappnamnen, bilderna blir stillbilder ur själva videon, och musik och ljudböcker
      använder taggarna och omslagen i filerna. Det som saknas är affischer, beskrivningar, betyg, skådespelare, trailers, svensk åldersgräns
      (barnprofiler ser då bara titlar utan känd gräns om du tillåter det), sidan Strömmande och datum för kommande avsnitt.</p></details>`;
    const test = async () => {
      const r = $('#sttres'); result(r, null, 'Frågar TMDB…');
      try { await api('/setup/tmdb-test', { method: 'POST', body: { key: $('#sttk').value } }); result(r, true, '✓ TMDB godkände nyckeln.'); return true; }
      catch (e) { if (e.aborted) throw e; result(r, false, esc(e.message)); return false; }
    };
    $('#sttest').onclick = act(test);
    $('#stsave').onclick = act(async () => {
      const key = $('#sttk').value.trim();
      if (!key) { if (c.tmdb) await test(); else result($('#sttres'), false, 'Klistra in nyckeln först.'); return; }
      if (!await test()) return;
      await api('/settings', { method: 'PUT', body: { tmdbKey: key } });
      $('#sttk').value = ''; c.tmdb = true;
      if (c.libraries.length) await api('/scan', { method: 'POST' }).catch(() => {});
      result($('#sttres'), true, `✓ Nyckeln är sparad.${c.libraries.length ? ' Metadata hämtas nu i bakgrunden.' : ' Metadata hämtas när du lagt till bibliotek.'}`);
      await mark('metadata', 'done');
    });
  },

  // ---------- 3. Bibliotek ----------
  async libraries(el, S, { mark }) {
    el.innerHTML = `<p>Ett bibliotek är en mapp med en sorts innehåll. BraXhn TV har letat i <code>${esc(S.mediaRoot)}</code> och gissat vad mapparna innehåller
      – från namnet (Filmer/Movies, Serier/TV, Musik/Music, Ljudböcker/Audiobooks) och från filerna (avsnitt som <code>S01E02</code> blir serier).</p>
      <div id="stlibs"></div>
      <h3>Förslag</h3><div id="stsug">${loadingState({ kind: 'inline', label: 'Letar efter mappar…' })}</div>
      <details class="setup-more" id="stother"><summary>Välj en annan mapp</summary>
        <div class="row"><div style="flex:1;min-width:160px"><label for="ston">Namn</label><input id="ston" placeholder="Filmer"></div>
        <div><label for="stot">Typ</label><select id="stot">${Object.entries(TYPES).map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></div></div>
        <label for="stop">Mapp</label><input id="stop" value="${esc(S.mediaRoot)}">
        <div class="fsb" id="stfsb"></div>
        <div class="row" style="margin-top:12px"><button type="button" class="primary" id="stoadd">Lägg till och skanna</button></div></details>
      <div id="stscan" class="setup-scan" role="status" aria-live="polite"></div>
      <p class="muted small">Hittar du inte mappen? Lägg till den som en sökväg i Unraid-mallen (t.ex. <code>/mnt/user/Filmer</code> → <code>${esc(S.mediaRoot)}/Filmer</code>) och starta om containern.
      Hur filerna bör heta står i README under <i>Namnge filer</i>.</p>`;
    let libs = S.checks.libraries;
    const drawLibs = () => {
      $('#stlibs').innerHTML = libs.length ? `<h3>Dina bibliotek</h3><ul class="setup-libs">${libs.map(l => `<li><b>${esc(l.name)}</b> <span class="muted">${TYPES[l.type] || ''} · <code>${esc(l.path)}</code></span> <span class="ok-badge">${+l.count || 0} ${l.type === 'music' ? 'album' : l.type === 'audiobook' ? 'böcker' : 'titlar'}</span></li>`).join('')}</ul>` : '';
    };
    drawLibs();
    const add = async (name, type, p) => {
      await api('/libraries', { method: 'POST', body: { name, type, path: p } });
      toast(`${name} tillagt – skannar`);
      await loadLibs(); await mark('libraries', 'done');
      await suggest(); poll();
    };
    const suggest = async () => {
      const box = $('#stsug');
      let r;
      try { r = await api('/setup/suggest'); } catch (e) { if (e.aborted) throw e; box.innerHTML = errorState(e, { retry: true, compact: true }); bindRetry(box, suggest); return; }
      if (!r.suggestions.length) {
        box.innerHTML = emptyState({ icon: '📂', compact: true, title: `Inga mappar under ${r.root}`, text: 'Lägg till dina mediamappar som sökvägar i Unraid-mallen och starta om containern – eller välj en mapp nedan.' });
        return;
      }
      box.innerHTML = `<ul class="setup-sug">${r.suggestions.map((s, i) => `<li>
        <div class="info"><b>📁 ${esc(s.name)}</b><div class="muted small">${esc(s.reason)}</div></div>
        ${s.library ? `<span class="ok-badge">Tillagd som ${esc(s.library)}</span>` : `<label class="sr-only" for="sgt${i}">Typ för ${esc(s.name)}</label>
        <select id="sgt${i}" data-sgt="${i}">${s.type ? '' : '<option value="">Välj typ…</option>'}${Object.entries(TYPES).map(([v, n]) => `<option value="${v}" ${s.type === v ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <button type="button" class="${s.type ? 'primary' : 'ghost'} small" data-sga="${i}" ${s.type ? '' : 'disabled'}>Lägg till</button>`}</li>`).join('')}</ul>`;
      $$('[data-sgt]').forEach(sel => sel.onchange = () => { const b = $(`[data-sga="${sel.dataset.sgt}"]`); b.disabled = !sel.value; });
      $$('[data-sga]').forEach(b => b.onclick = act(async () => {
        const s = r.suggestions[+b.dataset.sga], type = $(`[data-sgt="${b.dataset.sga}"]`).value;
        b.disabled = true;
        try { await add(s.type === type ? s.suggestedName : TYPES[type], type, s.path); } finally { b.disabled = false; }
      }));
    };
    // Mappväljaren (samma som i Administration)
    const browse = async (p) => {
      try {
        const r = await api('/fs?path=' + encodeURIComponent(p));
        $('#stop').value = r.path;
        $('#stfsb').innerHTML = (r.parent ? `<div data-p="${esc(r.parent)}">⬆ ..</div>` : '') + r.dirs.map(d => `<div data-p="${esc(r.path + '/' + d)}">📁 ${esc(d)}</div>`).join('')
          || '<div class="muted" role="status">Inga undermappar</div>';
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
      box.innerHTML = s.running ? `⏳ Skannar <b>${esc(s.library || '')}</b>: ${esc(s.phase)} ${s.done}/${s.total}${s.queued ? ` · ${s.queued} till i kö` : ''}${bar(s)}`
        : libs.length ? `✓ Skanningen är klar.${a?.running ? '' : ' Du kan gå vidare medan resten analyseras.'}` : '';
      if (a?.running) box.innerHTML += `<div class="muted small" style="margin-top:8px">I bakgrunden: ${esc(a.library || '')} – ${esc(a.phase)} ${a.done}/${a.total}${bar(a)}</div>`;
      later(poll, s.running || a?.running ? 1500 : 8000);
    };
    await suggest();
    poll().catch(e => { if (!e.aborted) console.warn(e); });
  },

  // ---------- 4. Hårdvaruomkodning ----------
  async hardware(el) {
    const h = await api('/setup/hw');
    const NAMES = { none: 'processorn', vaapi: 'VAAPI (Intel/AMD)', qsv: 'Intel Quick Sync', nvenc: 'NVIDIA NVENC' };
    const works = h.active !== 'none', failed = h.wanted !== 'none' && h.active === 'none';
    const rec = h.recommend;
    let advice;
    if (works) advice = `<p class="setup-res ok">✓ Hårdvaruomkodning med <b>${esc(NAMES[h.active] || h.active)}</b> fungerar. Filmer som måste konverteras kodas på grafikkretsen.</p>`;
    else if (failed) advice = `<p class="setup-res bad">✕ <code>HWACCEL=${esc(h.wanted)}</code> är inställt men fungerar inte, så processorn används.<br>${esc(h.error || '')}</p>
      ${h.hint ? `<p><b>Åtgärd:</b> ${esc(h.hint)}</p>` : ''}`;
    else if (rec !== 'none') advice = `<p class="setup-res">Servern ser ${rec === 'nvenc' ? 'ett NVIDIA-kort' : 'en grafikkrets (<code>/dev/dri</code>)'} men använder processorn. Sätt <b>Hårdvaruomkodning</b> (<code>HWACCEL</code>) till <code>${esc(rec)}</code> i Unraid – testa gärna först med knappen nedan.</p>`;
    else advice = `<p class="setup-res">Ingen grafikkrets syns i containern, så processorn används. Det räcker oftast: en modern processor klarar 1080p i realtid.
      4K HDR är tungt utan grafikkrets.</p>`;
    const modes = [...new Set(['none', h.wanted, rec].filter(m => m && m !== 'none'))];
    el.innerHTML = `<p>När en enhet inte kan spela filen som den är (t.ex. 4K HEVC på en äldre TV, eller låg bandbredd utanför hemmet) kodar servern om den
      medan du tittar. Det går mycket lättare med en grafikkrets.</p>${advice}
      <table class="setup-hw"><tr><th scope="row">Inställt (HWACCEL)</th><td><code>${esc(h.wanted)}</code> → används: <b>${esc(NAMES[h.active] || h.active)}</b></td></tr>
      <tr><th scope="row">Intel/AMD (/dev/dri)</th><td>${h.dri.length ? esc(h.dri.join(', ')) : '<span class="muted">saknas i containern</span>'}</td></tr>
      <tr><th scope="row">NVIDIA</th><td>${h.nvidia.device ? esc(h.nvidia.gpus.join(', ') || 'hittat') : '<span class="muted">saknas i containern</span>'}</td></tr>
      <tr><th scope="row">ffmpeg kan</th><td>${esc(h.encoders.join(', ') || 'okänt')}</td></tr>
      <tr><th scope="row">Processor</th><td>${esc(h.cpu.model)} · ${h.cpu.cores} kärnor</td></tr></table>
      <h3>Testa omkodning</h3><p class="muted small">Kodar en testbild i 720p i fyra sekunder. Ändrar ingenting.</p>
      <div class="row">${['none', ...modes].map(m => `<button type="button" class="ghost" data-hwt="${esc(m)}">Testa ${esc(NAMES[m] || m)}</button>`).join('')}</div>
      <p id="sthwres" role="status" class="setup-res muted"></p>
      <details class="setup-more" ${rec !== 'none' && !works ? 'open' : ''}><summary>Så ställer du in det i Unraid</summary>
      <ul class="setup-list">
        <li><b>Intel (iGPU) eller AMD:</b> Docker → BraXhn TV → <b>Edit</b>. Fyll i <b>GPU-enhet</b> med <code>/dev/dri</code> och sätt <b>Hårdvaruomkodning</b> till <code>qsv</code> (Intel) eller <code>vaapi</code> (Intel/AMD). Tryck <b>Apply</b>.</li>
        <li><b>NVIDIA:</b> installera pluginen <i>Nvidia-Driver</i> och starta om Unraid. Använd sedan mallen ${ext(REPO + '/blob/main/braxhn-tv-nvidia.xml', 'braxhn-tv-nvidia.xml')} – den har redan <code>HWACCEL=nvenc</code>,
          <code>--runtime=nvidia</code> och <code>NVIDIA_VISIBLE_DEVICES=all</code>. Med den vanliga mallen (${ext(REPO + '/blob/main/braxhn-tv.xml', 'braxhn-tv.xml')}): sätt <i>Hårdvaruomkodning</i> till <code>nvenc</code>, slå på <i>Avancerad vy</i>, lägg till <code>--runtime=nvidia</code> under <i>Extra Parameters</i> och fyll i <i>NVIDIA: grafikkort</i> (<code>all</code>).</li>
        <li>Fungerar hårdvaran inte går servern automatiskt över till processorn, och Administration → Säkerhetskontroll visar varför.</li></ul></details>`;
    $$('[data-hwt]').forEach(b => b.onclick = act(async () => {
      const m = b.dataset.hwt, r = $('#sthwres');
      $$('[data-hwt]').forEach(x => x.disabled = true);
      result(r, null, `Testar ${esc(NAMES[m] || m)}…`);
      try {
        const t = await api('/setup/hw-test', { method: 'POST', body: { mode: m } });
        if (t.ok) result(r, true, `✓ ${esc(NAMES[m] || m)}: ${t.fps} bilder/s i 720p – ungefär ${(t.fps / 25).toFixed(1).replace('.', ',')} gånger realtid.${m !== 'none' && m !== h.active ? ` Sätt <code>HWACCEL=${esc(m)}</code> i Unraid för att använda det.` : ''}`);
        else result(r, false, `✕ ${esc(NAMES[m] || m)} fungerar inte: ${esc(t.error || '')}${t.hint ? `<br><b>Åtgärd:</b> ${esc(t.hint)}` : ''}`);
      } finally { $$('[data-hwt]').forEach(x => x.disabled = false); }
    }));
  },

  // ---------- 5. Åtkomst utanför hemmet ----------
  async remote(el, S) {
    const c = S.checks;
    el.innerHTML = `<p>Hemma fungerar allt direkt. Vill ni titta i mobilen på resan, i bilen eller hos mormor finns tre vägar:</p>
      <ul class="setup-list"><li><b>VPN</b> (NetBird, Tailscale, WireGuard i routern) – enklast och säkrast: inget öppnas mot internet och telefonen räknas som hemma.</li>
      <li><b>Egen domän med HTTPS</b> via en omvänd proxy (Nginx Proxy Manager, SWAG) – krävs för bilen och Chromecast utanför hemmet.</li>
      <li><b>Inbyggd HTTPS</b> med ett gratis certifikat från Let's Encrypt, utan proxy.</li></ul>
      <fieldset class="setup-choice"><legend>Hur ska ni nå servern utifrån?</legend>
        <label class="switch"><input type="radio" name="strm" value="vpn" ${c.publicUrl ? '' : 'checked'}> Bara hemma eller via VPN</label>
        <label class="switch"><input type="radio" name="strm" value="url" ${c.publicUrl ? 'checked' : ''}> Via en egen adress på internet</label></fieldset>
      <div id="sturlw" ${c.publicUrl ? '' : 'hidden'}><label for="stpu">Publik adress</label><input id="stpu" type="url" inputmode="url" placeholder="https://tv.dindomän.se" value="${esc(c.publicUrl)}">
        <p class="muted small">Läge: ${c.https ? yes(true, 'Du är ansluten med HTTPS') : yes(false, 'Den här anslutningen är okrypterad')} ${c.cert ? yes(true, 'Inbyggt certifikat finns') : ''}</p></div>
      <label class="switch"><input type="checkbox" id="st2fa" ${c.require2faRemote ? 'checked' : ''}> Kräv tvåstegsverifiering för inloggning utanför hemmet (rekommenderas)</label>
      <p class="muted small">Ditt konto: ${c.my2fa ? yes(true, 'Tvåstegsverifiering på') : `${yes(false, 'Ingen tvåstegsverifiering')} – <a href="#/account">aktivera den under Mitt konto</a> (autentiseringsapp eller passkey)`}.
        Varje konto kan också spärras till hemnätet under Hushållet eller Administration.</p>
      <div class="row" style="margin-top:12px"><button type="button" class="primary" id="strsave">Spara</button></div>
      <p id="strres" role="status" class="setup-res muted"></p>
      <div class="row setup-links"><a class="btn ghost" href="#/admin/security">Öppna säkerhetskontrollen</a><a class="btn ghost" href="#/admin/acme">HTTPS med Let's Encrypt</a></div>
      <p class="muted small">Administration går bara att nå hemifrån eller via VPN, oavsett vad du väljer här.</p>`;
    $$('[name=strm]').forEach(r => r.onchange = () => { $('#sturlw').hidden = $('[name=strm]:checked').value !== 'url'; });
    $('#strsave').onclick = act(async () => {
      const url = $('[name=strm]:checked').value === 'url' ? $('#stpu').value.trim() : '';
      const want2fa = $('#st2fa').checked;
      if (want2fa && !c.my2fa && !c.require2faRemote && !await confirmDialog('Du har själv inte tvåstegsverifiering. Utanför hemmet kan du inte logga in förrän du aktiverat den. Fortsätta?', { okLabel: 'Fortsätt' })) return;
      try { await api('/settings', { method: 'PUT', body: { publicUrl: url, require2faRemote: want2fa } }); }
      catch (e) { if (e.aborted) throw e; result($('#strres'), false, esc(e.message)); return; }
      c.publicUrl = url; c.require2faRemote = want2fa;
      result($('#strres'), true, '✓ Sparat.');
    });
  },

  // ---------- 6. Hushållet ----------
  async household(el, S) {
    const c = S.checks;
    const draw = () => {
      el.innerHTML = `<p><b>Konton</b> har eget lösenord – ge varje vuxen ett eget. <b>Profiler</b> delar ditt konto, som på Netflix: man väljer profil under <i>Vem tittar?</i>.
        En <b>barnprofil</b> ser bara filmer och serier inom åldersgränsen.</p>
        <ul class="setup-libs">${c.accounts.map(a => `<li>👤 <b>${esc(a.name)}</b> <span class="muted">${a.admin ? 'administratör' : 'konto'}</span></li>`).join('')}
          ${c.profiles.map(p => `<li>${p.kid ? '🧸' : '🙂'} <b>${esc(p.name)}</b> <span class="muted">${p.kid ? `barnprofil, max ${+p.maxAge} år` : 'profil'}</span></li>`).join('')}</ul>
        <div class="setup-forms">
        <form id="stuser" class="setup-form"><h3>Nytt konto</h3>
          <label for="stun">Namn</label><input id="stun" required maxlength="64" autocomplete="off">
          <label for="stup">Lösenord (minst 10 tecken)</label><input id="stup" type="password" minlength="10" required autocomplete="new-password">
          <label class="switch"><input type="checkbox" id="stur" checked> Får titta utanför hemmet</label>
          <label class="switch"><input type="checkbox" id="stua"> Administratör</label>
          <button class="primary">Skapa konto</button></form>
        <form id="stkid" class="setup-form"><h3>Ny barnprofil</h3>
          <label for="stkn">Namn</label><input id="stkn" required maxlength="40" autocomplete="off">
          <label for="stka">Åldersgräns</label><select id="stka">${[[0, 'Barntillåtet'], [7, '7 år'], [11, '11 år'], [15, '15 år']].map(([v, n]) => `<option value="${v}" ${v === 7 ? 'selected' : ''}>${n}</option>`).join('')}</select>
          <label for="stkp">PIN för att byta från profilen (valfri, 4–8 siffror)</label><input id="stkp" type="password" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" autocomplete="off">
          <button class="primary">Skapa barnprofil</button></form></div>
        <h3>Logga in på TV:n med kod</h3>
        ${c.quickConnect ? `<p>Slipp skriva lösenord med fjärrkontrollen: välj <b>Logga in med kod</b> på TV:n (webbläsaren eller appen). En sexsiffrig kod visas –
          godkänn den från telefonen under <b>Godkänn inloggning på TV</b> i menyn, eller skanna QR-koden. <a href="#/quickconnect">Godkänn en kod nu</a>.</p>`
          : '<p>Snabbinloggning med kod är avstängd. <button type="button" class="ghost small" id="stqc">Slå på</button></p>'}
        <h3>Appar</h3>
        <ul class="setup-list"><li><b>Webben</b> fungerar i alla webbläsare: <code>${esc(location.origin)}</code>${c.publicUrl ? ` eller <code>${esc(c.publicUrl)}</code>` : ''}. På iPhone: Dela → <i>Lägg till på hemskärmen</i>; på Android: menyn → <i>Installera app</i>.</li>
          <li><b>iPhone, iPad och Apple TV:</b> appen finns i ${ext(REPO + '/tree/main/apps/apple', 'apps/apple')} och byggs med Xcode (se dess README).</li>
          <li><b>Google TV/Android TV och bilen (Android Automotive):</b> ladda ner APK-filen under ${ext(REPO + '/actions', 'GitHub Actions')} → <i>Android Automotive-app</i> → <i>Artifacts</i> (se ${ext(REPO + '/tree/main/apps/automotive', 'apps/automotive')}).</li>
          <li><b>Smart-TV utan app:</b> slå på DLNA under Administration → Drift.</li></ul>`;
      $('#stuser').onsubmit = act(async (e) => {
        e.preventDefault();
        const name = $('#stun').value.trim();
        await api('/users', { method: 'POST', body: { name, password: $('#stup').value, isAdmin: $('#stua').checked, remoteAllowed: $('#stur').checked } });
        c.accounts.push({ name, admin: $('#stua').checked }); toast(`Kontot ${name} är skapat`); draw(); $('#stun').focus();
      });
      $('#stkid').onsubmit = act(async (e) => {
        e.preventDefault();
        const name = $('#stkn').value.trim(), maxAge = +$('#stka').value;
        await api('/profiles', { method: 'POST', body: { name, maxAge, pin: $('#stkp').value || null } });
        c.profiles.push({ name, kid: true, maxAge }); toast(`Barnprofilen ${name} är skapad`); await boot(); draw(); $('#stkn').focus();
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
      [c.tmdb, 'Metadata från TMDB', c.tmdb ? `Språk ${c.language}` : 'Ingen nyckel – titlar och bilder tas från filerna', 'metadata'],
      [c.libraries.length > 0, 'Bibliotek', c.libraries.length ? `${c.libraries.length} bibliotek (${c.libraries.map(l => l.name).join(', ')}), ${items} titlar/album${c.scanning ? ' – skannar fortfarande' : ''}` : 'Inga bibliotek ännu', 'libraries'],
      [c.hw.active !== 'none' || c.hw.wanted === 'none', 'Omkodning', c.hw.active !== 'none' ? `Grafikkrets (${c.hw.active})` : c.hw.wanted !== 'none' ? `HWACCEL=${c.hw.wanted} fungerar inte – processorn används` : 'Processorn (ingen grafikkrets inställd)', 'hardware'],
      [!c.publicUrl || c.publicUrl.startsWith('https://'), 'Utanför hemmet', c.publicUrl ? c.publicUrl : 'Bara hemma eller via VPN', 'remote'],
      [c.my2fa, 'Tvåstegsverifiering för dig', c.my2fa ? 'På' : 'Av – rekommenderas, särskilt om servern nås från internet', 'remote'],
      [c.accounts.length + c.profiles.length > 1, 'Hushållet', `${c.accounts.length} konton, ${c.profiles.length} profiler${c.profiles.some(p => p.kid) ? ' (varav barnprofiler)' : ''}`, 'household']
    ];
    const left = rows.filter(r => !r[0]);
    el.innerHTML = `<p>${left.length ? `Nästan klart! ${left.length === 1 ? 'En sak' : left.length + ' saker'} kan du göra nu eller senare.` : 'Allt är klart – mycket nöje!'}</p>
      <div class="checks">${rows.map(([ok, t, d, step]) => `<div class="check ${ok ? 'ok' : 'warn'}"><span class="dot" aria-hidden="true">${ok ? '✓' : '!'}</span>
        <div><b>${esc(t)}</b>${st[step] === 'skipped' && !ok ? ' <span class="muted small">(hoppades över)</span>' : ''}<div class="muted small">${esc(d)}</div>
        ${ok ? '' : `<a class="small" href="#/setup/${step}">Gå till steget</a>`}</div></div>`).join('')}</div>
      <p class="muted small" style="margin-top:18px">Mer finns under Administration: live-TV, Sonarr/Radarr, notiser, säkerhetskopior och undertexter. Guiden kan köras igen därifrån.</p>`;
  }
};
