package net.braxhn.tv

import android.app.Application
import android.content.Context
import android.media.MediaCodecList
import android.net.Uri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

@Serializable data class ListenPrefs(val normalize: Boolean = true, val skipBack: Int = 15, val skipForward: Int = 30, val skipSilence: Boolean = false)

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Api.init(this)
        Downloads.init(this)
    }
}

// ---------- modeller (matchar serverns JSON) ----------

@Serializable data class UserInfo(val id: Int, val name: String, @SerialName("is_admin") val isAdmin: Int = 0)
@Serializable data class ServerStatus(val needsSetup: Boolean = false, val version: String = "", val user: UserInfo? = null)
@Serializable data class LoginResponse(val token: String, val user: UserInfo)
@Serializable data class Library(val id: Int, val name: String, val type: String, val count: Int? = null)
@Serializable data class Marker(val start: Double, val end: Double)

@Serializable data class AudioStream(
    val index: Int, val codec: String? = null, val lang: String? = null, val title: String? = null,
    val channels: Int? = null, val default: Boolean? = null
) {
    val label: String get() = listOfNotNull(lang?.uppercase() ?: "Ljud", title, codec?.uppercase(), channels?.let { "${it}ch" }).joinToString(" · ")
}

@Serializable data class SubtitleTrack(
    val id: String, val label: String, val lang: String? = null, val forced: Boolean? = null, val bitmap: Boolean? = null
)

@Serializable data class CastMember(val id: Int, val name: String, val role: String = "cast", val character: String? = null)

/** Rollistan som en textrad, t.ex. "Regi: X · Medverkande: A, B, C" (null om den saknas) */
fun castLine(cast: List<CastMember>?): String? {
    if (cast.isNullOrEmpty()) return null
    val lead = cast.filter { it.role != "cast" }.map { it.name }.distinct()
    val actors = cast.filter { it.role == "cast" }.take(8).map { it.name }
    val parts = mutableListOf<String>()
    if (lead.isNotEmpty()) parts.add((if (cast.any { it.role == "creator" }) "Skapad av: " else "Regi: ") + lead.joinToString(", "))
    if (actors.isNotEmpty()) parts.add("Medverkande: " + actors.joinToString(", "))
    return if (parts.isEmpty()) null else parts.joinToString("  ·  ")
}

@Serializable data class ItemRef(val id: Int, val season: Int? = null, val episode: Int? = null, val position: Double? = null)

@Serializable data class MediaItem(
    val id: Int, val kind: String, val title: String, val year: Int? = null,
    val poster: Boolean = false, val backdrop: Boolean = false, val thumb: Boolean = false,
    val duration: Double? = null, val rating: Double? = null, val overview: String? = null, val hdr: String? = null,
    val season: Int? = null, val episode: Int? = null, val show: Int? = null, val showTitle: String? = null,
    val position: Double? = null, val watched: Boolean? = null, val episodes: Int? = null, val watchedEpisodes: Int? = null,
    val intro: Marker? = null, val credits: Double? = null,
    val children: List<MediaItem>? = null, val next: ItemRef? = null,
    val audio: List<AudioStream>? = null, val subtitles: List<SubtitleTrack>? = null,
    val nextId: Int? = null, val prevId: Int? = null,
    val cast: List<CastMember>? = null, val inWatchlist: Boolean? = null, val onThisDay: DayNote? = null
) {
    val isShow get() = kind == "show"
    val isEpisode get() = kind == "episode"
    val sxe: String get() = if (season != null && episode != null) "S%02dE%02d".format(season, episode) else ""
    val progress: Float get() = if (position != null && duration != null && duration > 0) (position / duration).toFloat().coerceIn(0f, 1f) else 0f
    val subtitleLine: String get() = when {
        isEpisode -> listOfNotNull(showTitle, sxe).joinToString(" · ")
        isShow -> listOfNotNull(year?.toString(), episodes?.let { "$it avsnitt" }).joinToString(" · ")
        else -> year?.toString() ?: ""
    }
}

@Serializable data class HomeRow(val library: Library, val title: String, val items: List<MediaItem>)
@Serializable data class HomeResponse(@SerialName("continue") val continueWatching: List<MediaItem>, val rows: List<HomeRow>,
    /** Nya avsnitt av serier man följer (saknas hos äldre servrar) */
    val forYou: List<MediaItem> = emptyList())
@Serializable data class LibraryItems(val library: Library, val items: List<MediaItem>)
@Serializable data class PlaybackSubtitle(val id: String, val label: String, val lang: String? = null, val url: String)
@Serializable data class Playback(
    val mode: String, val url: String, val reasons: List<String> = emptyList(), val subtitles: List<PlaybackSubtitle> = emptyList(),
    val intro: Marker? = null, val recap: Marker? = null, val credits: Double? = null, val duration: Double? = null, val quality: String? = null,
    val remote: Boolean? = null, val tonemap: Boolean? = null,
    val chapters: List<Chapter> = emptyList(), val audio: List<AudioStream> = emptyList(), val audioSelected: String? = null, val preroll: List<PrerollEntry> = emptyList()
)
@Serializable data class Chapter(val start: Double, val end: Double, val title: String)

class ApiException(msg: String, val need2fa: Boolean = false, val needPassword: Boolean = false) : IOException(msg)

@Serializable data class TokenResponse(val token: String)

// ---------- klient ----------

object Api {
    /** Lever hela appens livstid – används för rapporter som måste gå iväg även när en vy stängs. */
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var ctx: Context
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }
    private val prefs get() = ctx.getSharedPreferences("braxhn", Context.MODE_PRIVATE)

    val server = MutableStateFlow("")
    val token = MutableStateFlow<String?>(null)
    /** Kortlivad token som bara gäller bilder – kontots token skickas aldrig i URL:er. */
    val imageToken = MutableStateFlow<String?>(null)
    private var imageTokenAt = 0L
    var quality: String
        get() = prefs.getString("quality", "auto") ?: "auto"
        set(v) { prefs.edit().putString("quality", v).apply() }
    var subtitleLang: String
        get() = prefs.getString("sublang", "") ?: ""
        set(v) { prefs.edit().putString("sublang", v).apply() }

    // ---- lyssningsinställningar (sparas per användare på servern, cachas här för musiktjänsten) ----
    val skipBackChoices = listOf(5, 10, 15, 30, 45, 60)
    val skipForwardChoices = listOf(10, 15, 30, 45, 60, 90)
    val skipBack: Int get() = prefs.getInt("skipBack", 15).takeIf { it in skipBackChoices } ?: 15
    val skipForward: Int get() = prefs.getInt("skipForward", 30).takeIf { it in skipForwardChoices } ?: 30
    val skipSilence: Boolean get() = prefs.getBoolean("skipSilence", false)
    val normalize: Boolean get() = prefs.getBoolean("normalize", true)

    private fun storeListenPrefs(p: ListenPrefs) {
        prefs.edit().putInt("skipBack", p.skipBack).putInt("skipForward", p.skipForward)
            .putBoolean("skipSilence", p.skipSilence).putBoolean("normalize", p.normalize).apply()
    }

    /** Läser lyssningsinställningarna från servern (tyst vid fel – de cachade värdena gäller då). */
    suspend fun refreshListenPrefs() {
        if (token.value == null) return
        runCatching { get<ListenPrefs>("/api/me/listening") }.getOrNull()?.let { storeListenPrefs(it) }
    }

    /** Sparar ändrade lyssningsinställningar på servern och lokalt. */
    suspend fun saveListenPrefs(body: JsonObject) {
        val p = json.decodeFromString<ListenPrefs>(request("/api/me/listening", "PUT", body = body))
        storeListenPrefs(p)
    }

    fun init(c: Context) {
        ctx = c.applicationContext
        server.value = prefs.getString("server", "") ?: ""
        token.value = prefs.getString("token", null)
    }

    fun normalize(input: String): String {
        var s = input.trim().trimEnd('/')
        if (!s.startsWith("http://", true) && !s.startsWith("https://", true)) s = "http://$s"
        val u = Uri.parse(s)
        if (u.scheme == "http" && u.port == -1) s = "$s:8420"
        return s
    }

    fun url(path: String, query: Map<String, String?> = emptyMap()): String {
        val b = Uri.parse(server.value + path).buildUpon()
        query.forEach { (k, v) -> if (v != null) b.appendQueryParameter(k, v) }
        return b.build().toString()
    }

    fun absolute(relative: String) = server.value + relative

    fun imageUrl(item: MediaItem, landscape: Boolean = false): String? {
        val type = if (landscape) when { item.thumb -> "thumb"; item.backdrop -> "backdrop"; item.poster -> "poster"; else -> null }
                   else when { item.poster -> "poster"; item.thumb -> "thumb"; else -> null }
        val t = imageToken.value ?: return null
        return type?.let { url("/api/image/${item.id}/$it", mapOf("t" to t)) }
    }

    private suspend fun request(path: String, method: String = "GET", query: Map<String, String?> = emptyMap(), body: JsonObject? = null): String =
        withContext(Dispatchers.IO) {
            val c = URL(url(path, query)).openConnection() as HttpURLConnection
            try {
                c.requestMethod = method
                c.connectTimeout = 15000; c.readTimeout = 30000
                token.value?.let { c.setRequestProperty("Authorization", "Bearer $it") }
                if (body != null) {
                    c.doOutput = true
                    c.setRequestProperty("Content-Type", "application/json")
                    c.outputStream.use { it.write(body.toString().toByteArray()) }
                }
                val code = c.responseCode
                val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
                if (code == 401 && token.value != null && path != "/api/login" && path != "/api/media-token" && path != "/api/profiles/switch") { clearLogin(); throw ApiException("Du har loggats ut") }
                if (code !in 200..299) {
                    val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
                    val msg = obj?.get("error")?.jsonPrimitive?.content
                    val need2fa = obj?.get("need2fa")?.jsonPrimitive?.content == "true"
                    throw ApiException(msg ?: "Servern svarade $code", need2fa, obj?.get("needPassword")?.jsonPrimitive?.content == "true")
                }
                text
            } finally { c.disconnect() }
        }

    suspend inline fun <reified T> get(path: String, query: Map<String, String?> = emptyMap()): T =
        json.decodeFromString(requestPublic(path, "GET", query, null))

    suspend fun post(path: String, body: JsonObject = JsonObject(emptyMap())): String = request(path, "POST", body = body)

    // Publik wrapper så att inline-funktionen ovan kan anropa den privata
    suspend fun requestPublic(path: String, method: String, query: Map<String, String?>, body: JsonObject?) = request(path, method, query, body)

    suspend fun login(serverInput: String, name: String, password: String, code: String? = null) {
        server.value = normalize(serverInput)
        val st: ServerStatus = get("/api/status")
        if (st.needsSetup) throw ApiException("Servern är inte konfigurerad – öppna den i en webbläsare först.")
        val r: LoginResponse = json.decodeFromString(request("/api/login", "POST", body = buildJsonObject {
            put("name", name); put("password", password); put("app", true)
            if (!code.isNullOrBlank()) put("code", code.trim())
        }))
        prefs.edit().putString("server", server.value).putString("token", r.token).apply()
        token.value = r.token
        refreshImageToken(force = true)
    }

    /** Hämtar ny bildtoken (gäller 7 dygn) om den saknas eller är äldre än ett dygn. */
    suspend fun refreshImageToken(force: Boolean = false) {
        if (token.value == null) return
        if (!force && imageToken.value != null && System.currentTimeMillis() - imageTokenAt < 86_400_000L) return
        runCatching { json.decodeFromString<TokenResponse>(post("/api/media-token")) }.getOrNull()?.let {
            imageToken.value = it.token; imageTokenAt = System.currentTimeMillis()
        }
    }

    fun clearLogin() {
        prefs.edit().remove("token").apply()
        token.value = null
        imageToken.value = null
    }

    suspend fun logout() {
        runCatching { post("/api/logout") }
        clearLogin()
    }

    /** Vilka format den här enheten avkodar själv (resten remuxas/omkodas av servern). */
    /** Enhetens avkodare ändras inte under körning – räkna upp dem en gång (MediaCodecList är långsam). */
    private val decoderTypes: Set<String> by lazy {
        runCatching {
            MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }.flatMap { it.supportedTypes.toList() }.map { it.lowercase() }.toSet()
        }.getOrDefault(emptySet())
    }

    fun capabilities(audio: Int?, sub: SubtitleTrack?): Map<String, String?> {
        val types = decoderTypes
        val v = mutableListOf("h264")
        if ("video/hevc" in types) v += "hevc"
        if ("video/x-vnd.on2.vp9" in types) v += "vp9"
        if ("video/av01" in types) v += "av1"
        // Dolby/DTS/TrueHD: egen avkodare eller bitström till förstärkaren (TvOutput) – då skickas ljudet orört
        val a = mutableListOf("aac", "mp3", "opus", "flac", "vorbis") + TvOutput.surroundCodecs(ctx, types)
        // hdr/hdrt/dv efter skärmen; atrack=1: spelaren väljer ljudspår själv i en direktuppspelad fil
        return mapOf(
            "c" to "mp4,mkv,webm", "v" to v.joinToString(","), "a" to a.joinToString(","), "atrack" to "1",
            "q" to quality.takeIf { it != "auto" }, "audio" to audio?.toString(),
            "sub" to sub?.takeIf { it.bitmap == true }?.id
        ) + TvOutput.hdrQuery(ctx, types)
    }

    suspend fun reportProgress(id: Int, position: Double, duration: Double) {
        runCatching { post("/api/items/$id/progress", buildJsonObject { put("position", position); put("duration", duration) }) }
    }
    suspend fun setWatched(id: Int, watched: Boolean) {
        post("/api/items/$id/watched", buildJsonObject { put("watched", JsonPrimitive(watched)) })
    }

    // ---- inloggning med kod (sist i objektet så att radhänvisningarna i test/contracts/apps.json står kvar) ----

    /** Startar inloggning med kod: servern ger en sexsiffrig kod som godkänns från en inloggad telefon eller dator. */
    suspend fun startQuickConnect(serverInput: String): QuickConnectStart {
        server.value = normalize(serverInput)
        val st: ServerStatus = get("/api/status")
        if (st.needsSetup) throw ApiException("Servern är inte konfigurerad – öppna den i en webbläsare först.")
        val pm = ctx.packageManager
        val kind = when {
            pm.hasSystemFeature("android.hardware.type.automotive") -> "Bil"
            pm.hasSystemFeature("android.software.leanback") -> "Google TV"
            else -> "Android"
        }
        return json.decodeFromString<QuickConnectStart>(request("/api/quickconnect", "POST", body = buildJsonObject {
            put("app", true); put("name", android.os.Build.MODEL ?: kind); put("device", kind)
        }))
    }

    /** Frågar om koden har godkänts. Vid "approved" sparas token som vid vanlig inloggning. Returnerar status. */
    suspend fun pollQuickConnect(secret: String): String {
        val r: QuickConnectPoll = get("/api/quickconnect/$secret")
        val t = r.token
        if (r.status == "approved" && t != null) {
            prefs.edit().putString("server", server.value).putString("token", t).apply()
            token.value = t
            refreshImageToken(force = true)
        }
        return r.status
    }

    // ---- profiler, Min lista och tittarkomfort (efter inloggning med kod av samma skäl) ----

    /** Byter profil i hushållet. Servern ger en ny token för profilen; den gamla slutar gälla. Kastar ApiException vid fel PIN/lösenord. */
    suspend fun switchProfile(id: Int, pin: String?, password: String?) {
        val r: LoginResponse = json.decodeFromString(request("/api/profiles/switch", "POST", body = buildJsonObject {
            put("id", id)
            if (!pin.isNullOrBlank()) put("pin", pin.trim())
            if (!password.isNullOrBlank()) put("password", password)
        }))
        prefs.edit().putString("token", r.token).apply()
        token.value = r.token
        refreshImageToken(force = true)
    }

    /** Lägger till i eller tar bort från Min lista (ett avsnitt räknas som hela serien på servern). */
    suspend fun setWatchlist(id: Int, add: Boolean) {
        post("/api/items/$id/watchlist", buildJsonObject { put("add", JsonPrimitive(add)) })
    }

    /** Nattläge (jämnare ljudnivå) och tydligare dialog – servern filtrerar ljudet, sparas per enhet */
    var nightMode: Boolean
        get() = prefs.getBoolean("night", false)
        set(v) { prefs.edit().putBoolean("night", v).apply() }
    var dialogBoost: Boolean
        get() = prefs.getBoolean("dialog", false)
        set(v) { prefs.edit().putBoolean("dialog", v).apply() }
    fun comfortQuery(): Map<String, String?> = mapOf("night" to (if (nightMode) "1" else null), "dialog" to (if (dialogBoost) "1" else null))
}

fun formatTime(s: Double): String {
    val t = s.toInt().coerceAtLeast(0)
    val h = t / 3600; val m = (t % 3600) / 60; val sec = t % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}
fun formatDuration(s: Double?): String {
    if (s == null || s <= 0) return ""
    val m = (s / 60).toInt().coerceAtLeast(1)
    return if (m >= 60) "${m / 60} h ${m % 60} min" else "$m min"
}

/** Inloggning med kod (POST /api/quickconnect): koden visas, nyckeln används för att polla */
@Serializable data class QuickConnectStart(val secret: String, val code: String)
/** GET /api/quickconnect/:secret – status pending/approved/expired; token och user bara vid approved */
@Serializable data class QuickConnectPoll(val status: String, val token: String? = null, val user: UserInfo? = null)
