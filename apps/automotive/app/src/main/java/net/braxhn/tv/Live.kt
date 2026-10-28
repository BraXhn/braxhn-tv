package net.braxhn.tv

import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import androidx.annotation.OptIn
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.C
import androidx.media3.common.MediaItem as M3Item
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ---- modeller (matchar /api/live och /api/dvr) ----
@Serializable data class LiveProg(val id: Int, val start: Long, val stop: Long, val title: String, val subtitle: String? = null)
@Serializable data class LiveChannel(val id: Int, val number: String? = null, val name: String, val logo: String? = null, val now: LiveProg? = null, val next: LiveProg? = null)
@Serializable data class LiveChannels(val channels: List<LiveChannel> = emptyList())
@Serializable data class PlayUrl(val url: String, val live: Boolean? = null)
@Serializable data class Recording(val id: Int, val title: String, val subtitle: String? = null, @kotlinx.serialization.SerialName("channel_name") val channel: String? = null,
                                   val start: Long, val stop: Long, val status: String, val size: Long? = null, val error: String? = null, val plan: String? = null, val planText: String? = null, val watchable: Boolean? = null, val commercials: List<Marker> = emptyList())
@Serializable data class DvrList(val scheduled: List<Recording> = emptyList(), val done: List<Recording> = emptyList(), val comskip: ComskipInfo? = null)
/** Reklamavbrott: autoSkip = hoppa över automatiskt (serverns standard) */
@Serializable data class ComskipInfo(val enabled: Boolean = false, val autoSkip: Boolean = false)

/** Körs appen på en TV (Google TV / Android TV)? */
fun isTv(ctx: Context) = ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)

/** Tydlig ram runt det som har fokus – behövs för fjärrkontroll (D-pad) på TV */
fun Modifier.focusRing(shape: RoundedCornerShape = RoundedCornerShape(10.dp)): Modifier = composed {
    var focused by remember { mutableStateOf(false) }
    this.onFocusChanged { focused = it.isFocused }.border(BorderStroke(if (focused) 3.dp else 0.dp, if (focused) Color.White else Color.Transparent), shape)
}

private val hm = SimpleDateFormat("HH:mm", Locale("sv", "SE"))
private fun t(s: Long) = hm.format(Date(s * 1000))
private val recDay = SimpleDateFormat("EEE d MMM HH:mm", Locale("sv", "SE"))

/** Enkel kanallista – används när servern saknar /api/iptv (äldre servrar) */
@Composable
fun ChannelGrid(onPlay: (Screen.LivePlay) -> Unit, push: (Screen) -> Unit) {
    var data by remember { mutableStateOf<LiveChannels?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { Api.refreshImageToken(); runCatching { data = Api.get("/api/live/channels") }.onFailure { error = it.message } }
    val d = data ?: return if (error != null) ErrorText(error!!) else Loading()
    LaunchedEffect(d) { LiveNav.list = d.channels.map { c -> ChanRef(c.id, c.number, c.name) } }
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Live-TV", fontSize = 28.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f).padding(vertical = 12.dp))
            OutlinedButton(onClick = { push(Screen.Recordings) }, modifier = Modifier.focusRing(RoundedCornerShape(20.dp))) { Text("Inspelningar") }
        }
        if (d.channels.isEmpty()) { ErrorText("Inga kanaler – lägg till en källa under Administration i webben."); return }
        // Läses en gång för hela rutnätet (inte per kanal)
        val tok = Api.imageToken.collectAsState().value
        LazyVerticalGrid(GridCells.Adaptive(300.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(bottom = 24.dp)) {
            items(d.channels, key = { it.id }) { ch ->
                Row(Modifier.clip(RoundedCornerShape(12.dp)).focusRing(RoundedCornerShape(12.dp)).background(Surface2).clickable { onPlay(Screen.LivePlay(ch.id, ch.name)) }.padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(72.dp, 48.dp).clip(RoundedCornerShape(8.dp)).background(Color(0x22FFFFFF)), contentAlignment = Alignment.Center) {
                        Text(ch.number ?: ch.name.take(3), fontWeight = FontWeight.Bold)
                        if (ch.logo != null && tok != null) AsyncImage(Api.url("/api/live/logo/${ch.id}", mapOf("t" to tok)), null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize().padding(4.dp))
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(ch.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        ch.now?.let { p ->
                            Text(p.title, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            val f = ((System.currentTimeMillis() / 1000.0 - p.start) / (p.stop - p.start)).toFloat().coerceIn(0f, 1f)
                            LinearProgressIndicator(progress = { f }, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).height(3.dp), color = Accent)
                        }
                        ch.next?.let { Text("${t(it.start)} ${it.title}", color = Color.Gray, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    }
                }
            }
        }
    }
}

/** Inspelningar i tre flikar: Kommande, Pågår (titta medan den spelas in) och Inspelat (hoppa över reklam) */
@Composable
fun RecordingsScreen(onPlay: (Screen.LivePlay) -> Unit) {
    var data by remember { mutableStateOf<DvrList?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var tab by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(reload) { runCatching { data = Api.get("/api/dvr") }.onFailure { error = it.message } }
    val d = data ?: return if (error != null) ErrorText(error!!) else Loading()
    val upcoming: List<Recording> = d.scheduled.filter { it.status == "scheduled" }
    val running: List<Recording> = d.scheduled.filter { it.status == "recording" }
    val done: List<Recording> = d.done.filter { it.status == "done" }
    val cur: String = tab ?: if (running.isNotEmpty()) "running" else if (done.isNotEmpty() || upcoming.isEmpty()) "done" else "upcoming"
    val autoSkip = d.comskip?.autoSkip == true
    fun remove(r: Recording) { scope.launch { runCatching { Api.requestPublic("/api/dvr/recordings/${r.id}", "DELETE", emptyMap(), null) }; reload++ } }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Inspelningar", fontSize = 28.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(vertical = 12.dp).weight(1f))
                listOf("upcoming" to "Kommande (${upcoming.size})", "running" to "Pågår (${running.size})", "done" to "Inspelat (${done.size})").forEach { (k, n) ->
                    FilterChip(selected = cur == k, onClick = { tab = k }, label = { Text(n, fontSize = 16.sp) }, modifier = Modifier.height(44.dp))
                }
            }
        }
        when (cur) {
            "running" -> {
                if (running.isEmpty()) item { Text("Inget spelas in just nu.", color = Color.Gray) }
                items(running, key = { it.id }) { r ->
                    val canWatch = r.watchable != false
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).focusRing().background(Surface2)
                        .clickable(enabled = canWatch) { onPlay(Screen.LivePlay(-r.id, r.title)) }.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("⏺ ", color = Color(0xFFFF5D6C))
                        Column(Modifier.weight(1f)) {
                            Text(listOfNotNull(r.title, r.subtitle).joinToString(" – "), fontWeight = FontWeight.SemiBold)
                            Text(listOfNotNull(r.channel, "spelas in, klar ${t(r.stop)}").joinToString(" · "), color = Color.Gray, fontSize = 13.sp)
                        }
                        if (canWatch) Text("Titta", color = Accent, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
            "upcoming" -> {
                if (upcoming.isEmpty()) item { Text("Inget bokat. Boka i TV-guiden (välj ett program → Spela in) eller i webben.", color = Color.Gray) }
                items(upcoming, key = { it.id }) { r ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Surface2).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(listOfNotNull(r.title, r.subtitle).joinToString(" – "), fontWeight = FontWeight.SemiBold)
                            Text(listOfNotNull(recDay.format(Date(r.start * 1000)), r.channel).joinToString(" · "), color = Color.Gray, fontSize = 13.sp)
                            // Konflikt: tunrarna räcker inte (börjar sent, avbryts eller missas)
                            if (r.plan != null && r.plan != "ok") Text(r.planText ?: "Krockar med andra inspelningar", color = Color(0xFFFFB454), fontSize = 13.sp)
                        }
                        TextButton(onClick = { remove(r) }) { Text("Avboka") }
                    }
                }
            }
            else -> {
                if (done.isEmpty()) item { Text("Inget inspelat ännu.", color = Color.Gray) }
                items(done, key = { it.id }) { r ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).focusRing().background(Surface2)
                        .clickable { onPlay(Screen.LivePlay(-r.id, r.title, r.commercials, autoSkip)) }.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(listOfNotNull(r.title, r.subtitle).joinToString(" – "), fontWeight = FontWeight.SemiBold)
                            Text(listOfNotNull(r.channel, SimpleDateFormat("d MMM HH:mm", Locale("sv", "SE")).format(Date(r.start * 1000)),
                                if (r.commercials.isNotEmpty()) "${r.commercials.size} reklamavbrott" else null).joinToString(" · "), color = Color.Gray, fontSize = 13.sp)
                        }
                        TextButton(onClick = { remove(r) }) { Text("Ta bort") }
                    }
                }
            }
        }
    }
}

/**
 * Spelar en live-kanal (id > 0) eller en inspelning (id < 0, även en som pågår). Live: kanalbyte med upp/ned,
 * CH+/CH− och sifferknapparna på fjärrkontrollen, och Från början när kanalen har catch-up.
 * Inspelning: Hoppa över reklam (automatiskt när servern är inställd så).
 */
@OptIn(UnstableApi::class)
@Composable
fun LivePlayerScreen(req: Screen.LivePlay, onClose: () -> Unit, onPlay: (Screen) -> Unit) {
    val context = LocalContext.current
    val tv = remember { isTv(context) }
    var chan by remember(req) { mutableIntStateOf(req.id) }
    var title by remember(req) { mutableStateOf(req.title) }
    var error by remember(req) { mutableStateOf<String?>(null) }
    var digits by remember { mutableStateOf("") }
    var banner by remember { mutableStateOf<String?>(null) }
    var nowProg by remember { mutableStateOf<IptvProg?>(null) }
    var breakNow by remember(req) { mutableStateOf<Marker?>(null) }
    val skipped = remember(req) { mutableStateListOf<Double>() }
    val skipFocus = remember { FocusRequester() }
    val viewRef = remember { arrayOfNulls<PlayerView>(1) }
    val live = chan > 0
    val player = remember {
        val http = DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true).setUserAgent("BraXhnTV-Android")
        ExoPlayer.Builder(context).setMediaSourceFactory(DefaultMediaSourceFactory(http)).build().apply {
            setAudioAttributes(androidx.media3.common.AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
        }
    }

    fun neighbour(delta: Int): ChanRef? {
        val l = LiveNav.list
        val i = l.indexOfFirst { c -> c.id == chan }
        if (l.isEmpty() || i < 0) return null
        return l[((i + delta) % l.size + l.size) % l.size]
    }
    fun switchTo(c: ChanRef) {
        if (c.id == chan) return
        chan = c.id; title = c.name; nowProg = null
        banner = listOfNotNull(c.number, c.name).joinToString("  ")
    }

    LaunchedEffect(chan) {
        error = null
        try {
            val path = if (chan > 0) "/api/live/$chan/play" else "/api/dvr/recordings/${-chan}/play"
            val u = Api.json.decodeFromString<PlayUrl>(Api.post(path))
            val hls = chan > 0 || u.live == true || u.url.contains(".m3u8")
            val mi = M3Item.Builder().setUri(Uri.parse(Api.absolute(u.url))).apply { if (hls) setMimeType(MimeTypes.APPLICATION_M3U8) }.build()
            // En pågående inspelning är en växande HLS-lista: börja från början, inte vid kanten
            if (chan < 0 && u.live == true) player.setMediaItem(mi, 0L) else player.setMediaItem(mi)
            player.prepare(); player.playWhenReady = true
        } catch (e: Exception) { error = e.message }
        if (chan > 0) {
            // Programmet som sänds nu (Från början) och nästa kanal i förväg (snabbt kanalbyte) – tyst hos äldre servrar
            val tNow = System.currentTimeMillis() / 1000
            nowProg = runCatching {
                Api.get<IptvEpg>("/api/iptv/epg", mapOf("ids" to chan.toString(), "from" to (tNow - 60).toString(), "to" to (tNow + 60).toString()))
                    .programs[chan.toString()]?.firstOrNull { p -> p.start <= tNow && p.stop > tNow }
            }.getOrNull()
            neighbour(1)?.let { n -> runCatching { Api.post("/api/iptv/channels/${n.id}/prestart") } }
        }
    }
    // Sifferknapparna: kanalnumret väljs 1,5 s efter sista siffran
    LaunchedEffect(digits) {
        if (digits.isEmpty()) return@LaunchedEffect
        delay(1500)
        val want = digits
        digits = ""
        val wantN: Int? = want.toIntOrNull()
        val target = LiveNav.list.firstOrNull { c -> c.number == want } ?: LiveNav.list.firstOrNull { c -> wantN != null && c.number?.toIntOrNull() == wantN }
        if (target != null) switchTo(target) else banner = "Kanal $want finns inte"
    }
    LaunchedEffect(banner) { if (banner != null) { delay(3000); banner = null } }
    // Reklamavbrott i inspelningen
    LaunchedEffect(req) {
        if (req.breaks.isEmpty()) return@LaunchedEffect
        while (true) {
            delay(500)
            val tPos = player.currentPosition / 1000.0
            val b = req.breaks.firstOrNull { m -> tPos >= m.start && tPos < m.end - 1 }
            if (b != null && req.autoSkip && b.start !in skipped) {
                skipped.add(b.start); player.seekTo((b.end * 1000).toLong()); breakNow = null
                banner = "Hoppade över reklam"
            } else breakNow = b
        }
    }
    LaunchedEffect(breakNow) { if (tv && breakNow != null) runCatching { skipFocus.requestFocus() } }

    /** Fjärrkontrollen: siffror och CH+/CH− alltid, upp/ned när spelarens kontroller är dolda */
    fun handleKey(ev: android.view.KeyEvent): Boolean {
        if (chan <= 0 || LiveNav.list.isEmpty()) return false
        val code = ev.keyCode
        val digit: Int = when (code) {
            in android.view.KeyEvent.KEYCODE_0..android.view.KeyEvent.KEYCODE_9 -> code - android.view.KeyEvent.KEYCODE_0
            in android.view.KeyEvent.KEYCODE_NUMPAD_0..android.view.KeyEvent.KEYCODE_NUMPAD_9 -> code - android.view.KeyEvent.KEYCODE_NUMPAD_0
            else -> -1
        }
        val controls = viewRef[0]?.isControllerFullyVisible == true
        val up = code == android.view.KeyEvent.KEYCODE_CHANNEL_UP || (code == android.view.KeyEvent.KEYCODE_DPAD_UP && !controls)
        val down = code == android.view.KeyEvent.KEYCODE_CHANNEL_DOWN || (code == android.view.KeyEvent.KEYCODE_DPAD_DOWN && !controls)
        if (digit < 0 && !up && !down) return false
        if (ev.action == android.view.KeyEvent.ACTION_DOWN) {
            if (digit >= 0) { if (digits.length < 4) { digits += digit.toString(); banner = digits } }
            else if (ev.repeatCount == 0) neighbour(if (up) 1 else -1)?.let { c -> switchTo(c) }
        }
        return true
    }
    val latestKey by rememberUpdatedState<(android.view.KeyEvent) -> Boolean>({ ev -> handleKey(ev) })
    DisposableEffect(Unit) {
        val h: (android.view.KeyEvent) -> Boolean = { ev: android.view.KeyEvent -> latestKey(ev) }
        KeyHook.handler = h
        onDispose { if (KeyHook.handler === h) KeyHook.handler = null }
    }

    DisposableEffect(req) {
        val l = object : androidx.media3.common.Player.Listener {
            override fun onPlayerError(e: androidx.media3.common.PlaybackException) { error = if (e.message?.contains("409") == true) "Alla tuners används" else e.errorCodeName }
        }
        player.addListener(l)
        onDispose { player.removeListener(l) }
    }
    DisposableEffect(Unit) { onDispose { player.release() } }
    // Krav i bilen (och Google TV:s hemknapp): pausa när aktiviteten pausas
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, ev -> if (ev == Lifecycle.Event.ON_PAUSE) player.pause() }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs) }
    }
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(factory = { c -> PlayerView(c).apply { this.player = player; keepScreenOn = true; viewRef[0] = this } }, modifier = Modifier.fillMaxSize())
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onClose, modifier = Modifier.size(56.dp).focusRing(RoundedCornerShape(28.dp)).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                Icon(Icons.Filled.Close, "Stäng", tint = Color.White)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(title + if (live) "  · LIVE" else "", color = Color.White, fontWeight = FontWeight.SemiBold)
                nowProg?.let { p -> Text("${t(p.start)}–${t(p.stop)}  ${p.title}", color = Color.LightGray, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            val p = nowProg
            if (live && p != null && p.catchup == true) {
                OutlinedButton(onClick = { onPlay(Screen.Stream("catchup", p.id, p.title)) }, modifier = Modifier.focusRing(RoundedCornerShape(20.dp)),
                    colors = ButtonDefaults.outlinedButtonColors(containerColor = Color.Black.copy(alpha = 0.5f), contentColor = Color.White)) { Text("Från början") }
            }
        }
        banner?.let { b ->
            Text(b, color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.align(Alignment.TopEnd).padding(top = 80.dp, end = 32.dp).background(Color.Black.copy(alpha = 0.7f), RoundedCornerShape(12.dp)).padding(horizontal = 20.dp, vertical = 12.dp))
        }
        breakNow?.let { b ->
            Button(onClick = { skipped.add(b.start); player.seekTo((b.end * 1000).toLong()); breakNow = null },
                modifier = Modifier.align(Alignment.BottomEnd).padding(end = 32.dp, bottom = 110.dp).height(60.dp).focusRequester(skipFocus).focusRing(RoundedCornerShape(30.dp)),
                colors = ButtonDefaults.buttonColors(containerColor = Color.Black.copy(alpha = 0.75f), contentColor = Color.White)) {
                Text("Hoppa över reklam", fontSize = 18.sp)
            }
        }
        error?.let { Text(it, color = Color.White, modifier = Modifier.align(Alignment.Center).background(Surface2, RoundedCornerShape(12.dp)).padding(20.dp)) }
    }
}

