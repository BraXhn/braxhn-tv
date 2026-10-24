// "Anpassa startsidan": visa/dölj hyllorna, ändra ordningen (dra och släpp eller ↑/↓ med tangentbord och TV-fjärr,
// som ordningen i en egen samling) och välj om Utvalt ska visas överst. Sparas på servern per användare
// (PUT /api/me/home-layout) direkt vid varje ändring, så att samma startsida följer med till alla enheter.
import { $$, api, esc, toastErr } from '../core.js';
import { iconButton } from '../ui/buttons.js';
import { openDialog } from '../ui/dialog.js';

const HERO = [['auto', 'På breda skärmar (standard)'], ['on', 'Alltid'], ['off', 'Aldrig']];

/**
 * Öppnar dialogen. onChange anropas när dialogen stängs om något ändrats (startsidan ritas om).
 * @param {{ onChange?: () => void }} [o]
 */
export async function openHomeCustomizer({ onChange } = {}) {
  let L;
  try { L = await api('/me/home-layout', { bg: true }); } catch (e) { return toastErr(e); }
  const names = new Map(L.shelves.map(s => [s.id, s.name]));
  let order = L.order.filter(id => names.has(id)), hidden = new Set(L.hidden), changed = false;
  const box = document.createElement('div');
  const d = openDialog({
    title: 'Anpassa startsidan', size: 'wide', body: box,
    actions: [{ label: 'Återställ standard', kind: 'ghost', onClick: async () => {
      try { L = await api('/me/home-layout', { method: 'PUT', body: { reset: true }, bg: true }); } catch (e) { toastErr(e); return false; }
      order = L.order; hidden = new Set(L.hidden); changed = true; draw(); say('Startsidan är återställd');
      $$('select', box)[0].value = L.hero;
      return false;
    } }, { label: 'Klar', kind: 'primary' }],
    onClose: () => { if (changed) onChange?.(); }
  });
  box.innerHTML = `<p class="muted small">Gäller ditt konto på alla enheter. Bocka ur hyllor du inte vill se och ändra ordningen genom att dra eller med ↑ och ↓.</p>
    <label for="hcHero">Utvalt överst</label>
    <select id="hcHero">${HERO.map(([v, t]) => `<option value="${v}"${L.hero === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
    <h3 class="hc-h">Hyllor</h3><ol class="corder hcorder" aria-label="Hyllornas ordning"></ol><p class="sr-only" aria-live="polite" id="hcLive"></p>`;
  const list = box.querySelector('ol'), live = box.querySelector('#hcLive');
  const say = (t) => { live.textContent = t; };
  const save = async (body) => {
    changed = true;
    try { await api('/me/home-layout', { method: 'PUT', body, bg: true }); } catch (e) { toastErr(e); }
  };
  const li = (id, n) => {
    const name = names.get(id), on = !hidden.has(id);
    return `<li draggable="true" data-id="${esc(id)}"${on ? '' : ' class="off"'}><span class="grip" aria-hidden="true">⠿</span>
      <label class="ccheck cn"><input type="checkbox" data-show="${esc(id)}"${on ? ' checked' : ''}> ${n + 1}. ${esc(name)}</label>
      ${iconButton({ icon: '↑', label: `Flytta upp ${name}`, data: { mv: -1 }, disabled: n === 0 })}${iconButton({ icon: '↓', label: `Flytta ned ${name}`, data: { mv: 1 }, disabled: n === order.length - 1 })}</li>`;
  };
  const draw = (focus) => {
    list.innerHTML = order.map(li).join('');
    if (focus) {
      const el = list.querySelector(`li[data-id="${focus.id}"]`);
      (el?.querySelector(`[data-mv="${focus.dir}"]:not([disabled])`) || el?.querySelector('button:not([disabled])'))?.focus();
    }
  };
  const move = (from, to, dir) => {
    if (to < 0 || to >= order.length || from === to || from < 0) return;
    const [x] = order.splice(from, 1);
    order.splice(to, 0, x);
    draw(dir ? { id: x, dir } : null);
    say(`${names.get(x)} är nu på plats ${order.indexOf(x) + 1} av ${order.length}`);
    save({ order });
  };
  box.querySelector('#hcHero').onchange = (e) => { save({ hero: e.target.value }); say('Sparat'); };
  list.onclick = (e) => {
    const b = e.target.closest('[data-mv]'); if (!b) return;
    const id = b.closest('li').dataset.id, from = order.indexOf(id), dir = +b.dataset.mv;
    move(from, from + dir, dir);
  };
  list.onchange = (e) => {
    const c = e.target.closest('[data-show]'); if (!c) return;
    const id = c.dataset.show;
    if (c.checked) hidden.delete(id); else hidden.add(id);
    c.closest('li').classList.toggle('off', !c.checked);
    say(`${names.get(id)} ${c.checked ? 'visas' : 'döljs'}`);
    save({ hidden: [...hidden] });
  };
  let dragId = null;
  list.ondragstart = (e) => { const el = e.target.closest?.('li'); if (!el) return; dragId = el.dataset.id; el.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', dragId); } catch {} };
  list.ondragend = () => { dragId = null; $$('li', list).forEach(x => x.classList.remove('drag', 'over')); };
  list.ondragover = (e) => { const el = e.target.closest?.('li'); if (!el || dragId == null) return; e.preventDefault(); $$('li.over', list).forEach(x => x !== el && x.classList.remove('over')); el.classList.add('over'); };
  list.ondrop = (e) => {
    const el = e.target.closest?.('li'); if (!el || dragId == null) return;
    e.preventDefault();
    move(order.indexOf(dragId), order.indexOf(el.dataset.id), 0);
  };
  draw();
  return d;
}
