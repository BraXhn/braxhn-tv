package net.braxhn.tv

import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

// Uppkopplingen utanför hemmet: mätningen mot /api/speedtest och vad som skickas som bw till /playback. Reglerna står i
// BwCore.kt (testas på JVM); här är anropen.
//
// Mäts i bakgrunden efter provet om appen är hemma (Hemma.kt: när en server öppnas, appen kommer tillbaka och nätet
// byts), när en förvärmning saknar färsk mätning och, om inget annat hunnit, när uppspelningen börjar (högst 1,5 s).
// Under uppspelningen tar spelarens egen mätning över (PlayerScreen.kt, note).

object Bandwidth {
    private val meter = BwCore.Meter()
    private val pairs = BwCore.Pairs()
    /** here i /api/local: servern ser förfrågan som hemma. null = okänt (inget svar än, äldre server). */
    @Volatile var here: Boolean? = null
    /** Appens vyer syns (MainActivity): bara då mäts i bakgrunden, inte för musiktjänsten ensam */
    @Volatile var visible = false
    private val lock = Any()
    private var running: Deferred<Int>? = null

    private fun now() = System.currentTimeMillis()

    fun away(): Boolean = BwCore.away(LocalPick.isLocalUrl(Api.saved), Home.via.value != null, here)

    /** Färsk mätning utanför hemmet, annars null (t.ex. spolning i en omkodning) */
    fun current(): Int? = if (away()) meter.fresh(now()).takeIf { it > 0 } else null

    /** Spelarens mätning på riktiga segment (kbit/s) */
    fun note(kbps: Int) { if (kbps > 0 && away()) meter.note(kbps, now()) }

    /** Nytt nät, ny server eller utloggning: mätningen gäller inte längre */
    fun reset() { meter.clear(); pairs.clear(); here = null }

    /** Mätningen som pågår, annars en ny (i appens scope – den fortsätter även om den som väntar ger upp) */
    fun measure(): Deferred<Int> = synchronized(lock) {
        running?.takeIf { it.isActive } ?: Api.appScope.async {
            val k = runCatching { sampleNow() }.getOrDefault(0)
            if (k > 0) meter.note(k, now())
            k
        }.also { running = it }
    }

    /** Mät i bakgrunden om appen är utanför hemmet och saknar en färsk mätning */
    fun refresh() { if (visible && Api.token.value != null && away() && meter.fresh(now()) == 0) measure() }

    /** bw till förvärmningen (null = förvärm inte nu, se BwCore.forWarm). Kommer ihåg värdet för uppspelningen. */
    fun forWarm(id: Int, start: Double): Int? {
        val key = BwCore.pairKey(id, start)
        val bw = BwCore.forWarm(away(), pairs.get(key, now()), meter.fresh(now()))
        if (bw != null) pairs.put(key, bw, now())
        return bw
    }

    /** bw till uppspelningen (samma som förvärmningen när en sådan nyss gjorts) */
    suspend fun forPlay(id: Int, start: Double): Int? =
        BwCore.forPlay(away(), pairs.get(BwCore.pairKey(id, start), now()), meter.fresh(now()), { measure().await() })

    /** Provet: inloggat, med adressen som gäller nu, kort tidsgräns. Avbryts efter BwCore.SAMPLE_MS. */
    private suspend fun sampleNow(): Int = withContext(Dispatchers.IO) {
        val tok = Api.token.value ?: return@withContext 0
        val q = mapOf("kb" to BwCore.SAMPLE_KB.toString(), "n" to now().toString())
        val c = URL(Api.url("/api/speedtest", q, Home.base())).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 5000; c.readTimeout = 5000
            c.useCaches = false
            c.setRequestProperty("Authorization", "Bearer $tok")
            if (c.responseCode != 200) return@withContext 0
            BwCore.sample(c.inputStream, now = { System.nanoTime() / 1_000_000 })
        } finally { c.disconnect() } // avbryter resten av provet (strömmen stängs inte först – då läses resten)
    }
}
