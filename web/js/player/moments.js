// Spelaren: spara ett ögonblick (klipp) att dela med hushållet. Dialogen föreslår de senaste 30 sekunderna; start och
// slut kan sättas till där filmen är, titeln krävs, och valfritt bränns den valda textundertexten in och en liten
// vattenstämpel med titeln läggs på. Servern gör klippet i bakgrunden (server/moments.js) – det dyker upp i #/moments.
// Laddas med need('player/moments.js') från video.js när knappen ✂ Ögonblick används.
import { api, esc, fmtTime, toast, t } from '../core.js';
import { openDialog } from '../ui/dialog.js';

/** "1:23", "1:02:03", "83.5" eller "1:23,5" → sekunder (NaN om det inte går) */
export function parseClock(s) {
  const x = String(s ?? '').trim().replace(',', '.');
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(x)) return NaN;
  return x.split(':').reduce((a, v) => a * 60 + parseFloat(v), 0);
}
const clock = (s) => { const r = Math.round(s * 10) / 10; return fmtTime(Math.floor(r)) + (r % 1 ? ',' + Math.round((r % 1) * 10) : ''); };

export function openMoment(cur, v) {
  const it = cur.it, dur = it.duration || (isFinite(v.duration) ? v.duration : 0);
  const pos = v.currentTime || 0;
  const wasPlaying = !v.paused; v.pause();
  let start = Math.max(0, pos - 30), end = pos >= 1 ? pos : Math.min(dur || 30, 30);
  const sub = it.subtitles.find(s => s.id === cur.sub && !s.bitmap);
  const name = it.kind === 'episode' ? `${it.showTitle || ''} – ${it.title}` : it.title;
  const d = openDialog({
    title: t('Spara ögonblick'), form: true,
    body: `<p class="muted small">${t('Klippet sparas på servern och syns för hushållet under Ögonblick. Du kan dela det utanför hemmet med en länk som slutar gälla.')}</p>
      <div class="field"><label for="mtitle">${t('Titel')}</label><input id="mtitle" required maxlength="80" autocomplete="off" value="${esc(name || '')}"></div>
      <div class="mrange">
        <div class="field"><label for="mstart">${t('Start')}</label><input id="mstart" inputmode="decimal" required autocomplete="off" aria-describedby="mlen"></div>
        <div class="field"><label for="mend">${t('Slut')}</label><input id="mend" inputmode="decimal" required autocomplete="off" aria-describedby="mlen"></div>
      </div>
      <div class="row mbtns"><button type="button" class="ghost small" id="mlast">${t('Senaste 30 s')}</button>
        <button type="button" class="ghost small" id="msetstart">${t('Start = {t}', { t: clock(pos) })}</button>
        <button type="button" class="ghost small" id="msetend">${t('Slut = {t}', { t: clock(pos) })}</button></div>
      <p class="muted small" id="mlen" role="status"></p>
      ${sub ? `<label class="chk"><input type="checkbox" id="msub"> ${t('Bränn in undertexten ({label})', { label: esc(sub.label) })}</label>` : ''}
      <label class="chk"><input type="checkbox" id="mmark"> ${t('Liten vattenstämpel med titeln')}</label>`,
    actions: [{ label: t('Avbryt'), value: null }, { label: t('Spara ögonblick'), kind: 'primary', submit: true, id: 'msave',
      onClick: async (h) => {
        const s = parseClock(h.$('#mstart').value), e = parseClock(h.$('#mend').value);
        if (!(e > s)) { toast(t('Slutet måste komma efter starten'), { error: true }); return false; }
        return api(`/items/${it.id}/moments`, { method: 'POST', body: { start: s, end: e, title: h.$('#mtitle').value, audio: cur.audio === '' ? null : +cur.audio,
          sub: h.$('#msub')?.checked ? sub.id : null, watermark: h.$('#mmark').checked } });
      } }]
  });
  const show = () => {
    d.$('#mstart').value = clock(start); d.$('#mend').value = clock(end); len();
  };
  const len = () => {
    const s = parseClock(d.$('#mstart').value), e = parseClock(d.$('#mend').value);
    d.$('#mlen').textContent = e > s ? t('Längd {n} s', { n: String(Math.round((e - s) * 10) / 10).replace('.', ',') }) : t('Slutet måste komma efter starten');
  };
  d.$('#mstart').oninput = len; d.$('#mend').oninput = len;
  d.$('#mlast').onclick = () => { start = Math.max(0, pos - 30); end = Math.max(pos, Math.min(dur || 30, 30)); show(); };
  d.$('#msetstart').onclick = () => { start = pos; if (end <= start) end = Math.min(dur || start + 30, start + 30); show(); };
  d.$('#msetend').onclick = () => { end = pos; if (start >= end) start = Math.max(0, end - 30); show(); };
  show();
  d.closed.then((r) => {
    if (r && typeof r === 'object') toast(t('Ögonblicket sparas – det dyker upp under Ögonblick om en stund'), { action: { label: t('Visa'), onClick: () => { location.hash = '#/moments'; } } });
    if (wasPlaying && v.isConnected) v.play().catch(() => {});
  });
}
