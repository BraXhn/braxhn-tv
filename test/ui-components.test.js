// Webbklientens komponenter (web/js/ui/): strängbyggarna escapar text och sätter rätt aria-attribut.
// Modulerna är webbläsarmoduler – här räcker en minimal attrapp av document/window eftersom bara
// de rena funktionerna som bygger HTML testas (interaktionen testas i webbläsaren, se docs/ui-komponenter.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Ett "element" som tar emot allt (moduler som kopplar knappar när de laddas, t.ex. router.js)
const fake = new Proxy(function () {}, {
  get: (t, k) => k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? [][Symbol.iterator] : k === 'then' ? undefined : fake,
  set: () => true, apply: () => fake, construct: () => fake
});
globalThis.document ??= { querySelector: () => fake, querySelectorAll: () => [], addEventListener() {}, createElement: () => fake, documentElement: fake, head: fake, body: fake };
globalThis.window ??= { addEventListener() {}, isSecureContext: false };
globalThis.location ??= { hash: '', origin: 'http://test' };
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} });
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
const { emptyState, errorState, loadingState } = await import('../web/js/ui/states.js');
const { iconButton } = await import('../web/js/ui/buttons.js');
const { tabsHtml } = await import('../web/js/ui/tabs.js');
const { card, cardItem, seasonCard, seasonItem, shelfHtml } = await import('../web/js/ui/cards.js');
const { fieldHtml } = await import('../web/js/ui/dialog.js');
const { cardActions } = await import('../web/js/ui/cardmenu.js');

const EVIL = '<img src=x onerror=alert(1)>"\'&';
const noRawTag = (html) => assert.ok(!html.includes('<img src=x'), 'otvättad HTML: ' + html);

test('emptyState: escapar rubrik, text och knapp; html släpps igenom', () => {
  const h = emptyState({ icon: '📁', title: EVIL, text: EVIL, action: { label: EVIL, href: '#/x"y' } });
  noRawTag(h);
  assert.match(h, /class="state empty"/);
  assert.match(h, /aria-hidden="true">📁/);
  assert.match(h, /href="#\/x&quot;y"/);
  assert.match(emptyState({ html: 'mappar som <code>A/B</code>' }), /<code>A\/B<\/code>/);
  assert.match(emptyState({ action: { label: 'Gör', id: 'go' } }), /<button type="button" class="primary" id="go">Gör<\/button>/);
});

test('errorState: ingen kontakt eller annat fel, role=alert, Försök igen', () => {
  const off = errorState(Object.assign(new Error('x'), { offline: true }), { retry: true });
  assert.match(off, /role="alert"/);
  assert.match(off, /Ingen kontakt med servern/);
  assert.match(off, /id="retry"[^>]*>Försök igen/);
  const other = errorState(new Error(EVIL));
  noRawTag(other);
  assert.match(other, /Något gick fel/);
  assert.doesNotMatch(other, /retry/);
});

test('loadingState: skelett med aria-busy och text för skärmläsare', () => {
  for (const kind of ['grid', 'shelves', 'list', 'detail', 'panels']) {
    const h = loadingState({ kind });
    assert.match(h, /role="status" aria-busy="true"/, kind);
    assert.match(h, /<span class="sr-only">Laddar…<\/span>/, kind);
    assert.match(h, /aria-hidden="true"/, kind);
  }
  assert.equal((loadingState({ kind: 'grid', count: 5 }).match(/sk-card/g) || []).length, 5);
  assert.match(loadingState({ kind: 'inline', label: 'Söker…' }), /sr-only">Söker…/);
});

test('iconButton: alltid aria-label och title, ikonen dold, escapade attribut', () => {
  const h = iconButton({ icon: '✕', label: `Ta bort ${EVIL}`, data: { del: '5"' }, pressed: true });
  noRawTag(h);
  assert.match(h, /aria-label="Ta bort &lt;img/);
  assert.match(h, /title="Ta bort &lt;img/);
  assert.match(h, /data-del="5&quot;"/);
  assert.match(h, /aria-pressed="true"/);
  assert.match(h, /<span aria-hidden="true">✕<\/span>/);
  assert.match(iconButton({ icon: 'play', label: 'Spela' }), /<svg[^>]*aria-hidden="true"/);
});

test('tabsHtml: tablist, en vald flik med tabindex 0, länk- och knappflikar', () => {
  const h = tabsHtml({ label: 'Säsonger', current: 2, panel: 'eps', items: [{ key: 1, label: 'Säsong 1' }, { key: 2, label: EVIL }] });
  noRawTag(h);
  assert.match(h, /role="tablist" aria-label="Säsonger"/);
  assert.equal((h.match(/aria-selected="true"/g) || []).length, 1);
  assert.match(h, /aria-selected="true" tabindex="0" data-tab-key="2" aria-controls="eps"/);
  assert.match(h, /aria-selected="false" tabindex="-1"/);
  assert.match(tabsHtml({ label: 'M', current: 'a', items: [{ key: 'a', label: 'A', href: '#/m/1/a' }] }), /<a role="tab"[^>]*href="#\/m\/1\/a">A<\/a>/);
});

test('card: ett namn för länken, menyknapp med aria-label och aria-haspopup, bild med mått', () => {
  const it = { id: 7, kind: 'movie', title: EVIL, year: 2020, poster: true, position: 600, duration: 1200, watched: false };
  const h = card(it);
  noRawTag(h);
  assert.match(h, /<a class="clink" href="#\/item\/7" aria-label="&lt;img[^"]*, 2020, 50 % sett">/);
  assert.match(h, /class="cmenu" data-cmenu="7" aria-haspopup="menu" aria-expanded="false" aria-label="Fler åtgärder för &lt;img/);
  // Bilden hämtas i kortets storlek (standardbredd 125 px × 1,2 → 160 px), inte i full storlek
  assert.match(h, /<img loading="(lazy|eager" fetchpriority="high)" decoding="async" src="\/api\/image\/7\/poster\?w=160" alt="" width="300" height="450"/);
  assert.match(card({ ...it, id: 10, kind: 'episode', thumb: true }, true), /src="\/api\/image\/10\/thumb\?w=240"/); // liggande: 1,9 kort
  assert.match(h, /class="bar" aria-hidden="true"/);
  assert.equal(cardItem(7), it);
  assert.doesNotMatch(card({ ...it, id: 8 }, false, { menu: false }), /cmenu/);
  const ep = card({ id: 9, kind: 'episode', title: 'Pilot', season: 1, episode: 2, show: 4, showTitle: 'Serien', watched: true }, true);
  assert.match(ep, /aria-label="Serien, S01E02 · Pilot, sedd"/);
});

test('card: Plex-rader under affischen, ▶ med namn, märke för osedda avsnitt', () => {
  const mv = card({ id: 21, kind: 'movie', title: 'Film', year: 2001, poster: true });
  assert.match(mv, /class="cplay" data-cplay="21" aria-label="Spela Film"/);
  assert.doesNotMatch(mv, /cedit/); // bara administratörer
  const ep = card({ id: 22, kind: 'episode', title: 'Pilot', season: 3, episode: 23, show: 4, showTitle: 'Serien', showPoster: true, position: 0 });
  assert.match(ep, /<div class="t">Serien<\/div><div class="s">Pilot<\/div><div class="s s2">S3 · A23<\/div>/);
  assert.match(ep, /src="\/api\/image\/4\/poster\?w=160"/);
  assert.match(ep, /href="#\/item\/4"/);
  const sh = card({ id: 23, kind: 'show', title: 'Serie', seasons: 3, episodes: 10, watchedEpisodes: 4 });
  assert.match(sh, /<div class="s">3 säsonger<\/div>/);
  assert.match(sh, /class="badge" aria-hidden="true">6</);
  assert.match(sh, /aria-label="Serie, 3 säsonger, 6 osedda avsnitt"/);
});

test('seasonCard: ett kort per säsong med nyaste avsnittet och antal nya', () => {
  const g = { show: 5, showTitle: EVIL, showPoster: true, season: 3, count: 4, unwatched: 3, latest: { id: 9, title: 'Finalen', season: 3, episode: 8 }, next: { id: 7, episode: 6, position: 0 } };
  const h = seasonCard(g);
  noRawTag(h);
  assert.match(h, /data-show="5" data-season="3"/);
  assert.match(h, /href="#\/item\/5\/3"/);
  assert.match(h, /<div class="s">Finalen<\/div><div class="s s2">S3 · A8<\/div>/);
  assert.match(h, /class="badge" aria-hidden="true">3</);
  assert.match(h, /data-cplay="7" data-pos="0"/);
  assert.match(h, /class="cmenu"[^>]*aria-label="Fler åtgärder för &lt;img/);
  assert.equal(seasonItem(5, 3), g);
  assert.match(seasonCard({ ...g, unwatched: 0, next: null, latest: null }), /class="seen"[^]*<div class="s">Säsong 3<\/div>/);
  assert.match(shelfHtml('Rad', '', { row: 'continue' }), /<h2>Rad<\/h2><div class="shelf" data-row="continue">/);
});

test('fieldHtml: PIN och lösenord får rätt typ, inputmode och autocomplete', () => {
  const pin = fieldHtml({ name: 'pin', label: 'PIN', type: 'pin', hint: 'Fyra siffror' }, 'f1');
  assert.match(pin, /<label for="f1">PIN<\/label>/);
  assert.match(pin, /type="password"/);
  assert.match(pin, /autocomplete="off"/);
  assert.match(pin, /inputmode="numeric"/);
  assert.match(pin, /aria-describedby="f1h"/);
  const pw = fieldHtml({ name: 'p', label: 'Lösenord', type: 'password', required: true, value: EVIL }, 'f2');
  noRawTag(pw);
  assert.match(pw, /autocomplete="current-password"/);
  assert.match(pw, / required/);
});

test('kortmenyn: valen följer titelns sort och användarens roll', () => {
  const el = { closest: () => ({ dataset: { row: 'continue' } }) };
  const labels = (it, st) => cardActions(it, st, el).filter(x => typeof x === 'object' && !x.hidden).map(x => x.label);
  const movie = { id: 1, kind: 'movie', title: 'Film', position: 600, duration: 3600, watched: false };
  const m = labels(movie, { inWatchlist: true });
  assert.ok(m.includes('Fortsätt från 10:00') && m.includes('Spela från början'));
  assert.ok(m.includes('Ta bort från Min lista') && m.includes('Ta bort från Fortsätt titta'));
  assert.ok(!m.some(l => /följa|Följ/.test(l)), 'filmer kan inte följas');
  assert.ok(!m.includes('Uppdatera metadata'), 'adminval bara för administratörer');
  const show = labels({ id: 4, kind: 'show', title: 'Serien', episodes: 2, watchedEpisodes: 0 }, { inWatchlist: false, following: true, next: { id: 5, season: 1, episode: 1, position: 0 } });
  assert.ok(show.includes('Spela S01E01') && show.includes('Sluta följa serien') && show.includes('Markera serien som sedd'));
  assert.ok(!show.includes('Ta bort från Fortsätt titta') && !show.includes('Titta tillsammans…'));
  const ep = labels({ id: 5, kind: 'episode', title: 'Pilot', season: 1, episode: 1, show: 4, position: 0 }, { inWatchlist: false, following: false });
  assert.ok(ep.includes('Markera säsong 1 som sedd') && ep.includes('Gå till serien') && ep.includes('Lägg serien i Min lista'));
});

test('card: medelfärg som platshållare och de första korten efter en navigering hämtas först', async () => {
  const { nextRoute } = await import('../web/js/core.js');
  nextRoute();
  const html = Array.from({ length: 12 }, (_, i) => card({ id: 100 + i, kind: 'movie', title: 'F' + i, poster: true, ph: '#1a2b3c' })).join('');
  assert.equal(html.match(/loading="eager" fetchpriority="high"/g).length, 8);
  assert.equal(html.match(/loading="lazy"/g).length, 4);
  assert.match(html, /<div class="ph c" aria-hidden="true" style="background:#1a2b3c">F0<\/div>/);
  // Ny navigering: åter de första åtta
  nextRoute();
  assert.match(card({ id: 120, kind: 'movie', title: 'X', poster: true }), /fetchpriority="high"/);
  // Ogiltig färg ignoreras (ingen HTML-injektion via fältet), och utan bild ingen färg
  const bad = card({ id: 121, kind: 'movie', title: 'Y', poster: true, ph: 'red;background:url(x)' });
  assert.doesNotMatch(bad, /class="ph c"/);
  assert.doesNotMatch(card({ id: 122, kind: 'movie', title: 'Z', poster: false, ph: '#1a2b3c' }), /class="ph c"/);
  // Stående avsnittskort med seriens affisch: seriens färg
  assert.match(card({ id: 123, kind: 'episode', title: 'A', show: 5, showTitle: 'S', showPoster: true, ph: '#000000', showPh: '#abcdef', season: 1, episode: 1 }), /background:#abcdef/);
  assert.match(seasonCard({ show: 6, showTitle: 'S', showPoster: true, showPh: '#123456', season: 1, count: 1, unwatched: 1 }), /background:#123456/);
});
