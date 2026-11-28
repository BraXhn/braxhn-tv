package net.braxhn.tv

import kotlinx.coroutines.withTimeoutOrNull
import java.io.InputStream

// Uppkopplingen utanför hemmet (bw till /playback), utan Android – testas på JVM i BwCoreTest.kt. Samma regler som
// webben (web/js/player/caps.js) och Expo-appen (apps/expo/src/bwcore.ts).
//
// Servern väljer startsteget efter bw (kbit/s): den listar steget som ryms först, förstartar det och kodar om en
// remux eller direktuppspelning som inte ryms i nätet (server/routes/playback.js). Utan bw gäller serverns gissning.
// Hemma bryr sig servern inte om bw, så appen mäter bara utanför hemmet.
//
// - Mätningen: 4 MB från /api/speedtest, högst 1 s. Takten räknas på det som kommer efter första tredjedelen
//   (svarstid och TCP:s långsamma början hör inte till uppkopplingens takt).
// - En mätning gäller i 10 minuter. ExoPlayers egen mätning på riktiga segment (DefaultBandwidthMeter) håller den
//   färsk under uppspelningen. Byts nätet glöms den.
// - Förvärmningen och uppspelningen måste skicka samma bw, annars tar servern inte över den förvärmda strömmen (sbw
//   ingår i strömmens fråga). Därför minns appen vilket bw som förvärmdes för en titel och position (Pairs).
object BwCore {
    const val SAMPLE_KB = 4096
    const val SAMPLE_MS = 1000L
    /** Så länge gäller en mätning */
    const val FRESH_MS = 10 * 60_000L
    /** Så länge väntar uppspelningen högst på en mätning som pågår (som webben) */
    const val WAIT_MS = 1500L
    /** Så länge använder uppspelningen samma bw som förvärmningen (servern håller en förvärmd ström i 20 s) */
    const val PAIR_MS = 30_000L
    /** ExoPlayers mätning används först när en hämtning varit så här stor (små svar säger inget om takten) */
    const val MIN_PLAYER_BYTES = 128 * 1024L

    /**
     * Är appen utanför hemmet? Nej när den sparade adressen redan är en hemadress, när hemadressen används (Hemma.kt)
     * och när servern säger att förfrågan kommer från hemnätet (here i /api/local). Okänt (gammal server, inget svar
     * än) räknas som utanför när adressen är publik.
     */
    fun away(savedIsLocal: Boolean, viaHome: Boolean, here: Boolean?): Boolean = !savedIsLocal && !viaHome && here != true

    /**
     * Takten (kbit/s) ur märken [ms, byte hittills]. Det första märket är när svaret började komma. Räknas från första
     * tredjedelen av datan; kom allt i en eller två bitar räknas hela provet.
     */
    fun rateOf(marks: List<Pair<Long, Long>>): Int {
        if (marks.size < 2) return 0
        val last = marks.last()
        val total = last.second
        val from = marks.firstOrNull { it.second * 3 >= total } ?: marks.first()
        val a = if (last.first - from.first >= 20 && last.second > from.second) from else marks.first()
        val ms = maxOf(1L, last.first - a.first)
        val bytes = maxOf(0L, last.second - a.second)
        return if (bytes > 0) (bytes * 8 / ms).toInt() else 0 // byte/ms × 8 = kbit/s
    }

    /** Läser provet (svaret från /api/speedtest) i högst maxMs och ger takten i kbit/s. now = klockan i ms. */
    fun sample(input: InputStream, now: () -> Long, maxMs: Long = SAMPLE_MS, bufSize: Int = 16 * 1024): Int {
        val marks = arrayListOf(now() to 0L)
        val buf = ByteArray(bufSize)
        var got = 0L
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            got += n
            val t = now()
            marks += t to got
            if (t - marks[0].first > maxMs) break
        }
        return rateOf(marks)
    }

    /** ExoPlayers mätning (bitrateEstimate i bit/s efter en hämtning på bytes) → kbit/s, 0 = används inte */
    fun fromPlayer(bytes: Long, bitrateEstimate: Long): Int =
        if (bytes >= MIN_PLAYER_BYTES && bitrateEstimate > 0) (bitrateEstimate / 1000).coerceAtMost(1_000_000).toInt() else 0

    /** Senaste mätningen och när den gjordes */
    class Meter(private val freshMs: Long = FRESH_MS) {
        private var kbps = 0
        private var at = 0L
        @Synchronized fun note(k: Int, now: Long) { if (k > 0) { kbps = k; at = now } }
        /** Mätningen om den är färsk, annars 0 */
        @Synchronized fun fresh(now: Long): Int = if (kbps > 0 && now - at in 0 until freshMs) kbps else 0
        @Synchronized fun clear() { kbps = 0; at = 0 }
    }

    /** Nyckeln för en förvärmning: titeln och startpositionen i hela sekunder */
    fun pairKey(id: Int, start: Double): String = "$id:${start.toLong()}"

    /** Vilket bw som förvärmdes för en titel och position, och när */
    class Pairs(private val windowMs: Long = PAIR_MS) {
        private val m = HashMap<String, Pair<Int, Long>>()
        @Synchronized fun put(key: String, bw: Int, now: Long) { if (m.size > 50) m.clear(); m[key] = bw to now }
        @Synchronized fun get(key: String, now: Long): Int? = m[key]?.takeIf { now - it.second in 0 until windowMs }?.first
        @Synchronized fun clear() = m.clear()
    }

    /**
     * bw till förvärmningen: samma som förra förvärmningen av titeln (så att frågan inte ändras medan ExoPlayer mäter),
     * annars den färska mätningen. null hemma, eller utanför hemmet utan färsk mätning – då förvärms inget (servern
     * kan inte förutse valet) och appen mäter i stället.
     */
    fun forWarm(away: Boolean, paired: Int?, fresh: Int): Int? = if (!away) null else paired ?: fresh.takeIf { it > 0 }

    /**
     * bw till uppspelningen: samma som förvärmningen, annars den färska mätningen, annars en mätning som får ta högst
     * waitMs (measure delar en mätning som redan pågår). null = skicka inget (hemma, eller ingen mätning i tid).
     */
    suspend fun forPlay(away: Boolean, paired: Int?, fresh: Int, measure: suspend () -> Int, waitMs: Long = WAIT_MS): Int? {
        if (!away) return null
        if (paired != null) return paired
        if (fresh > 0) return fresh
        return withTimeoutOrNull(waitMs) { measure() }?.takeIf { it > 0 }
    }
}
