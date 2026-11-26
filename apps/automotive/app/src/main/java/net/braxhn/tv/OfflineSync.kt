package net.braxhn.tv

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.security.MessageDigest
import java.time.ZonedDateTime
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Uppspelning när servern inte svarar (reglerna i OfflineCore.kt): positioner som väntar på att skickas och skärmtiden
 * som räknas i appen. Båda sparas per server och profil. Kön skickas i ordning med at när nätet kommer tillbaka,
 * när appen öppnas och efter ett lyckat framstegsanrop.
 */
object OfflineSync {
    @Serializable private data class PendingJson(val id: Int, val pos: Long, val dur: Double = 0.0, val at: Long)
    @Serializable private data class PosJson(val id: Int, val pos: Double, val dur: Double = 0.0)
    @Serializable private data class ScreenJson(val status: ScreenTimeState, val offDay: String? = null, val off: Double = 0.0)

    private lateinit var ctx: Context
    private val prefs get() = ctx.getSharedPreferences("braxhn-offline", Context.MODE_PRIVATE)
    private val sending = AtomicBoolean(false)
    private val lock = Any()
    /** Senast sparade skärmtidsstatus per server och profil (sparas bara när den ändras) */
    private val screens = HashMap<String, ScreenJson?>()

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
    private fun fp(token: String): String =
        MessageDigest.getInstance("SHA-256").digest(token.toByteArray()).take(8).joinToString("") { "%02x".format(it) }

    /** Profilen som hör till token som används nu – från /api/status (Session.refresh) */
    fun rememberUser(uid: Int) {
        if (!::ctx.isInitialized) return
        val t = Api.token.value ?: return
        val k = "uid." + fp(t)
        if (prefs.getInt(k, -1) != uid) prefs.edit().putInt(k, uid).apply()
    }

    /** "server-profil", null innan profilen är känd (inloggning utan svar från /api/status) */
    private fun scope(): String? {
        if (!::ctx.isInitialized) return null
        val t = Api.token.value ?: return null
        val uid = prefs.getInt("uid." + fp(t), -1).takeIf { it >= 0 } ?: return null
        val server = Api.saved.replace(Regex("[^A-Za-z0-9]"), "").take(60)
        return "$server-$uid"
    }

    // ---------- positioner ----------

    private fun load(scope: String): List<PendingProgress> =
        runCatching { Api.json.decodeFromString<List<PendingJson>>(prefs.getString("pending.$scope", "[]") ?: "[]") }.getOrDefault(emptyList())
            .map { PendingProgress(it.id, it.pos, it.dur, it.at) }

    private fun save(scope: String, list: List<PendingProgress>) {
        val e = prefs.edit()
        if (list.isEmpty()) e.remove("pending.$scope")
        else e.putString("pending.$scope", Api.json.encodeToString(list.map { PendingJson(it.id, it.position, it.duration, it.at) }))
        e.apply()
    }

    /** Framsteget kom inte fram: spara positionen och när den sparades */
    fun savePosition(id: Int, position: Double, duration: Double) {
        val sc = scope() ?: return
        synchronized(lock) { save(sc, ProgressQueue.record(load(sc), id, position, duration, System.currentTimeMillis())) }
    }

    /** Skickar väntande positioner i ordning (i bakgrunden; stannar vid första anropet utan svar) */
    fun flush() {
        val sc = scope() ?: return
        if (synchronized(lock) { load(sc).isEmpty() } || !sending.compareAndSet(false, true)) return
        Api.appScope.launch {
            try { flushNow(sc) } finally { sending.set(false) }
        }
    }

    private suspend fun flushNow(sc: String) {
        for (p in synchronized(lock) { load(sc) }) {
            if (scope() != sc) return // profilen eller servern byttes under tiden
            val body = buildJsonObject { ProgressQueue.body(p).forEach { (k, v) -> put(k, v) } }
            val status = try { Api.post(ProgressQueue.path(p), body); 200 }
                catch (e: ApiException) { e.code } // 0 = inget svar (felet kommer från netError eller utloggning)
                catch (e: IOException) { 0 }
            synchronized(lock) { save(sc, ProgressQueue.ack(load(sc), p, status)) }
            if (!ProgressQueue.keepGoing(status)) return
        }
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

    private fun loadScreen(sc: String): ScreenCache? {
        val j = screens.getOrPut(sc) {
            runCatching { prefs.getString("screen.$sc", null)?.let { Api.json.decodeFromString<ScreenJson>(it) } }.getOrNull()
        } ?: return null
        return ScreenCache(j.status.toCore(), j.offDay, j.off)
    }

    private fun saveScreen(sc: String, status: ScreenTimeState, c: ScreenCache) {
        val j = ScreenJson(status, c.offDay, c.offSeconds)
        if (screens[sc] == j) return
        screens[sc] = j
        prefs.edit().putString("screen.$sc", Api.json.encodeToString(j)).apply()
    }

    /** Ny status från servern (GET /api/screentime, screenTime i framstegssvaret – saknas = ingen skärmtid) */
    fun noteScreen(st: ScreenTimeState?) {
        val sc = scope() ?: return
        val s = st ?: ScreenTimeState(limited = false)
        synchronized(lock) { saveScreen(sc, s, ScreenClock.fresh(s.toCore())) }
    }

    /** Får profilen spela nu, utan kontakt med servern? */
    fun gateNow(): ScreenGate {
        val sc = scope() ?: return ScreenGate(true, null)
        return synchronized(lock) { ScreenClock.gate(loadScreen(sc), ZonedDateTime.now()) }
    }

    /** Tid som spelats utan kontakt med servern: räknas på dagen och ger svaret om det får fortsätta */
    fun playedOffline(seconds: Double): ScreenGate {
        val sc = scope() ?: return ScreenGate(true, null)
        val now = ZonedDateTime.now()
        return synchronized(lock) {
            val c = ScreenClock.addOffline(loadScreen(sc), now, seconds)
            val j = screens[sc]
            if (c != null && j != null) saveScreen(sc, j.status, c)
            ScreenClock.gate(c, now)
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
