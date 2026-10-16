package net.braxhn.tv

import android.app.DownloadManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

@Serializable data class OfflineStatus(val status: String, val progress: Int? = null, val url: String? = null, val size: Long? = null, val error: String? = null)
@Serializable data class DownloadRecord(val id: Int, val title: String, val subtitle: String, val file: String, val size: Long = 0)
/** Serverns plan för automatisk offline-synk (GET /api/offline/sync) */
@Serializable data class SyncPlan(val enabled: Boolean = false, val quality: String = "720", val wifiOnly: Boolean = true,
    val items: List<MediaItem> = emptyList(), val remove: List<Int> = emptyList())
/** Nedladdning som lämnats till DownloadManager – sparas så att bevakningen kan fortsätta efter omstart av appen */
@Serializable data class PendingDownload(val id: Int, val dlId: Long, val title: String, val subtitle: String, val file: String)

/** Offline-nedladdningar – bra för långresor utan täckning (spelas när bilen står parkerad). */
object Downloads {
    private lateinit var ctx: Context
    val records = MutableStateFlow<List<DownloadRecord>>(emptyList())
    val active = MutableStateFlow<Map<Int, Float>>(emptyMap())
    /** Senaste fel per titel (visas i detaljvyn) */
    val errors = MutableStateFlow<Map<Int, String>>(emptyMap())
    private val pending = MutableStateFlow<List<PendingDownload>>(emptyList())
    private val prefs get() = ctx.getSharedPreferences("braxhn-dl", Context.MODE_PRIVATE)
    private val dir get() = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "offline").apply { mkdirs() }
    private val dm get() = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

    fun init(c: Context) {
        ctx = c.applicationContext
        records.value = runCatching { Api.json.decodeFromString<List<DownloadRecord>>(prefs.getString("list", "[]") ?: "[]") }.getOrDefault(emptyList())
            .filter { File(dir, it.file).exists() }
        pending.value = runCatching { Api.json.decodeFromString<List<PendingDownload>>(prefs.getString("pending", "[]") ?: "[]") }.getOrDefault(emptyList())
        // Fortsätt bevaka nedladdningar som pågick när appen stängdes
        pending.value.forEach { p ->
            active.update { it + (p.id to 0.5f) }
            launchTracked(p.id) { poll(p) }
        }
    }
    private fun save() { prefs.edit().putString("list", Api.json.encodeToString(records.value)).apply() }
    private fun savePending() { prefs.edit().putString("pending", Api.json.encodeToString(pending.value)).apply() }

    fun localFile(id: Int): File? = records.value.firstOrNull { it.id == id }?.let { File(dir, it.file) }?.takeIf { it.exists() }

    /** Startar en nedladdning i appens livslånga scope – fortsätter även när användaren lämnar vyn. */
    fun start(item: MediaItem, quality: String) {
        if (active.value.containsKey(item.id) || localFile(item.id) != null) return
        active.update { it + (item.id to 0f) }
        errors.update { it - item.id }
        launchTracked(item.id) { download(item, quality) }
    }

    private fun launchTracked(id: Int, block: suspend () -> Unit) {
        Api.appScope.launch {
            try { block() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { errors.update { it + (id to (e.message ?: e.toString())) } }
            finally { active.update { it - id } }
        }
    }

    private suspend fun download(item: MediaItem, quality: String) {
        Api.post("/api/items/${item.id}/offline", buildJsonObject { put("q", quality) })
        var st: OfflineStatus
        do {
            delay(3000)
            st = Api.get("/api/items/${item.id}/offline", mapOf("q" to quality))
            if (st.status == "error") throw ApiException(st.error ?: "Servern kunde inte skapa filen")
            val prep = (st.progress ?: 0) / 200f
            active.update { it + (item.id to prep) }
        } while (st.status != "ready")
        val rel = st.url ?: throw ApiException("Servern skickade ingen nedladdningslänk")
        val name = "${item.id}.mp4"
        val target = File(dir, name).also { it.delete() }
        val req = DownloadManager.Request(Uri.parse(Api.absolute(rel)))
            .setTitle(item.title).setDescription("BraXhn TV")
            .setDestinationUri(Uri.fromFile(target))
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
        val dlId = dm.enqueue(req)
        val p = PendingDownload(item.id, dlId, if (item.isEpisode) "${item.showTitle ?: ""} – ${item.title}" else item.title,
            if (item.isEpisode) item.sxe else item.year?.toString() ?: "", name)
        pending.update { list -> list.filter { it.id != item.id } + p }
        savePending()
        poll(p)
    }

    /** Bevakar DownloadManager tills filen är klar. Avbryts eller misslyckas den tas den bort ur DownloadManager. */
    private suspend fun poll(p: PendingDownload) {
        var completed = false
        try {
            while (true) {
                delay(1500)
                val done = dm.query(DownloadManager.Query().setFilterById(p.dlId)).use { c ->
                    if (c == null || !c.moveToFirst()) throw ApiException("Nedladdningen avbröts")
                    val status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                    val got = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                    val total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                    if (total > 0) {
                        val v = 0.5f + got.toFloat() / total / 2
                        active.update { it + (p.id to v) }
                    }
                    if (status == DownloadManager.STATUS_FAILED) throw ApiException("Nedladdningen misslyckades")
                    status == DownloadManager.STATUS_SUCCESSFUL
                }
                if (done) {
                    val target = File(dir, p.file)
                    records.update { list -> list.filter { it.id != p.id } + DownloadRecord(p.id, p.title, p.subtitle, p.file, target.length()) }
                    save()
                    completed = true
                    return
                }
            }
        } finally {
            // Avbruten (även korutinen) eller misslyckad: städa bort den halvfärdiga nedladdningen
            if (!completed) runCatching { dm.remove(p.dlId) }
            pending.update { list -> list.filter { it.id != p.id } }
            savePending()
        }
    }

    fun remove(id: Int) {
        localFile(id)?.delete()
        records.update { list -> list.filter { it.id != id } }
        save()
    }

    // ---------- automatisk synk ----------
    private val syncing = AtomicBoolean(false)
    /** Avsnitt som synken själv laddat ner – bara de tas bort automatiskt */
    private fun autoIds(): MutableSet<Int> = (prefs.getStringSet("auto", emptySet()) ?: emptySet()).mapNotNull { it.toIntOrNull() }.toMutableSet()
    private fun saveAutoIds(ids: Set<Int>) { prefs.edit().putStringSet("auto", ids.map { it.toString() }.toSet()).apply() }

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
        // Glöm avsnitt som inte längre finns (borttagna för hand eller misslyckade) – de kan laddas ner igen
        val auto = autoIds().filter { localFile(it) != null || active.value.containsKey(it) }.toMutableSet()
        val plan: SyncPlan = Api.get("/api/offline/sync", mapOf("have" to auto.sorted().joinToString(",")))
        for (id in plan.remove) if (id in auto && localFile(id) != null) { remove(id); auto.remove(id) }
        saveAutoIds(auto)
        if (!plan.enabled || plan.items.isEmpty()) return
        if (plan.wifiOnly && !unmetered()) return
        for (item in plan.items) {
            if (localFile(item.id) != null || active.value.containsKey(item.id)) continue
            auto.add(item.id)
            saveAutoIds(auto)
            start(item, plan.quality)
        }
    }
}
