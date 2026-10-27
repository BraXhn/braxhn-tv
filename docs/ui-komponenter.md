# UI-komponenter i webbklienten

Webbklienten (`web/`) är ett SPA utan ramverk och utan byggsteg. Gemensamma gränssnittsbitar ligger i
`web/js/ui/` som små ES-moduler med vanliga funktioner: de flesta returnerar en **HTML-sträng** (som läggs
in med `innerHTML`/`insertAdjacentHTML`), några skapar element och kopplar händelser. Alla har JSDoc på svenska
i själva filen – den här sidan är översikten.

| Modul | Vad | Ersätter |
|---|---|---|
| `ui/dialog.js` | `openDialog`, `confirmDialog`, `promptDialog`, `formDialog`, `choiceDialog` | `document.createElement('dialog')`, `confirm()`, `prompt()`, `alert()` |
| `ui/states.js` | `emptyState`, `errorState` + `bindRetry`, `loadingState`, `noLib` | `<div class="empty">`, `<div class="spin">`, egna felrutor |
| `core.js` → `toast` | `toast(msg, { error, action, ms })`, `toastErr(e)` | `toast(e.message)` |
| `ui/buttons.js` | `iconButton`, `setIconButton` | knappar med bara ✕ ♥ ⏮ utan namn |
| `ui/tabs.js` | `tabsHtml`, `bindTabs` | `.tabs` med knappar/länkar utan roller |
| `ui/menu.js` | `openMenu`, `openPopover`, `closeMenu`, `contextMenu` | – (nytt) |
| `ui/cards.js` | `card`, `seasonCard`, `art`, `shelf`, `shelfHtml`, `colCard`, `personCard`, `cardItem` | – |
| `ui/shelves.js` | `initShelves`, `initCardSize` | – (‹ › på hyllor, piltangenter mellan kort, kortstorlek) |
| `ui/cardmenu.js` | `initCardMenus`, `openCardMenu`, `cardActions` | – (snabbåtgärder på korten) |
| `ui/activity.js` | `startActivity`, `stopActivity` | – (aktivitetsindikatorn för administratörer) |

Stilarna finns i `web/style.css` under *Komponenter* och använder designtokens i `:root`:
`--sp-1`…`--sp-6` (avstånd 4–40 px), `--r-sm`/`--r`/`--r-lg`/`--r-pill` (hörn), `--focus`, `--touch` (44 px),
`--shadow`, `--overlay`, `--dur` samt färgerna `--bg*`, `--line`, `--text`, `--dim`, `--accent`, `--ok`, `--err`, `--warn`.

## Beroenden och laddning

- `core.js` importerar ingenting. Komponenterna importerar bara `core.js` (och `ui/icons.js`), så de kan användas
  från alla vyer utan cirkulära importer. Undantag: `ui/cardmenu.js` och `ui/activity.js` hör ihop med appen
  (spelaren, routern, titelsidans dialoger) och kopplas därför först i `app.js` (`initCardMenus()`) respektive i
  `router.js` (`startActivity()` efter inloggning).
- Ny modul: lägg in den i `MODULES` i `web/sw.js` och höj `CACHE` (ett test kontrollerar listan).

## Dialoger – `ui/dialog.js`

```js
import { openDialog, confirmDialog, promptDialog, formDialog, choiceDialog } from '../ui/dialog.js';

// Bekräftelse – farliga åtgärder får danger: true (Avbryt får då fokus, så Enter tar inte bort något av misstag)
if (!await confirmDialog('Ta bort spellistan?', { okLabel: 'Ta bort', danger: true })) return;

// Ett fält. null = avbrutet, '' = tomt men OK
const pin = await promptDialog('PIN', { title: 'PIN för Barnen', type: 'pin', required: true, maxlength: 8 });

// Flera fält i samma dialog (t.ex. lösenord + engångskod)
const f = await formDialog({ title: 'Stäng av tvåstegsverifiering', okLabel: 'Stäng av', danger: true, fields: [
  { name: 'password', label: 'Ditt lösenord', type: 'password', required: true },
  { name: 'code', label: 'Kod från autentiseringsappen', inputmode: 'numeric', autocomplete: 'one-time-code', required: true }] });
if (!f) return;

// Ett av flera val
const any = await choiceDialog('Spela in serien', [{ label: 'Bara SVT1', value: false }, { label: 'Alla kanaler', value: true }]);

// Egen dialog. body är HTML – servertext ska ha gått genom esc()
const d = openDialog({
  title: `Skärmtid – ${p.name}`,            // rubriken escapas av openDialog
  body: `<p>${esc(text)}</p>`,
  size: 'wide',
  actions: [{ label: 'Stäng' },
    { label: 'Spara', kind: 'primary', onClick: async (h) => { await api(...); } }], // fel → toast, dialogen står kvar
  onClose: (value) => { if (value !== 'route') route(); }
});
d.$('#std').value;  // querySelector inom dialogen
await d.closed;      // uppfylls när dialogen stängts
```

Vad `openDialog` sköter:
- `<dialog>` med `aria-labelledby` (rubriken) och `aria-describedby` (innehållet), modal via `showModal()`.
- Fokus på första vettiga kontroll: `[autofocus]`, annars första fältet, annars första knapp som inte är farlig
  eller primär. Tab/Shift+Tab går runt inom dialogen.
- Escape stänger. Fokus går tillbaka till elementet som öppnade dialogen.
- Dialogen tas bort ur DOM när den stängs, och stängs när användaren navigerar (även med Bakåt på telefonen) –
  `onClose` får då värdet `'route'`. `closeOnRoute: false` för dialoger som hör till ljudspelaren.
- Åtgärdsknappar med `onClick` inaktiveras medan de kör, fel visas som toast. Returnerar `onClick` `false` står
  dialogen kvar (t.ex. "Kopiera").
- `form: true` lägger allt i ett `<form>`: Enter skickar och webbläsarens validering (`required`, `pattern`,
  `minlength`) stoppar tomma fält. Knappen med `submit: true` är den som körs.
- På telefon (≤ 600 px) visas dialogen som ett ark nerifrån med knapparna i tummens räckhåll.

Fälttyper i `formDialog`/`promptDialog`: `text`, `password` (autocomplete `current-password` om inget annat
anges – använd `new-password` när ett nytt lösenord sätts), `pin` (dolt sifferfält, `inputmode=numeric`,
autocomplete av), `number`, `url`, `textarea`. Alla fält får en riktig `<label for>` och ev. hjälptext via
`aria-describedby`.

## Tomt, fel och laddning – `ui/states.js`

```js
main.innerHTML = emptyState({ icon: '🔖', title: 'Min lista är tom', text: 'Lägg till filmer med ”+ Min lista”.',
  action: { label: 'Till startsidan', href: '#/' } });
box.innerHTML = errorState(err, { retry: true, compact: true }); bindRetry(box, load);
box.innerHTML = loadingState({ kind: 'inline', label: 'Söker…' });
```

När används vad:
- **loadingState** medan något hämtas. `router.js` visar redan ett skelett i rätt form för varje vy
  (`grid`, `shelves`, `list`, `detail`, `panels`) – vyerna behöver bara `inline` för delar som laddas efteråt
  (sökresultat, en panel, innehåll i en dialog). Skeletten har samma mått som innehållet (ingen hoppande sida)
  och animeras inte med *minska rörelse*. `aria-busy` och en dold text "Laddar…" för skärmläsare.
- **emptyState** när svaret kom men inte innehöll något. Säg *varför* och *vad man kan göra* (en länk till
  Administration, en hint om filnamn). `text` escapas; `html` är för egen, betrodd text med t.ex. `<code>`.
- **errorState** när anropet misslyckades. `err.offline` (satt av `api()` när servern inte svarar) ger
  "Ingen kontakt med servern", annars "Något gick fel" med felmeddelandet. `role="alert"`. Ge `retry` när ett
  nytt försök kan hjälpa och koppla med `bindRetry` (den flyttar även fokus till knappen).
- **toast** för kvittenser på något användaren just gjorde ("Sparat"), och för fel i en åtgärd där sidan i
  övrigt fungerar: `toastErr(e)` (ignorerar avbrutna anrop). Ångringsbara åtgärder får en knapp:
  `toast('Borttagen från Min lista', { action: { label: 'Ångra', onClick: undo } })`. Toasten är
  `role=status` (fel: `role=alert`), står kvar längre med en knapp och pausar när musen eller fokus är på den.

## Knappar med ikon – `ui/buttons.js`

```js
iconButton({ icon: '✕', label: `Ta bort ${t.title} ur listan`, data: { del: t.id } })
iconButton({ icon: t.favorite ? '♥' : '♡', label: `Favorit: ${t.title}`, data: { fav: t.id }, pressed: !!t.favorite })
iconButton({ icon: 'play', label: 'Spela' })   // namn i ICON ger SVG-ikonen
setIconButton(btn, 'pause', 'Pausa (mellanslag)') // byt ikon och namn
```

En knapp utan synlig text ska **alltid** ha `aria-label` – `iconButton` sätter den och `title` (verktygstips),
och döljer ikonen för skärmläsare. Växlingsknappar får `aria-pressed`. Knappar som öppnar något får
`haspopup: 'menu' | 'dialog'`. Alla SVG i `ICON` har `aria-hidden="true"`.

## Flikar – `ui/tabs.js`

```js
main.innerHTML = tabsHtml({ id: 'tabs', label: 'Säsonger', panel: 'eps', current: cur,
  items: seasons.map(s => ({ key: s, label: 'Säsong ' + s })) }) + '<div id="eps" role="tabpanel"></div>';
bindTabs($('#tabs'), (key) => { cur = +key; renderEps(); });
// Flikar som byter sida: ge href, bindTabs behövs inte
tabsHtml({ label: 'Musik', current: tab, items: [{ key: 'albums', label: 'Album', href: `#/music/${lid}/albums` }] })
```

`role=tablist/tab`, `aria-selected`, `aria-controls` och "roving tabindex": bara vald flik nås med Tab,
←/→/Home/End flyttar mellan flikarna (fungerar för alla fliklistor, även de som ritas om).

## Meny, popover och snabbmeny – `ui/menu.js`

```js
openMenu(knapp, [
  { icon: '▶', label: 'Spela', onSelect: () => play() },
  'separator',
  { label: 'Ta bort', danger: true, onSelect: del },
  { label: 'Visa information', href: '#/item/5' },
  { label: 'Mer', submenu: [...] },
  { label: 'Bara admin', hidden: !me.adminHere },
], { title: 'Filmens namn' });

openPopover(knapp, { label: 'Aktivitet', title: 'Aktivitet', html: '…' });   // eget innehåll
contextMenu(document, '.card[data-id]', (el, point) => openCardMenu(el, point));  // högerklick/långtryck/Menu-tangent
```

- `role=menu`/`menuitem`; ↑/↓/Home/End flyttar, Enter väljer, en bokstav hoppar till valet, Escape och Tab
  stänger. Fokus går tillbaka till knappen; `aria-expanded`/`aria-controls` sätts på den.
- Stängs vid klick utanför, skrollning, ändrad fönsterstorlek och navigering. Bara en meny är öppen åt gången.
- Placeras under knappen (eller vid muspekaren) och vänds uppåt/åt vänster så att den alltid får plats; lång
  meny skrollar. På telefon (≤ 600 px) blir den ett ark nerifrån med 44 px höga val.
- `contextMenu`: högerklick, Menu-tangenten och Shift+F10 (öppnar vid elementet) samt långtryck ~500 ms på
  pekskärm. Rör sig fingret mer än 10 px eller skrollar sidan blir det inget långtryck, och klicket efter ett
  långtryck öppnar inte länken.

## Kort och kortmeny – `ui/cards.js`, `ui/cardmenu.js`

`card(it, land, { menu })` ritar `<div class="card">` med en länk (ett enda namn för skärmläsare: titel,
undertitel och läge, t.ex. "Alfa Film, 2020, 40 % sett") och en `⋮`-knapp (`aria-label="Fler åtgärder för …"`,
`aria-haspopup="menu"`). Knappen syns vid hovring och fokus, alltid på pekskärm. Bilder laddas lat, har
`width`/`height` (ingen layoutförskjutning) och tas bort om de inte går att ladda så att färgplattan syns.

**Bildstorlek:** be aldrig om en serverbild i full storlek där den visas liten. `imgSrc(url, cssBredd)`,
`imgUrl(url, cssBredd)`, `heroUrl(url)` och `coverImg(url, klass)` i `core.js` lägger till `?w=` med en av
serverns fasta bredder (160–1280, `server/imgsize.js`) efter bredden × pixeltätheten (högst 2×). Kortens bredd
följer `--cw` via `cardW()`. Servern förstorar aldrig och skickar originalet om `w` saknas eller är ogiltigt.

Ovanpå bilden finns ▶ (`.cplay`, spelar direkt), ✎ (`.cedit`, bara administratörer) och ⋮ nere till höger; knapparna kopplas delegerat i `ui/cardmenu.js`. `seasonCard(g)` ritar ett säsongskort från `/api/home` (`rows[].seasons`) med en egen meny. Hyllor (`.section > h2 + .shelf`) får ‹ › automatiskt av `ui/shelves.js`, som också flyttar fokus mellan kort med piltangenterna; kortbredden styrs av `--card-w` (reglaget `#cardsize`).

Ange vilken rad korten ligger i med `data-row` (`continue`, `watchlist`, `foryou`) – `shelf(title, items, land, more, row)`
gör det. Kortmenyn visar då t.ex. "Ta bort från Fortsätt titta" och tar bort kortet ur Min lista-raden.

Menyns val (`cardActions`) beror på sorten och rollen: spela/fortsätt/från början, sedd/osedd (film, avsnitt,
serie, säsong), Min lista, lägg till i samling (`ui/collections.js`: `addToCollection(it)`, `collectionForm(col, item)`,
`deleteCollection(col)`), ta bort från samlingen (kort i en egen samling man får ändra: `data-ucol` + `data-edit` på rutnätet), betygsätt (`ui/rating.js`), ta bort från Fortsätt titta, följ serien, titta tillsammans, ladda ner, visa
information/gå till serien och för administratörer metadataverktygen. Läget som korten inte känner till hämtas
från `GET /api/items/:id/state`. Kortet uppdateras direkt och ångringsbara val får "Ångra" i toasten.

## Stjärnbetyg – `ui/rating.js`

`starsHtml(värde, { label, id, cls, readonly })` ritar fem stjärnor som ett reglage (`role="slider"`,
`aria-valuenow`/`aria-valuetext` "3,5 av 5 stjärnor"); fyllnaden per stjärna är `--f` (0/50/100 %). `bindStars(el,
onChange)` gör det styrbart: klick (vänstra halvan = halv stjärna, samma värde igen tar bort), ←/→ halva steg, 1–5,
0/Delete tar bort; misslyckas `onChange` visas det förra värdet. `rateDialog({ kind, id, title, value, onSaved })` är
dialogen från kortmenyn och låtarnas ⋮ (`kind` = `item`/`album`/`track`), `saveRating(kind, id, värde)` sparar och visar
en toast. Titelsidan tar dessutom emot 1–5 (0 tar bort) var som helst på sidan utom i fält, dialoger och spelaren.

## Aktivitet – `ui/activity.js`

Knapp i menyraden (bara `me.adminHere`) med en ring runt ikonen medan jobb pågår: fylls efter förloppet när
exakt ett jobb har ett känt förlopp, annars en roterande båge (stilla med *minska rörelse*), plus ett antal.
Panelen (popover, ark på telefon) grupperar `GET /api/jobs` per sort med förlopp och tid. Hämtar var 3:e sekund
när något pågår eller panelen är öppen, annars var 20:e; pausar när fliken är dold, aldrig mer än ett anrop i
luften, och slutar tyst vid 401/403/404.

## Riktlinjer

- **esc() på all servertext** som hamnar i HTML. Komponenterna escapar sina egna parametrar (rubriker,
  etiketter, `text`) – men `body` i `openDialog` och `html` i `emptyState` är HTML och ska byggas med `esc()`.
- **Inga inline-händelser** (`onclick="…"`) – CSP stoppar dem. Koppla i JavaScript efter att HTML:en lagts in,
  eller delegera.
- **Fokus**: flytta fokus bara när användaren gjort något (öppnat en dialog/meny) och lämna tillbaka det när det
  stängs. Ta bort-åtgärder flyttar fokus till nästa kort. Använd aldrig `outline: none` utan ersättning –
  `:focus-visible` ger den tydliga orangea ramen.
- **TV och fjärrkontroll**: allt ska gå att nå med Tab/piltangenter och Enter, och Escape/Bakåt ska stänga det
  som är öppet. Lägg inte viktiga åtgärder bara på hovring – kortens ⋮ nås med Tab och Menu-tangenten.
  Klickbara rader som inte är knappar kopplas med `keyClick()` i `core.js`.
- **Telefon**: minst 44 px stora mål (`--touch`) på pekskärm, dialoger och menyer som ark nerifrån, inget som
  gör sidan bredare än skärmen (kontrollera vid 375 px), och `env(safe-area-inset-*)` för installerad app.
- **Rörelse**: animationer bara under `prefers-reduced-motion: no-preference` (eller stängs av under `reduce`).
- **Svenska** i all text som användaren ser, och skriv vad som händer ("Ta bort", inte "OK") på knappar.

## Testa

- `test/ui-components.test.js` testar strängbyggarna (escapning, aria-attribut, kortmenyns val per sort och roll).
- `test/card-actions.test.js` testar `/api/items/:id/state` och `/api/items/:id/continue` mot en riktig server,
  även att barnprofiler inte kan nå titlar över åldersgränsen.
- Interaktion (tangentbord, fokus, ark på telefon) kontrolleras i en riktig webbläsare, t.ex. Playwright med
  Chromium mot en testserver med VP9/WebM-filer: öppna dialoger och menyer med bara tangentbordet, kontrollera
  att fokus kommer tillbaka, att inga knappar saknar namn och att sidan inte skrollar i sidled vid 375 px.
