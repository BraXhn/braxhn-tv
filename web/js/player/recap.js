// "Det här har hänt": sammanfattningen av förra säsongen (eller de senaste avsnitten) inför en serie, ihopklippt av
// servern ur de egna filerna (server/recap.js, /api/items/:id/recap). openRecap() spelar den i en dialog – finns den
// inte än görs den först, med läget i en role=status – recapButton() lägger knappen på seriesidan och offerRecap()
// erbjuder den i spelaren när första avsnittet i en ny säsong startas efter ett uppehåll (servern avgör: offer), med
// Hoppa över. Laddas med need('player/recap.js') från views/item.js och player/video.js.
import { $, api, esc, store, sxe, t, tn } from '../core.js';
import { openDialog } from '../ui/dialog.js';
import { P, loadHls, startPlay } from './video.js';

/** "Säsong 1 · 3 avsnitt · cirka 1 min" */
export function summary(info) {
  const n = info.episodes?.length || 0;
  const eps = tn(n, 'ett avsnitt', '{n} avsnitt');
  const what = info.scope === 'season' ? t('Säsong {season} · {eps}', { season: info.season, eps }) : t('Säsong {season} · de senaste: {eps}', { season: info.season, eps });
  const secs = Math.round(info.duration || info.estimate || 0);
  return secs ? `${what} · ${secs < 90 ? t('cirka {n} s', { n: secs }) : t('cirka {n} min', { n: Math.round(secs / 60) })}` : what;
}
const POLL = 1500;

/**
 * Spelar sammanfattningen inför titeln id (serie eller avsnitt) i en dialog. next = avsnittet att spela efteråt
 * ({ id, season, episode, position }) – då finns knappen "▶ Spela SxxEyy". Ger dialogens värde när den stängts:
 * 'ended' (spelad till slut), 'play' (Spela), annars hoppad över.
 */
export async function openRecap(id, { next = null } = {}) {
  let hls = null, timer = null, gone = false;
  const v0 = next ? [{ label: t('▶ Spela {ep}', { ep: sxe(next) }), kind: 'primary', value: 'play' }] : [];
  const d = openDialog({
    title: t('Det här har hänt'), size: 'wide', className: 'recapdlg',
    body: `<p class="muted" id="rcsum"></p><video id="rcvid" controls playsinline hidden aria-label="${t('Sammanfattningen')}"></video>
      <div class="rcstate" id="rcstate" role="status" aria-live="polite" aria-busy="true">${t('Hämtar sammanfattningen…')}</div>`,
    actions: [{ label: t('Hoppa över'), kind: 'ghost', value: 'skip' }, ...v0],
    onClose: () => {
      gone = true; clearTimeout(timer);
      if (hls) { hls.destroy(); hls = null; }
      const v = d.$('#rcvid'); if (v) { v.onended = v.onerror = null; v.pause(); v.removeAttribute('src'); v.load(); }
    }
  });
  const v = d.$('#rcvid'), st = d.$('#rcstate');
  const say = (msg, busy = false) => { st.textContent = msg; st.hidden = !msg; st.setAttribute('aria-busy', busy ? 'true' : 'false'); };
  const cannot = () => { v.hidden = true; say(t('Sammanfattningen kan inte spelas i den här webbläsaren')); };
  async function play(info) {
    say('');
    v.hidden = false;
    v.onended = () => d.close('ended');
    if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = info.url; v.onerror = cannot; }
    else {
      const Hls = await loadHls().catch(() => null);
      if (gone) return;
      if (!Hls?.isSupported()) return cannot();
      hls = new Hls({ maxBufferLength: 30, enableWorker: false }); // CSP tillåter inga blob-workers
      hls.on(Hls.Events.ERROR, (_, e) => { if (e.fatal) { hls?.destroy(); hls = null; cannot(); } });
      hls.loadSource(info.url); hls.attachMedia(v);
    }
    v.play().catch(() => {});
    v.focus({ preventScroll: true });
  }
  function show(info) {
    if (gone) return;
    d.$('#rcsum').textContent = info.available ? `${info.title} · ${summary(info)}` : '';
    if (!info.available) return say(t(info.reason || 'Det finns ingen sammanfattning'));
    if (info.state === 'ready') return play(info);
    if (info.state === 'failed') return say(t(info.error || 'Sammanfattningen kunde inte göras'));
    say(t('Klipper ihop sammanfattningen ur avsnitten… (det kan ta en minut)'), true);
    timer = setTimeout(() => api(`/items/${id}/recap`, { bg: true }).then(show, fail), POLL);
  }
  const fail = (e) => { if (!gone) say(e?.message || t('Sammanfattningen kunde inte göras')); };
  api(`/items/${id}/recap`, { bg: true })
    .then(info => info.available && (info.state === 'none' || info.state === 'failed') ? api(`/items/${id}/recap`, { method: 'POST', bg: true }) : info)
    .then(show, fail);
  const r = await d.closed;
  if (r === 'play' && next) startPlay(null, next.id, next.position || 0);
  return r;
}

/** Knappen "Det här har hänt" på seriesidan (efter ▶-knappen), bara när det finns något att sammanfatta */
export async function recapButton(it) {
  const anchor = $('#playnext'); if (!anchor) return;
  const info = await api(`/items/${it.id}/recap`, { bg: true }).catch(() => null);
  if (!info?.available || !anchor.isConnected || $('#recap')) return;
  anchor.insertAdjacentHTML('afterend', `<button class="ghost" id="recap" aria-haspopup="dialog" title="${esc(summary(info))}">${t('⟲ Det här har hänt')}</button>`);
  $('#recap').onclick = () => openRecap(it.id, { next: info.target });
}

/**
 * Erbjudandet i spelaren (cur = spelarens läge, v = videon): rutan med "▶ Se sammanfattningen" och "Hoppa över".
 * Försvinner efter 45 s in i avsnittet. Hoppa över gäller avsnittet (sparas i webbläsaren). Sammanfattningen
 * görs redan när rutan visas, så att den oftast är klar när man trycker.
 */
export async function offerRecap(cur, v) {
  const id = cur.it.id;
  const info = await api(`/items/${id}/recap`, { bg: true }).catch(() => null);
  const key = 'recap.skip.' + id;
  if (!info?.offer || P !== cur || !cur.el.isConnected || store.get(key, '') || $('#precap', cur.el)) return;
  if (info.state === 'none' || info.state === 'failed') api(`/items/${id}/recap`, { method: 'POST', bg: true }).catch(() => {});
  cur.el.insertAdjacentHTML('beforeend', `<div class="recapoffer" id="precap" role="group" aria-labelledby="precapt">
    <div><b id="precapt">${t('Det här har hänt')}</b><span class="small">${esc(summary(info))}</span></div>
    <button class="primary small" id="precapgo">${t('▶ Se sammanfattningen')}</button><button class="ghost small" id="precapx">${t('Hoppa över')}</button></div>`);
  const box = $('#precap', cur.el);
  const hide = () => { box.remove(); v.removeEventListener('timeupdate', late); };
  const late = () => { if (v.currentTime > 45 || P !== cur) hide(); };
  v.addEventListener('timeupdate', late);
  $('#precapx', box).onclick = () => { store.set(key, '1'); hide(); };
  $('#precapgo', box).onclick = async () => {
    const was = !v.paused; v.pause(); hide();
    await openRecap(id);
    if (P === cur && v.isConnected && (was || v.currentTime < 1)) v.play().catch(() => {});
  };
}
