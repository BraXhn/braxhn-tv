// Vy: personsida (skådespelare, regissörer)
import { $, api, esc, fmtDay, main, views } from '../core.js';
import { ROLE_NAME, card, personArt } from '../ui/cards.js';

views.person = async (id) => {
  const p = await api('/people/' + encodeURIComponent(id));
  const age = p.birthday ? Math.floor(((p.deathday ? new Date(p.deathday) : new Date()) - new Date(p.birthday)) / 31557600000) : null;
  const life = [p.birthday ? `Född ${fmtDay(p.birthday)}${!p.deathday && age ? ` (${age} år)` : ''}` : '', p.birthplace || '',
    p.deathday ? `Död ${fmtDay(p.deathday)}${age ? ` (${age} år)` : ''}` : ''].filter(Boolean);
  const roleText = (i) => i.roles.map(r => r.role === 'cast' ? (r.character || 'Medverkar') : ROLE_NAME[r.role] || r.role).join(', ');
  main.innerHTML = `<div class="person-head"><div class="card pcard">${personArt(p, 180)}</div>
    <div><h1>${esc(p.name)}</h1><div class="meta">${life.map(x => `<span>${esc(x)}</span>`).join('')}</div>
    ${p.bio ? `<p class="overview bio clamp" id="bio">${esc(p.bio)}</p><button class="ghost small" id="biomore" hidden>Visa mer</button>` : ''}</div></div>
    <section class="section"><h2>I biblioteket <span class="muted small">${p.items.length} ${p.items.length === 1 ? 'titel' : 'titlar'}</span></h2>
    <div class="grid">${p.items.map(i => `<div>${card(i)}<div class="role">${esc(roleText(i))}</div></div>`).join('')}</div></section>`;
  const bio = $('#bio');
  if (bio && bio.scrollHeight > bio.clientHeight + 4) {
    $('#biomore').hidden = false;
    $('#biomore').onclick = (e) => { const closed = bio.classList.toggle('clamp'); e.currentTarget.textContent = closed ? 'Visa mer' : 'Visa mindre'; };
  }
};
