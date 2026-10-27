// Uppspelningsval per konto (sparas på servern, /api/me/playback-prefs): ljud- och undertextspråk, undertextläge,
// SDH, automatisk överhoppning, nästa avsnitt och standardkvalitet. Servern väljer spåren (playprefs.js) och skickar
// förvalen i /api/items/:id (defaultAudio/defaultSub) och /api/items/:id/playback (autoSkip/autoNext) – här finns
// panelen under Mitt konto och flytten av de gamla webbläsarvalen (sublang, quality) till kontot.
import { $, $$, act, api, esc, me, routeGen, status, store, toast } from '../core.js';

export const LANGS = [['sv', 'Svenska'], ['en', 'Engelska'], ['no', 'Norska'], ['da', 'Danska'], ['fi', 'Finska'], ['is', 'Isländska'],
  ['de', 'Tyska'], ['fr', 'Franska'], ['es', 'Spanska'], ['it', 'Italienska'], ['nl', 'Nederländska'], ['pl', 'Polska'],
  ['pt', 'Portugisiska'], ['ru', 'Ryska'], ['tr', 'Turkiska'], ['ar', 'Arabiska'], ['fa', 'Persiska'], ['hi', 'Hindi'],
  ['ja', 'Japanska'], ['ko', 'Koreanska'], ['zh', 'Kinesiska'], ['th', 'Thai']];
const SUB_MODES = [['off', 'Av'], ['forced', 'Bara tvingade undertexter'], ['foreign', 'När ljudet är på ett annat språk än mina språk'], ['always', 'Alltid']];
const QUALS = [['orig', 'Original'], ['1080', '1080p (8 Mbit/s)'], ['720', '720p (4 Mbit/s)'], ['480', '480p (1,5 Mbit/s)'], ['360', '360p (0,8 Mbit/s)']];
const QRANK = { orig: 99, '2160': 6, '1080': 5, '720': 4, '480': 3, '360': 2 };
const COUNTDOWNS = [0, 5, 8, 10, 15, 20, 30];
const N_AUDIO = 3, N_SUB = 3;

/**
 * En gång per konto och webbläsare: de gamla valen i webbläsaren (undertextspråk och kvalitet) flyttas till kontot,
 * om kontot inte redan har sparade val (då gäller de). Tyst vid fel – försöker igen nästa gång.
 */
let migrating = null;
export function migrateLocalPrefs() {
  if (!me) return Promise.resolve();
  const key = 'pbprefs.migrated.' + me.id;
  if (store.get(key, false)) return Promise.resolve();
  return migrating || (migrating = (async () => {
    try {
      const p = await api('/me/playback-prefs', { bg: true });
      const sub = String(store.get('sublang', '') || ''), q = String(store.get('quality', 'auto') || 'auto');
      const body = {};
      if (sub) { body.subLangs = [sub]; body.subMode = 'always'; } // förut: alltid undertexter på senast valda språk
      if (q !== 'auto' && QRANK[q]) body[status.remote ? 'qualityRemote' : 'qualityHome'] = q;
      if (!p.saved && Object.keys(body).length) await api('/me/playback-prefs', { method: 'PUT', body, bg: true });
      store.set(key, true);
    } catch {} finally { migrating = null; }
  })());
}

const langOpts = (val, { orig = false } = {}) => {
  const list = [...LANGS];
  if (val && val !== 'orig' && !list.some(([k]) => k === val)) list.push([val, val]);
  return `<option value="">–</option>${orig ? `<option value="orig" ${val === 'orig' ? 'selected' : ''}>Originalspråk</option>` : ''}` +
    list.map(([k, n]) => `<option value="${esc(k)}" ${k === val ? 'selected' : ''}>${esc(n)}</option>`).join('');
};
const sel = (id, opts, val) => `<select id="${id}">${opts.map(([k, n]) => `<option value="${esc(String(k))}" ${String(k) === String(val) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;

/** Panelen under Mitt konto */
export async function renderPlaybackPrefs(box) {
  const gen = routeGen;
  await migrateLocalPrefs();
  const p = await api('/me/playback-prefs');
  if (gen !== routeGen || !box.isConnected) return;
  const cap = QRANK[p.remoteCap] ? p.remoteCap : '1080';
  const capName = cap === 'orig' ? 'Original' : cap + 'p';
  const remoteQ = [['auto', `Auto (anpassas efter uppkopplingen, högst ${capName})`], ...QUALS.filter(([k]) => QRANK[k] <= QRANK[cap])];
  const langRow = (prefix, n, vals, orig) => Array.from({ length: n }, (_, i) =>
    `<label class="pplang"><span class="muted small">${i + 1}.</span><select id="${prefix}${i}" aria-label="${prefix === 'ppa' ? 'Ljudspråk' : 'Undertextspråk'} ${i + 1}">${langOpts(vals[i] || '', { orig })}</select></label>`).join('');
  box.innerHTML = `<h2>Uppspelning</h2>
    <p class="muted small">Gäller ditt konto på alla enheter – webbläsare, appar och Chromecast. Du kan alltid byta spår under ⚙ medan du tittar.</p>
    <h3 class="pph">Ljud</h3>
    <fieldset class="pplangs"><legend>Föredraget ljudspråk, i ordning</legend><div class="row">${langRow('ppa', N_AUDIO, p.audioLangs, true)}</div></fieldset>
    <p class="muted small">Första språket som filmen har spelas. Originalspråk = filens förvalda ljudspår. Kommentarsspår väljs aldrig automatiskt.</p>
    <div class="ppchk"><label class="ccheck"><input type="checkbox" id="ppad" ${p.audioDesc ? 'checked' : ''}> Syntolkning: välj ljudspåret med ljudbeskrivning när filmen har ett</label></div>
    <h3 class="pph">Undertexter</h3>
    <div class="row ppgrid">
      <div><label for="ppmode">Visa undertexter</label>${sel('ppmode', SUB_MODES, p.subMode)}</div>
      <div><label for="ppsdh">Undertexter för hörselskadade (SDH)</label>${sel('ppsdh', [['avoid', 'Undvik SDH'], ['prefer', 'Föredra SDH']], p.sdh)}</div></div>
    <fieldset class="pplangs"><legend>Undertextspråk, i ordning</legend><div class="row">${langRow('pps', N_SUB, p.subLangs, false)}</div></fieldset>
    <p class="muted small">Tvingade undertexter visar bara repliker på andra språk (t.ex. utomjordingar). "Mina språk" är både ljud- och undertextspråken ovan.</p>
    <div class="ppchk"><label class="ccheck"><input type="checkbox" id="ppsync" ${p.autoSync !== false ? 'checked' : ''}> Synka nedladdade undertexter mot ljudet automatiskt</label></div>
    <p class="muted small">Servern jämför replikerna med talet i filmen och flyttar undertexten (även fel bildfrekvens, t.ex. 25 mot 23,976). Det går också att synka eller finjustera under ⚙ i spelaren.</p>
    <h3 class="pph">Serier</h3>
    <div class="ppchk">
      <label class="ccheck"><input type="checkbox" id="ppintro" ${p.skipIntro ? 'checked' : ''}> Hoppa över intro automatiskt</label>
      <label class="ccheck"><input type="checkbox" id="pprecap" ${p.skipRecap ? 'checked' : ''}> Hoppa över sammanfattningen ("tidigare i serien")</label>
      <label class="ccheck"><input type="checkbox" id="ppcred" ${p.skipCredits ? 'checked' : ''}> Hoppa över eftertexterna – nästa avsnitt startar</label>
      <label class="ccheck"><input type="checkbox" id="ppnext" ${p.autoNext ? 'checked' : ''}> Spela nästa avsnitt automatiskt</label></div>
    <div class="row ppgrid"><div><label for="ppcd">Nedräkning före nästa avsnitt</label>${sel('ppcd', COUNTDOWNS.map(s => [s, s ? s + ' sekunder' : 'Ingen – direkt']), p.nextCountdown)}</div></div>
    <p class="muted small">Innan spelaren hoppar visas "Hoppar över intro…" i några sekunder med Avbryt. Fungerar när intro och eftertexter har hittats i avsnittet.</p>
    <h3 class="pph">Kvalitet</h3>
    <div class="row ppgrid">
      <div><label for="ppqh">Hemma</label>${sel('ppqh', [['auto', 'Auto (original)'], ...QUALS], p.qualityHome)}</div>
      <div><label for="ppqr">Utanför hemmet</label>${sel('ppqr', remoteQ, QRANK[p.qualityRemote] > QRANK[cap] ? 'auto' : p.qualityRemote)}</div></div>
    <p class="muted small">Utanför hemmet tillåter servern högst ${esc(capName)}. Med Auto väljs kvaliteten efter uppkopplingen.</p>`;
  const langs = (prefix, n) => [...new Set(Array.from({ length: n }, (_, i) => $(`#${prefix}${i}`, box).value).filter(Boolean))];
  const save = act(async () => {
    const body = {
      audioLangs: langs('ppa', N_AUDIO), subLangs: langs('pps', N_SUB), subMode: $('#ppmode', box).value, sdh: $('#ppsdh', box).value,
      skipIntro: $('#ppintro', box).checked, skipRecap: $('#pprecap', box).checked, skipCredits: $('#ppcred', box).checked,
      autoNext: $('#ppnext', box).checked, nextCountdown: +$('#ppcd', box).value, qualityHome: $('#ppqh', box).value, qualityRemote: $('#ppqr', box).value,
      autoSync: $('#ppsync', box).checked, audioDesc: $('#ppad', box).checked
    };
    await api('/me/playback-prefs', { method: 'PUT', body, bg: true });
    toast('Sparat');
  });
  $$('select,input', box).forEach(x => { x.onchange = save; });
}
