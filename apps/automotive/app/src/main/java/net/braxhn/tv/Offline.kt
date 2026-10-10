package net.braxhn.tv

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File

@Serializable data class OfflineStatus(val status: String, val progress: Int? = null, val url: String? = null, val size: Long? = null, val error: String? = null)
@Serializable data class DownloadRecord(val id: Int, val title: String, val subtitle: String, val file: String, val size: Long = 0)

/** Offline-nedladdningar – bra för långresor utan täckning (spelas när bilen står parkerad). */
object Downloads {
    private lateinit var ctx: Context
    val records = MutableStateFlow<List<DownloadRecord>>(emptyList())
    val active = MutableStateFlow<Map<Int, Float>>(emptyMap())
    private val prefs get() = ctx.getSharedPreferences("braxhn-dl", Context.MODE_PRIVATE)
    private val dir get() = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "offline").apply { mkdirs() }

    fun init(c: Context) {
        ctx = c.applicationContext
        records.value = runCatching { Api.json.decodeFromString<List<DownloadRecord>>(prefs.getString("list", "[]")!!) }.getOrDefault(emptyList())
            .filter { File(dir, it.file).exists() }
    }
    private fun save() { prefs.edit().putString("list", Api.json.encodeToString(records.value)).apply() }

    fun localFile(id: Int): File? = records.value.firstOrNull { it.id == id }?.let { File(dir, it.file) }?.takeIf { it.exists() }

    suspend fun download(item: MediaItem, quality: String) {
        if (active.value.containsKey(item.id) || localFile(item.id) != null) return
        active.value = active.value + (item.id to 0f)
        try {
            Api.post("/api/items/${item.id}/offline", buildJsonObject { put("q", quality) })
            var st: OfflineStatus
            do {
                delay(3000)
                st = Api.get("/api/items/${item.id}/offline", mapOf("q" to quality))
                if (st.status == "error") throw ApiException(st.error ?: "Servern kunde inte skapa filen")
                active.value = active.value + (item.id to (st.progress ?: 0) / 200f)
            } while (st.status != "ready")
            val name = "${item.id}.mp4"
            val target = File(dir, name).also { it.delete() }
            val dm = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val req = DownloadManager.Request(Uri.parse(Api.absolute(st.url!!)))
                .setTitle(item.title).setDescription("BraXhn TV")
                .setDestinationUri(Uri.fromFile(target))
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            val dlId = dm.enqueue(req)
            while (true) {
                delay(1500)
                dm.query(DownloadManager.Query().setFilterById(dlId)).use { c ->
                    if (!c.moveToFirst()) throw ApiException("Nedladdningen avbröts")
                    val status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                    val done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                    val total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                    if (total > 0) active.value = active.value + (item.id to 0.5f + done.toFloat() / total / 2)
                    if (status == DownloadManager.STATUS_FAILED) throw ApiException("Nedladdningen misslyckades")
                    if (status == DownloadManager.STATUS_SUCCESSFUL) {
                        records.value = records.value.filter { it.id != item.id } + DownloadRecord(item.id,
                            if (item.isEpisode) "${item.showTitle} – ${item.title}" else item.title,
                            if (item.isEpisode) item.sxe else item.year?.toString() ?: "", name, target.length())
                        save()
                        return
                    }
                }
            }
        } finally {
            active.value = active.value - item.id
        }
    }

    fun remove(id: Int) {
        localFile(id)?.delete()
        records.value = records.value.filter { it.id != id }
        save()
    }
}
