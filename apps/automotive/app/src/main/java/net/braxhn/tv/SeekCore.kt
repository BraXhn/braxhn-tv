package net.braxhn.tv

// Spolning i en omkodad ström, utan Android (testas på JVM i SeekCoreTest.kt). Spellistan har 6 s-segment, och servern
// måste koda hela segmentet med målet innan något kan visas (3–4,5 s för en 1080p-film). Spolar man utanför det som är
// buffrat startar spelaren i stället om strömmen vid målet (/playback med start= och prev=<förra strömmens pid>):
// servern ger korta segment där (1 s med processorn, 2 s med grafikkortet, som vid Fortsätt titta) och stoppar den
// gamla strömmen direkt. Samma regler som webbspelaren (seekRestart i web/js/player/hlsconfig.js) och Expo-appen
// (apps/expo/src/seekcore.ts). Spelaren och anropen: PlayerScreen.kt (SeekingPlayer, seekRestart).

object SeekCore {
    /** Ett segment i spellistan: start och längd i sekunder */
    data class Frag(val start: Double, val duration: Double)

    /**
     * Fjärrkontrollens snabbspolning (Google TV) och skärmens hoppknappar kommer i steg: omstarten väntar så här länge
     * på nästa tryck, så att fem tryck i rad blir en omstart vid det sista målet i stället för fem.
     */
    const val STEP_SETTLE_MS = 600L

    /** Segmentet som innehåller t, eller -1 */
    fun fragAt(frags: List<Frag>, t: Double): Int {
        if (!t.isFinite()) return -1
        return frags.indexOfFirst { f -> t >= f.start - 0.001 && t < f.start + f.duration }
    }

    /**
     * Ska spelaren starta om strömmen vid t i stället för att hämta segmentet? Nej när
     * - ingen bild har visats än i strömmen (spelarens egna hopp vid starten),
     * - t redan är buffrat (buffered = [start, slut] i sekunder),
     * - segmentet redan är kort (början av filen, efter en omstart eller Fortsätt titta),
     * - t är nära slutet (där ger servern inga korta segment),
     * - servern har segmentet klart eller kodar det just nu (ready = X-Seg-Ready, segmentet efter "till" kodas).
     */
    fun shouldRestart(buffered: List<Pair<Double, Double>>, t: Double, frags: List<Frag>, ready: IntRange?, started: Boolean): Boolean {
        if (!started || !t.isFinite() || frags.isEmpty()) return false
        if (buffered.any { (a, b) -> t >= a - 0.1 && t < b }) return false
        val n = fragAt(frags, t)
        if (n < 0) return false
        val last = frags.last()
        if (t > last.start + last.duration - 4) return false
        if (frags[n].duration <= 2.01) return false
        if (ready != null && n >= ready.first && n <= ready.last + 1) return false
        return true
    }

    /** X-Seg-Ready från servern ("12-20") → 12..20, annars null */
    fun readyRange(h: String?): IntRange? {
        val m = Regex("^(\\d+)-(\\d+)$").find(h?.trim() ?: return null) ?: return null
        val a = m.groupValues[1].toIntOrNull() ?: return null
        val b = m.groupValues[2].toIntOrNull() ?: return null
        return if (b >= a) a..b else null
    }

    /** pid i strömmens adress (just den här uppspelningen), eller null */
    fun pidOf(url: String?): String? = url?.let { u -> Regex("[?&]pid=([0-9a-f]{8})(?:&|$)").find(u)?.groupValues?.get(1) }

    /** Målet för fjärrkontrollens steg: från positionen (eller målet för en omstart som väntar), inom filmen */
    fun stepTarget(fromMs: Long, deltaMs: Long, durationMs: Long): Long {
        val t = fromMs + deltaMs
        return when {
            t < 0 -> 0
            durationMs > 0 && t > durationMs -> durationMs
            else -> t
        }
    }
}
