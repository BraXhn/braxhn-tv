// Titta tillsammans (watch party)
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, api, esc, main, me, status, toast, views, t } from '../core.js';
import { P, play } from './video.js';
import { errorState } from '../ui/states.js';

export function joinParty() {
  if (!P) return;
  const rid = P.party, el = P.el;
  $('#plink', el).value = `${status.publicUrl || location.origin}/#/party/${rid}`;
  $('#pparty', el).textContent = t('👥 Rummet');
  if (P.es) return;
  const es = P.es = new EventSource(`/api/party/${rid}/events`);
  const apply = (st) => {
    const v = P && $('#vid', P.el); if (!v) return;
    const target = st.position + (st.playing ? (Date.now() - st.at) / 1000 : 0);
    const cur = P;
    cur.applying = true;
    if (Math.abs(v.currentTime - target) > 1.5) v.currentTime = target;
    if (st.playing && v.paused) v.play().catch(() => {});
    if (!st.playing && !v.paused) v.pause();
    setTimeout(() => { cur.applying = false; }, 600);
  };
  const members = (m) => { const x = $('#pmembers', el); if (x) x.textContent = t('Här nu: ') + m.map(y => y.name).join(', '); };
  const addChat = (c) => { const x = $('#pchat', el); if (!x) return; x.insertAdjacentHTML('beforeend', `<div><b>${esc(c.name)}:</b> ${esc(c.text)}</div>`); x.scrollTop = 1e9; };
  // hello skickas vid varje (åter)anslutning med hela historiken – töm chatten först så inget dubbleras
  es.addEventListener('hello', (e) => { const d = JSON.parse(e.data); const x = $('#pchat', el); if (x) x.innerHTML = ''; members(d.members); d.chat.forEach(addChat); if (d.state.by !== me.name || d.state.position > 0) apply(d.state); });
  es.addEventListener('state', (e) => { const st = JSON.parse(e.data); if (st.by !== me.name) apply(st); });
  es.addEventListener('members', (e) => members(JSON.parse(e.data)));
  es.addEventListener('chat', (e) => { const c = JSON.parse(e.data); addChat(c); const pb = $('#partybox', el); if (c.name !== me.name && (!pb || pb.hidden)) toast(`${c.name}: ${c.text}`); });
  es.addEventListener('item', (e) => { const d = JSON.parse(e.data); if (P && P.it.id !== d.itemId) { toast(t('{by} bytte till nästa avsnitt', { by: d.by })); play(d.itemId, 0); } });
  es.addEventListener('closed', () => { toast(t('Rummet stängdes')); es.close(); if (P && P.es === es) { P.party = null; P.es = null; } });
}
views.party = async (rid) => {
  try {
    const r = await api('/party/' + rid);
    const pos = r.state.position + (r.state.playing ? (Date.now() - r.state.at) / 1000 : 0);
    location.hash = '#/item/' + r.itemId;
    setTimeout(() => play(r.itemId, pos, { party: rid }), 50);
  } catch (e) { if (e.aborted) throw e; main.innerHTML = errorState(e.offline ? e : { message: t('Rummet finns inte längre. {message}', { message: e.message }) }); }
};
