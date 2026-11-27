package net.braxhn.tv

import android.app.DownloadManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

@Serializable data class OfflineStatus(val status: String, val progress: Int? = null, val url: String? = null, val size: Long? = null, val error: String? = null)
/** Serverns plan för automatisk offline-synk (GET /api/offline/sync) */
@Serializable data class SyncPlan(val enabled: Boolean = false, val quality: String = "720", val wifiOnly: Boolean = true,
    val items: List<MediaItem> = emptyList(), val remove: List<Int> = emptyList())
/** Nedladdning som lämnats till DownloadManager – sparas så att bevakningen kan fortsätta efter omstart av appen.
 *  file = sökvägen under offline/, scope = profilens mapp ("" = påbörjad före profilerna, i offline/ direkt) */
@Serializable data class PendingDownload(val id: Int, val dlId: Long, val title: String, val subtitle: String, val file: String, val scope: String = "")

/**
 * Offline-nedladdningar – bra för långresor utan täckning (spelas när bilen står parkerad). Gäller en server och profil
 * (offline/<server>-<profil>/ och listan list.<server>-<profil>), som i Expo-appen: en barnprofil ser inte vad en vuxen
 * laddat ner. Reglerna (vem som ser vad, flytten från före profilerna, kontrollen mot servern) står i DownloadCore.kt.
 */
object Downloads {
    private lateinit var ctx: Context
    /** Det som profilen som är inloggad nu har laddat ner */
    val records = MutableStateFlow<List<DownloadRecord>>(emptyList())
    private val shownActive = MutableStateFlow<Map<Int, Float>>(emptyMap())
    private val shownErrors = MutableStateFlow<Map<Int, String>>(emptyMap())
    /** Förloppet (0–1) per titel för profilen som är inloggad nu – en annan profils nedladdning syns inte här */
    val active: StateFlow<Map<Int, Float>> = shownActive.asStateFlow()
    /** Senaste fel per titel för profilen som är inloggad nu (visas i detaljvyn) */
    val errors: StateFlow<Map<Int, String>> = shownErrors.asStateFlow()
    /** Förlopp och fel per profil och titel (DownloadProgress i DownloadCore.kt), och nedladdningarna som pågår.
     *  Ändras bara under progressLock, så att en flytt från före profilerna inte tappar något. */
    private val progressLock = Any()
    private var progress: Map<DownloadKey, Float> = emptyMap()
    private var failures: Map<DownloadKey, String> = emptyMap()
    private val tracks = HashSet<Track>()
    /** En nedladdning som pågår: profilen kan bytas från "" till en profil av flytten från före profilerna */
    private class Track(var scope: String?, val id: Int) { val key get() = DownloadKey(scope, id) }
    /** Besked i Nedladdat, t.ex. att titlar togs bort för att profilen inte får se dem längre */
    val notice = MutableStateFlow<String?>(null)
    private val pending = MutableStateFlow<List<PendingDownload>>(emptyList())
    private val prefs get() = ctx.getSharedPreferences("braxhn-dl", Context.MODE_PRIVATE)
    private val root get() = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "offline").apply { mkdirs() }
    /** Profilens mapp; "" = de gamla nedladdningarna från före profilerna (offline/ direkt) */
    private fun dirOf(sc: String) = if (sc.isEmpty()) root else File(root, sc).apply { mkdirs() }
    private val dm get() = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
    private val lock = Any()
    /** Profilen vars nedladdningar visas (null = utloggad, eller profilen är inte känd än) */
    @Volatile private var scope: String? = null
    /** De gamla nedladdningarna som visas just nu (samma inloggning som vid uppdateringen, profilen inte känd än) */
    @Volatile private var legacyIds: Set<Int> = emptySet()
    /** De gamla nedladdningarna visas just nu (då även deras förlopp) */
    @Volatile private var showingLegacy = false
    /** Senaste kontrollen mot servern per profil (ms) */
    private val checked = HashMap<String, Long>()
    private val checking = AtomicBoolean(false)

    fun init(c: Context) {
        ctx = c.applicationContext
        pending.value = runCatching { Api.json.decodeFromString<List<PendingDownload>>(prefs.getString("pending", "[]") ?: "[]") }.getOrDefault(emptyList())
        // Från appversion 0.7.0 och äldre: en gemensam lista ("list") – den hör till inloggningen som gäller nu
        if (prefs.getString("legacy", null) == null && (prefs.contains("list") || pending.value.any { it.scope.isEmpty() })) {
            if (loadList("").isNotEmpty() || pending.value.any { it.scope.isEmpty() })
                prefs.edit().putString("legacy", Api.json.encodeToString(LegacyDownloads(Api.saved, OfflineSync.currentFp() ?: ""))).apply()
            else prefs.edit().remove("list").remove("auto").apply()
        }
        open()
        // Fortsätt bevaka nedladdningar som pågick när appen stängdes
        pending.value.forEach { p -> launchTracked(p.scope, p.id, 0.5f) { t -> poll(p, t) } }
    }

    // ---------- lagring per profil ----------
    private fun listKey(sc: String) = if (sc.isEmpty()) "list" else "list.$sc"
    private fun autoKey(sc: String) = if (sc.isEmpty()) "auto" else "auto.$sc"
    private fun loadList(sc: String): List<DownloadRecord> =
        runCatching { Api.json.decodeFromString<List<DownloadRecord>>(prefs.getString(listKey(sc), "[]") ?: "[]") }.getOrDefault(emptyList())
            .filter { File(dirOf(sc), it.file).exists() }
    private fun saveList(sc: String, list: List<DownloadRecord>) {
        if (list.isEmpty()) prefs.edit().remove(listKey(sc)).apply()
        else prefs.edit().putString(listKey(sc), Api.json.encodeToString(list)).apply()
    }
    private fun savePending() { prefs.edit().putString("pending", Api.json.encodeToString(pending.value)).apply() }
    private fun legacy(): LegacyDownloads? =
        runCatching { prefs.getString("legacy", null)?.let { Api.json.decodeFromString<LegacyDownloads>(it) } }.getOrNull()
    private fun ownerOf(server: String): Int? = prefs.getInt("owner." + DownloadScope.clean(server), -1).takeIf { it >= 0 }

    /**
     * Läser in nedladdningarna för profilen som är inloggad nu: när appen startar, när inloggningen byts och när
     * servern har sagt vilken profil inloggningen hör till (Session.refresh). Flyttar då också de gamla nedladdningarna.
     */
    fun open() {
        if (!::ctx.isInitialized) return
        synchronized(lock) {
            var showLegacy = false
            legacy()?.let { l ->
                val (nl, fate) = DownloadMigration.fate(l, Api.saved, OfflineSync.currentFp(), OfflineSync::uidFor, ownerOf(l.server))
                if (nl != l) prefs.edit().putString("legacy", Api.json.encodeToString(nl)).apply()
                when (fate) {
                    is LegacyFate.Assign -> migrate(DownloadScope.of(l.server, fate.uid))
                    LegacyFate.ShowHere -> showLegacy = true
                    LegacyFate.Hidden -> {}
                }
            }
            val sc = OfflineSync.scope()
            if (sc != scope) notice.value = null
            scope = sc
            val own = sc?.let { loadList(it) } ?: emptyList()
            val old = if (showLegacy) loadList("").filter { l -> own.none { it.id == l.id } } else emptyList()
            legacyIds = old.map { it.id }.toSet()
            showingLegacy = showLegacy
            records.value = own + old
        }
        changeProgress {}
    }

    // ---------- förlopp och fel per profil ----------

    /** Ändrar förlopp/fel och visar det som gäller profilen som är inloggad nu */
    private fun changeProgress(block: () -> Unit) {
        synchronized(progressLock) {
            block()
            shownActive.value = DownloadProgress.view(progress, scope, showingLegacy)
            shownErrors.value = DownloadProgress.view(failures, scope, showingLegacy)
        }
    }
    private fun setProgress(t: Track, v: Float) = changeProgress { if (t in tracks) progress = progress + (t.key to v) }
    private fun isActive(sc: String, id: Int): Boolean = synchronized(progressLock) { progress.containsKey(DownloadKey(sc, id)) }

    /** De gamla nedladdningarna flyttas till profilens mapp och lista (filer som inte gick att flytta väntar till nästa gång) */
    private fun migrate(target: String) {
        val old = loadList("")
        val (merged, move) = DownloadMigration.merge(loadList(target), old)
        val dir = dirOf(target)
        val failed = move.filter { r -> !moveFile(File(root, r.file), File(dir, r.file)) }
        // Förlopp och fel för de gamla följer med till profilen
        changeProgress {
            progress = DownloadProgress.rekey(progress, "", target); failures = DownloadProgress.rekey(failures, "", target)
            tracks.filter { it.scope == "" }.forEach { it.scope = target }
        }
        saveList(target, merged.filter { it !in failed })
        // Samma titel fanns redan i profilens mapp: den gamla filen behövs inte
        old.filter { o -> move.none { it.id == o.id } }.forEach { File(root, it.file).delete() }
        val auto = autoIds("") + autoIds(target)
        saveAutoIds(target, auto)
        // Nedladdningar som pågick före uppdateringen blir klara i profilens lista
        pending.update { list -> list.map { if (it.scope.isEmpty()) it.copy(scope = target) else it } }
        savePending()
        if (failed.isEmpty()) prefs.edit().remove("list").remove("auto").remove("legacy").apply()
        else saveList("", failed)
    }

    private fun moveFile(from: File, to: File): Boolean {
        if (!from.exists()) return to.exists()
        if (from.renameTo(to)) return true
        return runCatching { from.copyTo(to, overwrite = true); from.delete(); true }.getOrDefault(false)
    }

    /** Huvudkontot behövs för de gamla nedladdningarna (det gick inte att veta vem som laddade ner dem) */
    fun needsOwner(): Boolean = ::ctx.isInitialized && legacy()?.let { it.ownerOnly && DownloadScope.sameServer(it.server, Api.saved) } == true

    /** Huvudkontot på servern (owner i /api/profiles) – de gamla nedladdningarna flyttas dit */
    fun learnOwner(uid: Int) {
        if (!::ctx.isInitialized) return
        prefs.edit().putInt("owner." + DownloadScope.clean(Api.saved), uid).apply()
        open()
    }

    /** Var filen ligger, för profilen som är inloggad nu */
    fun localFile(id: Int): File? {
        val r = records.value.firstOrNull { it.id == id } ?: return null
        val dir = if (id in legacyIds) root else dirOf(scope ?: return null)
        return File(dir, r.file).takeIf { it.exists() }
    }

    /** Startar en nedladdning i appens livslånga scope – fortsätter även när användaren lämnar vyn. */
    fun start(item: MediaItem, quality: String) {
        if (localFile(item.id) != null) return
        val sc = scope ?: run { changeProgress { failures = failures + (DownloadKey(null, item.id) to str(R.string.dl_need_server)) }; return }
        launchTracked(sc, item.id, 0f) { t -> download(item, quality, sc, t) }
    }

    /** Startar bevakningen av en nedladdning för profilen sc – inte om profilen redan har titeln på väg */
    private fun launchTracked(sc: String, id: Int, start: Float, block: suspend (Track) -> Unit) {
        val t = Track(sc, id)
        var busy = false
        changeProgress {
            busy = shownActive.value.containsKey(id) && sc == scope || progress.containsKey(t.key)
            if (!busy) {
                tracks += t; progress = progress + (t.key to start)
                failures = failures - t.key - DownloadKey(null, id)
            }
        }
        if (busy) return
        Api.appScope.launch {
            try { block(t) }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { changeProgress { failures = failures + (t.key to (e.message ?: e.toString())) } }
            finally { changeProgress { tracks -= t; progress = progress - t.key } }
        }
    }

    private suspend fun download(item: MediaItem, quality: String, sc: String, t: Track) {
        Api.post("/api/items/${item.id}/offline", buildJsonObject { put("q", quality) })
        var st: OfflineStatus
        do {
            delay(3000)
            st = Api.get("/api/items/${item.id}/offline", mapOf("q" to quality))
            if (st.status == "error") throw ApiException(st.error ?: str(R.string.dl_server_failed))
            val prep = (st.progress ?: 0) / 200f
            setProgress(t, prep)
        } while (st.status != "ready")
        val rel = st.url ?: throw ApiException(str(R.string.dl_no_link))
        val name = "${item.id}.mp4"
        val target = File(dirOf(sc), name).also { it.delete() }
        val req = DownloadManager.Request(Uri.parse(Api.savedAbsolute(rel))) // systemet laddar ner: den sparade adressen, som nås även utanför hemmet
            .setTitle(item.title).setDescription(ctx.getString(R.string.app_name))
            .setDestinationUri(Uri.fromFile(target))
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
        val dlId = dm.enqueue(req)
        val p = PendingDownload(item.id, dlId, if (item.isEpisode) "${item.showTitle ?: ""} – ${item.title}" else item.title,
            if (item.isEpisode) item.sxe else item.year?.toString() ?: "", "$sc/$name", sc)
        pending.update { list -> list.filter { it.id != item.id || it.scope != sc } + p }
        savePending()
        poll(p, t)
    }

    /** Bevakar DownloadManager tills filen är klar. Avbryts eller misslyckas den tas den bort ur DownloadManager. */
    private suspend fun poll(p: PendingDownload, t: Track) {
        var completed = false
        try {
            while (true) {
                delay(1500)
                val done = dm.query(DownloadManager.Query().setFilterById(p.dlId)).use { c ->
                    if (c == null || !c.moveToFirst()) throw ApiException(str(R.string.dl_cancelled))
                    val status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                    val got = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                    val total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                    if (total > 0) {
                        val v = 0.5f + got.toFloat() / total / 2
                        setProgress(t, v)
                    }
                    if (status == DownloadManager.STATUS_FAILED) throw ApiException(str(R.string.dl_failed))
                    status == DownloadManager.STATUS_SUCCESSFUL
                }
                if (done) {
                    finished(p)
                    completed = true
                    return
                }
            }
        } finally {
            // Avbruten (även korutinen) eller misslyckad: städa bort den halvfärdiga nedladdningen
            if (!completed) runCatching { dm.remove(p.dlId) }
            pending.update { list -> list.filter { it.dlId != p.dlId } }
            savePending()
        }
    }

    /** Filen är klar: in i listan för profilen som startade nedladdningen (den kan ha flyttats från före profilerna) */
    private fun finished(p: PendingDownload) {
        synchronized(lock) {
            val sc = pending.value.firstOrNull { it.dlId == p.dlId }?.scope ?: p.scope
            val name = "${p.id}.mp4"
            val file = File(root, p.file)
            val dest = File(dirOf(sc), name)
            if (file.absolutePath != dest.absolutePath) moveFile(file, dest)
            if (sc.isEmpty() && legacy() == null) return // ska inte hända: flytten byter profil på pågående, utloggningen avbryter dem
            saveList(sc, loadList(sc).filter { it.id != p.id } + DownloadRecord(p.id, p.title, p.subtitle, name, dest.length()))
        }
        open()
    }

    fun remove(id: Int) {
        synchronized(lock) {
            val sc = if (id in legacyIds) "" else scope ?: return
            removeFrom(sc, id)
        }
        open()
    }

    private fun removeFrom(sc: String, id: Int) {
        val list = loadList(sc)
        list.filter { it.id == id }.forEach { File(dirOf(sc), it.file).delete() }
        saveList(sc, list.filter { it.id != id })
    }

    // ---------- utloggning och behörighet ----------

    /** Finns något nedladdat (eller på väg) från servern på enheten, för någon av dess profiler? */
    fun hasServerDownloads(server: String): Boolean {
        if (!::ctx.isInitialized) return false
        if (pending.value.any { DownloadScope.ofServer(it.scope, server) }) return true
        if (legacy()?.let { DownloadScope.sameServer(it.server, server) } == true && loadList("").isNotEmpty()) return true
        return (root.listFiles() ?: emptyArray()).any { d -> d.isDirectory && DownloadScope.ofServer(d.name, server) && (d.listFiles()?.isNotEmpty() == true) }
    }

    /** Utloggning: allt som laddats ner från servern tas bort (alla dess profiler), pågående nedladdningar avbryts */
    fun removeServer(server: String) {
        if (!::ctx.isInitialized) return
        synchronized(lock) {
            val l = legacy()?.takeIf { DownloadScope.sameServer(it.server, server) }
            pending.value.filter { DownloadScope.ofServer(it.scope, server) || (l != null && it.scope.isEmpty()) }
                .forEach { runCatching { dm.remove(it.dlId) } } // bevakningen märker det och städar
            (root.listFiles() ?: emptyArray()).filter { it.isDirectory && DownloadScope.ofServer(it.name, server) }.forEach { it.deleteRecursively() }
            val e = prefs.edit()
            prefs.all.keys.filter { k -> (k.startsWith("list.") || k.startsWith("auto.")) && DownloadScope.ofServer(k.substringAfter('.'), server) }.forEach { e.remove(it) }
            e.remove("owner." + DownloadScope.clean(server))
            if (l != null) {
                loadList("").forEach { File(root, it.file).delete() }
                e.remove("list").remove("auto").remove("legacy")
            }
            e.apply()
            checked.keys.removeAll { DownloadScope.ofServer(it, server) }
        }
        open()
    }

    /**
     * Servern svarar (Session.refresh): får kontot inte ladda ner längre tas allt som profilen laddat ner bort, och
     * nedladdade titlar som profilen inte får se längre eller som inte finns kvar (403/404) tas bort – högst var
     * sjätte timme. Som Expo-appens online().
     */
    suspend fun online(canDownload: Boolean) {
        if (!::ctx.isInitialized) return
        val sc = scope ?: return
        if (DownloadAccess.removeAll(canDownload, records.value.size)) {
            synchronized(lock) {
                if (scope != sc) return
                pending.value.filter { it.scope == sc }.forEach { runCatching { dm.remove(it.dlId) } }
                loadList(sc).forEach { File(dirOf(sc), it.file).delete() }
                saveList(sc, emptyList())
                prefs.edit().remove(autoKey(sc)).apply()
            }
            open()
            notice.value = str(R.string.downloads_removed_no_right)
            return
        }
        val now = System.currentTimeMillis()
        if (!DownloadAccess.due(synchronized(lock) { checked[sc] }, now) || !checking.compareAndSet(false, true)) return
        try {
            synchronized(lock) { checked[sc] = now }
            val gone = mutableListOf<String>()
            for (r in synchronized(lock) { loadList(sc) }) {
                if (scope != sc) return
                val status = try { Api.requestPublic("/api/items/${r.id}", "GET", emptyMap(), null); 200 }
                    catch (e: ApiException) { e.code } // 0 = inget svar eller utloggad
                    catch (e: IOException) { 0 }
                when (DownloadAccess.verdict(status)) {
                    DownloadAccess.Verdict.STOP -> { synchronized(lock) { checked.remove(sc) }; break } // inget nät: igen nästa gång
                    DownloadAccess.Verdict.REMOVE -> { synchronized(lock) { if (scope == sc) removeFrom(sc, r.id) }; gone += r.title }
                    DownloadAccess.Verdict.KEEP -> {}
                }
            }
            if (gone.isNotEmpty() && scope == sc) {
                open()
                notice.value = str(R.string.downloads_removed_access, gone.joinToString(", "))
            }
        } finally { checking.set(false) }
    }

    // ---------- automatisk synk ----------
    private val syncing = AtomicBoolean(false)
    /** Avsnitt som synken själv laddat ner – bara de tas bort automatiskt (per profil) */
    private fun autoIds(sc: String): MutableSet<Int> = (prefs.getStringSet(autoKey(sc), emptySet()) ?: emptySet()).mapNotNull { it.toIntOrNull() }.toMutableSet()
    private fun saveAutoIds(sc: String, ids: Set<Int>) { prefs.edit().putStringSet(autoKey(sc), ids.map { it.toString() }.toSet()).apply() }

    private fun unmetered(): Boolean {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    /** Servern anger vilka avsnitt som ska finnas offline (nästa osedda i följda serier). Saknade laddas ner,
     *  sedda tas bort – men bara de som synken själv laddat ner. Körs i bakgrunden; fel ignoreras. */
    fun autoSync() {
        if (!::ctx.isInitialized || Api.token.value == null || !syncing.compareAndSet(false, true)) return
        Api.appScope.launch {
            try { syncNow() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { android.util.Log.w("BraXhnTV", "Automatisk synk misslyckades: ${e.message}") }
            finally { syncing.set(false) }
        }
    }

    private suspend fun syncNow() {
        val sc = scope ?: return
        // Glöm avsnitt som inte längre finns (borttagna för hand eller misslyckade) – de kan laddas ner igen
        val auto = autoIds(sc).filter { localFile(it) != null || isActive(sc, it) }.toMutableSet()
        val plan: SyncPlan = Api.get("/api/offline/sync", mapOf("have" to auto.sorted().joinToString(",")))
        if (scope != sc) return // profilen byttes under tiden
        for (id in plan.remove) if (id in auto && localFile(id) != null) { remove(id); auto.remove(id) }
        saveAutoIds(sc, auto)
        if (!plan.enabled || plan.items.isEmpty()) return
        if (plan.wifiOnly && !unmetered()) return
        for (item in plan.items) {
            if (localFile(item.id) != null || isActive(sc, item.id)) continue
            auto.add(item.id)
            saveAutoIds(sc, auto)
            start(item, plan.quality)
        }
    }
}
