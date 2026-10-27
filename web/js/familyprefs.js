// Familjefiltrets inställningar (server/familyfilter.js): profilens läge (Mitt konto), läget för hushållets profiler
// och administratörens ordlistor och standard för barnprofiler (Administration).
import { $, act, api, esc, toast, toastErr } from './core.js';
import { openDialog } from './ui/dialog.js';

const MODES = [['off', 'Av'], ['mute', 'Tysta svordomar'], ['skip', 'Tysta svordomar och hoppa över markerade scener']];
const modeName = (m) => (MODES.find(x => x[0] === m) || MODES[0])[1];
const opts = (cur, std) => `${std ? `<option value="" ${cur === '' ? 'selected' : ''}>${esc(std)}</option>` : ''}` +
  MODES.map(([v, n]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${esc(n)}</option>`).join('');
const INTRO = 'Ljudet tystas där undertexten innehåller en svordom och undertexten visar *** i stället. Tiderna kommer från undertexten (med undertextsynken), så titlar utan textundertext filtreras inte.';

/** Panelen i Mitt konto: den egna profilens läge (barnprofiler ser bara läget) */
export async function renderFamilyPrefs(el) {
  if (!el) return;
  const F = await api('/me/family-filter');
  if (!el.isConnected) return;
  el.innerHTML = `<h2>Familjefilter ${F.mode !== 'off' ? '<span class="ok-badge">På</span>' : ''}</h2>
    <p class="muted small">${esc(INTRO)} Gäller webben, Chromecast och apparna.</p>
    ${F.canChange ? `<div class="row"><label style="min-width:240px">Läge<select id="ffmode">${opts(F.setting, 'Standard (av för vuxna)')}</select></label></div>
      <p class="muted small">Scener markerar du i spelaren under ⚙ → Familjefilter.</p>`
    : `<p>${esc(modeName(F.mode))}</p><p class="muted small">Ändras av huvudkontot under Profiler i hushållet.</p>`}`;
  const sel = $('#ffmode', el);
  if (sel) sel.onchange = act(async () => { await api('/me/family-filter', { method: 'PUT', body: { mode: sel.value } }); toast('Sparat'); renderFamilyPrefs(el); });
}

/** Dialog för en profil i hushållet (huvudkontot) */
export async function familyProfileDialog(p, onSaved) {
  const d = openDialog({ title: `Familjefilter – ${p.name}`, form: true,
    body: `<p class="muted small">${esc(INTRO)}</p><div class="field"><label for="ffpm">Läge</label><select id="ffpm">${opts(p.familyFilter || '', p.kid ? 'Standard (administratörens val för barnprofiler)' : 'Standard (av)')}</select></div>
      <p class="muted small">Gäller nu: <b>${esc(modeName(p.familyMode))}</b></p>`,
    actions: [{ label: 'Avbryt', value: null }, { label: 'Spara', kind: 'primary', submit: true,
      onClick: async (h) => { await api('/profiles/' + p.id, { method: 'PUT', body: { familyFilter: h.$('#ffpm').value } }); return true; } }] });
  if (await d.closed === true) { toast('Sparat'); onSaved?.(); }
}

const list = (a) => (a || []).join(', ');
const parse = (s) => String(s || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean);
/** Administrationens panel: standard för barnprofiler, egna ord, avstängda inbyggda ord och en provruta */
export async function renderFamilyAdmin(el) {
  if (!el) return;
  const A = await api('/admin/family-filter');
  if (!el.isConnected) return;
  el.innerHTML = `<h2>Familjefilter</h2>
    <p class="muted small">${esc(INTRO)} Varje profil väljer själv (huvudkontot för barnprofilerna); här väljer du standard för barnprofiler och vilka ord som räknas.
      Ord matchas på ordgräns med vanliga böjningar. <code>ord*</code> = allt som börjar med ordet, <code>*ord</code> = sammansättningar som slutar med det, <code>ord!</code> = bara exakt ordet. Flera ord = en fras.</p>
    <form id="fff">
      <label>Standard för barnprofiler<select id="ffkids">${opts(A.kidsDefault, '')}</select></label>
      <label>Egna ord – svenska (kommatecken eller en per rad)</label><textarea id="ffsv" rows="2">${esc(list(A.custom.sv))}</textarea>
      <label>Egna ord – engelska</label><textarea id="ffen" rows="2">${esc(list(A.custom.en))}</textarea>
      <details><summary class="muted small">Inbyggda ord (${A.builtin.sv.length + A.builtin.en.length}) – kryssa ur för att stänga av</summary>
        <div class="ffwords">${['sv', 'en'].map(l => `<p class="muted small">${l === 'sv' ? 'Svenska' : 'Engelska'}</p>` + A.builtin[l].map(w =>
          `<label class="switch"><input type="checkbox" data-ffw="${esc(w)}" ${A.custom.off.includes(w) ? '' : 'checked'}> ${esc(w)}</label>`).join('')).join('')}</div></details>
      <div class="row" style="margin-top:10px"><button class="primary">Spara</button></div></form>
    <div class="row" style="margin-top:12px;align-items:flex-end"><div style="flex:1;min-width:200px"><label for="fftest">Prova en replik</label><input id="fftest" placeholder="T.ex. Fan, vad kallt det är!"></div>
      <button type="button" class="ghost" id="fftestb">Prova</button></div><p class="small" id="fftestr" aria-live="polite"></p>`;
  $('#fff', el).onsubmit = async (e) => {
    e.preventDefault();
    const off = [...el.querySelectorAll('[data-ffw]')].filter(x => !x.checked).map(x => x.dataset.ffw);
    try { await api('/admin/family-filter', { method: 'PUT', body: { kidsDefault: $('#ffkids', el).value, sv: parse($('#ffsv', el).value), en: parse($('#ffen', el).value), off } }); toast('Sparat'); renderFamilyAdmin(el); }
    catch (er) { toastErr(er); }
  };
  $('#fftestb', el).onclick = act(async () => {
    const r = await api('/admin/family-filter/test', { method: 'POST', body: { text: $('#fftest', el).value } });
    $('#fftestr', el).textContent = r.hit ? `Tystas – undertexten visar: ${r.masked}` : 'Ingen träff – repliken tystas inte.';
  });
}
