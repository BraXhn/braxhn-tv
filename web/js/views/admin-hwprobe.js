// Administration – Hårdvaruomkodning: knappen Prova omkodningen kör provet i server/hwprobe.js (genererad testbild,
// H.264, HEVC och 10-bitars HEVC med vald hårdvara och med processorn) och visar per kodare om grafikkortet eller
// processorn används eller att det inte fungerar, uppmätt hastighet i 1080p och 4K och – vid fel – vad man ska göra,
// med ffmpegs felutskrift i en utfällbar ruta. Senaste resultatet sparas på servern och visas med datum.
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, act, api, esc, later, t, locale } from '../core.js';

const MODE = { nvenc: 'NVIDIA (NVENC)', vaapi: 'VA-API (Intel/AMD)', qsv: 'Intel Quick Sync', videotoolbox: 'VideoToolbox', none: '' };
const modeName = (m) => m === 'none' ? t('Processorn') : MODE[m] || m;
const CODEC = { h264: 'H.264', hevc: 'HEVC', hevc10: () => t('HEVC 10 bitar') };
const codecName = (c) => typeof CODEC[c] === 'function' ? CODEC[c]() : CODEC[c] || c;
const num = (v) => String(v).replace('.', locale.startsWith('sv') ? ',' : '.');

/** Förklaringen för en felkod från servern (server/hwprobe.js explain) */
function why(x) {
  const W = {
    'nv-not-visible': t('Grafikkortet syns inte i containern. Installera pluginen <i>Nvidia-Driver</i> i Unraid, lägg till <code>--runtime=nvidia</code> under <i>Extra Parameters</i> och sätt <code>NVIDIA_VISIBLE_DEVICES=all</code> i mallen (eller använd mallen braxhn-tv-nvidia.xml). Starta sedan om containern.'),
    'nv-runtime': t('NVIDIA-enheten finns i containern, men inte drivrutinen. Lägg till <code>--runtime=nvidia</code> under <i>Extra Parameters</i> (det räcker inte att bara lägga till enheten) och starta om containern.'),
    'nv-caps': t('Drivrutinen syns, men utan videodelen. Sätt <code>NVIDIA_DRIVER_CAPABILITIES=all</code> i Unraid-mallen och starta om containern.'),
    'nv-no-device': t('Containern får inget grafikkort. Kontrollera <code>NVIDIA_VISIBLE_DEVICES</code> i mallen: <code>all</code>, eller kortets GPU-id från pluginen <i>Nvidia-Driver</i>.'),
    'nv-driver-old': t('NVIDIA-drivrutinen är för gammal för ffmpeg i containern. Uppdatera den i pluginen <i>Nvidia-Driver</i> och starta om Unraid.'),
    'nv-mismatch': t('Drivrutinen har uppdaterats, men containern kör fortfarande med den gamla. Starta om containern – hjälper inte det, starta om Unraid.'),
    'nv-busy': t('Grafikkortet tar inte emot fler kodningar just nu. GeForce-kort tillåter bara ett fåtal samtidigt – stäng av omkodning med grafikkortet i andra program (t.ex. Plex eller Jellyfin) eller uppdatera drivrutinen.'),
    'nv-unsupported': t('Det här grafikkortet saknar videokodare för formatet (t.ex. GT 1030, eller HEVC på mycket gamla kort).'),
    format: t('Grafikkretsen klarar inte just det här formatet. 10-bitars HEVC kräver t.ex. NVIDIA från GTX 10-serien eller Intel från 7:e generationen. Formaten som fungerar ovan används ändå.'),
    'dri-missing': t('<code>/dev/dri</code> saknas i containern. Lägg till enheten <code>/dev/dri</code> i Unraid-mallen (<i>GPU-enhet</i>, eller <code>--device=/dev/dri</code> under <i>Extra Parameters</i>) och starta om containern.'),
    'dri-denied': t('<code>/dev/dri</code> finns, men containern får inte använda den. Ge containerns användare gruppen som äger enheten (se <code>ls -l /dev/dri</code> på servern) med <code>--group-add</code> och gruppens nummer under <i>Extra Parameters</i>, eller ändra PUID/PGID.'),
    'va-driver': t('<code>/dev/dri</code> finns, men grafikdrivrutinen startar inte. Intel från 8:e generationen: sätt <code>LIBVA_DRIVER_NAME=iHD</code>; äldre Intel: <code>i965</code>; AMD: <code>radeonsi</code>. NVIDIA-kort fungerar inte med VA-API – välj <code>nvenc</code>.'),
    'qsv-none': t('Quick Sync hittar ingen Intel-grafik. Den kräver en Intel-processor med inbyggd grafik och <code>/dev/dri</code> i containern. Med AMD eller äldre Intel: välj <code>HWACCEL=vaapi</code>.'),
    'no-encoder': t('ffmpeg saknar kodaren {encoder}. Den finns i Docker-imagen – vid egen installation behöver ffmpeg ha den.', { encoder: `<code>${esc(x.encoder || '')}</code>` }),
    'vt-only-mac': t('VideoToolbox finns bara på Mac och används inte av servern i Docker. Välj <code>nvenc</code>, <code>vaapi</code>, <code>qsv</code> eller <code>none</code>.'),
    'no-ffmpeg': t('ffmpeg saknas. Den finns i Docker-imagen; vid egen installation: installera ffmpeg.'),
    timeout: t('Kodaren svarade inte inom 15 sekunder. Drivrutinen kan hänga – starta om containern och prova igen.'),
    unknown: t('Felet känns inte igen. Se ffmpegs felutskrift nedan och skicka gärna ett diagnostikpaket (Hälsokontroll) med en buggrapport.')
  };
  return W[x?.code] || W.unknown;
}

function speed(r, size) {
  if (r.fps?.[size] != null) return t('{fps} bildrutor/s · {x} × realtid', { fps: r.fps[size], x: num(r.realtime[size]) });
  if (r.status === 'fail') return '–';
  if (size === '2160p' && r.skipped4k === 'slow') return `<span class="muted">${t('provas inte – för långsamt redan i 1080p')}</span>`;
  if (size === '2160p' && r.skipped4k === 'failed') return `<span class="muted">${t('fungerar inte i 4K')}</span>`;
  return '–';
}
const STATUS = () => ({ gpu: ['ok-badge', t('Grafikkortet används')], cpu: ['ok-badge hb-info', t('Processorn används')], fail: ['warn-badge hb-err', t('Fungerar inte')] });

/** Sammanfattningen överst: används grafikkortet för omkodningen eller inte? */
function summary(R) {
  const gpu = R.results.filter(r => r.mode !== 'none');
  const h264 = gpu.find(r => r.codec === 'h264');
  const m = esc(R.mode);
  if (R.mode === 'none') return `<p>${t('Inget grafikkort hittades i containern, så omkodningen görs av processorn.')}</p>`;
  if (R.gpuWorks && R.serverUsesGpu) return `<p><span class="ok-badge">✓</span> ${t('Grafikkortet används för omkodningen ({mode}), {fps} bildrutor/s i 1080p.', { mode: esc(modeName(R.mode)), fps: h264?.fps?.['1080p'] ?? '–' })}</p>`;
  if (R.gpuWorks && R.wanted === 'none') return `<p><span class="warn-badge">!</span> ${t('Grafikkortet fungerar, men servern använder processorn. Sätt <code>HWACCEL={mode}</code> i Unraid-mallen och starta om containern.', { mode: m })}</p>`;
  if (R.gpuWorks) return `<p><span class="warn-badge">!</span> ${t('Grafikkortet fungerade i provet, men servern slutade använda det: {error}. Starta om containern.', { error: esc(R.serverError || '–') })}</p>`;
  return `<p><span class="warn-badge hb-err">✕</span> ${t('Grafikkortet används inte – omkodningen görs av processorn, och 4K kan hacka. Se förklaringen nedan.')}</p>`;
}

/** Resultattabellen (exporteras för testerna av vyn) */
export function resultHtml(R) {
  if (!R) return `<p class="muted small">${t('Provet har inte körts än.')}</p>`;
  const S = STATUS();
  const when = new Date(R.at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const seen = new Set(); // samma orsak för flera format med samma hårdvara förklaras en gång
  const rows = R.results.map(r => {
    const [cls, label] = S[r.status] || S.fail;
    const main = `<tr><th scope="row">${esc(codecName(r.codec))}<div class="muted small">${esc(modeName(r.mode))} · <code>${esc(r.encoder)}</code></div></th>
      <td><span class="${cls}">${label}</span></td><td>${speed(r, '1080p')}</td><td>${speed(r, '2160p')}</td></tr>`;
    if (r.status !== 'fail') return main;
    const key = `${r.mode}:${r.explanation?.code}`, again = seen.has(key);
    seen.add(key);
    return main + `<tr class="hwp-why"><td colspan="4"><p class="small" style="margin:0 0 4px">${again ? t('Samma orsak som ovan.') : why(r.explanation)}</p>
      ${r.line ? `<details class="small"><summary>${t('ffmpegs felrad')}: <code>${esc(r.line)}</code></summary><pre class="hwp-log">${esc(r.log || r.line)}</pre></details>` : ''}</td></tr>`;
  }).join('');
  return `${summary(R)}
    ${R.aborted ? `<p class="small"><span class="warn-badge">!</span> ${t('Provet avbröts eftersom {n} strömmar började omkodas. Prova igen när färre tittar.', { n: +R.aborted.streams })}</p>` : ''}
    <div class="hwp-wrap"><table class="hwp-table"><caption class="sr-only">${t('Resultat per kodare')}</caption>
      <thead><tr><th scope="col">${t('Format')}</th><th scope="col">${t('Resultat')}</th><th scope="col">1080p</th><th scope="col">4K</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="muted small">${t('Senaste provet: {date} · tog {s} s. Realtid = 25 bildrutor/s; minst 1 × behövs för att filmen inte ska hacka, och varje samtidig omkodning delar på hastigheten.', { date: esc(when), s: Math.round(R.ms / 1000) })}</p>`;
}

export async function adminHwProbe() {
  const box = $('#hwp');
  if (!box) return;
  let I = await api('/admin/hwprobe');
  if (!box.isConnected) return;
  const target = () => I.wanted !== 'none' && MODE[I.wanted] ? I.wanted : I.detected;
  const draw = () => {
    const busy = I.busy >= I.busyLimit;
    const tm = target();
    box.innerHTML = `<p class="muted small">${tm === 'none' ? t('Provet kodar en genererad testbild i några sekunder per format med processorn (inget grafikkort hittades i containern) och mäter hastigheten. Dina filer används inte, och pågående uppspelning går före.')
      : t('Provet kodar en genererad testbild i några sekunder per format – med {mode} och med processorn som jämförelse – och mäter hastigheten. Dina filer används inte, och pågående uppspelning går före.', { mode: esc(modeName(tm)) })}</p>
      <div class="row"><button type="button" class="primary" id="hwp-run"${I.running || busy ? ' disabled' : ''}>${t('Prova omkodningen')}</button>
        <span class="small" id="hwp-st" role="status">${I.running ? esc(progress()) : busy ? t('{n} strömmar omkodas just nu – prova igen när färre tittar.', { n: +I.busy }) : ''}</span></div>
      <div id="hwp-res" style="margin-top:12px">${resultHtml(I.last)}</div>`;
    $('#hwp-run', box).onclick = act(async () => {
      I = await api('/admin/hwprobe', { method: 'POST', body: {} });
      draw(); poll();
    });
  };
  const progress = () => I.step ? t('Provar {codec} med {mode} … ({done} av {total})', { codec: codecName(I.step.codec), mode: modeName(I.step.mode), done: I.done + 1, total: I.total }) : t('Startar provet …');
  const poll = () => later(async () => {
    try { I = await api('/admin/hwprobe'); } catch { return poll(); }
    if (!box.isConnected) return;
    if (I.running) { const s = $('#hwp-st', box); if (s) s.textContent = progress(); return poll(); }
    draw();
    const s = $('#hwp-st', box); if (s && I.last) s.textContent = t('Provet är klart.');
  }, 1000);
  draw();
  if (I.running) poll();
}
