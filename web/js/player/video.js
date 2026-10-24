// Videospelaren: start, laddning (direkt/HLS), framsteg, nästa avsnitt och stängning
import { $, $$, api, esc, fmtTime, status, store, sxe, toast, toastErr } from '../core.js';
import { M, musicSession, videoSession } from '../audio.js';
import { canAirPlay, capsQuery, lastBandwidth, measureBandwidth, saveData } from './caps.js';
import { castItem, castReady } from './cast.js';
import { bindControls, keys } from './controls.js';
import { closeOverlays, overlayClose, overlayOpen, setMini, stopVideo } from './overlay.js';
import { joinParty } from './party.js';
import { pgsStop, restyleSubs, setSubs, subBurns, textStop } from './subs.js';
import { applyAudioFx, applySubStyle, audioFx, bindSubStyleFields, measureCtl, serverFxParams, setAudioFx, stopAudioFx, subStyleFields, thumbStyle, webAudioFx } from './comfort.js';
import { route } from '../router.js';
import { screenBadge, timeUp } from '../screentime.js';
import { ICON } from '../ui/icons.js';

// Som ovan, men avbryter även en uppspelning som håller på att starta
export function closeAllPlayers() { playSeq++; closeOverlays(); }

// ---------- spelare ----------
export let P = null;
let rate = 1; // uppspelningshastighet – följer med till nästa avsnitt under besöket
const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
let playSeq = 0; // ökas för varje play() och när alla spelare stängs – äldre anrop avbryter sig själva
export function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  const add = (src) => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = () => ok(window.Hls); s.onerror = no; document.head.append(s); });
  return add(new URL('../../vendor/hls.min.js', import.meta.url).href); // samma bygge som modulen (cachas för alltid)
}
// Startknapp: inaktiveras medan spelaren startar (dubbelklick ger inte två spelare)
export function startPlay(b, ...args) {
  if (b) { if (b.disabled) return; b.disabled = true; }
  return play(...args).catch(e => toastErr(e)).finally(() => { if (b) b.disabled = false; });
}

export async function play(id, start = 0, opts = {}) {
  const seq = ++playSeq;
  let it;
  try {
    // Flera versioner: hämta spårlistan (ljud/undertexter) för den version som faktiskt spelas
    const want = opts.version || store.get('version.' + id, '');
    it = await api('/items/' + id + (want ? '?version=' + encodeURIComponent(want) : ''), { bg: true });
    if (it.versions && !it.versions.some(v => String(v.id) === String(want))) {
      const q = store.get('quality', 'auto');
      const p = await api(`/items/${id}/playback?${capsQuery({ q: q === 'auto' ? '' : q })}&info=1`, { bg: true });
      if (p.version && p.version !== it.version) it = await api(`/items/${id}?version=${p.version}`, { bg: true });
    }
  }
  catch (e) { if (seq === playSeq) toastErr(e); return; }
  if (seq !== playSeq) return; // ett nyare play() eller en navigering har tagit över
  const partyId = opts.party || (P && P.party) || null;
  // Behåll anslutningen till rummet vid byte av avsnitt – tas över först nu när hämtningen lyckats
  const keepParty = P && P.party && P.party === partyId ? P.es : null;
  if (keepParty) P.es = null;
  if (M.audio && !M.audio.paused) M.audio.pause();
  closeOverlays();
  const el = $('#player');
  const q = (s) => $(s, el);
  const audios = it.audio, defAudio = audios.find(a => a.default) || audios[0];
  const subPref = store.get('sublang', '');
  const textSubs = it.subtitles.filter(s => !s.bitmap);
  const defSub = textSubs.find(s => s.forced) || (subPref && textSubs.find(s => s.lang === subPref));
  const sub2Pref = store.get('sub2lang', ''), defSub2 = sub2Pref && textSubs.find(s => s.lang === sub2Pref && s.id !== defSub?.id);
  const cur = P = { it, el, q: store.get('quality', 'auto'), audio: defAudio ? String(defAudio.index) : '', sub: defSub ? defSub.id : '', sub2: defSub2 ? defSub2.id : '', offset: 0, hls: null, lastSent: 0, nextTimer: null, pb: null,
    party: partyId, es: keepParty, applying: false, tok: null, lmd: null };
  const title = it.kind === 'episode' ? `${esc(it.showTitle)} · ${sxe(it)} · ${esc(it.title)}` : esc(it.title);
  const chaps = it.chapters || [];
  const line2 = it.kind === 'episode' ? `${sxe(it)} — ${esc(it.title)}` : (it.year || '');
  el.innerHTML = `<video id="vid" autoplay playsinline x-webkit-airplay="allow"></video>
    <div class="pbar"><button class="ghost small" id="pclose">← Tillbaka</button><span class="title">${title}</span><span class="muted small" id="pmode"></span>
      <button class="ghost small castbtn" id="pcast" ${castReady ? '' : 'hidden'} title="Casta till Chromecast">📺 Casta</button>
      ${canAirPlay() ? '<button class="ghost small" id="pair" title="AirPlay">AirPlay</button>' : ''}
      <button class="ghost small" id="pparty" title="Titta tillsammans med någon annanstans">👥 ${partyId ? 'Rummet' : 'Titta tillsammans'}</button></div>
    <div class="partybox" id="partybox" hidden><div class="row" style="justify-content:space-between"><b>Titta tillsammans</b><button class="ghost small" id="pbclose" aria-label="Stäng Titta tillsammans" title="Stäng">✕</button></div>
      <div class="muted small" id="pmembers"></div><div class="row" style="margin:6px 0"><input id="plink" readonly><button class="ghost small" id="pcopy">Kopiera</button></div>
      <div class="pchat" id="pchat"></div><input id="pmsg" placeholder="Skriv ett meddelande…" maxlength="300"></div>
    <button class="skip" id="pskip" hidden></button><div class="pgs" id="pgs"></div><div class="subtxt" id="subtxt" aria-live="off"></div><div class="sub2" id="sub2"></div><div class="chapters" id="chlist" hidden></div>
    <div class="setp" id="setp" hidden>
      <label>Kvalitet<select id="pq"><option value="auto">Auto</option><option value="orig">Original</option><option value="1080">1080p (8 Mbit/s)</option><option value="720">720p (4 Mbit/s)</option><option value="480">480p (1,5 Mbit/s)</option><option value="360">360p (0,8 Mbit/s)</option></select></label>
      ${audios.length > 1 ? `<label>Ljud<select id="pa">${audios.map(a => `<option value="${a.index}">${esc([a.lang || 'Ljud', a.title, a.codec, a.channels ? a.channels + 'ch' : ''].filter(Boolean).join(' · '))}</option>`).join('')}</select></label>` : ''}
      <label>Undertexter<select id="ps"><option value="">Inga undertexter</option>${it.subtitles.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}</select></label>
      ${textSubs.length > 1 ? `<label>Andra undertext<select id="ps2"><option value="">Ingen</option>${textSubs.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}</select></label>` : ''}
      <span id="poff" class="row" hidden>Undertextens tid <button class="ghost small" data-off="-0.5" title="Tidigare" aria-label="Undertexten tidigare">−</button><span class="small" id="poffv">0,0 s</span><button class="ghost small" data-off="0.5" title="Senare" aria-label="Undertexten senare">+</button></span>
      <label>Hastighet<select id="prate">${RATES.map(r => `<option value="${r}">${r === 1 ? 'Normal' : String(r).replace('.', ',') + '×'}</option>`).join('')}</select></label>
      <div class="setgrp"><b>Ljud</b>
        <label class="chk"><input type="checkbox" id="pnight"> Nattläge <span class="muted">jämnare ljud, svaga ljud lyfts</span></label>
        <label class="chk"><input type="checkbox" id="pdialog"> Tydligare dialog <span class="muted">rösterna förstärks</span></label></div>
      <details class="setgrp"><summary>Undertextens utseende</summary>${subStyleFields('pst')}</details></div>
    <div class="ctl" id="ctl">
      <div class="scrub" id="scrub"><div class="preview" id="prev" hidden><div class="pimg" id="pimg"></div><span id="ptime"></span></div>
        <div class="track" id="track"><b id="tbuf"></b><i id="tfill"></i>${chaps.slice(1).map(c => it.duration ? `<span class="chap" style="left:${c.start / it.duration * 100}%"></span>` : '').join('')}</div></div>
      <div class="crow">
        <div class="cinfo"><b>${esc(it.kind === 'episode' ? it.showTitle || it.title : it.title)}</b><span>${line2}</span><span id="ctime">0:00</span></div>
        <div class="cmid">
          <button id="cprev" title="${chaps.length ? 'Föregående kapitel' : 'Till början'}" aria-label="${chaps.length ? 'Föregående kapitel' : 'Till början'}">${ICON.prev}</button>
          <button id="cback" title="10 s bakåt (←)" aria-label="10 s bakåt (←)">${ICON.back10}</button>
          <button id="cplay" class="big" title="Spela/pausa (mellanslag)" aria-label="Spela/pausa (mellanslag)">${ICON.play}</button>
          <button id="cfwd" title="30 s framåt (→)" aria-label="30 s framåt (→)">${ICON.fwd30}</button>
          <button id="${it.nextId ? 'pnext' : 'cnextch'}" title="${it.nextId ? 'Nästa avsnitt' : 'Nästa kapitel'}" ${it.nextId || chaps.length > 1 ? '' : 'disabled'}>${ICON.next}</button>
          <button id="cstop" title="Stoppa" aria-label="Stoppa">${ICON.stop}</button>
        </div>
        <div class="cright">
          ${chaps.length ? `<button id="pchap" title="Kapitel" aria-label="Kapitel">${ICON.list}</button>` : ''}
          <button id="cset" title="Kvalitet, ljud och undertexter" aria-label="Kvalitet, ljud och undertexter">${ICON.gear}</button>
          <span class="vol"><button id="cmute" title="Ljud av/på (m)" aria-label="Ljud av/på (m)">${ICON.vol}</button><input type="range" id="cvol" min="0" max="1" step="0.05" aria-label="Volym"></span>
          <button id="cmini" title="Litet fönster (fortsätt bläddra)" aria-label="Litet fönster (fortsätt bläddra)">${ICON.mini}</button>
          <button id="cfull" title="Helskärm (f)" aria-label="Helskärm (f)">${ICON.full}</button>
        </div>
      </div>
    </div>`;
  overlayOpen(el);
  const v = q('#vid');
  applySubStyle(el);
  bindControls(cur, v);
  q('#pq').value = cur.q; if (q('#pa')) q('#pa').value = cur.audio; q('#ps').value = cur.sub; if (q('#ps2')) q('#ps2').value = cur.sub2;
  q('#prate').value = String(rate);
  q('#prate').onchange = (e) => { rate = +e.target.value; v.defaultPlaybackRate = v.playbackRate = rate; };
  v.addEventListener('loadedmetadata', () => { v.defaultPlaybackRate = v.playbackRate = rate; });
  // Nattläge/tydligare dialog: i webbläsaren med WebAudio, annars (Safari) av servern – då startas strömmen om
  const fx = audioFx();
  q('#pnight').checked = fx.night; q('#pdialog').checked = fx.dialog;
  const fxChange = () => {
    setAudioFx({ night: q('#pnight').checked, dialog: q('#pdialog').checked });
    if (webAudioFx) applyAudioFx(v); else reload();
  };
  q('#pnight').onchange = fxChange; q('#pdialog').onchange = fxChange;
  bindSubStyleFields(q('#setp'), () => { applySubStyle(el); restyleSubs(); });
  const onResize = () => { if (P === cur) measureCtl(el); else window.removeEventListener('resize', onResize); };
  window.addEventListener('resize', onResize);
  q('#pclose').onclick = () => setMini(true); // fortsätt spela i litet fönster; ⏹ stoppar
  q('#pq').onchange = (e) => { cur.q = e.target.value; store.set('quality', cur.q); reload(); };
  if (q('#pa')) q('#pa').onchange = (e) => { cur.audio = e.target.value; reload(); };
  q('#ps').onchange = (e) => {
    const prev = it.subtitles.find(x => x.id === cur.sub), s = it.subtitles.find(x => x.id === e.target.value);
    cur.sub = e.target.value; store.set('sublang', s?.lang || ''); cur.offset = 0;
    // Bildundertexter som inte är PGS bränns in av servern => ny ström. Text och PGS byts direkt.
    if (subBurns(s) || subBurns(prev)) reload(); else setSubs();
  };
  if (q('#ps2')) q('#ps2').onchange = (e) => { cur.sub2 = e.target.value; store.set('sub2lang', it.subtitles.find(x => x.id === cur.sub2)?.lang || ''); setSubs(); };
  if (q('#pchap')) q('#pchap').onclick = (e) => {
    e.stopPropagation();
    const l = q('#chlist');
    q('#setp').hidden = true;
    if (!l.hidden) { l.hidden = true; return; }
    const c0 = it.chapters.filter(c => c.start <= v.currentTime).pop();
    // Förhandsbild per kapitel ur spolningsbilderna (närmast kapitlets start); utan dem bara text
    const tw = innerWidth < 500 ? 96 : 128;
    l.classList.toggle('thumbs', !!cur.tp);
    l.innerHTML = it.chapters.map((c, i) => `<button data-ch="${i}" class="${c === c0 ? 'on' : ''}">${cur.tp ? `<span class="chimg" style="${thumbStyle(cur.tp, it.id, c.start, tw)}"></span>` : ''}<span class="chtitle">${esc(c.title)}</span><span class="muted">${fmtTime(c.start)}</span></button>`).join('');
    l.hidden = false;
    $('button.on', l)?.scrollIntoView({ block: 'nearest' });
    ($('button.on', l) || $('button', l))?.focus({ preventScroll: true });
    $$('[data-ch]', l).forEach(b => b.onclick = () => { v.currentTime = it.chapters[+b.dataset.ch].start + 0.05; l.hidden = true; });
  };
  $$('[data-off]', el).forEach(b => b.onclick = () => { cur.offset = Math.round((cur.offset + +b.dataset.off) * 10) / 10; setSubs(); });
  if (q('#pcast')) q('#pcast').onclick = () => castItem(it, v.currentTime);
  if (q('#pair')) q('#pair').onclick = () => v.webkitShowPlaybackTargetPicker();
  if (q('#pnext')) q('#pnext').onclick = () => { sendProgress(true); goNext(it.nextId); };
  q('#pparty').onclick = async () => {
    if (!cur.party) {
      try { const r = await api('/party', { method: 'POST', body: { itemId: it.id }, bg: true }); if (P !== cur) return; cur.party = r.id; pushState(); joinParty(); toast('Rum skapat – dela länken'); }
      catch (e) { return toastErr(e); }
    }
    q('#partybox').hidden = !q('#partybox').hidden;
  };
  q('#pbclose').onclick = () => { q('#partybox').hidden = true; };
  if (opts.startParty && !cur.party) q('#pparty').click(); // "Titta tillsammans…" från kortets meny
  q('#pcopy').onclick = () => { navigator.clipboard?.writeText(q('#plink').value).then(() => toast('Länken kopierad')); };
  q('#pmsg').onkeydown = (e) => { if (e.key === 'Enter' && e.target.value.trim() && cur.party) { api(`/party/${cur.party}/chat`, { method: 'POST', body: { text: e.target.value }, bg: true }).catch(() => {}); e.target.value = ''; } };
  // Lokala händelser skickas till rummet (men inte de som kommer från rummet självt)
  const pushState = () => { if (P === cur && cur.party && !cur.applying) api(`/party/${cur.party}/state`, { method: 'POST', body: { playing: !v.paused, position: v.currentTime }, bg: true }).catch(() => {}); };
  ['play', 'pause', 'seeked'].forEach(ev => v.addEventListener(ev, pushState));
  if (cur.party) joinParty();
  v.addEventListener('timeupdate', () => {
    if (P !== cur) return; if (Date.now() - cur.lastSent > 10000) sendProgress(); markers();
    const d = cur.it.duration || v.duration; if (d) q('#tfill').style.width = Math.min(100, v.currentTime / d * 100) + '%';
  });
  // Spolningslist med förhandsbilder (bredd cachas, ritas högst en gång per bildruta)
  api(`/items/${it.id}/trickplay`, { bg: true }).then(tp => { if (P === cur) cur.tp = tp; }).catch(() => {});
  const track = q('#track'), prev = q('#prev'), ptime = q('#ptime'), img = q('#pimg');
  let rect = null, raf = 0, mx = 0;
  const tAt = (x, r) => Math.max(0, Math.min(1, (x - r.left) / r.width)) * (cur.it.duration || v.duration || 0);
  const drawPrev = () => {
    raf = 0;
    if (P !== cur || !rect) return;
    const t = tAt(mx, rect);
    const ch = (cur.it.chapters || []).filter(c => c.start <= t).pop();
    ptime.textContent = fmtTime(t) + (ch ? ' · ' + ch.title : '');
    const tp = cur.tp;
    if (tp) {
      const i = Math.min(tp.count - 1, Math.floor(t / tp.interval)), per = tp.cols * tp.rows, sheet = Math.floor(i / per) + tp.first, k = i % per;
      Object.assign(img.style, { width: tp.w + 'px', height: tp.h + 'px', backgroundImage: `url(/api/items/${cur.it.id}/trickplay/${sheet})`,
        backgroundPosition: `-${(k % tp.cols) * tp.w}px -${Math.floor(k / tp.cols) * tp.h}px`, display: 'block' });
    } else img.style.display = 'none';
    prev.hidden = false;
    const pw = prev.offsetWidth;
    prev.style.left = Math.max(0, Math.min(rect.width - pw, mx - rect.left - pw / 2)) + 'px';
  };
  track.onmouseenter = () => { rect = track.getBoundingClientRect(); };
  track.onmousemove = (e) => {
    if (P !== cur) return;
    if (!rect) rect = track.getBoundingClientRect();
    mx = e.clientX;
    if (!raf) raf = requestAnimationFrame(drawPrev);
  };
  track.onmouseleave = () => { prev.hidden = true; rect = null; if (raf) { cancelAnimationFrame(raf); raf = 0; } };
  track.onclick = (e) => { v.currentTime = tAt(e.clientX, track.getBoundingClientRect()); };
  v.addEventListener('pause', () => P === cur && sendProgress());
  v.addEventListener('ended', () => P === cur && onEnded());
  v.addEventListener('error', () => {
    if (P === cur && cur.pb?.mode === 'direct' && !cur.forceHls) { toast('Webbläsaren kunde inte spela filen direkt – byter läge'); cur.forceHls = true; reload(); }
    else if (P === cur && v.error) toast(`Kunde inte spela upp (${['', 'avbrutet', 'nätverksfel', 'avkodningsfel', 'formatet stöds inte'][v.error.code] || 'fel'}) – prova en lägre kvalitet under ⚙`);
  });
  // Kontrollerna syns när filmen är pausad eller musen rör sig, och döljs (med muspekaren) efter 3 s
  let idle; const wake = () => {
    el.classList.remove('idle'); clearTimeout(idle);
    idle = setTimeout(() => P === cur && !cur.mini && !v.paused && q('#setp').hidden && q('#chlist').hidden && !el.matches(':has(.ctl:hover)') && el.classList.add('idle'), 3000);
  };
  el.onmousemove = wake; el.ontouchstart = wake; el.onkeydown = wake; wake();
  v.addEventListener('pause', wake); v.addEventListener('play', wake);
  videoSession(v);
  document.addEventListener('keydown', keys);
  await load(start);
}

function markers() {
  if (!P) return;
  const v = $('#vid', P.el), b = $('#pskip', P.el), pb = P.pb; if (!v || !b || !pb) return;
  const t = v.currentTime;
  if (pb.recap && t >= pb.recap.start && t < pb.recap.end - 1) {
    if (b.dataset.k !== 'recap') { b.dataset.k = 'recap'; b.textContent = 'Hoppa över sammanfattning ⏭'; b.onclick = () => { v.currentTime = pb.recap.end; b.hidden = true; }; }
    b.hidden = false;
  } else if (pb.intro && t >= pb.intro.start && t < pb.intro.end - 1) {
    if (b.dataset.k !== 'intro') { b.dataset.k = 'intro'; b.textContent = 'Hoppa över intro ⏭'; b.onclick = () => { v.currentTime = pb.intro.end; b.hidden = true; }; }
    b.hidden = false;
  } else if (pb.credits && P.it.nextId && t >= pb.credits && t < pb.credits + 60) {
    if (b.dataset.k !== 'credits') { b.dataset.k = 'credits'; b.textContent = 'Nästa avsnitt ⏭'; b.onclick = () => { if (!P) return; sendProgress(true); goNext(P.it.nextId); }; }
    b.hidden = false;
  } else { b.hidden = true; b.dataset.k = ''; }
}

async function load(start) {
  const cur = P; if (!cur) return;
  const { it, el } = cur, v = $('#vid', el);
  if (!v || !v.isConnected) return;
  // Varje anrop får en egen token – ett senare load() (kvalitets-/ljudbyte) eller stängning gör detta inaktuellt
  const tok = cur.tok = Symbol();
  const live = () => P === cur && cur.tok === tok && v.isConnected;
  if (cur.hls) { cur.hls.destroy(); cur.hls = null; }
  if (cur.lmd) { v.removeEventListener('loadedmetadata', cur.lmd); cur.lmd = null; }
  const sub = it.subtitles.find(s => s.id === cur.sub);
  const extra = { q: cur.q === 'auto' ? '' : cur.q, audio: cur.audio, sub: subBurns(sub) ? sub.id : '' };
  if (it.version) extra.version = it.version; // spårlistan hör till just den versionen
  if (cur.forceHls) extra.force = 'hls';
  Object.assign(extra, serverFxParams()); // Safari: servern filtrerar ljudet (nattläge/tydligare dialog)
  if (canAirPlay()) extra.cast = '1'; // AirPlay-mottagaren hämtar strömmen själv och behöver token i URL:en
  if (v.canPlayType('application/vnd.apple.mpegurl')) extra.nhls = '1'; // Safaris egen HLS-spelare (iPhone) – se servern
  // Servern förbereder rätt segment direkt. Inte för Safaris egen HLS: den hämtar alltid segment 0 först och spolar
  // sedan, så en förstart mitt i filmen skulle bara stoppas och startas om
  if (start > 0 && !extra.nhls) extra.start = String(Math.floor(start));
  // Utanför hemmet: uppmätt uppkoppling (väntar högst 1,5 s på en ny mätning) och "Spara data" i telefonen
  if (status.remote) {
    const bw = lastBandwidth() || await Promise.race([measureBandwidth(), new Promise(r => setTimeout(() => r(0), 1500))]);
    if (!live()) return;
    if (bw) extra.bw = String(bw);
    if (saveData()) extra.save = '1';
  }
  let pb;
  // Servern kan behöva en stund för en film som inte analyserats än (nyckelbilder, så att den slipper omkodas)
  const ctEl = $('#ctime', el); if (ctEl) ctEl.textContent = 'Förbereder…';
  try { pb = await api(`/items/${it.id}/playback?${capsQuery(extra)}`, { bg: true }); }
  catch (e) { if (live()) { if (e.code === 'screen_time') { closePlayer(false); timeUp(); } else toastErr(e); } return; }
  if (!live()) return;
  cur.pb = pb;
  const label = { direct: 'Direkt', remux: 'Remux', transcode: 'Omkodning' }[pb.mode];
  const pm = $('#pmode', el);
  pm.textContent = `${label}${pb.quality && pb.quality !== 'orig' ? ' · ' + pb.quality + 'p' : ''}${pb.tonemap ? ' · HDR→SDR' : ''}${pb.remote ? ' · utanför hemmet' : ''}`;
  pm.title = pb.reasons.join(', ');
  if (pb.mode === 'direct' || v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = pb.url;
  } else {
    let Hls;
    try { Hls = await loadHls(); if (!Hls.isSupported()) throw new Error(); }
    catch { if (live()) toast('Kunde inte ladda HLS-spelaren'); return; }
    if (!live()) return;
    if (cur.hls) { cur.hls.destroy(); cur.hls = null; }
    // abrEwmaDefaultEstimate: startgissning för bandbredden när mastern har flera kvalitetssteg (annars börjar
    // hls.js på lägsta steget); spelaren mäter sedan själv och växlar upp eller ner
    // Omkodning av HEVC/4K kan ta mer än hls.js standard (10 s) innan första byten kommer. Ge upp för tidigt så
    // försöker spelaren igen eller byter kvalitetssteg – då startar servern om omkodningen och filmen kommer aldrig
    // igång. Servern väntar själv upp till 90 s på ett segment.
    const slow = { maxTimeToFirstByteMs: 60000, maxLoadTimeMs: 180000, timeoutRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 4000 },
      errorRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 8000 } };
    // capLevelToPlayerSize: hämta inte 1080p till en telefonskärm; startgissningen från mätningen ovan
    const est = lastBandwidth() ? lastBandwidth() * 1000 * 0.8 : 6e6;
    const hls = cur.hls = new Hls({ startPosition: start, maxBufferLength: 40, abrEwmaDefaultEstimate: est, capLevelToPlayerSize: true,
      fragLoadPolicy: { default: slow }, xhrSetup: (x) => { x.withCredentials = true; } });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_, d) => {
      const l = hls.levels?.[d.level];
      if (hls.levels?.length > 1 && l?.height && cur.hls === hls && live()) pm.textContent = `${label} · ${l.height}p (anpassas)${pb.remote ? ' · utanför hemmet' : ''}`;
    });
    // Fatala fel: försök igen några gånger, men inte i all oändlighet (utgången inloggning, borttagen fil …)
    let netTries = 0, mediaTries = 0;
    hls.on(Hls.Events.FRAG_LOADED, () => { netTries = 0; });
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal || cur.hls !== hls || !live()) return;
      const code = d.response?.code;
      if (code === 401 || code === 403) { toast(code === 401 ? 'Inloggningen har gått ut – logga in igen' : 'Uppspelningen nekades'); return closePlayer(false); }
      if (d.type === 'networkError' && ++netTries <= 3) return void setTimeout(() => cur.hls === hls && hls.startLoad(), 1000 * netTries);
      if (d.type === 'mediaError' && ++mediaTries <= 2) return hls.recoverMediaError();
      toast(d.type === 'networkError' ? 'Ingen kontakt med servern – uppspelningen stoppades' : 'Uppspelningsfel: ' + d.details);
    });
    hls.loadSource(pb.url); hls.attachMedia(v);
  }
  const lmd = cur.lmd = () => {
    if (cur.lmd === lmd) cur.lmd = null;
    if (!live()) return;
    if (start > 0 && Math.abs(v.currentTime - start) > 2) v.currentTime = start;
    setSubs();
  };
  v.addEventListener('loadedmetadata', lmd, { once: true });
  v.play().catch(() => {});
  applyAudioFx(v);
}
function reload() { if (!P) return; const v = $('#vid', P.el); if (v) load(v.currentTime || 0); }

function sendProgress(final = false) {
  if (!P) return;
  const cur = P, v = $('#vid', cur.el); if (!v || !v.duration || v.currentTime < 1) return;
  cur.lastSent = Date.now();
  const body = JSON.stringify({ position: v.currentTime, duration: cur.it.duration || v.duration });
  if (final && navigator.sendBeacon) navigator.sendBeacon(`/api/items/${cur.it.id}/progress`, new Blob([body], { type: 'application/json' }));
  else fetch(`/api/items/${cur.it.id}/progress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    .then(r => r.json()).then(d => {
      if (d.screenTime) screenBadge(d.screenTime);
      if (d.stop && P === cur) { if (d.screenTime && !d.screenTime.allowed) { closePlayer(false); timeUp(); } else { toast('Uppspelningen stoppades av administratören'); closePlayer(); } }
    }).catch(() => {});
}

function onEnded() {
  sendProgress(true);
  const cur = P, { it } = cur;
  if (!it.nextId) return closePlayer();
  const box = document.createElement('div'); box.className = 'next';
  let n = 8;
  box.innerHTML = `<b>Nästa avsnitt om <span class="cd">${n}</span> s</b><div class="row"><button class="primary small" data-go>Spela nu</button><button class="ghost small" data-stay>Avbryt</button></div>`;
  cur.el.append(box);
  clearInterval(cur.nextTimer);
  const t = cur.nextTimer = setInterval(() => {
    if (P !== cur) return clearInterval(t);
    n--; $('.cd', box).textContent = n;
    if (n <= 0) { clearInterval(t); goNext(it.nextId); }
  }, 1000);
  $('[data-go]', box).onclick = () => { clearInterval(t); goNext(it.nextId); };
  $('[data-stay]', box).onclick = () => { clearInterval(t); box.remove(); };
}

async function goNext(nextId) {
  const party = P?.party;
  await play(nextId, 0);
  // I ett rum byter alla till nästa avsnitt
  if (party) api(`/party/${party}/state`, { method: 'POST', body: { itemId: nextId, playing: true, position: 0 }, bg: true }).catch(() => {});
}

/** cast: uppspelningen fortsätter på Chromecast – stoppa bara webbspelarens egen session (pid) */
export function closePlayer(refresh = true, { cast = false } = {}) {
  if (!P) return;
  if (P.es) { P.es.close(); P.es = null; }
  sendProgress(true);
  clearInterval(P.nextTimer);
  if (P.hls) { P.hls.destroy(); P.hls = null; }
  const el = P.el, v = $('#vid', el), id = P.it.id;
  // pid i strömlänken = just den här uppspelningen; servern stoppar då inte andra enheters sessioner
  let pid = ''; try { pid = new URL(P.pb?.url || '', location.origin).searchParams.get('pid') || ''; } catch {}
  if (v && P.lmd) v.removeEventListener('loadedmetadata', P.lmd);
  pgsStop(P); textStop(P); stopAudioFx(v);
  P.tok = null; P.lmd = null;
  P = null;
  stopVideo(v);
  if (pid || !cast) fetch(`/api/stream/${id}/stop${pid ? '?pid=' + encodeURIComponent(pid) : ''}`, { method: 'POST' }).catch(() => {});
  document.removeEventListener('keydown', keys);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  document.body.classList.remove('hasmini'); el.classList.remove('mini');
  overlayClose(el);
  musicSession();
  if (refresh) route();
}
window.addEventListener('pagehide', () => sendProgress(true));
