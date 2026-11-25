// Musikkön sparas per profil på servern (server/musicqueue.js) och visas i minispelaren när en sida öppnas.
// Webbtester som delar konto ska därför börja utan förra testets kö – annars kan minispelaren täcka rader eller
// knappar, och resultatet beror på i vilken ordning testerna körs.

/**
 * Tömmer kontots sparade musikkö (DELETE /api/me/queue). req = testfilens anropsfunktion (sökväg, { method }) som
 * svarar { status } och är inloggad som samma konto (eller profil) som sidan.
 */
export async function clearMusicQueue(req) {
  const r = await req('/api/me/queue', { method: 'DELETE' });
  if (r.status !== 200) throw new Error(`kunde inte tömma musikkön (HTTP ${r.status})`);
}
