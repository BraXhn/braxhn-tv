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
| `ui/cards.js` | `card`, `seasonCard`, `art`, `shelf`, `shelfHtml`, `colCard`, `personCard`, `cardItem`, `ebookCard`, `ebookCover` | – |
| `ui/shelves.js` | `initShelves`, `initCardSize` | – (‹ › på hyllor, kortstorlek) |
| `ui/spatial.js` | `move`, `focusFirst`, `firstIn`, `focusEl`, `reveal`, `scopeOf` | – (rumslig navigering med fjärrkontroll/piltangenter, laddas vid behov) |
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
  "Ingen kontakt med servern", `err.status === 404` (`api()` sätter `status`) ger "Hittades inte" med en
  begriplig förklaring och *Till startsidan* i stället för *Försök igen* (utom `compact`), annars "Något gick fel"
  med felmeddelandet (serverfel utan meddelande blir en mening, aldrig "Fel 502"). `role="alert"`. Ge `retry`
  när ett nytt försök kan hjälpa och koppla med `bindRetry` (den flyttar även fokus till knappen). Routern lägger
  en dold `h1` på felsidan.
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

Ovanpå bilden finns ▶ (`.cplay`, spelar direkt), ✎ (`.cedit`, bara administratörer) och ⋮ nere till höger; knapparna kopplas delegerat i `ui/cardmenu.js`. `seasonCard(g)` ritar ett säsongskort från `/api/home` (`rows[].seasons`) med en egen meny. Hyllor (`.section > h2 + .shelf`) får ‹ › automatiskt av `ui/shelves.js`; piltangenterna mellan korten sköts av den rumsliga navigeringen (`ui/spatial.js`, se nedan). Kortbredden styrs av `--card-w` (reglaget `#cardsize`, dolt i TV-läge).

Ange vilken rad korten ligger i med `data-row` (`continue`, `watchlist`, `foryou`) – `shelf(title, items, land, more, row)`
gör det. Kortmenyn visar då t.ex. "Ta bort från Fortsätt titta" och tar bort kortet ur Min lista-raden.

Menyns val (`cardActions`) beror på sorten och rollen: spela/fortsätt/från början, sedd/osedd (film, avsnitt,
serie, säsong), Min lista, lägg till i samling (`ui/collections.js`: `addToCollection(it)`, `collectionForm(col, item)`,
`deleteCollection(col)`), ta bort från samlingen (kort i en egen samling man får ändra: `data-ucol` + `data-edit` på rutnätet), betygsätt (`ui/rating.js`), ta bort från Fortsätt titta, följ serien, titta tillsammans, ladda ner, visa
information/gå till serien och för administratörer metadataverktygen. Läget som korten inte känner till hämtas
från `GET /api/items/:id/state`. Kortet uppdateras direkt och ångringsbara val får "Ångra" i toasten.

## Rumslig navigering och fjärrkontroll – `ui/spatial.js`

TV-webbläsare (Google TV, Fire TV, LG webOS, Samsung Tizen, webbappen i en TV-låda) har bara pilar, OK/Enter och
Bakåt. Pilarna väljer därför det närmaste fokuserbara elementet i pilens riktning utifrån `getBoundingClientRect`.

**När den är på:** alltid i *TV-läge* (`tvMode` i `core.js`: TV-webbläsarens User-Agent eller `?tv=1` i adressen, som
sparas – `?tv=0` tar bort; `html.tv`), och annars från första piltrycket när inget har fokus eller fokus står på ett
kort (`setSpatialOn()`, `html.kbnav`). Lyssnaren sitter i `router.js` på `window`, så den kommer efter alla lyssnare
på dokumentet. Modulen laddas i förväg i TV-läge (`idle`), annars vid första trycket – startmodulerna importerar
den aldrig.

**Så deltar en komponent:**
- **Egna piltangenter:** anropa `e.preventDefault()` när komponenten använder pilen (menyer, flikar, stjärnorna,
  TV-guidens rutnät, fotovisaren, kvällsvalet, karusellen på startsidan gör det). Då gör navigeringen ingenting.
  Använder komponenten inte pilen (t.ex. vid änden av en lista) – låt bli, så går fokus vidare rumsligt.
- **Textfält:** ← → flyttar markören och lämnar fältet bara vid kanten av texten; ↑ ↓ lämnar fältet (flerradiga
  fält vid första/sista raden). Reglage (`input[type=range]`, `role=slider`) och video behåller ← →; ett reglage
  vid sitt min/max släpper pilen vidare. Rullistor (`select`) navigeras som knappar – Enter öppnar dem.
- **Mål:** synliga, fokuserbara element som inte ligger i något `inert`. I ett `.card` är bara `.clink` ett mål;
  `data-nav-skip` tar bort ett element (och allt i det). Element med `tabindex="-1"` (roving tabindex i flikar,
  menyer och rutnät) är inga mål – bara det valda.
- **Område:** översta öppna `<dialog>` (fokusfällan gäller även pilarna), helskärmsspelaren (en öppen panel i den:
  inställningar, kapitel), annars hela sidan. Öppna menyer (`.pop`) sköter sina pilar själva.
- **Grupper:** i menyraden, sidomenyn, knapprader (`.row`, `.crow`, `.pbar`, `.tabs`) går pilen längs gruppen så länge
  det finns ett mål i samma rad/kolumn där. I en hylla (`.shelf` eller annan vågrät rullning) stannar ← → i hyllan;
  → vid slutet gör ingenting, ← vid början går vidare (sidomenyn).
- **Föredragen rad/kolumn:** följer med när man trycker flera gånger längs samma axel, och pilen åt motsatt håll går
  tillbaka till elementet man kom ifrån (ner och upp igen = samma kort).
- **Första fokus:** första piltrycket utan fokus och varje sidbyte med navigeringen på sätter fokus på `[data-tvfocus]`
  (Spela på titelsidan, albumet, artisten), annars första hyllans första kort, första kortet eller det första som syns.
  Bakåt till en lista ger fokus på kortet man öppnade (per historikpost, `history.state.bxi` i `router.js`).
- **Rullning:** fokus hamnar aldrig utanför skärmen. Hyllan och dialogens innehåll rullar så att målet syns med lite
  marginal, och sidan så att målet ligger innanför menyraden och de fasta raderna i nederkant (TV: mitt på skärmen).
  Finns inget mål upp/ner rullar sidan 40 % (text längre ner går att läsa).
- **Prestanda:** varje tryck mäter bara ±120 fokuserbara element runt det fokuserade i dokumentordning plus de fasta
  delarna (`#top`, `#rail`, `#tabbar`, `#mbar`, `#rbar`, mini-spelaren) – aldrig tusentals kort. Hittas inget där provas
  hela området en gång. `test/web-spatial.test.js` räknar mätningarna med 3000 kort.

**Bakåt:** Escape, Backspace utanför textfält (med navigeringen på), `GoBack`/`BrowserBack`/`Back`/`XF86Back` och
keyCode 10009 (Samsung) och 461 (LG) – `isBackKey()` i `core.js`. TV-plattformarnas Bakåt skickas vidare som en Escape dit
fokus är, så att varje komponent bara behöver hantera Escape. Ordningen: dialog/meny/panel stängs → helskärmsspelaren
blir litet fönster (eller live-TV stängs) → förra sidan i appen (`goBack()` i `router.js`; på startsidan händer inget,
från en djuplänk går Bakåt till startsidan). En komponent som stänger något med Escape ska anropa `preventDefault()`
(annars kan sidan bytas samtidigt); det som räknas som "öppet" när tangenten trycks (`dialog[open]`, `.pop`,
helskärmsspelaren, användarmenyn, helskärm) hindrar alltid sidbytet.

**Spelaren** (`player/controls.js`): när kontrollerna syns och en knapp i spelaren har synligt fokus flyttar pilarna
fokus rumsligt (kontrollraden, tidslinjen, *Hoppa över*, panelerna). Var kontrollerna dolda när tangenten trycktes
(`P.keyHidden`) spolar ← → (och fokus hamnar på tidslinjen, där ← → fortsätter spola) och ↑ ↓ ändrar volymen utan att
visa kontrollerna. Utan fokus i spelaren (eller efter ett musklick) spolar pilarna som förut. **Mediaknapparna**
(`mediaKey()` i `core.js`: `MediaPlayPause`, `MediaPlay`, `MediaPause`, `MediaStop`, `MediaFastForward`, `MediaRewind`,
`MediaTrackNext`, `MediaTrackPrevious` och TV-plattformarnas keyCode) styr videospelaren – även i litet fönster – och
annars ljudspelaren (`audio.js`).

**Fokusmarkering i TV-läge** (`html.tv` i `style.css`): 4 px ram med glorian runt kortet och kortet 6 % större (utan
förstoring med *minska rörelse*), tydligare ram på spelarens knappar och menyval. Hyllorna har plats för det och
fäster inte vid korten (`scroll-snap` av när navigeringen är på).

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

## Tillgänglighet (WCAG 2.2 AA)

Målet är att hela appen ska gå att använda med bara tangentbord, fjärrkontroll eller skärmläsare. `test/web-a11y.test.js`
kör granskningsskriptet `test/helpers/a11y-audit.js` över alla vyer (lägg till nya vyer i `VIEWS` där) vid 375 och
1280 px och i TV-läge, och provar tangentbordsflödena. Det ska vara grönt.

- **Sidan:** varje vy får en `h1` (finns ingen synlig lägger `router.js` en dold med menyradens namn) och fliken får
  titeln "Sida – BraXhn TV". Rubriknivåerna hoppar inte (h1 → h2 → h3; dölj en rubrik med `.sr-only` hellre än att
  hoppa över en nivå). Efter ett sidbyte flyttas fokus till rubriken. *Hoppa till innehållet* är första tabbstoppet.
- **Namn:** varje fält har en `<label for>` (eller ligger i sin `<label>`), annars `aria-label`. Knappar med bara en
  ikon via `iconButton`. Ett `aria-label` ska innehålla den synliga texten (2.5.3). Placeholder är ingen etikett.
- **Reglage:** egna reglage får `role="slider"`, `tabindex="0"`, `aria-valuemin/max/now` och `aria-valuetext` i ord
  ("12:30 av 1:45:00", "3,5 av 5 stjärnor", "50 %") och styrs med ←/→, Home/End, Page Up/Down.
- **aria:** varje `aria-labelledby/-describedby/-controls` pekar på ett id som finns; roller med obligatoriska föräldrar
  (`tab` i `tablist`, `menuitem` i `menu`, `gridcell` i `row`) och attribut (`aria-checked`, `aria-valuenow`) får dem.
  Aldrig `tabindex` > 0. Inget fokuserbart inuti `aria-hidden` – använd `inert` för det som ligger bakom något modalt.
- **Live-regioner sparsamt:** `toast` (`role=status`, fel `role=alert`), laddning (`aria-busy` och skelettets dolda
  "Laddar…") och spelarens läge (`say(el, text)` i `player/controls.js` – bara efter något användaren gjort eller när
  laddningen dröjer). Lägg inte `aria-live` på text som ändras hela tiden (tid, undertexter).
- **Modalt:** dialoger via `openDialog` (fokusfälla, Escape, fokus tillbaka). Helskärmsspelaren gör `#top`, `#rail`,
  `#main` och `#tabbar` inerta och lämnar fokus på knappen som startade den. Menyer lämnar fokus där det var.
- **Kontrast:** text minst 4,5:1 (stor text 3:1) mot sin bakgrund – dämpa inte text med `opacity` (TV-guidens äldre
  program använder `--dim` i stället). Fokusmarkeringen syns mot alla bakgrunder (`:focus-visible`, 3 px).
- **Klickytor:** minst 24 × 24 px (2.5.8), på pekskärm 44 px (`--touch`).
- **Textstorlek:** `font-size` alltid i `rem` (eller `em`), aldrig i px – *Mitt konto → Tillgänglighet* skalar `html`
  100–200 % (`web/start.js` sätter det före första ritningen, `html.bigtext` från 130 %). Inget får klippas vid 200 %
  (fasta höjder på textlådor, `overflow:hidden` utan `text-overflow`); testet kontrollerar det.
- **Rörelse och kontrast:** animationer bara utan `prefers-reduced-motion`/`html.reduce-motion` (JS: kontrollera båda,
  se `ui/shelves.js`). `prefers-contrast: more`/`html.more-contrast` höjer `--dim`, `--line` och fokusramen.
  Under `forced-colors: active` försvinner skuggor och bakgrundsfärger: markera val och förlopp med `outline` eller
  systemfärger (`Highlight`, `ButtonText`), aldrig bara med `box-shadow`/bakgrund.
- **Undertexter:** utseendet styrs av användaren (`player/comfort.js`: storlek, typsnitt, färg, kantlinje, bakgrund
  och färg, placering) – rita undertextytor med CSS-variablerna `--subcolor`, `--subbg`, `--subshadow`, `--subfont`.

## Språk – `t()` i `core.js`

Webben finns på svenska (standard och källspråk) och engelska. All text som användaren ser eller hör – rubriker,
knappar, `aria-label`/`title`/`placeholder`, toasts, dialoger, tomma lägen och fel från klienten – går genom `t()`:

```js
import { t, tn, locale } from '../core.js';
toast(t('Sparat'));
main.innerHTML = `<h2>${t('Mitt konto – {name}', { name: esc(me.name) })}</h2>`;
const n = tn(count, '{n} titel', '{n} titlar');          // plural efter Intl.PluralRules för valt språk
new Date(s * 1000).toLocaleDateString(locale, { … });  // datum, tid och tal med vald locale (fmtDate, fmtDay, hhmm …)
```

- **Nyckeln är den svenska texten.** Utan engelsk rad i `web/i18n/en.js` visas svenskan. Lägg till raden där för
  varje ny text (testet kräver det för text med å/ä/ö). Hela meningar, inte ord för ord: `t('Visa {n} titlar', { n })`
  i stället för `t('Visa') + n + t('titlar')`.
- **Variabler** skrivs `{namn}` och fylls i ett varv (värdena tolkas inte igen). I HTML-mallar är texten HTML: escapa
  värdena med `esc()` som förut, och behåll taggarna (`<b>`, `<a href="…">`) i översättningen.
- Komponenterna (`openDialog`, `emptyState`, `iconButton` …) tar emot färdig text – anroparen översätter:
  `confirmDialog(t('Ta bort profilen?'), { okLabel: t('Ta bort') })`.
- Jämför aldrig med svensk text (`textContent === 'Pausad'`, `/^Idag/`) – jämför med `t('…')` eller med data.
- `t()` fungerar även på modulnivå (tabeller med etiketter): katalogen läses in före modulerna och språkbyte laddar
  om sidan (`setLang` i `core.js`). Språket väljs per profil i *Mitt konto → Språk* och sparas på servern.
- Serverns felmeddelanden är svenska; `api()` översätter dem med samma katalog (de vanligaste finns sist i `en.js`).
  Fasta etiketter från servern översätts där de visas (`t(label)`); text med variabler som servern bygger
  (säkerhetskontrollen, mappförslagen i installationen) skriver servern på profilens språk (`c.user.lang`).
  Innehåll som ska vara orört (serverloggen, fritext i säkerhetsloggen) märks `translate="no"`.

## Riktlinjer

- **esc() på all servertext** som hamnar i HTML. Komponenterna escapar sina egna parametrar (rubriker,
  etiketter, `text`) – men `body` i `openDialog` och `html` i `emptyState` är HTML och ska byggas med `esc()`.
- **Inga inline-händelser** (`onclick="…"`) – CSP stoppar dem. Koppla i JavaScript efter att HTML:en lagts in,
  eller delegera.
- **Fokus**: flytta fokus bara när användaren gjort något (öppnat en dialog/meny) och lämna tillbaka det när det
  stängs. Ta bort-åtgärder flyttar fokus till nästa kort. Använd aldrig `outline: none` utan ersättning –
  `:focus-visible` ger den tydliga orangea ramen.
- **TV och fjärrkontroll**: allt ska gå att nå med bara piltangenter och Enter (TV-webbläsare har sällan Tab), och
  Escape/Bakåt ska stänga det som är öppet – se *Rumslig navigering*. Lägg inte viktiga åtgärder bara på hovring –
  kortens ⋮ nås med Tab och Menu-tangenten, och allt i kortmenyn finns även på titelsidan.
  Klickbara rader som inte är knappar kopplas med `keyClick()` i `core.js`.
- **Typografi och avstånd**: `.small` är bara en textstorlek – inre luft får bara knappar (`button.small`,
  `.btn.small`), så liten text ligger i linje med rubriken ovanför. Länkar som knappar har samma klasser som
  knapparna bredvid (`btn ghost` bredvid `button.ghost`). Kortens titel får två rader (`line-clamp`), raderna under
  en. Tal med decimaler genom `fmtNum`/`fmtRating`/`fmtSize` (svenska: 7,4 och 1,5 GB), aldrig `toFixed()` i text.
  Ikoner i spelarnas knappar från `ICON` (SVG), inte tecken som ⏸ ⏮ – de ritas olika i olika typsnitt.
- **TV-läge på stor skärm** (`html.tv`, minst 1600 px): texten är 125 % (Mitt konto → Textstorlek går före) och
  korten 175 px breda (`--cw`, fast värde eftersom `cardW()` läser det som ett tal). Kontrollera TV-vyer vid 1920 × 1080.
- **Ingen layoutförskjutning**: animera aldrig något som flyttar sidan när den visas första gången (sidomenyns
  övergång gäller bara under `html.rail-anim`, som ☰ sätter en kort stund). Bilder har `width`/`height`.
- **Telefon**: minst 44 px stora mål (`--touch`) på pekskärm, dialoger och menyer som ark nerifrån, inget som
  gör sidan bredare än skärmen (kontrollera vid 375 px), och `env(safe-area-inset-*)` för installerad app.
- **Rörelse**: animationer bara under `prefers-reduced-motion: no-preference` (eller stängs av under `reduce`).
- **Svenska som källa** i all text som användaren ser, alltid genom `t()` (se *Språk*), och skriv vad som händer
  ("Ta bort", inte "OK") på knappar.

## Testa

- `test/web-a11y.test.js` granskar alla vyer och tangentbordsflödena (se *Tillgänglighet* ovan).
- `test/web-spatial.test.js` styr appen i TV-läge med bara pilar, Enter och Escape/Bakåt (startsidan → titelsidan →
  spelaren → litet fönster → tillbaka till samma kort, sökfältet, dialogens fokusfälla, 3000 kort).
- `test/web-i18n.test.js` kontrollerar katalogen och letar svensk text i alla vyer på engelska (och kör granskningen där).
- `test/web-quality.test.js` kontrollerar färgernas kontrast i `style.css`, att `.small` inte ger text inre luft,
  och i webbläsaren (375/1280 px och TV-läge) ingen vågrät rullning, bilder med mått, layoutförskjutning under 0,02 på
  startsidan och i biblioteket, tvåradiga korttitlar, 404-läget och TV-lägets storlek.
- `test/ui-components.test.js` testar strängbyggarna (escapning, aria-attribut, kortmenyns val per sort och roll).
- `test/card-actions.test.js` testar `/api/items/:id/state` och `/api/items/:id/continue` mot en riktig server,
  även att barnprofiler inte kan nå titlar över åldersgränsen.
- Interaktion (tangentbord, fokus, ark på telefon) kontrolleras i en riktig webbläsare, t.ex. Playwright med
  Chromium mot en testserver med VP9/WebM-filer: öppna dialoger och menyer med bara tangentbordet, kontrollera
  att fokus kommer tillbaka, att inga knappar saknar namn och att sidan inte skrollar i sidled vid 375 px.
