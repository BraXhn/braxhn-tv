// Repliker i sökningen (/api/search/lines, server/sublines.js): träffar i undertexterna med markerad replik,
// @lazy – laddas av views/search.js när fliken Repliker väljs (need()), aldrig vid start
// sammanhang före/efter och en förhandsbild från spolningsbilderna. Klick spelar titeln från scenen (två sekunder före
// repliken) via fasaden i lazy.js.
import { $$, api, esc } from '../core.js';
import { startPlay } from '../lazy.js';
import { emptyState } from '../ui/states.js';

const LEAD = 2; // sekunder före repliken – man hör den från början
const clock = (t) => { t = Math.max(0, Math.floor(t)); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0'); };
/** Repliken med träffen markerad (marks = teckenintervall från servern) – varje bit genom esc() */
export function markLine(text, marks = []) {
  let out = '', at = 0;
  for (const [a, b] of marks) { if (a < at || b <= a) continue; out += esc(text.slice(at, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>'; at = b; }
  return out + esc(text.slice(at));
}
const sxe = (l) => l.season != null && l.episode != null ? `S${+l.season}E${+l.episode}` : '';
function thumbHtml(l) {
  const th = l.thumb;
  if (th && th.cols > 0 && th.rows > 0) {
    const x = th.cols > 1 ? th.col / (th.cols - 1) * 100 : 0, y = th.rows > 1 ? th.row / (th.rows - 1) * 100 : 0;
    return `<span class="lthumb" aria-hidden="true" style="background-image:url('${esc(th.url)}');background-size:${th.cols * 100}% ${th.rows * 100}%;background-position:${x.toFixed(3)}% ${y.toFixed(3)}%"></span>`;
  }
  const img = l.kind === 'episode' ? `/api/image/${+(l.version || l.id)}/thumb?w=320` : `/api/image/${+l.id}/backdrop?w=320`;
  return `<span class="lthumb" aria-hidden="true"><img loading="lazy" decoding="async" src="${esc(img)}" alt="" width="160" height="90" data-fb="1"></span>`;
}
const rowHtml = (l, i) => {
  const name = l.kind === 'episode' ? `${l.title}${sxe(l) ? ' · ' + sxe(l) : ''}${l.episodeTitle ? ' · ' + l.episodeTitle : ''}` : `${l.title}${l.year ? ` (${+l.year})` : ''}`;
  return `<button type="button" class="srow lrow" data-li="${i}" aria-label="${esc(`Spela ${name} från ${clock(l.t)}: ${l.line}`)}">
    ${thumbHtml(l)}<span class="lbody"><span class="lhead"><b>${esc(name)}</b><span class="ltime">${clock(l.t)}</span></span>
    ${l.before ? `<span class="lctx">${esc(l.before)}</span>` : ''}<span class="lline">${markLine(l.line, l.marks)}</span>${l.after ? `<span class="lctx">${esc(l.after)}</span>` : ''}
    ${l.label || l.lang ? `<span class="lsrc">Undertext: ${esc(l.label || l.lang)}</span>` : ''}</span></button>`;
};

/** Sök repliker och rita dem i el. Ger antalet träffar. api() kastar (aborted) om en nyare sökning startat. */
export async function renderLines(el, q) {
  const d = await api(`/search/lines?q=${encodeURIComponent(q)}&limit=40`);
  const L = d.lines || [], st = d.status || {};
  if (!L.length) {
    // titles finns bara i svaret till administratören
    const text = !st.enabled ? 'Repliksökningen är avstängd på servern.'
      : st.indexing ? 'Undertexterna indexeras fortfarande – fler repliker blir sökbara efter hand.'
      : st.titles === 0 ? 'Inga undertexter är indexerade än. Filmer och avsnitt med textundertexter (inbäddade eller .srt/.ass/.vtt bredvid filen) indexeras i bakgrunden efter skanningen.'
      : 'Prova med färre ord eller en annan del av repliken. Bara titlar med textundertexter går att söka i.';
    el.innerHTML = emptyState({ icon: '💬', title: 'Inga repliker hittades', text });
    return 0;
  }
  el.innerHTML = `<section class="section"><h2 class="sr-only">Repliker</h2>${st.indexing ? '<p class="muted small">Undertexterna indexeras fortfarande – fler träffar kan tillkomma.</p>' : ''}
    <div class="slist llist">${L.map(rowHtml).join('')}</div></section>`;
  $$('[data-li]', el).forEach(b => b.onclick = () => {
    const l = L[+b.dataset.li];
    startPlay(b, l.id, Math.max(0, l.t - LEAD), l.version ? { version: l.version } : {});
  });
  return L.length;
}
