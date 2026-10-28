// Offline i webbappen: filmer, avsnitt, album och ljudböcker sparas i webbläsaren och spelas utan kontakt med servern.
// Laddas vid behov (need('offline.js') i lazy.js, eller statiskt från de lata vyerna).
//
// Lagring: filerna ligger i Cache Storage ('braxhn-dl-v1' – service workern rensar bara sina egna 'braxhn-app-*')
// som bitar om 16 MB (/__dl/<profil>/<nyckel>/<del>/<bit>). En avbruten nedladdning fortsätter från första bit som
// saknas med en Range-förfrågan; svarar servern utan Range (omkodat ljud) börjar delen om. Uppspelning sätter ihop
// bitarna till en Blob (blob:-adress, CSP media-src tillåter det). Listan över nedladdningar ligger per profil i
// localStorage (store 'dl.<profil-id>'), tillsammans med den senast inloggade profilen ('dl.last') som visas när
// servern inte svarar. Utloggning glömmer 'dl.last' (nästa person på datorn ser inget offline), men filerna finns kvar
// tills de tas bort eller profilen loggar in igen.
//
// Servern bestämmer allt om behörighet: nedladdningsrätten (can_download), åldersgräns och bibliotek kontrolleras när
// planen hämtas (/api/items/:id/offline, /api/music/albums/:id/offline, /api/audiobooks/book/:id/offline) och varje
// fil hämtas med en kortlivad mediatoken som bara gäller titeln (scope). Token sparas aldrig – en ny plan hämtas
// varje gång en nedladdning startar eller fortsätter.
//
// Tittarposition offline sparas lokalt (pending) och skickas med "at" (när den sparades) när servern svarar igen –
// servern behåller ett senare framsteg från en annan enhet.
import { api, esc, fmtSize, me, store, toast, toastErr, t } from './core.js';
import { audioCaps, capsQuery } from './player/caps.js';
import { confirmDialog, openDialog } from './ui/dialog.js';

const CACHE = 'braxhn-dl-v1';
const CHUNK = 16 << 20;
const ACTIVE = ['queued', 'preparing', 'downloading'];
const VIDEO = ['movie', 'episode'];
/** Händelser: 'change' (listan ändrades), 'progress' (detail: { key, got, size }) */
export const bus = new EventTarget();

// ---------- lista per profil ----------
/** Profilen vars nedladdningar gäller: den inloggade, annars (servern svarar inte) den senast inloggade */
export const lastProfile = () => store.get('dl.last', null);
export const profileId = () => me?.id ?? lastProfile()?.id ?? null;
const listKey = (uid) => 'dl.' + uid;
export function list(uid = profileId()) { const l = uid == null ? [] : store.get(listKey(uid), []); return Array.isArray(l) ? l : []; }
export const find = (key, uid) => list(uid).find(e => e.key === key) || null;
function write(uid, l) {
  store.set(listKey(uid), l);
  // Arbete kvar (nedladdningar eller osynkade positioner): app.js laddar den här modulen när appen startar
  store.set('dlwork', l.some(e => ACTIVE.includes(e.state) || e.pending) || list().some(e => e.pending));
  bus.dispatchEvent(new Event('change'));
}
/** Läser om listan och ändrar en post (andra flikar kan ha skrivit under tiden). fn får ändra e; returnerar e. */
function update(key, fn, uid = profileId()) {
  const l = list(uid), e = l.find(x => x.key === key);
  if (!e) return null;
  fn(e); write(uid, l); return e;
}
export const keyOf = (kind, id) => (VIDEO.includes(kind) ? 'v' : kind === 'album' ? 'a' : 'b') + (+id);

// ---------- Cache Storage ----------
const chunkUrl = (uid, key, part, n) => `/__dl/${uid}/${key}/${part}/${n}`;
const extraUrl = (uid, key, what) => `/__dl/${uid}/${key}/${what}`;
const openCache = () => caches.open(CACHE);
export const supported = () => typeof caches !== 'undefined' && !!window.isSecureContext && typeof ReadableStream !== 'undefined';

/** Använt utrymme och kvot i webbläsaren, och om lagringen är beständig */
export async function storageInfo() {
  const s = navigator.storage;
  const [est, persisted] = await Promise.all([s?.estimate?.().catch(() => null), s?.persisted?.().catch(() => false)]);
  return { usage: est?.usage || 0, quota: est?.quota || 0, persisted: !!persisted };
}
/** Be webbläsaren att inte rensa nedladdningarna när utrymmet tar slut (Chrome avgör själv, Firefox frågar) */
async function persist() { try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {} }

// ---------- köa ----------
const QLABEL = { src: 'Original', orig: t('Full upplösning'), '1080': '1080p', '720': '720p', '480': '480p' };
const QKBPS = { '1080': 6000, '720': 3000, '480': 1200 };
const estimate = (q, dur) => QKBPS[q] && dur ? Math.round((QKBPS[q] + 160) * 1000 / 8 * dur) : 0;
const posterOf = (kind, id, it = {}) => kind === 'album' ? `/api/music/cover/${id}?w=320` : kind === 'book' ? `/api/audiobooks/cover/${id}?w=320`
  : kind === 'episode' && it.thumb ? `/api/image/${id}/thumb?w=480` : kind === 'episode' && it.show ? `/api/image/${it.show}/poster?w=320` : `/api/image/${id}/poster?w=320`;

/** Lägger till en post i kön (eller låter den vara om den redan finns) och startar nedladdningen */
async function enqueue(e, poster) {
  const uid = me?.id;
  if (uid == null) throw new Error(t('Logga in för att spara offline'));
  if (!supported()) throw new Error(t('Den här webbläsaren kan inte spara offline (kräver HTTPS)'));
  store.set('dl.last', { id: uid, name: me.name, kid: !!me.kid });
  const l = list(uid);
  if (l.some(x => x.key === e.key)) return false;
  l.push({ state: 'queued', got: 0, size: 0, added: Date.now(), position: 0, ...e });
  write(uid, l);
  persist();
  // Omslaget sparas direkt (det syns i listan även innan filen är klar)
  if (poster) fetch(poster).then(r => r.ok && openCache().then(c => c.put(extraUrl(uid, e.key, 'poster'), r))).then(() => bus.dispatchEvent(new Event('change'))).catch(() => {});
  pump();
  return true;
}

/** Dialog: välj kvalitet. Returnerar q eller null. opts: { src: bool (webbläsaren kan spela filen), size, duration, height, many } */
function qualityDialog(title, { src, size, duration, height, many }) {
  const last = store.get('dlq', '720');
  const opts = [
    ...(src ? [{ q: 'src', label: 'Original', hint: t('filen som den är{v}', { v: size ? ' · ' + fmtSize(size) : '' }) }] : []),
    ...(many ? [{ q: 'src?', label: t('Original när det går'), hint: t('annars 1080p') }] : []),
    ...['1080', '720', '480'].filter(q => !height || +q <= Math.max(480, height) || q === '480')
      .map(q => ({ q, label: QLABEL[q], hint: t('omkodas på servern{v}', { v: estimate(q, duration) ? ' · ≈ ' + fmtSize(estimate(q, duration)) : '' }) }))];
  const pick = opts.some(o => o.q === last) ? last : opts.find(o => o.q === '720')?.q || opts[0].q;
  const d = openDialog({ title, body: `<fieldset class="dlq"><legend class="muted small">${t('Kvalitet')}</legend>${opts.map(o => `<label class="dlqopt"><input type="radio" name="dlq" value="${esc(o.q)}"${o.q === pick ? ' checked' : ''}>
    <span><b>${esc(o.label)}</b> <span class="muted small">${esc(o.hint)}</span></span></label>`).join('')}</fieldset>
    <p class="muted small" id="dlqspace"></p>`,
  actions: [{ label: t('Avbryt'), value: null }, { label: t('Spara offline'), kind: 'primary', onClick: (h) => h.$('input[name=dlq]:checked')?.value || null }] });
  storageInfo().then(s => { const el = d.$('#dlqspace'); if (el && s.quota) el.textContent = t('Ledigt i webbläsaren: {v}', { v: fmtSize(Math.max(0, s.quota - s.usage)) }); }).catch(() => {});
  return d.closed.then(v => { if (typeof v === 'string') store.set('dlq', v === 'src?' ? '1080' : v); return typeof v === 'string' ? v : null; });
}

// Uppspelningsbeslutet (samma som titelsidan): kan webbläsaren spela filen som den är? Ger även vald version
// (flera versioner) och den förvalda undertexten.
const decision = (id) => api(`/items/${id}/playback?${capsQuery({ q: 'orig' })}&info=1`, { bg: true }).catch(() => null);
const videoEntry = (it, p, q) => ({
  key: keyOf(it.kind, it.id), kind: it.kind, id: it.id, file: p?.version || it.id, q, title: it.title,
  sub: it.kind === 'episode' ? `${it.showTitle || ''}`.trim() : it.year ? String(it.year) : '',
  show: it.kind === 'episode' && it.show ? { id: it.show, title: it.showTitle || '' } : null, season: it.season ?? null, episode: it.episode ?? null,
  duration: it.duration || p?.duration || 0, position: it.position > 30 && !it.watched ? it.position : 0, defSub: p?.defaultSub || null,
  intro: p?.intro || null, credits: p?.credits || null });

/** "Spara offline" för en film eller ett avsnitt (it = titeln från ett kort eller titelsidan) */
export async function downloadItem(it) {
  try {
    if (me?.canDownload === false) return toast(t('Ditt konto får inte ladda ner'), { error: true });
    const key = keyOf(it.kind, it.id), had = find(key);
    if (had) return alreadyThere(had);
    const p = await decision(it.version || it.id);
    const q = await qualityDialog(t('Spara offline – {v}{title}', { v: it.kind === 'episode' && it.showTitle ? it.showTitle + ' · ' : '', title: it.title }),
      { src: p?.mode === 'direct', size: it.size, duration: it.duration || p?.duration, height: it.height });
    if (!q) return;
    await enqueue(videoEntry(it, p, q), posterOf(it.kind, it.id, it));
    toast(t('{title} sparas offline – se Nedladdat', { title: it.title }), { action: { label: t('Visa'), onClick: () => { location.hash = '#/downloads'; } } });
  } catch (e) { toastErr(e); }
}
/** "Spara säsongen offline": alla avsnitt i listan (seriens titelsida) */
export async function downloadEpisodes(show, eps) {
  try {
    if (me?.canDownload === false) return toast(t('Ditt konto får inte ladda ner'), { error: true });
    const todo = eps.filter(e => !find(keyOf('episode', e.id)));
    if (!todo.length) return toast(t('Avsnitten finns redan i Nedladdat'));
    const dur = todo.reduce((s, e) => s + (e.duration || 0), 0);
    const q = await qualityDialog(t('Spara {todoN} avsnitt offline – {title}', { todoN: todo.length, title: show.title }), { many: true, duration: dur });
    if (!q) return;
    for (const e of todo) {
      const it = { ...e, kind: 'episode', show: show.id, showTitle: show.title };
      const p = await decision(e.id);
      const eq = q === 'src?' ? (p?.mode === 'direct' ? 'src' : '1080') : q;
      await enqueue(videoEntry(it, p, eq), posterOf('episode', e.id, it));
    }
    toast(t('{todoN} avsnitt sparas offline – se Nedladdat', { todoN: todo.length }), { action: { label: t('Visa'), onClick: () => { location.hash = '#/downloads'; } } });
  } catch (e) { toastErr(e); }
}
/** "Spara offline" för ett album */
export async function downloadAlbum(id) {
  try {
    if (me?.canDownload === false) return toast(t('Ditt konto får inte ladda ner'), { error: true });
    const key = keyOf('album', id); if (find(key)) return alreadyThere(find(key));
    const a = await api(`/music/albums/${+id}/offline?a=${audioCaps()}`, { bg: true });
    await enqueue({ key, kind: 'album', id: a.id, title: a.title, sub: a.artist || '', year: a.year, duration: a.duration,
      parts: a.tracks.map(t => ({ id: t.id, title: t.title, track: t.track, disc: t.disc, artist: t.artist, duration: t.duration, gain: t.gain ?? null, peak: t.peak ?? null })) },
    a.cover ? posterOf('album', a.id) : null);
    toast(t('{title} sparas offline – se Nedladdat', { title: a.title }), { action: { label: t('Visa'), onClick: () => { location.hash = '#/downloads'; } } });
  } catch (e) { toastErr(e); }
}
/** "Spara offline" för en ljudbok */
export async function downloadBook(id) {
  try {
    if (me?.canDownload === false) return toast(t('Ditt konto får inte ladda ner'), { error: true });
    const key = keyOf('book', id); if (find(key)) return alreadyThere(find(key));
    const b = await api(`/audiobooks/book/${+id}/offline?a=${audioCaps()}`, { bg: true });
    await enqueue({ key, kind: 'book', id: b.id, title: b.title, sub: b.author || '', duration: b.duration, position: b.position || 0, speed: b.speed || 1,
      chapters: (b.chapters || []).slice(0, 500).map(c => ({ title: c.title, start: c.start, end: c.end })),
      parts: b.files.map(f => ({ id: f.id, offset: f.offset, duration: f.duration })) }, b.cover ? posterOf('book', b.id) : null);
    toast(t('{title} sparas offline – se Nedladdat', { title: b.title }), { action: { label: t('Visa'), onClick: () => { location.hash = '#/downloads'; } } });
  } catch (e) { toastErr(e); }
}
async function alreadyThere(e) {
  const done = e.state === 'done';
  const d = openDialog({ title: e.title, body: `<p>${done ? t('Finns redan i Nedladdat.') : t('Ligger redan i kön för Nedladdat.')}</p>`,
    actions: [{ label: t('Ta bort'), kind: 'danger', value: 'del' }, { label: t('Stäng') }, { label: t('Visa Nedladdat'), kind: 'primary', value: 'show' }] });
  const v = await d.closed;
  if (v === 'show') location.hash = '#/downloads';
  if (v === 'del') await removeEntry(e.key, true);
}
/** Finns titeln i Nedladdat? 'done' | 'active' | null */
export function stateOf(kind, id) { const e = find(keyOf(kind, id)); return !e ? null : e.state === 'done' ? 'done' : 'active'; }

// ---------- pausa, fortsätt, ta bort ----------
let cur = null; // { key, ctrl } – nedladdningen som pågår i den här fliken
export function pause(key) { update(key, e => { if (ACTIVE.includes(e.state)) e.state = 'paused'; }); if (cur?.key === key) cur.ctrl.abort(); }
export function resumeEntry(key) { update(key, e => { if (e.state === 'paused' || e.state === 'error') { e.state = 'queued'; e.error = null; } }); pump(); }
export async function removeEntry(key, ask = false) {
  const uid = profileId(), e = find(key, uid);
  if (!e) return;
  if (ask && !await confirmDialog(t('Ta bort {title} från Nedladdat?', { title: e.title }), { okLabel: t('Ta bort'), danger: true })) return false;
  if (cur?.key === key) cur.ctrl.abort();
  // Avbryt serverns omkodning om den bara gjordes för den här nedladdningen
  if (e.state === 'preparing' && me) api(`/items/${e.file}/offline?q=${encodeURIComponent(e.q)}`, { method: 'DELETE', bg: true }).catch(() => {});
  write(uid, list(uid).filter(x => x.key !== key));
  await dropFiles(uid, e);
  return true;
}
async function dropFiles(uid, e) {
  try {
    const c = await openCache();
    const urls = [extraUrl(uid, e.key, 'poster'), ...(e.subs || []).map((s, i) => extraUrl(uid, e.key, 'sub' + i))];
    (e.parts || []).forEach((p, i) => { for (let n = 0; n < (p.chunks || 0) + 1; n++) urls.push(chunkUrl(uid, e.key, i, n)); });
    await Promise.all(urls.map(u => c.delete(u)));
  } catch {}
}
/** Tar bort allt som profilen sparat offline */
export async function removeAll() {
  const uid = profileId();
  for (const e of list(uid)) { if (cur?.key === e.key) cur.ctrl.abort(); await dropFiles(uid, e); }
  write(uid, []);
}

// ---------- nedladdning ----------
let running = false, retry = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const netErr = (e) => !!e && (e.offline || e.name === 'TypeError' || /network|fetch|Load failed/i.test(e.message || ''));
/** Startar kön (en flik i taget laddar ner – Web Locks) */
export function pump() {
  if (running || me?.id == null) return;
  running = true;
  const go = () => loop().catch(e => console.warn('[offline]', e));
  const p = navigator.locks?.request ? navigator.locks.request('braxhn-dl', { ifAvailable: true }, (lock) => lock ? go() : null) : go();
  Promise.resolve(p).finally(() => { running = false; });
}
async function loop() {
  const uid = me?.id;
  for (;;) {
    if (me?.id !== uid) return; // profilbyte: den nya profilens kö startar vid nästa pump()
    const todo = list(uid).filter(e => ACTIVE.includes(e.state));
    if (!todo.length) return;
    let moved = false, waiting = false;
    for (const tm of todo) {
      const e = find(tm.key, uid);
      if (!e || !ACTIVE.includes(e.state)) continue;
      try { const r = await work(uid, e); if (r === 'wait') waiting = true; else moved = true; }
      catch (err) {
        if (err.name === 'AbortError') { moved = true; continue; } // pausad eller borttagen
        if (netErr(err)) { clearTimeout(retry); retry = setTimeout(pump, 30000); return; } // ingen kontakt: igen om en stund eller när nätet kommer tillbaka
        const msg = err.name === 'QuotaExceededError' ? t('Inte tillräckligt med utrymme i webbläsaren – ta bort något i Nedladdat') : err.message || String(err);
        update(e.key, x => { x.state = 'error'; x.error = msg; }, uid);
        moved = true;
      }
    }
    if (!moved && waiting) await sleep(4000);
  }
}
/** Hämtar filen/filerna för posten. 'wait' = servern förbereder (omkodar) filen. */
async function work(uid, e) {
  let files, subs = [];
  if (VIDEO.includes(e.kind)) {
    const q = encodeURIComponent(e.q);
    let st = await api(`/items/${e.file}/offline?q=${q}&subs=1`, { bg: true });
    if (st.status === 'none' || (st.status === 'error' && e.state !== 'preparing')) st = await api(`/items/${e.file}/offline`, { method: 'POST', body: { q: e.q }, bg: true });
    if (st.status === 'error') throw new Error(st.error || t('Servern kunde inte förbereda filen'));
    if (st.status !== 'ready') { update(e.key, x => { if (ACTIVE.includes(x.state)) { x.state = 'preparing'; x.prep = st.progress || 0; } }, uid); return 'wait'; }
    if (st.status === 'ready' && !st.url) st = await api(`/items/${e.file}/offline?q=${q}&subs=1`, { bg: true });
    files = [{ url: st.url, size: st.size || 0 }];
    subs = st.subs || [];
  } else if (e.kind === 'album') {
    const a = await api(`/music/albums/${e.id}/offline?a=${audioCaps()}`, { bg: true });
    const byId = new Map(a.tracks.map(t => [t.id, t]));
    files = e.parts.map(p => ({ url: byId.get(p.id)?.url, size: 0 }));
  } else {
    const b = await api(`/audiobooks/book/${e.id}/offline?a=${audioCaps()}`, { bg: true });
    const byId = new Map(b.files.map(f => [f.id, f]));
    files = e.parts.map(p => ({ url: byId.get(p.id)?.url, size: 0 }));
  }
  if (files.some(f => !f.url)) throw new Error(t('Innehållet har ändrats på servern – ta bort och ladda ned igen'));
  const size = files.reduce((s, f) => s + f.size, 0);
  update(e.key, x => {
    if (!ACTIVE.includes(x.state)) return;
    x.state = 'downloading'; x.prep = 100;
    if (!x.parts) x.parts = files.map(() => ({}));
    if (size) x.size = size;
  }, uid);
  // Utrymme: avbryt i förväg om filen uppenbart inte får plats
  if (size) {
    const s = await storageInfo();
    const left = size - (find(e.key, uid)?.got || 0);
    if (s.quota && s.quota - s.usage < left + 50e6) throw Object.assign(new Error(t('Inte tillräckligt med utrymme i webbläsaren ({left} behövs, {v} ledigt)', { left: fmtSize(left), v: fmtSize(Math.max(0, s.quota - s.usage)) })), { name: 'SpaceError' });
  }
  const ctrl = new AbortController();
  cur = { key: e.key, ctrl };
  try {
    for (let i = 0; i < files.length; i++) await fetchPart(uid, e.key, i, files[i].url, ctrl.signal);
    // Undertexterna (små) sist – en undertext som inte går att läsa hoppas över
    const c = await openCache(), got = [];
    for (const s of subs) {
      try {
        const r = await fetch(s.url, { signal: ctrl.signal });
        if (!r.ok) continue;
        await c.put(extraUrl(uid, e.key, 'sub' + got.length), new Response(await r.blob(), { headers: { 'Content-Type': 'text/vtt' } }));
        got.push({ id: s.id, lang: s.lang, label: s.label, forced: !!s.forced });
      } catch (err) { if (err.name === 'AbortError') throw err; }
    }
    update(e.key, x => { x.subs = got; x.state = 'done'; x.done = Date.now(); x.size = x.parts.reduce((s, p) => s + (p.size || p.got || 0), 0); x.got = x.size; }, uid);
    return 'done';
  } finally { if (cur?.ctrl === ctrl) cur = null; }
}
let lastTick = 0;
async function fetchPart(uid, key, i, url, signal) {
  const e0 = find(key, uid), p0 = e0?.parts?.[i];
  if (!p0) throw Object.assign(new Error(''), { name: 'AbortError' });
  if (p0.done) return;
  const c = await openCache();
  let from = p0.got || 0, chunks = p0.chunks || 0;
  const res = await fetch(url, { headers: from ? { Range: `bytes=${from}-` } : {}, signal, cache: 'no-store' });
  if (res.status === 416 && from) { update(key, x => { x.parts[i].done = true; }, uid); return; }
  if (!res.ok) throw new Error(res.status === 403 ? t('Nedladdningen nekades av servern') : res.status === 404 ? t('Filen finns inte längre på servern') : t('Servern svarade {status}', { status: res.status }));
  const total = +(/\/(\d+)$/.exec(res.headers.get('content-range') || '')?.[1] || 0) || (+res.headers.get('content-length') ? +res.headers.get('content-length') + (res.status === 206 ? from : 0) : 0);
  // Servern skickade hela filen (ingen Range) eller filen har bytts sedan förra gången: börja om delen
  if (from && (res.status !== 206 || (p0.size && total && total !== p0.size))) {
    for (let n = 0; n < chunks; n++) await c.delete(chunkUrl(uid, key, i, n));
    from = 0; chunks = 0;
    if (res.status === 206) { res.body?.cancel?.(); update(key, x => { Object.assign(x.parts[i], { got: 0, chunks: 0, size: 0 }); }, uid); return fetchPart(uid, key, i, url, signal); }
  }
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  update(key, x => { Object.assign(x.parts[i], { got: from, chunks, size: total, mime: /^(video|audio)\//.test(mime) ? mime : x.parts[i].mime || '' }); }, uid);
  const reader = res.body.getReader();
  let buf = [], n = 0;
  const flush = async () => {
    if (!n) return;
    await c.put(chunkUrl(uid, key, i, chunks), new Response(new Blob(buf)));
    chunks++; from += n; buf = []; n = 0;
    const e = update(key, x => { Object.assign(x.parts[i], { got: from, chunks }); x.got = x.parts.reduce((s, p) => s + (p.got || 0), 0); }, uid);
    if (!e) throw Object.assign(new Error(''), { name: 'AbortError' }); // borttagen under tiden
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf.push(value); n += value.length;
    if (Date.now() - lastTick > 300) {
      lastTick = Date.now();
      const e = find(key, uid);
      if (e) bus.dispatchEvent(new CustomEvent('progress', { detail: { key, got: e.parts.reduce((s, p, j) => s + (j === i ? from + n : p.got || 0), 0), size: e.size } }));
    }
    if (n >= CHUNK) await flush();
  }
  await flush();
  update(key, x => { const p = x.parts[i]; p.done = true; if (!p.size) p.size = p.got; }, uid);
}

// ---------- uppspelning ----------
/** Delen (filen) som en Blob ur bitarna i cachen */
export async function partBlob(e, i, uid = profileId()) {
  const c = await openCache(), p = e.parts[i], blobs = [];
  for (let n = 0; n < (p.chunks || 0); n++) {
    const r = await c.match(chunkUrl(uid, e.key, i, n));
    if (!r) throw new Error(t('Delar av filen saknas i webbläsaren – ta bort och ladda ned igen'));
    blobs.push(await r.blob());
  }
  return new Blob(blobs, { type: p.mime || (VIDEO.includes(e.kind) ? 'video/mp4' : 'audio/mpeg') });
}
/** Omslaget/affischen som blob:-adress (null om det inte sparats). Anroparen släpper adressen. */
export async function posterUrl(e, uid = profileId()) {
  try { const r = await (await openCache()).match(extraUrl(uid, e.key, 'poster')); return r ? URL.createObjectURL(await r.blob()) : null; } catch { return null; }
}
/** Undertexterna som blob:-adresser: [{ label, lang, forced, id, url }] */
export async function subUrls(e, uid = profileId()) {
  const c = await openCache(), out = [];
  for (const [i, s] of (e.subs || []).entries()) {
    const r = await c.match(extraUrl(uid, e.key, 'sub' + i)).catch(() => null);
    if (r) out.push({ ...s, url: URL.createObjectURL(new Blob([await r.blob()], { type: 'text/vtt' })) });
  }
  return out;
}

// ---------- tittarposition ----------
let syncing = false, syncTimer = null;
/** Sparar positionen lokalt (och i kön till servern). done = filmen/boken är slut. */
export function savePosition(key, pos, done = false) {
  const e = update(key, x => {
    x.position = done ? 0 : Math.max(0, Math.round(pos)); x.played = Date.now(); if (done) x.finished = true;
    if (x.kind !== 'album') x.pending = { pos: done ? x.duration || pos : Math.max(0, Math.round(pos)), at: Math.floor(Date.now() / 1000) };
  });
  if (e?.pending && me) { clearTimeout(syncTimer); syncTimer = setTimeout(syncPositions, 2000); }
}
/** Skickar positioner som sparats offline – bara för profilen som är inloggad (kakan hör till den) */
export async function syncPositions() {
  if (syncing || me?.id == null) return;
  syncing = true;
  const uid = me.id;
  try {
    for (const e of list(uid).filter(x => x.pending)) {
      const sent = e.pending;
      const path = e.kind === 'book' ? `/api/audiobooks/book/${e.id}/progress` : `/api/items/${e.file || e.id}/progress`;
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: sent.pos, at: sent.at, ...(e.duration ? { duration: e.duration } : {}) }) });
      if (r.status === 401) break; // inte inloggad – nästa gång
      // Klart (eller titeln finns inte/får inte ses längre): ta bort ur kön, om ingen ny position sparats under tiden
      if (r.ok || r.status === 403 || r.status === 404) update(e.key, x => { if (x.pending?.at === sent.at && x.pending?.pos === sent.pos) delete x.pending; }, uid);
    }
  } catch { /* ingen kontakt: när nätet kommer tillbaka */ } finally { syncing = false; }
}
/** Positioner som väntar på att skickas */
export const pendingCount = () => list().filter(e => e.pending).length;

/** Anropas när appen startat med en inloggad profil: kön och synken fortsätter */
export function resume() {
  if (me?.id == null) return;
  store.set('dl.last', { id: me.id, name: me.name, kid: !!me.kid });
  pump(); syncPositions();
}
window.addEventListener('online', () => { pump(); syncPositions(); });
