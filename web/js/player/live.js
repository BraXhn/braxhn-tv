// Spelare för live-TV och inspelningar
import { $, act, api, esc, fmtTime, hhmm, me, store, toast } from '../core.js';
import { M, musicSession, videoSession } from '../audio.js';
import { overlayClose, overlayOpen, stopVideo } from './overlay.js';
import { closeAllPlayers, loadHls } from './video.js';
import { screenPing, screenSt, timeUp } from '../screentime.js';
import { provide } from '../lazy.js';
import * as self from './live.js';
provide('live', self); // fasaderna i lazy.js når modulen härifrån

export let LP = null, RP = null; // live-spelare, inspelningsspelare
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.fullscreenElement || document.querySelector('dialog[open]')) return;
  if (RP) closeRec(); else if (LP) closeLive();
});

export async function playLive(ch) {
  closeAllPlayers();
  if (M.audio && !M.audio.paused) M.audio.pause();
  const el = $('#player');
  el.innerHTML = `<video id="lvid" controls autoplay playsinline></video>
    <div class="pbar"><button class="ghost small" id="lclose">← Tillbaka</button><span class="title">${esc(ch.number ? ch.number + ' · ' : '')}${esc(ch.name)}</span>
      <span class="muted small" id="lnow">${ch.now ? esc(ch.now.title) + ' · ' + hhmm(ch.now.start) + '–' + hhmm(ch.now.stop) : ''}</span>
      <span class="muted small" id="lstat">Startar kanalen…</span>
      <button class="ghost small" id="lback" title="Spola tillbaka 30 sekunder" hidden>⏪ 30 s</button><button class="ghost small" id="lfwd" title="Spola fram 30 sekunder" hidden>30 s ⏩</button>
      <button class="small liveind" id="llive" hidden>● Live</button>
      ${ch.now ? `<button class="ghost small" id="lrec">⏺ Spela in</button>` : ''}</div>`;
  overlayOpen(el);
  const v = $('#lvid', el), stat = $('#lstat', el);
  // Lokal referens: om spelaren stängs (eller en annan öppnas) under start avbryter vi utan att röra borttagna element
  const lp = LP = { ch, hls: null, el, v };
  const cur = () => LP === lp;
  const setStat = (t) => { if (cur()) stat.textContent = t; };
  videoSession(v);
  $('#lclose', el).onclick = () => closeLive(lp);
  const rb = $('#lrec', el);
  if (rb) rb.onclick = act(async () => { await api('/dvr/program', { method: 'POST', body: { programId: ch.now.id }, bg: true }); toast('Spelar in ' + ch.now.title); rb.disabled = true; });
  try {
    const r = await api(`/live/${ch.id}/play`, { method: 'POST', bg: true });
    if (!cur()) return;
    if (v.canPlayType('application/vnd.apple.mpegurl') && !window.MediaSource) { v.src = r.url; }
    else {
      const Hls = await loadHls();
      if (!cur()) return;
      // Timeshift: servern sparar upp till några timmar bakåt. Spelaren hoppar inte själv tillbaka till live
      // (liveMaxLatencyDurationCount är oändlig som standard) och håller bara en kort buffert bakåt i minnet.
      const hls = lp.hls = new Hls({ liveSyncDurationCount: 3, backBufferLength: 90, xhrSetup: (x) => { x.withCredentials = true; } });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal || !cur() || lp.hls !== hls) return;
        if (d.response?.code === 403) { hls.destroy(); lp.hls = null; if (screenSt?.limited) { closeLive(lp); timeUp(); } else setStat('Uppspelningen nekades'); }
        else if (d.response?.code === 409 || d.response?.code === 502) { setStat(d.response.code === 409 ? 'Alla tuners används' : 'Kanalen kunde inte startas'); hls.destroy(); lp.hls = null; }
        else if (d.type === 'networkError') setTimeout(() => { if (cur() && lp.hls === hls) hls.startLoad(); }, 1500);
        else if (d.type === 'mediaError') hls.recoverMediaError();
      });
      hls.loadSource(r.url); hls.attachMedia(v);
    }
    v.addEventListener('playing', () => { setStat(''); liveControls(lp); }, { once: true });
    v.play().catch(() => {});
  } catch (e) { setStat(e.message); }
}
// Timeshift i livespelaren: spola i det sparade fönstret och "Live" som hoppar till direktsändningen när man ligger efter
function liveControls(lp) {
  const { v, el } = lp, btn = $('#llive', el), back = $('#lback', el), fwd = $('#lfwd', el);
  if (!btn || LP !== lp) return;
  const range = () => { const s = v.seekable; return s.length ? { start: s.start(0), end: s.end(s.length - 1) } : null; };
  // Direktsändningens punkt: hls.js räknar fram den, Safari ger slutet av det spolbara fönstret
  const edge = () => { const h = lp.hls?.liveSyncPosition; if (h != null && isFinite(h)) return h; const r = range(); return r ? r.end : null; };
  const seekTo = (t) => { const r = range(), e = edge(); if (!r || e == null) return; v.currentTime = Math.max(r.start + 0.5, Math.min(e, t)); };
  btn.onclick = () => { const e = edge(); if (e != null) v.currentTime = e; v.play().catch(() => {}); };
  back.onclick = () => seekTo(v.currentTime - 30);
  fwd.onclick = () => seekTo(v.currentTime + 30);
  const update = () => {
    if (LP !== lp) return clearInterval(lp.tick);
    const r = range(), e = edge();
    const canSeek = !!r && r.end - r.start > 20;
    back.hidden = fwd.hidden = !canSeek; btn.hidden = !r;
    const behind = e == null ? 0 : e - v.currentTime;
    const atLive = behind < 10 && !v.paused;
    btn.classList.toggle('on', atLive);
    btn.textContent = atLive ? '● Live' : `Gå till live (−${fmtTime(Math.max(0, behind))})`;
    fwd.disabled = behind < 10;
  };
  lp.tick = setInterval(update, 1000);
  update();
}
export function closeLive(lp = LP) {
  if (!lp || LP !== lp) return;
  LP = null;
  clearInterval(lp.tick);
  if (lp.hls) { lp.hls.destroy(); lp.hls = null; }
  stopVideo(lp.v);
  overlayClose(lp.el);
  musicSession();
}
export async function playRec(r, cs = {}) {
  const u = await api(`/dvr/recordings/${r.id}/play`, { method: 'POST' }); // avbryts om man hunnit lämna sidan
  closeAllPlayers();
  if (M.audio && !M.audio.paused) M.audio.pause();
  const el = $('#player');
  const ads = Array.isArray(r.commercials) ? r.commercials : [];
  el.innerHTML = `<video id="rvid" controls autoplay playsinline src="${esc(u.url)}"></video><div class="pbar"><button class="ghost small" id="rclose">← Tillbaka</button><span class="title">${esc(r.title)}${r.subtitle ? ' – ' + esc(r.subtitle) : ''}</span>
    ${ads.length ? `<label class="small"><input type="checkbox" id="rauto"> Hoppa över reklam automatiskt</label>` : ''}</div>
    <button class="skip" id="rskip" hidden>Hoppa över reklam ⏭</button>`;
  overlayOpen(el);
  const rp = RP = { el, v: $('#rvid', el) };
  videoSession(rp.v);
  screenPing(rp.v, 'r:' + r.id, () => RP === rp, () => closeRec(rp));
  $('#rclose', el).onclick = () => closeRec(rp);
  if (ads.length) recCommercials(rp, ads, cs.autoSkip);
}
// Reklamavbrott i inspelningar: knappen visas inne i ett avbrott, eller hoppas över automatiskt (val per användare i webbläsaren)
function recCommercials(rp, ads, autoDefault) {
  const { v, el } = rp, b = $('#rskip', el), auto = $('#rauto', el);
  const key = 'comskipAuto.' + (me?.id ?? '');
  auto.checked = !!store.get(key, !!autoDefault);
  auto.onchange = () => store.set(key, auto.checked);
  const skipped = new Set(); // ett avbrott hoppas bara över automatiskt en gång (spolar man tillbaka in i det får man titta)
  v.addEventListener('timeupdate', () => {
    if (RP !== rp) return;
    const t = v.currentTime, i = ads.findIndex(a => t >= a.start && t < a.end - 1);
    if (i < 0) { b.hidden = true; return; }
    if (auto.checked && !skipped.has(i)) { skipped.add(i); v.currentTime = ads[i].end; toast('Reklam överhoppad'); b.hidden = true; return; }
    b.hidden = false;
    b.onclick = () => { v.currentTime = ads[i].end; b.hidden = true; };
  });
}
export function closeRec(rp = RP) {
  if (!rp || RP !== rp) return;
  RP = null;
  stopVideo(rp.v);
  overlayClose(rp.el);
  musicSession();
}
