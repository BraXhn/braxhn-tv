package net.braxhn.tv

import android.net.Uri
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.Subtitles
import androidx.compose.material.icons.filled.List
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.clickable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.C
import androidx.media3.common.MediaItem as M3Item
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(UnstableApi::class)
@Composable
fun PlayerScreen(req: Screen.Play, onClose: () -> Unit, onPlay: (Screen.Play) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var item by remember(req) { mutableStateOf<MediaItem?>(null) }
    var pb by remember(req) { mutableStateOf<Playback?>(null) }
    var error by remember(req) { mutableStateOf<String?>(null) }
    var skip by remember(req) { mutableStateOf<String?>(null) }
    var status by remember(req) { mutableStateOf("") }
    var currentSub by remember(req) { mutableStateOf<SubtitleTrack?>(null) }
    var menu by remember { mutableStateOf<String?>(null) } // "tracks" | "chapters"

    val player = remember {
        val http = DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true).setUserAgent("BraXhnTV-Android")
        ExoPlayer.Builder(context).setMediaSourceFactory(DefaultMediaSourceFactory(http)).build().apply {
            setAudioAttributes(androidx.media3.common.AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true) // hanterar ljudfokus
        }
    }

    fun report(final: Boolean = false) {
        val it = item ?: return
        val pos = player.currentPosition / 1000.0
        val dur = pb?.duration ?: it.duration ?: 0.0
        if (pos > 1) Api.appScope.launch { Api.reportProgress(it.id, pos, dur) }
        if (final) Api.appScope.launch { runCatching { Api.post("/api/stream/${it.id}/stop") } }
    }

    // Läs in objekt + uppspelningsbeslut och starta
    LaunchedEffect(req) {
        // Nedladdad fil: spela lokalt (fungerar utan nät)
        Downloads.localFile(req.id)?.let { f ->
            status = "Offline"
            item = runCatching { Api.get<MediaItem>("/api/items/${req.id}") }.getOrNull()
            pb = runCatching { Api.get<Playback>("/api/items/${req.id}/playback", Api.capabilities(req.audio, null)) }.getOrNull()
            player.setMediaItem(M3Item.fromUri(Uri.fromFile(f)), (req.start * 1000).toLong())
            player.prepare(); player.playWhenReady = true
            return@LaunchedEffect
        }
        try {
            val it: MediaItem = Api.get("/api/items/${req.id}")
            item = it
            val sub = req.sub ?: it.subtitles?.firstOrNull { s -> s.forced == true && s.bitmap != true }
                ?: it.subtitles?.firstOrNull { s -> Api.subtitleLang.isNotEmpty() && s.lang == Api.subtitleLang && s.bitmap != true }
            val p: Playback = Api.get("/api/items/${req.id}/playback", Api.capabilities(req.audio, sub))
            pb = p
            currentSub = sub
            status = listOfNotNull(when (p.mode) { "direct" -> "Direkt"; "remux" -> "Remux"; else -> "Omkodning" },
                if (p.tonemap == true) "HDR→SDR" else null, if (p.remote == true) "utanför hemmet" else null).joinToString(" · ")
            // Alla textundertexter bifogas så att de kan bytas direkt; den valda markeras som standard
            val subs = p.subtitles.map { s ->
                M3Item.SubtitleConfiguration.Builder(Uri.parse(Api.absolute(s.url)))
                    .setId(s.id).setMimeType(MimeTypes.TEXT_VTT).setLanguage(s.lang).setLabel(s.label)
                    .setSelectionFlags(if (s.id == sub?.id) C.SELECTION_FLAG_DEFAULT else 0).build()
            }
            player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                .clearOverridesOfType(C.TRACK_TYPE_TEXT).setTrackTypeDisabled(C.TRACK_TYPE_TEXT, sub == null || sub.bitmap == true).build()
            val mi = M3Item.Builder()
                .setUri(Api.absolute(p.url))
                .apply { if (p.mode != "direct") setMimeType(MimeTypes.APPLICATION_M3U8) }
                .setSubtitleConfigurations(subs)
                .setMediaMetadata(MediaMetadata.Builder().setTitle(if (it.isEpisode) "${it.showTitle} – ${it.sxe} ${it.title}" else it.title).build())
                .build()
            player.setMediaItem(mi, (req.start * 1000).toLong())
            player.prepare()
            player.playWhenReady = true
        } catch (e: Exception) { error = e.message ?: e.toString() }
    }

    // Tittarstatus, introknapp
    LaunchedEffect(req) {
        var n = 0
        while (true) {
            delay(500)
            val t = player.currentPosition / 1000.0
            val p = pb
            skip = when {
                p?.recap != null && t >= p.recap.start && t < p.recap.end - 1 -> "Hoppa över sammanfattning"
                p?.intro != null && t >= p.intro.start && t < p.intro.end - 1 -> "Hoppa över intro"
                p?.credits != null && item?.nextId != null && t >= p.credits && t < p.credits + 60 -> "Nästa avsnitt"
                else -> null
            }
            if (++n % 20 == 0 && player.isPlaying) report()
        }
    }

    // Avsnitt slut → nästa
    DisposableEffect(req) {
        val l = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) {
                    report(final = true)
                    val next = item?.nextId
                    if (next != null) onPlay(Screen.Play(next, 0.0, null, null)) else onClose()
                }
            }
            override fun onPlayerError(e: androidx.media3.common.PlaybackException) { error = e.errorCodeName + ": " + (e.message ?: "") }
        }
        player.addListener(l)
        onDispose { player.removeListener(l) }
    }

    // Effekter med nyckel lifecycle/Unit överlever byte av req – läs alltid senaste report (annars fel item-id)
    val latestReport by rememberUpdatedState<(Boolean) -> Unit>({ f -> report(f) })

    // Krav i bilen: pausa när aktiviteten pausas (t.ex. när bilen börjar rulla)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, ev ->
            if (ev == Lifecycle.Event.ON_PAUSE) { player.pause(); latestReport(false) }
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs) }
    }
    DisposableEffect(Unit) { onDispose { latestReport(true); player.release() } }

    /** Byt undertext utan att starta om strömmen (bildundertexter bränns in av servern och kräver omstart) */
    fun selectSubtitle(s: SubtitleTrack?) {
        val it = item ?: return
        Api.subtitleLang = s?.lang ?: ""
        if (s?.bitmap == true || currentSub?.bitmap == true) {
            report(final = true); onPlay(Screen.Play(it.id, player.currentPosition / 1000.0, req.audio, s)); return
        }
        currentSub = s
        val b = player.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_TEXT)
        if (s == null) b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        else {
            b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
            player.currentTracks.groups.firstOrNull { g -> g.type == C.TRACK_TYPE_TEXT && (0 until g.length).any { i -> g.getTrackFormat(i).id?.endsWith(s.id) == true } }
                ?.let { g -> b.setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, 0)) }
        }
        player.trackSelectionParameters = b.build()
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(factory = { ctx -> PlayerView(ctx).apply { this.player = player; setShowSubtitleButton(true); keepScreenOn = true } },
            modifier = Modifier.fillMaxSize())
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { report(final = true); onClose() }, modifier = Modifier.size(56.dp).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                Icon(Icons.Filled.Close, "Stäng", tint = Color.White, modifier = Modifier.size(30.dp))
            }
            Spacer(Modifier.width(12.dp))
            Text(item?.let { if (it.isEpisode) "${it.showTitle} · ${it.sxe} · ${it.title}" else it.title } ?: "", color = Color.White, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(status, color = Color.LightGray, fontSize = 12.sp)
            val p = pb
            if (p != null && (p.audio.size > 1 || p.subtitles.isNotEmpty() || (item?.subtitles?.isNotEmpty() == true))) {
                Spacer(Modifier.width(8.dp))
                IconButton(onClick = { menu = "tracks" }, modifier = Modifier.size(56.dp).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                    Icon(Icons.Filled.Subtitles, "Ljud och undertexter", tint = Color.White, modifier = Modifier.size(28.dp))
                }
            }
            if (p != null && p.chapters.isNotEmpty()) {
                Spacer(Modifier.width(8.dp))
                IconButton(onClick = { menu = "chapters" }, modifier = Modifier.size(56.dp).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                    Icon(Icons.Filled.List, "Kapitel", tint = Color.White, modifier = Modifier.size(28.dp))
                }
            }
        }
        if (menu != null) {
            val p = pb
            AlertDialog(onDismissRequest = { menu = null }, confirmButton = { TextButton(onClick = { menu = null }) { Text("Stäng") } },
                title = { Text(if (menu == "chapters") "Kapitel" else "Ljud och undertexter") },
                text = {
                    LazyColumn(Modifier.heightIn(max = 420.dp)) {
                        if (menu == "chapters" && p != null) {
                            val now = player.currentPosition / 1000.0
                            val cur = p.chapters.lastOrNull { c -> c.start <= now }
                            items(p.chapters) { c ->
                                OptionRow("${c.title}   ${fmtTime(c.start)}", c == cur) { player.seekTo(((c.start + 0.05) * 1000).toLong()); menu = null }
                            }
                        } else if (p != null) {
                            if (p.audio.size > 1) {
                                this.item { Text("Ljud", fontWeight = FontWeight.Bold, modifier = Modifier.padding(vertical = 6.dp)) }
                                val sel = p.audioSelected?.toIntOrNull() ?: req.audio
                                items(p.audio) { a ->
                                    OptionRow(a.label, a.index == sel) {
                                        menu = null
                                        if (a.index != sel) { report(final = true); onPlay(Screen.Play(req.id, player.currentPosition / 1000.0, a.index, currentSub)) }
                                    }
                                }
                            }
                            this.item { Text("Undertexter", fontWeight = FontWeight.Bold, modifier = Modifier.padding(vertical = 6.dp)) }
                            this.item { OptionRow("Inga", currentSub == null) { selectSubtitle(null); menu = null } }
                            items(item?.subtitles ?: emptyList()) { s -> OptionRow(s.label, s.id == currentSub?.id) { selectSubtitle(s); menu = null } }
                        }
                    }
                })
        }
        skip?.let { label ->
            Button(onClick = {
                val p = pb
                if (label == "Hoppa över sammanfattning" && p?.recap != null) player.seekTo((p.recap.end * 1000).toLong())
                else if (label == "Hoppa över intro" && p?.intro != null) player.seekTo((p.intro.end * 1000).toLong())
                else item?.nextId?.let { next -> report(final = true); onPlay(Screen.Play(next, 0.0, null, null)) }
            }, modifier = Modifier.align(Alignment.BottomEnd).padding(end = 32.dp, bottom = 110.dp).height(60.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color.Black.copy(alpha = 0.75f), contentColor = Color.White)) {
                Icon(Icons.Filled.SkipNext, null); Text(" $label", fontSize = 18.sp)
            }
        }
        error?.let { e ->
            Column(Modifier.align(Alignment.Center).background(Surface2, RoundedCornerShape(14.dp)).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Kunde inte spela", fontWeight = FontWeight.Bold, color = Color.White)
                Text(e, color = Color.Gray, fontSize = 13.sp)
                Spacer(Modifier.height(12.dp))
                Button(onClick = onClose) { Text("Stäng") }
            }
        }
    }
}

@Composable
private fun OptionRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 12.dp, horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected = selected, onClick = onClick)
        Spacer(Modifier.width(8.dp))
        Text(label, fontSize = 17.sp)
    }
}

private fun fmtTime(s: Double): String {
    val t = s.toInt(); val h = t / 3600; val m = (t % 3600) / 60; val sec = t % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}
