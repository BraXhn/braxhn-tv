// Vy: personsida (skådespelare, regissörer)
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, api, esc, fmtDay, main, views, t } from '../core.js';
import { ROLE_NAME, card, personArt } from '../ui/cards.js';

views.person = async (id) => {
  const p = await api('/people/' + encodeURIComponent(id));
  const age = p.birthday ? Math.floor(((p.deathday ? new Date(p.deathday) : new Date()) - new Date(p.birthday)) / 31557600000) : null;
  const life = [p.birthday ? t('Född {birthday}{v}', { birthday: fmtDay(p.birthday), v: !p.deathday && age ? ` ${t('({age} år)', { age })}` : '' }) : '', p.birthplace || '',
    p.deathday ? t('Död {deathday}{v}', { deathday: fmtDay(p.deathday), v: age ? ` ${t('({age} år)', { age })}` : '' }) : ''].filter(Boolean);
  const roleText = (i) => i.roles.map(r => r.role === 'cast' ? (r.character || t('Medverkar')) : ROLE_NAME[r.role] || r.role).join(', ');
  main.innerHTML = `<div class="person-head"><div class="card pcard">${personArt(p, 180)}</div>
    <div><h1>${esc(p.name)}</h1><div class="meta">${life.map(x => `<span>${esc(x)}</span>`).join('')}</div>
    ${p.bio ? `<p class="overview bio clamp" id="bio">${esc(p.bio)}</p><button class="ghost small" id="biomore" hidden>${t('Visa mer')}</button>` : ''}</div></div>
    <section class="section"><h2>${t('I biblioteket')} <span class="muted small">${p.items.length} ${p.items.length === 1 ? t('titel') : t('titlar')}</span></h2>
    <div class="grid">${p.items.map(i => `<div>${card(i)}<div class="role">${esc(roleText(i))}</div></div>`).join('')}</div></section>`;
  const bio = $('#bio');
  if (bio && bio.scrollHeight > bio.clientHeight + 4) {
    $('#biomore').hidden = false;
    $('#biomore').onclick = (e) => { const closed = bio.classList.toggle('clamp'); e.currentTarget.textContent = closed ? t('Visa mer') : t('Visa mindre'); };
  }
};
