// Bio-läge i webbspelaren: trailers (och administratörens förfilm) före filmen, med "Hoppa över" och "Hoppa över alla".
// Servern väljer vad som spelas (/api/items/:id/playback?cinema=1 → preroll); här spelas kön i en egen <video> ovanpå
// spelaren, så att filmens framsteg, intro-knappar och Titta tillsammans inte påverkas. Inställningen finns under Mitt konto.
import { $, act, api, esc, fmtTime, routeGen, toast } from '../core.js';

/**
 * Spela kön före filmen. Löses när kön är slut, hoppats över, spelaren stängts eller gjorts liten (då startar filmen
 * direkt i det lilla fönstret). live() = spelaren gäller fortfarande; onClose stänger spelaren (länken till titeln).
 */
export function runPreroll(cur, list, { live, onClose }) {
  return new Promise(done => {
    const el = cur.el;
    const v = document.createElement('video');
    v.id = 'previd'; v.autoplay = true; v.playsInline = true; v.setAttribute('playsinline', '');
    const box = document.createElement('div'); box.className = 'cinemabox';
    box.setAttribute('role', 'region'); box.setAttribute('aria-label', 'Före filmen');
    el.append(v, box); el.classList.add('cinema'); cur.pre = { v, skip: () => next(), all: () => finish() };
    let i = -1, ended = false;
    const obs = new MutationObserver(() => { if (!v.isConnected || cur.mini || !live()) finish(); });
    function finish() {
      if (ended) return; ended = true;
      obs.disconnect(); cur.pre = null;
      v.pause(); v.removeAttribute('src'); v.load(); v.remove(); box.remove(); el.classList.remove('cinema');
      done();
    }
    function next() {
      if (ended) return;
      if (!live()) return finish();
      if (++i >= list.length) return finish();
      show(list[i]);
    }
    function show(x) {
      const last = i === list.length - 1;
      const what = x.kind === 'trailer' ? `Trailer ${list.filter(y => y.kind === 'trailer').indexOf(x) + 1} av ${list.filter(y => y.kind === 'trailer').length}` : 'Förfilm';
      box.innerHTML = `<div class="cbinfo"><span class="muted small">${what}</span>
          <div>${x.kind === 'trailer' ? `<b>Trailer: ${esc(x.title)}</b>${x.itemId ? ` – <a href="#/item/${+x.itemId}" data-goto>finns i biblioteket</a>` : ''}` : '<b>Strax börjar filmen</b>'}</div></div>
        <div class="cbbtns"><button class="primary" data-skip>${last ? 'Till filmen ⏭' : 'Hoppa över ⏭'}</button>
          ${last ? '' : '<button class="ghost" data-all>Hoppa över alla</button>'}
          <button class="ghost" data-close title="Stäng spelaren" aria-label="Stäng spelaren">✕</button></div>
        <div class="cbleft muted small" aria-live="off" data-left></div>`;
      $('[data-skip]', box).onclick = next;
      if ($('[data-all]', box)) $('[data-all]', box).onclick = finish;
      $('[data-close]', box).onclick = () => { finish(); onClose(); };
      // Till titelsidan: spelaren stängs och sidan öppnas (länkens vanliga navigering)
      const a = $('[data-goto]', box); if (a) a.onclick = () => { finish(); onClose(); };
      v.src = x.url;
      v.play().catch(() => {});
      $('[data-skip]', box).focus({ preventScroll: true });
    }
    v.onended = next;
    // Filen går inte att spela i webbläsaren (t.ex. AVI) eller finns inte längre: nästa
    v.onerror = () => { if (!ended && v.getAttribute('src')) next(); };
    v.ontimeupdate = () => {
      const x = list[i], d = x?.duration || (isFinite(v.duration) ? v.duration : 0), l = $('[data-left]', box);
      if (l && d) l.textContent = `${fmtTime(Math.max(0, d - v.currentTime))} kvar`;
    };
    v.onclick = () => v.paused ? v.play().catch(() => {}) : v.pause();
    obs.observe(el, { attributes: true, attributeFilter: ['class'], childList: true });
    next();
  });
}
/** Tangenter medan trailers spelas: mellanslag pausar, s/Enter hoppar över, Escape gör spelaren liten (filmen startar) */
export function preKey(e, cur) {
  const p = cur.pre; if (!p) return false;
  if ((e.key === ' ' || e.key === 'Enter') && e.target.closest?.('button,a')) return true; // knappen själv
  if (e.key === ' ' || e.key === 'k') { e.preventDefault(); p.v.paused ? p.v.play().catch(() => {}) : p.v.pause(); }
  else if (e.key === 's') p.skip();
  else return false;
  return true;
}

/** Panelen under Mitt konto */
export async function renderCinemaPrefs(box) {
  const gen = routeGen;
  const p = await api('/me/cinema');
  if (gen !== routeGen || !box.isConnected) return;
  box.innerHTML = `<h2>Bio-läge</h2>
    <p class="muted small">Som på bio: före en film spelas trailers för filmer i biblioteket som du inte har sett – helst i liknande genre och efter vad du brukar titta på. Gäller när du startar en film från början i webbläsaren (inte avsnitt, och inte när du fortsätter titta mitt i). Du kan alltid hoppa över.</p>
    <div class="row" style="align-items:flex-end;gap:18px"><div><label for="cmn">Trailers före filmer</label><select id="cmn"><option value="0">Av</option>${
      Array.from({ length: p.max }, (_, k) => `<option value="${k + 1}">${k + 1} ${k ? 'trailers' : 'trailer'}</option>`).join('')}</select></div>
      ${p.prerollAvailable ? `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="cmp" ${p.preroll ? 'checked' : ''}> Spela förfilmen sist före filmen</label>` : ''}</div>`;
  $('#cmn', box).value = String(p.trailers);
  const save = act(async () => {
    await api('/me/cinema', { method: 'PUT', body: { trailers: +$('#cmn', box).value, ...($('#cmp', box) ? { preroll: $('#cmp', box).checked } : {}) }, bg: true });
    toast('Sparat');
  });
  $('#cmn', box).onchange = save;
  if ($('#cmp', box)) $('#cmp', box).onchange = save;
}
