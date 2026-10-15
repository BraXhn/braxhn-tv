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
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ---- modeller (matchar /api/live och /api/dvr) ----
@Serializable data class LiveProg(val id: Int, val start: Long, val stop: Long, val title: String, val subtitle: String? = null)
@Serializable data class LiveChannel(val id: Int, val number: String? = null, val name: String, val logo: String? = null, val now: LiveProg? = null, val next: LiveProg? = null)
@Serializable data class LiveChannels(val channels: List<LiveChannel> = emptyList())
@Serializable data class PlayUrl(val url: String)
@Serializable data class Recording(val id: Int, val title: String, val subtitle: String? = null, @kotlinx.serialization.SerialName("channel_name") val channel: String? = null,
                                   val start: Long, val stop: Long, val status: String, val size: Long? = null, val error: String? = null)
@Serializable data class DvrList(val scheduled: List<Recording> = emptyList(), val done: List<Recording> = emptyList())

/** Körs appen på en TV (Google TV / Android TV)? */
fun isTv(ctx: Context) = ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)

/** Tydlig ram runt det som har fokus – behövs för fjärrkontroll (D-pad) på TV */
fun Modifier.focusRing(shape: RoundedCornerShape = RoundedCornerShape(10.dp)): Modifier = composed {
    var focused by remember { mutableStateOf(false) }
    this.onFocusChanged { focused = it.isFocused }.border(BorderStroke(if (focused) 3.dp else 0.dp, if (focused) Color.White else Color.Transparent), shape)
}

private val hm = SimpleDateFormat("HH:mm", Locale("sv", "SE"))
private fun t(s: Long) = hm.format(Date(s * 1000))

@Composable
fun LiveScreen(onPlay: (Screen.LivePlay) -> Unit, push: (Screen) -> Unit) {
    var data by remember { mutableStateOf<LiveChannels?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { Api.refreshImageToken(); runCatching { data = Api.get("/api/live/channels") }.onFailure { error = it.message } }
    val d = data ?: return if (error != null) ErrorText(error!!) else Loading()
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

@Composable
fun RecordingsScreen(onPlay: (Screen.LivePlay) -> Unit) {
    var data by remember { mutableStateOf<DvrList?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(reload) { runCatching { data = Api.get("/api/dvr") }.onFailure { error = it.message } }
    val d = data ?: return if (error != null) ErrorText(error!!) else Loading()
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Text("Inspelningar", fontSize = 28.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(vertical = 12.dp)) }
        val done = d.done.filter { it.status == "done" }
        if (done.isEmpty()) item { Text("Inget inspelat ännu. Boka inspelningar i TV-guiden i webben.", color = Color.Gray) }
        items(done, key = { it.id }) { r ->
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).focusRing().background(Surface2).clickable { onPlay(Screen.LivePlay(-r.id, r.title)) }.padding(14.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(listOfNotNull(r.title, r.subtitle).joinToString(" – "), fontWeight = FontWeight.SemiBold)
                    Text(listOfNotNull(r.channel, SimpleDateFormat("d MMM HH:mm", Locale("sv", "SE")).format(Date(r.start * 1000))).joinToString(" · "), color = Color.Gray, fontSize = 13.sp)
                }
                TextButton(onClick = { scope.launch { runCatching { Api.requestPublic("/api/dvr/recordings/${r.id}", "DELETE", emptyMap(), null) }; reload++ } }) { Text("Ta bort") }
            }
        }
        if (d.scheduled.isNotEmpty()) {
            item { Text("Kommande", fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 16.dp)) }
            items(d.scheduled, key = { it.id }) { r ->
                Text("${SimpleDateFormat("EEE d MMM HH:mm", Locale("sv", "SE")).format(Date(r.start * 1000))}  ${r.title}${if (r.status == "recording") "  ⏺" else ""}  · ${r.channel ?: ""}", color = Color.LightGray)
            }
        }
    }
}

/** Spelar en live-kanal (id > 0) eller en inspelning (id < 0) */
@OptIn(UnstableApi::class)
@Composable
fun LivePlayerScreen(req: Screen.LivePlay, onClose: () -> Unit) {
    val context = LocalContext.current
    var error by remember(req) { mutableStateOf<String?>(null) }
    val player = remember {
        val http = DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true).setUserAgent("BraXhnTV-Android")
        ExoPlayer.Builder(context).setMediaSourceFactory(DefaultMediaSourceFactory(http)).build().apply {
            setAudioAttributes(androidx.media3.common.AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
        }
    }
    LaunchedEffect(req) {
        try {
            val live = req.id > 0
            val path = if (live) "/api/live/${req.id}/play" else "/api/dvr/recordings/${-req.id}/play"
            val u = Api.json.decodeFromString<PlayUrl>(Api.post(path))
            val mi = M3Item.Builder().setUri(Uri.parse(Api.absolute(u.url))).apply { if (live) setMimeType(MimeTypes.APPLICATION_M3U8) }.build()
            player.setMediaItem(mi); player.prepare(); player.playWhenReady = true
        } catch (e: Exception) { error = e.message }
    }
    DisposableEffect(req) {
        val l = object : androidx.media3.common.Player.Listener {
            override fun onPlayerError(e: androidx.media3.common.PlaybackException) { error = if (e.message?.contains("409") == true) "Alla tuners används" else e.errorCodeName }
        }
        player.addListener(l)
        onDispose { player.removeListener(l); player.release() }
    }
    // Krav i bilen (och Google TV:s hemknapp): pausa när aktiviteten pausas
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, ev -> if (ev == Lifecycle.Event.ON_PAUSE) player.pause() }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs) }
    }
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(factory = { PlayerView(it).apply { this.player = player; keepScreenOn = true } }, modifier = Modifier.fillMaxSize())
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onClose, modifier = Modifier.size(56.dp).focusRing(RoundedCornerShape(28.dp)).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                Icon(Icons.Filled.Close, "Stäng", tint = Color.White)
            }
            Spacer(Modifier.width(12.dp))
            Text(req.title + if (req.id > 0) "  · LIVE" else "", color = Color.White, fontWeight = FontWeight.SemiBold)
        }
        error?.let { Text(it, color = Color.White, modifier = Modifier.align(Alignment.Center).background(Surface2, RoundedCornerShape(12.dp)).padding(20.dp)) }
    }
}
