// Vy: Ordlistan (#/vocab) – ord som profilen sparat i spelarens språkinlärningsläge (player/learn.js), med meningen,
// översättningen och titeln. Sök, ändra översättningen, lyssna på repliken (ljudklipp från servern), spela från
// repliken, ta bort och exportera till Anki (TSV/CSV, eller ZIP med ljudklipp när kontot får ladda ner).
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, $$, api, esc, fmtDate, fmtTime, main, me, routeGen, onLeave, toast, toastErr, views, t, tn } from '../core.js';
import { confirmDialog, formDialog } from '../ui/dialog.js';
import { emptyState, errorState, bindRetry } from '../ui/states.js';
import { iconButton } from '../ui/buttons.js';
import { startPlay } from '../lazy.js';

views.vocab = async () => {
  if (!me) { location.hash = '#/login'; return; }
  let q = '', words = [], audio = null;
  onLeave(() => { audio?.pause(); audio = null; });
  main.innerHTML = `<section class="vocab"><h1>${t('Ordlista')}</h1>
    <p class="muted">${t('Ord du sparat i spelarens språkinlärningsläge (⚙ → Språkinlärning). Klicka på ett ord i undertexten för att spara det med meningen och översättningen.')}</p>
    <div class="vtools"><label class="sr-only" for="vq">${t('Sök i ordlistan')}</label><input id="vq" type="search" placeholder="${t('Sök i ordlistan')}" autocomplete="off">
      <a class="btn" id="vtsv" href="/api/vocab/export?format=tsv" download>${t('Exportera till Anki (TSV)')}</a>
      <a class="btn ghost" id="vcsv" href="/api/vocab/export?format=csv" download>CSV</a>
      ${me.canDownload === false ? '' : `<a class="btn ghost" id="vzip" href="/api/vocab/export?format=zip" download>${t('ZIP med ljud')}</a>`}</div>
    <p class="muted small" id="vcount" role="status"></p><div id="vlist"></div>
    <details class="muted vhelp"><summary>${t('Så importerar du i Anki')}</summary><p>${t('Arkiv → Importera och välj filen. Fälten är Ord, Mening, Översättning och Källa (ZIP: även Ljud). Lägg ljudfilerna ur ZIP-filen i Ankis mediamapp (collection.media) innan du importerar ordlista.txt.')}</p></details></section>`;
  const list = $('#vlist'), g = routeGen;
  const draw = () => {
    $('#vcount').textContent = words.length ? tn(words.length, '{n} sparat ord', '{n} sparade ord') : '';
    if (!words.length) {
      list.innerHTML = q ? emptyState({ icon: '🔍', title: t('Inga ord matchar sökningen') })
        : emptyState({ icon: '📒', title: t('Ordlistan är tom'), text: t('Starta en film eller ett avsnitt med textundertexter, slå på Språkinlärning under ⚙ och klicka på ett ord i undertexten.') });
      return;
    }
    list.innerHTML = words.map(w => `<div class="vrow" data-vid="${w.id}"><div>
        <div class="vword">${esc(w.word)}</div>
        <p class="vsent">${esc(w.sentence)}</p>${w.translation ? `<p class="vtr">${esc(w.translation)}</p>` : ''}
        <div class="muted small">${esc(w.source || t('Okänd titel'))}${w.start != null ? ' · ' + fmtTime(w.start) : ''} · ${fmtDate(w.created)}</div></div>
      <div class="vacts">
        ${w.clip && me.canDownload !== false ? iconButton({ icon: '🔊', label: t('Lyssna på repliken: {word}', { word: w.word }), data: { listen: w.id } }) : ''}
        ${w.itemId && w.start != null ? iconButton({ icon: 'play', label: t('Spela från repliken: {word}', { word: w.word }), data: { play: w.id } }) : ''}
        ${iconButton({ icon: '✎', label: t('Ändra översättningen: {word}', { word: w.word }), data: { edit: w.id }, haspopup: 'dialog' })}
        ${iconButton({ icon: '✕', label: t('Ta bort {word} ur ordlistan', { word: w.word }), data: { del: w.id } })}</div></div>`).join('');
  };
  const load = async () => {
    try { words = (await api('/vocab' + (q ? '?q=' + encodeURIComponent(q) : ''))).words; }
    catch (e) { if (g !== routeGen || e?.aborted) return; list.innerHTML = errorState(e, { retry: true }); bindRetry(list, load); return; }
    if (g === routeGen) draw();
  };
  let timer = 0;
  $('#vq').oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { q = e.target.value.trim(); load(); }, 250); };
  const byId = (b) => words.find(w => w.id === +(b.dataset.listen || b.dataset.play || b.dataset.edit || b.dataset.del));
  list.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const w = byId(b); if (!w) return;
    if (b.dataset.listen) {
      audio?.pause();
      audio = new Audio(`/api/vocab/${w.id}/clip`);
      audio.play().catch(() => toast(t('Ljudklippet kunde inte spelas'), { error: true }));
    } else if (b.dataset.play) startPlay(b, w.itemId, Math.max(0, w.start - 1));
    else if (b.dataset.edit) {
      const f = await formDialog({ title: w.word, okLabel: t('Spara'), fields: [
        { name: 'word', label: t('Ord'), value: w.word, required: true, maxlength: 100 },
        { name: 'translation', label: t('Översättning'), type: 'textarea', value: w.translation, maxlength: 600 }] });
      if (!f) return;
      try { Object.assign(w, await api('/vocab/' + w.id, { method: 'PUT', body: f })); draw(); toast(t('Sparat')); } catch (err) { toastErr(err); }
    } else if (b.dataset.del) {
      if (!await confirmDialog(t('Ta bort ”{word}” ur ordlistan?', { word: w.word }), { okLabel: t('Ta bort'), danger: true })) return;
      try {
        await api('/vocab/' + w.id, { method: 'DELETE' });
        const i = words.indexOf(w); words.splice(i, 1); draw();
        toast(t('Borttaget ur ordlistan'));
        ($$('#vlist .vrow')[Math.min(i, words.length - 1)]?.querySelector('button') || $('#vq')).focus();
      } catch (err) { toastErr(err); }
    }
  };
  await load();
};
