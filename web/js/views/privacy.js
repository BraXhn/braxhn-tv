// Vy: Integritet (#/privacy) – vad servern sparar om dig och hur länge, vilka externa tjänster den här servern
// använder, vem som ansvarar och dina rättigheter (GDPR). Ladda ner mina uppgifter (/api/me/export) och
// Radera mitt konto (DELETE /api/me, bara vanliga huvudkonton).
// @lazy – laddas vid behov (LAZY i js/router.js), förladdas inte från index.html (server/http/static.js)
import { $, api, esc, main, me, routeGen, toast, toastErr, views, t, tn } from '../core.js';
import { confirmDialog, promptDialog } from '../ui/dialog.js';
import { errorState, bindRetry } from '../ui/states.js';

const badge = (on) => on ? `<span class="ok-badge">${t('På')}</span>` : `<span class="muted small">${t('Av')}</span>`;
const days = (n) => n ? tn(n, '{n} dag', '{n} dagar') : t('för alltid');

views.privacy = async () => {
  if (!me) { location.hash = '#/login'; return; }
  const g = routeGen;
  let P;
  try { P = await api('/privacy'); } catch (e) { if (g !== routeGen || e?.aborted) return; main.innerHTML = errorState(e, { retry: true }); bindRetry(main, () => views.privacy()); return; }
  if (g !== routeGen) return;
  const S = P.services, R = P.retention;
  const svc = [
    [S.tmdb, 'TMDB', t('Bilder, beskrivningar och skådespelare till filmer och serier. Servern skickar titel och år – aldrig vem som tittar.')],
    [S.fanart, 'fanart.tv', t('Extra bilder (logotyper och bakgrunder) till titlar i biblioteket.')],
    [S.musicMeta, 'MusicBrainz, Wikidata, LRCLIB', t('Information om artister och album samt låttexter. Servern skickar artist, album och låt.')],
    [S.bookMeta, 'Open Library, Google Books, Audible (Audnexus)', t('Omslag och beskrivningar till böcker och ljudböcker. Servern skickar titel, författare eller ISBN.')],
    [S.updateCheck, 'GitHub', t('Högst en gång per dygn: finns det en ny version? Servern skickar bara sin version.')],
    [!!S.notify, S.notify ? t('Notiser ({kind})', { kind: esc(S.notify) }) : t('Notiser'), t('Händelser som administratören valt (t.ex. nya titlar) skickas till notistjänsten.')],
    [S.relay, 'BraXhn Relay', t('Fjärråtkomst: trafiken utifrån går krypterad genom reläet till servern. Reläet sparar inte vad du tittar på.')],
    [S.acme, "Let's Encrypt", t('Certifikat för https. Bara serverns domännamn skickas.')],
    [S.scrobble, t('Scrobbling (ditt konto)'), t('Det du lyssnar på skickas till Last.fm eller ListenBrainz – bara om du själv kopplat ett konto under Mitt konto.')]
  ];
  main.innerHTML = `<section class="privacy"><h1>${t('Integritet')}</h1>
  <div class="panel"><h2>${t('Vem ansvarar?')}</h2>
    <p>${t('BraXhn TV körs på en egen server hemma hos den som bjudit in dig. Det är den personen som ansvarar för uppgifterna – inte utvecklarna av BraXhn TV, som aldrig får någon information från servern.')}</p>
    <p>${P.contact ? t('Kontakt för frågor om dina uppgifter: {c}', { c: `<b>${esc(P.contact)}</b>` }) : t('Frågor om dina uppgifter ställer du till serverns administratör.')}</p></div>
  <div class="panel"><h2>${t('Vad servern sparar')}</h2>
    <ul>
      <li>${t('<b>Kontot:</b> namn, lösenord (bara som ett hash-värde), e-post om den angetts, inställningar och profiler.')}</li>
      <li>${t('<b>Tittande och lyssnande:</b> var du är i filmer, avsnitt, böcker och musik, betyg, listor och favoriter – så att du kan fortsätta där du var.')}</li>
      <li>${t('<b>Historik:</b> vad som spelats, när och på vilken enhet. Sparas {d}. IP-adressen i historiken tas bort efter {ip}.', { d: days(R.historyDays), ip: days(R.ipDays) })}</li>
      <li>${t('<b>Inloggade enheter:</b> enhetstyp och IP-adress för varje inloggning, tills du loggar ut eller inloggningen går ut.')}</li>
      <li>${t('<b>Säkerhetsloggen:</b> inloggningar, misslyckade försök och ändringar, med IP-adress. Sparas {d} för att upptäcka intrång.', { d: days(R.auditDays) })}</li>
    </ul>
    <p class="muted small">${t('Inget säljs, ingen reklam och ingen spårning. Webbläsaren sparar bara det som behövs för inloggningen och dina val (t.ex. språk och volym) – inga kakor från tredje part.')}</p></div>
  <div class="panel"><h2>${t('Externa tjänster på den här servern')}</h2>
    <p class="muted small">${t('Servern hämtar information från de här tjänsterna. De ser serverns IP-adress, inte din.')}</p>
    <table>${svc.map(([on, name, why]) => `<tr><td><b>${esc(name)}</b><div class="muted small">${why}</div></td><td class="r">${badge(on)}</td></tr>`).join('')}</table>
    <p class="muted small">${t('Bilder från TMDB, även affischer i sökningar och tjänsternas logotyper, hämtas via servern. Enda undantaget: i Chrome laddar webbläsaren Googles Cast-bibliotek när du öppnar spelaren, så att du kan casta – då ser Google din IP-adress.')}</p></div>
  <div class="panel"><h2>${t('Dina rättigheter')}</h2>
    <p>${t('Du har rätt att få veta vad som sparats om dig, få en kopia, få fel rättade och få dina uppgifter raderade. Mycket kan du göra själv här:')}</p>
    <div class="row" style="flex-wrap:wrap;gap:8px">
      <a class="btn primary" href="/api/me/export" download id="pexport">${t('Ladda ner mina uppgifter')}</a>
      <a class="btn ghost" href="#/history">${t('Min historik')}</a>
      <a class="btn ghost" href="#/account">${t('Mitt konto')}</a>
      ${P.canDeleteSelf ? `<button class="danger" id="pdelete">${t('Radera mitt konto')}</button>` : ''}
    </div>
    <p class="muted small">${t('Filen (JSON) innehåller allt servern sparat om kontot och dess profiler – utan lösenord, PIN-koder och nycklar.')}
    ${P.canDeleteSelf ? '' : t('Kontot tas bort av {who}.', { who: me.is_admin ? t('en annan administratör') : t('huvudkontot under Profiler i hushållet') })}</p></div>
  <p class="muted small">${t('Den här produkten använder TMDB:s API men är inte godkänd eller certifierad av TMDB.')}</p>
  </section>`;
  $('#pexport').onclick = () => toast(t('Hämtar dina uppgifter …'));
  if ($('#pdelete')) $('#pdelete').onclick = async () => {
    if (!await confirmDialog(t('Kontot, alla profiler, historik, listor och inställningar raderas för gott. Det går inte att ångra.'), { title: t('Radera mitt konto?'), okLabel: t('Fortsätt'), danger: true })) return;
    const v = P.hasPassword
      ? await promptDialog(t('Lösenord'), { title: t('Bekräfta med ditt lösenord'), type: 'password', okLabel: t('Radera kontot') })
      : await promptDialog(t('Kontots namn'), { title: t('Skriv kontots namn för att bekräfta'), okLabel: t('Radera kontot') });
    if (v == null) return;
    try {
      await api('/me', { method: 'DELETE', body: P.hasPassword ? { password: v } : { confirm: v } });
      toast(t('Kontot är raderat'));
      setTimeout(() => location.replace('/'), 800);
    } catch (e) { toastErr(e); }
  };
};
