// Chromecast (Cast SDK:s CAF-ramverk, Default Media Receiver): filmer, avsnitt, musik, ljudböcker och poddar.
// - Varje titel laddas med en egen kortlivad mediatoken (servern: cast=1, token gäller bara den titeln).
// - Nästa avsnitt köas på mottagaren (queueInsertItems) med en egen token (playback?queue=1) – och nästa igen när det startar.
// - Framsteg och sedd-status sparas medan man castar: RemotePlayerControllers händelser → samma framstegs-API som
//   webbspelaren (var 10:e sekund, vid paus, när titeln byts och när uppspelningen slutar).
// - Kontrollpanelen (#castbar, som mini-spelaren) styr mottagaren: spola, paus, ±10 s, volym, ljud- och undertextspår, stopp.
// Vilken titel som spelas står i MediaInfo.customData (bx: 1) – så hittar en omladdad sida tillbaka till en pågående cast.
import { $, api, esc, fmtTime, status, sxe, toast, toastErr } from '../core.js';
import { P, closePlayer } from './video.js';
import { serverFxParams } from './comfort.js';
import { M, spokenPos, stopAudio } from '../audio.js';

export let castReady = false;
const C = { ctx: null, player: null, ctrl: null, cur: null, lastPos: 0, lastSent: 0, queued: new Set(), skipPlayed: null };
const SEND_EVERY = 10000;
const origin = () => status.publicUrl || location.origin;

export function initCast() {
  if (!window.chrome || !window.isSecureContext || document.getElementById('castsdk')) return;
  window.__onGCastApiAvailable = (ok) => {
    if (!ok || !window.cast?.framework) return;
    C.ctx = cast.framework.CastContext.getInstance();
    C.ctx.setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });
    castReady = true;
    document.querySelectorAll('.castbtn').forEach(b => b.hidden = false);
    try { remote(); } catch (e) { console.warn('[cast]', e); }
  };
  const s = document.createElement('script'); s.id = 'castsdk';
  s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
  document.head.append(s);
}

// ---------- mottagarens tillstånd → framsteg och panel ----------
function remote() {
  const F = cast.framework, E = F.RemotePlayerEventType;
  C.player = new F.RemotePlayer();
  C.ctrl = new F.RemotePlayerController(C.player);
  const on = (ev, fn) => C.ctrl.addEventListener(ev, fn);
  on(E.MEDIA_INFO_CHANGED, mediaChanged);
  on(E.CURRENT_TIME_CHANGED, () => {
    if (!C.cur) return;
    C.lastPos = pos();
    if (!C.player.isPaused && Date.now() - C.lastSent >= SEND_EVERY) report(C.cur, C.lastPos);
    paint();
  });
  on(E.IS_PAUSED_CHANGED, () => { if (C.cur) report(C.cur, C.lastPos = pos()); paint(); });
  on(E.IS_MEDIA_LOADED_CHANGED, () => { if (!C.player.isMediaLoaded) finish(); });
  on(E.IS_CONNECTED_CHANGED, () => { if (!C.player.isConnected) finish(); });
  for (const ev of [E.VOLUME_LEVEL_CHANGED, E.IS_MUTED_CHANGED, E.DURATION_CHANGED]) on(ev, paint);
  // Sidan laddades om medan en cast pågår: ta upp tråden
  if (C.player.isConnected && C.player.mediaInfo) mediaChanged();
}
const curOf = (mi) => mi?.customData?.bx === 1 ? { ...mi.customData, key: `${mi.customData.kind}:${mi.customData.id}:${mi.customData.offset || 0}` } : null;
/** Position i titeln: filens början i en ljudbok (offset) + ev. startpunkt i en omkodad ström (ss) + mottagarens tid */
const pos = () => (C.cur?.offset || 0) + (C.cur?.ss || 0) + (C.player?.currentTime || 0);
function mediaChanged() { adopt(curOf(C.player.mediaInfo)); }
/** Byt titel som följs: spara den förra (sista kända positionen) och börja följa den nya */
function adopt(next, at) {
  if (next?.key === C.cur?.key) { if (next) C.cur = next; return paint(); }
  if (C.cur) report(C.cur, C.lastPos, true);
  C.cur = next; C.lastPos = next ? at ?? pos() : 0; C.lastSent = Date.now();
  if (next) started(next);
  paint();
}
function finish() {
  if (C.cur) report(C.cur, C.lastPos, true);
  C.cur = null; C.queued.clear();
  paint();
}
// En ny titel startade på mottagaren: musikspår räknas som spelade, avsnitt köar nästa
function started(cur) {
  if (cur.kind === 'track' && C.skipPlayed !== cur.id) fetch(`/api/music/tracks/${cur.id}/played`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  C.skipPlayed = null;
  if (cur.kind === 'video' && cur.nextId) queueNext(cur.nextId);
}
/** Spara framsteget med webbspelarens API (filmer/avsnitt) eller ljudböckernas och poddarnas */
function report(cur, position, final = false) {
  if (!cur || !(position >= 1)) return;
  C.lastSent = Date.now();
  const url = cur.kind === 'video' ? `/api/items/${cur.id}/progress` : cur.kind === 'book' ? `/api/audiobooks/book/${cur.id}/progress`
    : cur.kind === 'podcast' ? `/api/podcasts/episodes/${cur.id}/progress` : null;
  if (!url) return;
  const body = cur.kind === 'video' ? { position, duration: cur.duration } : { position };
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true })
    .then(r => r.json()).then(d => {
      // Administratören stoppade uppspelningen eller skärmtiden tog slut
      if (d?.stop && !final && C.cur === cur) { toast(d.screenTime?.message || 'Uppspelningen stoppades'); stopCast(); }
    }).catch(() => {});
}
window.addEventListener('pagehide', () => { if (C.cur) report(C.cur, C.lastPos, true); });

// ---------- laddning ----------
async function session() {
  let s = C.ctx.getCurrentSession();
  if (!s) { try { await C.ctx.requestSession(); } catch { return null; } s = C.ctx.getCurrentSession(); }
  return s;
}
const promise = (fn) => new Promise((ok, no) => fn(ok, no));
/** MediaInfo för en film/ett avsnitt (en egen mediatoken per titel). queue: köas för senare (ingen förstart på servern). */
// sub: undertextens id, '' = inga, utelämnad = kontots förval (defaultSub från servern)
async function videoMedia(it, { audio = '', sub, queue = false } = {}) {
  const p = await api(`/items/${it.id}/playback?` + new URLSearchParams({ c: 'mp4,webm', v: 'h264,vp8,vp9', a: 'aac,mp3,opus,flac', hdr: '0', cast: '1', audio: audio || '',
    q: P?.q && P.q !== 'auto' ? P.q : '', ...(it.version ? { version: it.version } : {}), ...(queue ? { queue: '1' } : {}), ...serverFxParams(true) }), { bg: true }); // nattläge/dialog: servern filtrerar
  const o = origin();
  const mi = new chrome.cast.media.MediaInfo(o + p.url, p.mime);
  mi.streamType = chrome.cast.media.StreamType.BUFFERED;
  if (p.mode !== 'direct') { mi.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat.TS; mi.hlsVideoSegmentFormat = chrome.cast.media.HlsVideoSegmentFormat.MPEG2_TS; }
  const title = it.kind === 'episode' ? `${it.showTitle} – ${sxe(it)} ${it.title}` : it.title;
  mi.metadata = new chrome.cast.media.GenericMediaMetadata();
  mi.metadata.title = title;
  if (it.thumb || it.poster) mi.metadata.images = [new chrome.cast.Image(`${o}/api/image/${p.version || it.id}/${it.poster ? 'poster' : 'thumb'}?t=${p.token}`)];
  mi.tracks = p.subtitles.map((s, i) => {
    const t = new chrome.cast.media.Track(i + 1, chrome.cast.media.TrackType.TEXT);
    t.trackContentId = o + s.url; t.trackContentType = 'text/vtt'; t.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
    t.name = s.label; t.language = s.lang || 'und'; return t;
  });
  const want = sub ?? p.defaultSub ?? '';
  const si = want ? p.subtitles.findIndex(s => s.id === want) : -1;
  const active = si >= 0 ? [si + 1] : [];
  mi.customData = { bx: 1, kind: 'video', id: it.id, version: it.version || null, title, sub: it.kind !== 'episode' && it.year ? String(it.year) : '',
    duration: p.duration || it.duration || 0, nextId: it.nextId || null, audio: p.audioSelected != null ? String(p.audioSelected) : String(audio || ''),
    audios: (p.audio || []).map(a => ({ i: a.index, l: [a.lang || 'Ljud', a.title, a.codec, a.channels ? a.channels + 'ch' : ''].filter(Boolean).join(' · ') })),
    subs: p.subtitles.map((s, i) => ({ t: i + 1, l: s.label })) };
  return { info: mi, active };
}
/** Casta en film eller ett avsnitt från position (s). opts.audio/opts.sub: spårval (annars webbspelarens). */
export async function castItem(it, position, opts = {}) {
  if (!castReady) return toast('Chromecast kräver Chrome och att servern nås via HTTPS');
  const sess = await session(); if (!sess) return;
  let m;
  try { m = await videoMedia(it, { audio: opts.audio ?? P?.audio ?? '', sub: opts.sub ?? P?.sub }); }
  catch (e) { return toastErr(e); }
  const req = new chrome.cast.media.LoadRequest(m.info);
  req.currentTime = position || 0; req.autoplay = true;
  if (m.active.length) req.activeTrackIds = m.active;
  C.queued.clear();
  try {
    await sess.loadMedia(req);
    if (!opts.quiet) toast('Spelas på ' + sess.getCastDevice().friendlyName);
    if (P) closePlayer(false, { cast: true });
  } catch (e) { toast('Kunde inte casta: ' + (e?.code || e)); return; }
  // Händelsen från mottagaren kan dröja – följ titeln direkt. En ny laddning ersätter mottagarens kö, så nästa avsnitt
  // köas igen även när det är samma titel (byte av ljudspår).
  const c = curOf(m.info);
  if (C.player) adopt(c, position || 0);
  if (c.nextId) queueNext(c.nextId);
}
/** Köa nästa avsnitt på mottagaren (med egen mediatoken), så att det startar av sig självt */
async function queueNext(nextId) {
  if (C.queued.has(nextId)) return;
  C.queued.add(nextId);
  try {
    const nx = await api('/items/' + nextId, { bg: true });
    const m = await videoMedia(nx, { queue: true });
    const media = C.ctx.getCurrentSession()?.getMediaSession(); if (!media) throw new Error('ingen mediesession');
    const qi = new chrome.cast.media.QueueItem(m.info);
    qi.autoplay = true; qi.preloadTime = 20;
    if (m.active.length) qi.activeTrackIds = m.active;
    await promise((ok, no) => media.queueInsertItems(new chrome.cast.media.QueueInsertItemsRequest([qi]), ok, no));
  } catch (e) { C.queued.delete(nextId); console.warn('[cast] kunde inte köa nästa avsnitt', e?.message || e); }
}

// ---------- ljud: musik, ljudböcker och poddar ----------
const headInfo = (url) => fetch(url, { method: 'HEAD' }).then(r => ({ type: r.headers.get('content-type') || 'audio/mpeg', transcoded: r.headers.get('x-transcoded') === '1' })).catch(() => ({ type: 'audio/mpeg', transcoded: false }));
function audioInfo(url, type, meta, data) {
  const mi = new chrome.cast.media.MediaInfo(origin() + url, type.split(';')[0]);
  mi.streamType = chrome.cast.media.StreamType.BUFFERED;
  const md = new chrome.cast.media.MusicTrackMediaMetadata();
  md.title = meta.title; md.artist = meta.artist || ''; if (meta.album) md.albumName = meta.album;
  if (meta.image) md.images = [new chrome.cast.Image(origin() + meta.image)];
  mi.metadata = md;
  mi.customData = { bx: 1, ...data };
  return mi;
}
/** Casta det som ljudspelaren spelar: musikspåret (och resten av kön), ljudbokens fil eller poddavsnittet från samma position */
export async function castAudio() {
  if (!castReady) return toast('Chromecast kräver Chrome och att servern nås via HTTPS');
  if (!M.cur && !M.spoken) return;
  const sess = await session(); if (!sess) return;
  const items = []; let start = 0;
  try {
    if (M.spoken) {
      const s = M.spoken, at = spokenPos();
      let files;
      if (s.kind === 'book') files = (await api(`/audiobooks/book/${s.id}/play?a=mp3,aac,flac`, { bg: true })).files;
      else files = [{ offset: 0, duration: s.duration, url: (await api(`/podcasts/episodes/${s.id}/play`, { bg: true })).url }];
      const i = Math.max(0, files.findLastIndex(f => f.offset <= at));
      for (const [k, f] of files.slice(i, i + 50).entries()) {
        const local = k === 0 ? Math.max(0, at - f.offset) : 0;
        const h = await headInfo(f.url);
        // Omkodade strömmar går inte att spola i – de startas på rätt ställe av servern (ss)
        const ss = h.transcoded && local > 1 ? Math.floor(local) : 0;
        const url = ss ? f.url + (f.url.includes('?') ? '&' : '?') + 'ss=' + ss : f.url;
        items.push(audioInfo(url, h.type, { title: s.title, artist: s.sub, image: s.cover }, { kind: s.kind, id: s.id, title: s.title, sub: s.sub || '', duration: s.duration || 0, offset: f.offset || 0, ss }));
        if (k === 0) start = ss ? 0 : local;
      }
    } else {
      const list = M.queue.slice(M.idx, M.idx + 20);
      start = (M.audio?.currentTime || 0) + (M.offset || 0);
      const urls = await Promise.all(list.map(t => api(`/music/tracks/${t.id}/play`, { bg: true }).then(r => r.url + '&a=mp3,aac,flac')));
      for (const [k, t] of list.entries()) {
        const h = await headInfo(urls[k]);
        let url = urls[k], ss = 0;
        if (k === 0 && h.transcoded && start > 1) { ss = Math.floor(start); url += '&ss=' + ss; }
        items.push(audioInfo(url, h.type, { title: t.title, artist: t.artist, album: t.album, image: t.cover ? `/api/music/cover/${t.albumId}` : '' },
          { kind: 'track', id: t.id, title: t.title, sub: t.artist || '', duration: t.duration || 0, ss }));
        if (k === 0 && ss) start = 0;
      }
      C.skipPlayed = list[0]?.id ?? null; // spåret räknades redan när det startade här
    }
  } catch (e) { return toastErr(e); }
  if (!items.length) return;
  const req = new chrome.cast.media.LoadRequest(items[0]);
  req.currentTime = start; req.autoplay = true;
  C.queued.clear();
  try { await sess.loadMedia(req); } catch (e) { return toast('Kunde inte casta: ' + (e?.code || e)); }
  stopAudio(); // sparar ljudbokens/poddens position och stänger ljudspelaren här
  toast('Spelas på ' + sess.getCastDevice().friendlyName);
  const c0 = curOf(items[0]);
  if (C.player) adopt(c0, (c0.offset || 0) + (c0.ss || 0) + start);
  if (items.length > 1) {
    const media = sess.getMediaSession();
    const qis = items.slice(1).map(mi => { const q = new chrome.cast.media.QueueItem(mi); q.autoplay = true; q.preloadTime = 10; return q; });
    if (media) promise((ok, no) => media.queueInsertItems(new chrome.cast.media.QueueInsertItemsRequest(qis), ok, no)).catch(e => console.warn('[cast] kön', e?.message || e));
  }
}

// ---------- styrning ----------
export const casting = () => !!(C.cur && C.player?.isConnected);
function seekTo(t) {
  if (!C.cur) return;
  const local = Math.max(0, t - (C.cur.offset || 0) - (C.cur.ss || 0));
  C.player.currentTime = Math.min(local, C.player.duration || local);
  C.ctrl.seek();
  C.lastPos = pos(); report(C.cur, C.lastPos);
}
function stopCast() {
  if (C.cur) report(C.cur, C.lastPos = pos(), true);
  try { C.ctrl.stop(); } catch {}
  try { C.ctx.endCurrentSession(true); } catch {}
  C.cur = null; C.queued.clear();
  paint();
}
async function setAudioTrack(index) {
  const cur = C.cur; if (!cur || cur.kind !== 'video') return;
  // Ljudspåret väljs av servern (omkodning/remux) – ladda om titeln på samma ställe med det nya spåret
  const media = C.ctx.getCurrentSession()?.getMediaSession();
  const subT = media?.activeTrackIds?.[0];
  try {
    const it = await api('/items/' + cur.id + (cur.version ? '?version=' + cur.version : ''), { bg: true });
    const subId = subT ? it.subtitles.filter(s => !s.bitmap)[subT - 1]?.id || '' : '';
    await castItem({ ...it, version: cur.version || it.version }, pos(), { audio: String(index), sub: subId, quiet: true });
  } catch (e) { toastErr(e); }
}
function setSubTrack(trackId) {
  const media = C.ctx.getCurrentSession()?.getMediaSession(); if (!media) return;
  const ids = trackId ? [+trackId] : [];
  promise((ok, no) => media.editTracksInfo(new chrome.cast.media.EditTracksInfoRequest(ids), ok, no)).catch(() => toast('Kunde inte byta undertext'));
}

// ---------- panelen ----------
function ensureBar() {
  let bar = $('#castbar');
  if (bar) return bar;
  bar = document.createElement('div'); bar.id = 'castbar'; bar.hidden = true;
  bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Chromecast');
  bar.innerHTML = `<div class="mleft"><div class="castico" aria-hidden="true">📺</div><div class="mtxt"><b id="cxtitle"></b><span id="cxdev" class="muted small"></span></div></div>
    <div class="mmid"><div class="row mctl"><button class="ghost small" id="cxback" title="10 sekunder bakåt" aria-label="10 sekunder bakåt">↺10</button>
      <button class="primary" id="cxplay" title="Pausa" aria-label="Pausa">⏸</button>
      <button class="ghost small" id="cxfwd" title="10 sekunder framåt" aria-label="10 sekunder framåt">10↻</button>
      <button class="ghost small" id="cxstop" title="Sluta casta" aria-label="Sluta casta">⏹</button></div>
      <div class="mseek"><span id="cxcur" class="small muted">0:00</span><div class="track" id="cxtrack" role="slider" tabindex="0" aria-label="Spola" aria-valuemin="0"><i id="cxfill"></i></div><span id="cxdur" class="small muted">0:00</span></div></div>
    <div class="mright"><select id="cxaudio" aria-label="Ljudspår" hidden></select><select id="cxsub" aria-label="Undertexter" hidden></select>
      <button class="ghost small" id="cxmute" title="Ljud av" aria-label="Ljud av">🔊</button><input type="range" id="cxvol" min="0" max="1" step="0.05" aria-label="Volym på Chromecast"></div>`;
  document.body.append(bar);
  $('#cxplay').onclick = () => C.ctrl?.playOrPause();
  $('#cxback').onclick = () => seekTo(pos() - 10);
  $('#cxfwd').onclick = () => seekTo(pos() + 10);
  $('#cxstop').onclick = stopCast;
  $('#cxmute').onclick = () => C.ctrl?.muteOrUnmute();
  $('#cxvol').oninput = (e) => { C.player.volumeLevel = +e.target.value; C.ctrl.setVolumeLevel(); };
  const total = () => C.cur?.duration || ((C.cur?.offset || 0) + (C.cur?.ss || 0) + (C.player?.duration || 0));
  $('#cxtrack').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(), d = total(); if (d) seekTo((e.clientX - r.left) / r.width * d); };
  $('#cxtrack').onkeydown = (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); seekTo(pos() + (e.key === 'ArrowLeft' ? -10 : 10)); } };
  $('#cxaudio').onchange = (e) => setAudioTrack(e.target.value);
  $('#cxsub').onchange = (e) => setSubTrack(e.target.value);
  return bar;
}
function paint() {
  const on = casting();
  const bar = on ? ensureBar() : $('#castbar');
  document.body.classList.toggle('hascast', on);
  if (!bar) return;
  bar.hidden = !on;
  if (!on) return;
  // Panelens höjd (meddelanden läggs ovanför den, style.css)
  if (bar.offsetHeight) document.body.style.setProperty('--casth', bar.offsetHeight + 'px');
  const cur = C.cur, p = C.player;
  const sess = C.ctx.getCurrentSession();
  $('#cxtitle').textContent = cur.title || '';
  $('#cxdev').textContent = [cur.sub, sess ? 'på ' + sess.getCastDevice().friendlyName : ''].filter(Boolean).join(' · ');
  const t = pos(), d = cur.duration || ((cur.offset || 0) + (cur.ss || 0) + (p.duration || 0));
  $('#cxcur').textContent = fmtTime(t); $('#cxdur').textContent = fmtTime(d);
  $('#cxfill').style.width = d ? Math.min(100, t / d * 100) + '%' : '0';
  const tr = $('#cxtrack'); tr.setAttribute('aria-valuemax', String(Math.round(d))); tr.setAttribute('aria-valuenow', String(Math.round(t))); tr.setAttribute('aria-valuetext', fmtTime(t));
  const pb = $('#cxplay'), paused = !!p.isPaused;
  pb.textContent = paused ? '▶' : '⏸'; pb.title = paused ? 'Spela' : 'Pausa'; pb.setAttribute('aria-label', pb.title);
  const mute = $('#cxmute'); mute.textContent = p.isMuted ? '🔇' : '🔊'; mute.title = p.isMuted ? 'Ljud på' : 'Ljud av'; mute.setAttribute('aria-label', mute.title);
  if (document.activeElement !== $('#cxvol')) $('#cxvol').value = String(p.volumeLevel ?? 1);
  // Spårväljare (bara filmer och avsnitt; byggs om när titeln byts)
  const a = $('#cxaudio'), s = $('#cxsub');
  if (a.dataset.key !== cur.key) {
    a.dataset.key = cur.key;
    const audios = cur.kind === 'video' ? cur.audios || [] : [], subs = cur.kind === 'video' ? cur.subs || [] : [];
    a.innerHTML = audios.map(x => `<option value="${+x.i}">${esc(x.l)}</option>`).join(''); a.hidden = audios.length < 2; a.value = cur.audio || '';
    s.innerHTML = `<option value="">Inga undertexter</option>` + subs.map(x => `<option value="${+x.t}">${esc(x.l)}</option>`).join(''); s.hidden = !subs.length;
  }
  const act = sess?.getMediaSession()?.activeTrackIds || [];
  if (document.activeElement !== s) s.value = String(act.find(id => (cur.subs || []).some(x => x.t === id)) || '');
}
