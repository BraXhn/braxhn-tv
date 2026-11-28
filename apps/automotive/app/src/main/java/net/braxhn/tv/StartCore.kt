package net.braxhn.tv

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch

// Snabbare start, utan Android (testas på JVM i StartCoreTest.kt). Två saker som webben gör (warmPlay och earlyPlayback i
// web/js/player/video.js):
// 1. Förvärmning: när fokus har stått en stund på Spela (Google TV) skickas /playback?warm=1 med exakt samma fråga som
//    uppspelningen sedan skickar. Servern startar strömmen men räknar inget som uppspelning, och tar över den bara när
//    den riktiga frågan ger samma ström (warmSig i server/routes/playback.js) – annat ljudspår, annan kvalitet eller
//    en annan adress (hemadressen eller reläet) ger en ny ström, aldrig fel ström.
// 2. /playback skickas samtidigt som titelns uppgifter (/api/items/:id) i stället för efter. Frågan behöver ingenting
//    ur titelns svar: ljudspår och bildundertext kommer från valet på titelsidan (Screen.Play), textundertexter skickas
//    aldrig till servern (spelaren väljer dem själv) och bio-läget (cinema=1) avgör servern efter kontots val och
//    titelns typ (bara filmer från början får trailers).
// Kopplas i Start.kt (anropen) och PlayerScreen.kt.

object StartCore {
    /**
     * Så länge fokus ska stå kvar på en Spela-knapp innan strömmen förvärms. Med fjärrkontrollen rör man sig förbi
     * knappar och avsnitt i snabb följd – de ska inte starta en ström var (servern har bara en förvärmd per profil).
     */
    const val DWELL_MS = 700L

    /** Samma fråga förvärms högst så här ofta (som webben) – servern håller en förvärmd ström i 20 s */
    const val REPEAT_MS = 15_000L

    /**
     * Uppspelningens egna delar av frågan till /playback, utöver förmågorna (Api.capabilities) och nattläge/dialog:
     * bio-läge vid start från början (inte vid omstart mitt i, skipPreroll) och startpositionen (hela sekunder).
     */
    fun playExtras(start: Double, skipPreroll: Boolean): Map<String, String?> = mapOf(
        "cinema" to (if (!skipPreroll && start < 1) "1" else null),
        "start" to (if (start >= 1) start.toLong().toString() else null)
    )

    /** Förvärmningens fråga: uppspelningens fråga plus warm=1 (inget annat får skilja, då passar strömmen inte) */
    fun warmQuery(play: Map<String, String?>): Map<String, String?> = play + ("warm" to "1")

    /** Nyckeln som förvärmningen känns igen på: titeln och hela frågan (null-värden skickas inte) */
    fun key(id: Int, query: Map<String, String?>): String =
        "$id?" + query.filterValues { it != null }.toSortedMap().entries.joinToString("&") { (k, v) -> "$k=$v" }

    /** Vilka frågor som förvärmts och när: samma fråga högst var REPEAT_MS */
    class WarmLog(private val repeatMs: Long = REPEAT_MS) {
        private val at = HashMap<String, Long>()

        /** true = förvärm nu (och kom ihåg det) */
        @Synchronized fun take(key: String, now: Long): Boolean {
            val last = at[key]
            if (last != null && now - last < repeatMs) return false
            if (at.size > 100) at.clear()
            at[key] = now
            return true
        }
    }

    /**
     * Titelns uppgifter och /playback samtidigt. playback startas i scope (appens livslånga scope), så att strömmen
     * kan stoppas även om spelaren stängs medan frågorna pågår: blev svaret aldrig använt (titeln gick inte att hämta,
     * spelaren stängdes) får drop det när det kommer. Fel i item eller playback kastas som förut.
     */
    suspend fun <I, P> together(scope: CoroutineScope, item: suspend () -> I, playback: suspend () -> P, drop: suspend (P) -> Unit): Pair<I, P> {
        val pb = scope.async { playback() }
        var used = false
        try {
            val it = item()
            val p = pb.await()
            used = true
            return it to p
        } finally {
            if (!used) scope.launch { runCatching { pb.await() }.getOrNull()?.let { p -> runCatching { drop(p) } } }
        }
    }
}
