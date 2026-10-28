package net.braxhn.tv

import android.content.Context
import android.media.AudioManager
import android.net.Uri
import android.widget.Toast
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material.icons.filled.StarHalf
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem as M3Item
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// ---------- modeller (alla fält är nya och valfria – äldre servrar saknar dem) ----------

/** Extramaterial på titelsidan (/api/items/:id extras): trailer, featurette, bakom kulisserna … */
@Serializable data class ExtraFile(val id: Int, val type: String = "other", val group: String? = null, val name: String = "Extramaterial", val size: Long? = null)
/** Temamusik (/api/items/:id theme): play = profilens val (standard på för serier, av för filmer) */
@Serializable data class ThemeInfo(val play: Boolean = false)
/** GET /api/trailers/:id/play – adress med en token som bara gäller filen */
@Serializable data class ExtraPlay(val url: String, val mime: String? = null)
/** Familjefiltret i /api/items/:id/playback: servern tystar själv (server), skip = scener att hoppa över i läget "skip" */
@Serializable data class FamilySkip(val id: Int? = null, val start: Double, val end: Double, val label: String? = null)
@Serializable data class FamilyPlan(val mode: String? = null, val server: Boolean? = null, val ready: Boolean? = null, val skip: List<FamilySkip> = emptyList())
/** Automatisk undertextsynk (/api/items/:id/subs/:sid/sync) */
@Serializable data class SubSyncResult(val offset: Double? = null, val ratio: Double? = null, val confident: Boolean? = null)
@Serializable data class SubSyncJob(val state: String, val progress: Double? = null, val error: String? = null, val result: SubSyncResult? = null)
@Serializable data class SubSyncStatus(val syncable: Boolean = false, val job: SubSyncJob? = null)
/** Repliksökning (GET /api/search/lines) */
@Serializable data class SubLine(val id: Int, val kind: String? = null, val title: String? = null, val year: Int? = null, val episodeTitle: String? = null,
                                 val season: Int? = null, val episode: Int? = null, val t: Double, val line: String, val before: String? = null,
                                 val after: String? = null, val marks: List<List<Int>> = emptyList())
/** indexing är ett objekt (administratören) eller true/false/null – läses bara som "pågår" */
@Serializable data class LinesStatus(val enabled: Boolean = true, val indexing: JsonElement? = null) {
    val busy: Boolean get() { val i = indexing; return i != null && i !is JsonNull && (i as? JsonPrimitive)?.booleanOrNull != false }
}
@Serializable data class LinesResult(val lines: List<SubLine> = emptyList(), val status: LinesStatus? = null)
/** IPTV: film/avsnitt (POST /api/iptv/vod/:id/play, /episodes/:eid/play) och catch-up (POST /api/iptv/programs/:pid/catchup) */
@Serializable data class VodPlay(val direct: Boolean = false, val url: String, val sid: Int? = null, val offset: Double? = null, val duration: Double? = null, val position: Double? = null)
@Serializable data class CatchupPlay(val sid: Int? = null, val url: String, val offset: Double? = null, val duration: Double? = null)

/** Syntolkning (ljudbeskrivning): ffprobes visual_impaired eller spårets titel – samma regel som servern (playprefs.js) */
val AudioStream.isAudioDesc: Boolean
    get() = vi == true || AD_TITLE.containsMatchIn(title ?: "") || Regex("\\bAD\\b").containsMatchIn(title ?: "")
private val AD_TITLE = Regex("syntolk|beskrivning|description", RegexOption.IGNORE_CASE)

/** Tangenter från fjärrkontrollen före Compose/PlayerView (kanalbyte i live-spelaren). Sätts av den vy som behöver dem. */
object KeyHook {
    @Volatile var handler: ((android.view.KeyEvent) -> Boolean)? = null
}

// ---------- API-anrop (via den publika wrappern; Api-objektet lämnas orört för kontraktets radhänvisningar) ----------

/** Eget betyg i stjärnor 1–5 med halva steg; 0 tar bort betyget. */
suspend fun Api.setRating(id: Int, stars: Double) {
    requestPublic("/api/items/$id/rating", "PUT", emptyMap(), buildJsonObject { put("rating", stars) })
}

/** Startar automatisk synk av en undertextfil mot ljudet och väntar tills den är klar (högst 15 min). */
suspend fun Api.autoSyncSubtitle(itemId: Int, sid: String, audio: Int?, onProgress: (Double) -> Unit): SubSyncJob? {
    val path = "/api/items/$itemId/subs/${Uri.encode(sid)}/sync"
    var st = json.decodeFromString<SubSyncStatus>(requestPublic(path, "POST", emptyMap(), buildJsonObject { if (audio != null) put("audio", audio) }))
    var n = 0
    while (st.job != null && (st.job?.state == "queued" || st.job?.state == "running") && n++ < 450) {
        onProgress(st.job?.progress ?: 0.0)
        delay(2000)
        st = get<SubSyncStatus>(path)
    }
    return st.job
}

// ---------- titelsidan: betyg, extramaterial, temamusik ----------

private val StarColor = Color(0xFFFFC94A)

/** Mitt betyg: fem stjärnor. Tryck på samma stjärna igen för en halv, en gång till för att ta bort. Fungerar med D-pad. */
@Composable
fun RatingRow(item: MediaItem) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var rating by remember(item.id) { mutableStateOf(item.userRating ?: 0.0) }
    fun choose(k: Int) {
        val old = rating
        val v: Double = if (old == k.toDouble()) k - 0.5 else if (old == k - 0.5) 0.0 else k.toDouble()
        rating = v
        scope.launch {
            val r = runCatching { Api.setRating(item.id, v) }
            if (r.isFailure) { rating = old; Toast.makeText(ctx, "Kunde inte spara betyget: ${r.exceptionOrNull()?.message ?: ""}", Toast.LENGTH_SHORT).show() }
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Mitt betyg", color = Color.Gray, modifier = Modifier.padding(end = 8.dp))
        for (k in 1..5) {
            val full = rating >= k
            val half = !full && rating >= k - 0.5
            IconButton(onClick = { choose(k) }, modifier = Modifier.size(48.dp).focusRing(RoundedCornerShape(24.dp))) {
                Icon(if (full) Icons.Filled.Star else if (half) Icons.Filled.StarHalf else Icons.Filled.StarBorder,
                    "$k stjärnor", tint = if (full || half) StarColor else Color.Gray, modifier = Modifier.size(30.dp))
            }
        }
        if (rating > 0) Text(starsLabel(rating), color = Color.Gray, modifier = Modifier.padding(start = 6.dp))
    }
}

private fun starsLabel(v: Double): String = (if (v % 1.0 == 0.0) v.toInt().toString() else "%.1f".format(v).replace('.', ',')) + " av 5"

/** Extramaterial som hylla på titelsidan; spelas i en enkel spelare (Screen.Stream "extra") */
@Composable
fun ExtrasShelf(list: List<ExtraFile>, push: (Screen) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Extramaterial", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            items(list, key = { e -> e.id }) { e ->
                Row(Modifier.width(260.dp).clip(RoundedCornerShape(10.dp)).focusRing().background(Surface2)
                    .clickable { push(Screen.Stream("extra", e.id, e.name)) }.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.PlayCircle, null, tint = Accent, modifier = Modifier.size(36.dp))
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(e.name, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(e.group ?: "Extramaterial", color = Color.Gray, fontSize = 13.sp, maxLines = 1)
                    }
                }
            }
        }
    }
}

/** Temamusik som redan spelats under den här körningen (spelas inte igen när man kommer tillbaka till sidan) */
object ThemeMusic {
    val played: MutableSet<Int> = java.util.Collections.synchronizedSet(HashSet<Int>())
}
private const val THEME_VOLUME = 0.22f

/** Sänker volymen stegvis och pausar (spelaren släpps av den som anropar) */
private suspend fun fadeOut(p: ExoPlayer) {
    var v: Float = p.volume
    while (v > 0.01f) { v = (v - 0.025f).coerceAtLeast(0f); p.volume = v; delay(40) }
    p.pause()
}

/**
 * Temamusik på titelsidan enligt profilens val (theme.play): låg volym, tonas in och ut och spelas en gång.
 * Spelas inte om annan musik redan hörs (t.ex. bilens mediaspelare).
 */
@OptIn(UnstableApi::class)
@Composable
fun ThemeMusicEffect(item: MediaItem) {
    val context = LocalContext.current
    val play: Boolean = remember(item.id) {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        item.theme?.play == true && am?.isMusicActive != true && ThemeMusic.played.add(item.id)
    }
    if (!play) return
    DisposableEffect(item.id) {
        val tok: String? = Api.token.value
        val http: DefaultHttpDataSource.Factory = DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true).setUserAgent("BraXhnTV-Android")
        if (tok != null) http.setDefaultRequestProperties(mapOf("Authorization" to "Bearer $tok"))
        val p: ExoPlayer = ExoPlayer.Builder(context).setMediaSourceFactory(DefaultMediaSourceFactory(http)).build()
        // Ingen ljudfokus: temat ska inte pausa något annat
        p.setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), false)
        p.volume = 0f
        p.setMediaItem(M3Item.fromUri(Api.url("/api/items/${item.id}/theme")))
        p.prepare()
        p.playWhenReady = true
        val job: Job = Api.appScope.launch(Dispatchers.Main) {
            var v = 0f
            while (v < THEME_VOLUME) { delay(80); v = (v + 0.01f).coerceAtMost(THEME_VOLUME); p.volume = v }
            // Tonas ut de sista sekunderna (eller efter 45 s)
            while (p.playbackState != Player.STATE_ENDED) {
                delay(500)
                val d: Long = p.duration
                val pos: Long = p.currentPosition
                if ((d > 0 && d - pos < 4000) || pos > 45_000) break
            }
            fadeOut(p)
        }
        onDispose {
            job.cancel()
            Api.appScope.launch(Dispatchers.Main) { runCatching { fadeOut(p) }; p.release() }
        }
    }
}

// ---------- repliksökning ----------

/** Sökresultat för repliker: titel, repliken (träffen markerad) och tidpunkten. Spelar från strax före repliken. */
@Composable
fun LinesResults(q: String, push: (Screen) -> Unit) {
    var res by remember { mutableStateOf<LinesResult?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(q) {
        error = null
        if (q.length < 3) { res = null; return@LaunchedEffect }
        delay(350)
        try { res = Api.get<LinesResult>("/api/search/lines", mapOf("q" to q, "limit" to "40")) }
        catch (e: Exception) { res = null; error = if (e.message?.contains("404") == true) "Servern stöder inte repliksökning." else e.message }
    }
    val r = res
    when {
        error != null -> ErrorText(error ?: "")
        q.length < 3 -> ErrorText("Skriv en replik, t.ex. \"jag är din far\".")
        r == null -> Loading()
        r.lines.isEmpty() -> ErrorText(when {
            r.status?.enabled == false -> "Repliksökningen är avstängd på servern."
            r.status?.busy == true -> "Undertexterna läses in – försök igen om en stund."
            else -> "Ingen replik hittades."
        })
        else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(r.lines) { l ->
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).focusRing().background(Surface2)
                    .clickable { push(Screen.Play(l.id, (l.t - 2).coerceAtLeast(0.0), null, null)) }.padding(14.dp)) {
                    val head = if (l.kind == "episode")
                        listOfNotNull(l.title, if (l.season != null && l.episode != null) "S%02dE%02d".format(l.season, l.episode) else null, l.episodeTitle).joinToString(" · ")
                    else listOfNotNull(l.title, l.year?.toString()).joinToString(" · ")
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(head, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        Text(formatTime(l.t), color = Color.Gray, fontSize = 13.sp)
                    }
                    l.before?.let { b -> Text(b, color = Color.Gray, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    Text(marked(l.line, l.marks), fontSize = 17.sp)
                    l.after?.let { a -> Text(a, color = Color.Gray, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
            }
        }
    }
}

/** Repliken med sökorden markerade (marks = [[start, slut]] som teckenindex) */
private fun marked(line: String, marks: List<List<Int>>): AnnotatedString = buildAnnotatedString {
    append(line)
    for (m in marks) {
        if (m.size < 2) continue
        val s = m[0].coerceIn(0, line.length)
        val e = m[1].coerceIn(s, line.length)
        if (e > s) addStyle(SpanStyle(color = Accent, fontWeight = FontWeight.Bold), s, e)
    }
}

// ---------- enkel spelare: extramaterial, IPTV-filmer/avsnitt och catch-up ----------

/**
 * Spelar extramaterial (kind "extra"), en IPTV-film ("vod"), ett IPTV-avsnitt ("vodep") eller catch-up ("catchup").
 * IPTV-sessioner (HLS) stängs på servern när spelaren stängs; framsteg för filmer/avsnitt sparas var tionde sekund.
 */
@OptIn(UnstableApi::class)
@Composable
fun StreamPlayerScreen(req: Screen.Stream, onClose: () -> Unit) {
    val context = LocalContext.current
    var error by remember(req) { mutableStateOf<String?>(null) }
    var sid by remember(req) { mutableStateOf<Int?>(null) }
    var offset by remember(req) { mutableStateOf(0.0) }
    var duration by remember(req) { mutableStateOf<Double?>(null) }
    val progressKind: String? = when (req.kind) { "vod" -> "movie"; "vodep" -> "episode"; else -> null }
    val player: ExoPlayer = remember {
        val http = DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true).setUserAgent("BraXhnTV-Android")
        ExoPlayer.Builder(context).setMediaSourceFactory(DefaultMediaSourceFactory(http)).build().apply {
            setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
        }
    }

    fun report() {
        val k = progressKind ?: return
        val pos: Double = offset + player.currentPosition / 1000.0
        if (pos < 5) return
        val d: Double? = duration ?: player.duration.takeIf { it > 0 }?.let { ms -> ms / 1000.0 + offset }
        Api.appScope.launch {
            runCatching { Api.post("/api/iptv/progress", buildJsonObject { put("kind", k); put("id", req.id); put("position", pos); if (d != null) put("duration", d) }) }
        }
    }

    LaunchedEffect(req) {
        try {
            val start: Double = req.start
            val url: String
            var hls = false
            var seekMs = 0L
            when (req.kind) {
                "extra" -> {
                    val r: ExtraPlay = Api.get("/api/trailers/${req.id}/play")
                    url = r.url
                }
                "catchup" -> {
                    val r = Api.json.decodeFromString<CatchupPlay>(Api.requestPublic("/api/iptv/programs/${req.id}/catchup", "POST",
                        mapOf("offset" to start.toInt().toString()), JsonObject(emptyMap())))
                    url = r.url; hls = true; sid = r.sid; offset = r.offset ?: start; duration = r.duration
                }
                else -> {
                    val path = if (req.kind == "vodep") "/api/iptv/episodes/${req.id}/play" else "/api/iptv/vod/${req.id}/play"
                    val q: Map<String, String?> = if (start > 1) mapOf("ss" to start.toInt().toString()) else emptyMap()
                    val r = Api.json.decodeFromString<VodPlay>(Api.requestPublic(path, "POST", q, JsonObject(emptyMap())))
                    url = r.url; duration = r.duration
                    if (r.direct) seekMs = (start * 1000).toLong()
                    else { hls = true; sid = r.sid; offset = r.offset ?: 0.0 }
                }
            }
            val mi = M3Item.Builder().setUri(Uri.parse(Api.absolute(url))).apply { if (hls) setMimeType(MimeTypes.APPLICATION_M3U8) }.build()
            // HLS-sessionerna är EVENT-listor (växer medan servern läser): börja från början, inte vid "live"-kanten
            player.setMediaItem(mi, seekMs)
            player.prepare(); player.playWhenReady = true
        } catch (e: Exception) { error = e.message ?: e.toString() }
    }
    LaunchedEffect(req) {
        while (true) { delay(10_000); if (player.isPlaying) report() }
    }
    DisposableEffect(req) {
        val l = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) { if (state == Player.STATE_ENDED) { report(); onClose() } }
            override fun onPlayerError(e: androidx.media3.common.PlaybackException) { error = e.errorCodeName }
        }
        player.addListener(l)
        onDispose { player.removeListener(l) }
    }
    val latestReport by rememberUpdatedState<() -> Unit>({ report() })
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, ev -> if (ev == Lifecycle.Event.ON_PAUSE) { player.pause(); latestReport() } }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs) }
    }
    val latestSid by rememberUpdatedState(sid)
    DisposableEffect(Unit) {
        onDispose {
            latestReport()
            player.release()
            latestSid?.let { s -> Api.appScope.launch { runCatching { Api.post("/api/iptv/play/$s/stop") } } }
        }
    }
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(factory = { c -> PlayerView(c).apply { this.player = player; keepScreenOn = true } }, modifier = Modifier.fillMaxSize())
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onClose, modifier = Modifier.size(56.dp).focusRing(RoundedCornerShape(28.dp)).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                Icon(Icons.Filled.Close, "Stäng", tint = Color.White)
            }
            Spacer(Modifier.width(12.dp))
            Text(req.title + if (req.kind == "catchup") "  · Catch-up" else "", color = Color.White, fontWeight = FontWeight.SemiBold)
        }
        error?.let { Text(it, color = Color.White, modifier = Modifier.align(Alignment.Center).background(Surface2, RoundedCornerShape(12.dp)).padding(20.dp)) }
    }
}
