package net.braxhn.tv

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.security.MessageDigest
import java.time.ZonedDateTime
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Uppspelning när servern inte svarar (reglerna i OfflineCore.kt): positioner som väntar på att skickas och skärmtiden
 * som räknas i appen (en post per uppspelning). Båda sparas per server och profil. Köerna skickas när nätet kommer
 * tillbaka, när appen öppnas och efter ett lyckat framstegsanrop: positionerna i ordning med at, skärmtiden med
 * POST /api/screentime/offline.
 */
object OfflineSync {
    @Serializable private data class PendingJson(val id: Int, val pos: Long, val dur: Double = 0.0, val at: Long, val k: String = ProgressQueue.ITEM)
    @Serializable private data class PosJson(val id: Int, val pos: Double, val dur: Double = 0.0)
    @Serializable private data class EntryJson(val id: String, val at: Long, val seconds: Double, val audio: Boolean = false)
    /** offDay/off: summan per dag från äldre appversioner – flyttas till entries när den läses (ScreenClock.migrate) */
    @Serializable private data class ScreenJson(val status: ScreenTimeState, val offDay: String? = null, val off: Double = 0.0, val entries: List<EntryJson> = emptyList())
    @Serializable private data class OfflineResult(val added: Double = 0.0, val done: List<String> = emptyList(), val stop: Boolean = false, val screenTime: ScreenTimeState? = null)

    private lateinit var ctx: Context
    private val prefs get() = ctx.getSharedPreferences("braxhn-offline", Context.MODE_PRIVATE)
    private val sending = AtomicBoolean(false)
    private val lock = Any()
    /** Senast sparade skärmtidsstatus per server och profil (sparas bara när den ändras) */
    private val screens = HashMap<String, ScreenJson?>()
    /** Servrar (server-profil) som saknar POST /api/screentime/offline (äldre version): inget nytt försök förrän appen startas om */
    private val noOffline = HashSet<String>()

    fun init(c: Context) {
        ctx = c.applicationContext
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        runCatching {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { flush() }
            })
        }
    }

    // ---------- server och profil ----------

    /** Kort fingeravtryck av kontots token (själva token sparas inte här) */
    fun fp(token: String): String =
        MessageDigest.getInstance("SHA-256").digest(token.toByteArray()).take(8).joinToString("") { "%02x".format(it) }

    /** Profilen som hör till token som används nu – från /api/status (Session.refresh) */
    fun rememberUser(uid: Int) {
        if (!::ctx.isInitialized) return
        val t = Api.token.value ?: return
        val k = "uid." + fp(t)
        if (prefs.getInt(k, -1) != uid) prefs.edit().putInt(k, uid).apply()
    }

    /** Profilen för en inloggning (fingeravtrycket), om servern har sagt den */
    fun uidFor(fp: String): Int? = if (!::ctx.isInitialized) null else prefs.getInt("uid.$fp", -1).takeIf { it >= 0 }

    /** Fingeravtrycket av inloggningen som används nu (null = utloggad) */
    fun currentFp(): String? = Api.token.value?.let { fp(it) }

    /** "server-profil", null innan profilen är känd (inloggning utan svar från /api/status). Samma för nedladdningarna. */
    fun scope(): String? {
        val uid = uidFor(currentFp() ?: return null) ?: return null
        return DownloadScope.of(Api.saved, uid)
    }

    // ---------- positioner ----------

    private fun load(scope: String): List<PendingProgress> =
        runCatching { Api.json.decodeFromString<List<PendingJson>>(prefs.getString("pending.$scope", "[]") ?: "[]") }.getOrDefault(emptyList())
            .map { PendingProgress(it.id, it.pos, it.dur, it.at, it.k) }

    private fun save(scope: String, list: List<PendingProgress>) {
        val e = prefs.edit()
        if (list.isEmpty()) e.remove("pending.$scope")
        else e.putString("pending.$scope", Api.json.encodeToString(list.map { PendingJson(it.id, it.position, it.duration, it.at, it.kind) }))
        e.apply()
    }

    /** Framsteget kom inte fram: spara positionen och när den sparades (kind: film/avsnitt, ljudbok eller podd) */
    fun savePosition(id: Int, position: Double, duration: Double, kind: String = ProgressQueue.ITEM, atMs: Long = System.currentTimeMillis()) {
        val sc = scope() ?: return
        synchronized(lock) { save(sc, ProgressQueue.record(load(sc), id, position, duration, atMs, kind)) }
    }

    /** Skickar väntande positioner i ordning (i bakgrunden; stannar vid första anropet utan svar) */
    fun flush() {
        val sc = scope() ?: return
        if (synchronized(lock) { load(sc).isEmpty() && !screenWaiting(sc) } || !sending.compareAndSet(false, true)) return
        Api.appScope.launch {
            try { flushNow(sc) } finally { sending.set(false) }
        }
    }

    /** Skickar kön nu och väntar på svaret (före utloggningen, medan inloggningen gäller) */
    suspend fun flushAwait() {
        val sc = scope() ?: return
        if (!sending.compareAndSet(false, true)) return
        try { flushNow(sc) } finally { sending.set(false) }
    }

    private suspend fun flushNow(sc: String) {
        if (flushPositions(sc)) flushScreen(sc)
    }

    /** true = hela kön skickades (servern svarade) */
    private suspend fun flushPositions(sc: String): Boolean {
        for (p in synchronized(lock) { load(sc) }) {
            if (scope() != sc) return false // profilen eller servern byttes under tiden
            val body = buildJsonObject { ProgressQueue.body(p).forEach { (k, v) -> put(k, v) } }
            val status = try { Api.post(ProgressQueue.path(p), body); 200 }
                catch (e: ApiException) { e.code } // 0 = inget svar (felet kommer från netError eller utloggning)
                catch (e: IOException) { 0 }
            synchronized(lock) { save(sc, ProgressQueue.ack(load(sc), p, status)) }
            if (!ProgressQueue.keepGoing(status)) return false
        }
        return true
    }

    // ---------- var en nedladdad titel ska börja ----------

    private fun loadPos(sc: String): List<PosJson> =
        runCatching { Api.json.decodeFromString<List<PosJson>>(prefs.getString("pos.$sc", "[]") ?: "[]") }.getOrDefault(emptyList())

    /** Senaste positionen i en nedladdad titel (även när servern fick den): nedladdningarna börjar där utan nät */
    fun notePlayed(id: Int, position: Double, duration: Double) {
        val sc = scope() ?: return
        synchronized(lock) {
            val list = (loadPos(sc).filter { it.id != id } + PosJson(id, position, duration)).takeLast(ProgressQueue.MAX)
            prefs.edit().putString("pos.$sc", Api.json.encodeToString(list)).apply()
        }
    }

    /** Var titeln ska börja när den spelas från Nedladdat (0 = från början) */
    fun resumeAt(id: Int): Double {
        val sc = scope() ?: return 0.0
        val p = synchronized(lock) { loadPos(sc).lastOrNull { it.id == id } } ?: return 0.0
        return ResumePoint.start(p.pos, p.dur)
    }

    // ---------- skärmtid ----------

    private fun EntryJson.core() = ScreenEntry(id, at, seconds, audio)
    private fun ScreenEntry.json() = EntryJson(id, at, seconds, audio)

    private fun loadScreen(sc: String): ScreenCache? {
        var j = screens.getOrPut(sc) {
            runCatching { prefs.getString("screen.$sc", null)?.let { Api.json.decodeFromString<ScreenJson>(it) } }.getOrNull()
        } ?: return null
        if (j.off > 0 || j.offDay != null) {
            // Äldre appversion: summan för en dag blir poster som kan lämnas in (en gång – sparas direkt i nya formen)
            val moved = ScreenClock.migrate(j.offDay, j.off, ZonedDateTime.now()).map { it.json() }
            j = ScreenJson(j.status, entries = moved + j.entries)
            screens[sc] = j
            prefs.edit().putString("screen.$sc", Api.json.encodeToString(j)).apply()
        }
        return ScreenCache(j.status.toCore(), j.entries.map { it.core() })
    }

    private fun saveScreen(sc: String, status: ScreenTimeState, c: ScreenCache) {
        val j = ScreenJson(status, entries = c.entries.map { it.json() })
        if (screens[sc] == j) return
        screens[sc] = j
        prefs.edit().putString("screen.$sc", Api.json.encodeToString(j)).apply()
    }

    /** Ny status från servern (GET /api/screentime, screenTime i framstegssvaret – saknas = ingen skärmtid) */
    fun noteScreen(st: ScreenTimeState?) {
        val sc = scope() ?: return
        val s = st ?: ScreenTimeState(limited = false)
        synchronized(lock) { saveScreen(sc, s, ScreenClock.fresh(s.toCore(), loadScreen(sc)?.entries ?: emptyList())) }
    }

    /** Får profilen spela nu, utan kontakt med servern? */
    fun gateNow(): ScreenGate {
        val sc = scope() ?: return ScreenGate(true, null)
        return synchronized(lock) { ScreenClock.gate(loadScreen(sc), ZonedDateTime.now()) }
    }

    /**
     * Tid som spelats utan kontakt med servern, fram till endMs (när framsteget skickades – inte när felet kom):
     * sparas som en post som lämnas in senare, och ger svaret om det får fortsätta
     */
    fun playedOffline(seconds: Double, endMs: Long = System.currentTimeMillis(), audio: Boolean = false): ScreenGate {
        val sc = scope() ?: return ScreenGate(true, null)
        val end = java.time.Instant.ofEpochMilli(endMs).atZone(java.time.ZoneId.systemDefault())
        return synchronized(lock) {
            val c = ScreenClock.addOffline(loadScreen(sc) ?: ScreenClock.fresh(null), end, seconds, audio)
            if (c != null) saveScreen(sc, screens[sc]?.status ?: ScreenTimeState(limited = false), c)
            ScreenClock.gate(c, ZonedDateTime.now(), audio)
        }
    }

    private fun screenWaiting(sc: String): Boolean = sc !in noOffline && loadScreen(sc)?.entries?.isNotEmpty() == true

    /** Enhetens id för skärmtidens poster (samma post från samma enhet får växa hos servern). Slumpat en gång. */
    private fun deviceId(): String = prefs.getString("device", null) ?: java.util.UUID.randomUUID().toString().also { prefs.edit().putString("device", it).apply() }

    /**
     * Lämnar in skärmtiden som spelats utan kontakt (högst ScreenClock.SEND_MAX poster per anrop). Det servern listar
     * i done tas bort ur kön, och svarets screenTime blir den nya statusen.
     */
    private suspend fun flushScreen(sc: String) {
        repeat(10) {
            if (scope() != sc) return
            val sent = synchronized(lock) { if (screenWaiting(sc)) ScreenClock.batch(loadScreen(sc)!!.entries) else emptyList() }
            if (sent.isEmpty()) return
            val body = buildJsonObject {
                put("device", deviceId())
                put("entries", JsonArray(sent.map { e -> buildJsonObject { put("id", e.id); put("at", e.at); put("seconds", e.seconds); put("audio", e.audio) } }))
            }
            val r = try { Api.json.decodeFromString<OfflineResult>(Api.post("/api/screentime/offline", body)) }
                catch (e: ApiException) { if (e.code == 404) synchronized(lock) { noOffline.add(sc) }; return }
                catch (e: Exception) { return } // inget svar (eller ett svar som inte gick att läsa): nästa gång
            if (scope() != sc) return
            synchronized(lock) {
                val c = loadScreen(sc) ?: return
                val st = r.screenTime ?: ScreenTimeState(limited = false)
                saveScreen(sc, st, ScreenClock.fresh(st.toCore(), ScreenClock.ack(c.entries, sent, r.done)))
            }
            if (r.done.isEmpty()) return
        }
    }

    private val DAYS = intArrayOf(R.string.offline_day_sun, R.string.offline_day_mon, R.string.offline_day_tue, R.string.offline_day_wed,
        R.string.offline_day_thu, R.string.offline_day_fri, R.string.offline_day_sat)

    /** Samma besked som servern ger (server/screentime.js messageOf) */
    fun message(g: ScreenGate): String {
        if (g.reason == "limit") return str(R.string.offline_screen_limit, g.usedMinutes, g.totalMinutes)
        val win = when {
            g.from != null && g.until != null -> str(R.string.offline_screen_between, g.from, g.until)
            g.from != null -> str(R.string.offline_screen_from, g.from)
            else -> str(R.string.offline_screen_until, g.until ?: "")
        }
        return str(R.string.offline_screen_window, str(DAYS[g.weekday.coerceIn(0, 6)]), win)
    }
}

private fun ScreenTimeState.toCore() = ScreenStatus(limited = limited, day = day, daily = daily, used = used, extra = extra,
    remaining = remaining, from = from, until = until, audio = audio)
