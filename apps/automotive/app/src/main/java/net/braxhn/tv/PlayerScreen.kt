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
import androidx.compose.material.icons.filled.PictureInPictureAlt
import androidx.compose.material.icons.filled.Speed
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.clickable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
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
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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
    var menu by remember { mutableStateOf<String?>(null) } // "tracks" | "chapters" | "speed"
    val tv = remember { isTv(context) }
    // Bio-läge: trailers/förfilm ligger först i spelarens kö, filmen på plats mainIndex
    var mainIndex by remember(req) { mutableIntStateOf(0) }
    var prerolls by remember(req) { mutableStateOf<List<PrerollEntry>>(emptyList()) }
    var prerollLabel by remember(req) { mutableStateOf<String?>(null) }
    var offline by remember(req) { mutableStateOf(false) }
    var speed by remember { mutableFloatStateOf(1f) }
    val activity = remember { context.findActivity() }
    val pipOk = remember { Pip.supported(context) }
    val inPip by Pip.active.collectAsState()
    val skipFocus = remember { FocusRequester() }
    // Google TV: bildfrekvensväxling (av/rate/res, Inställningar) och ljudspår valt i spelaren vid direktuppspelning
    val frameMode = remember { if (tv) TvOutput.frameRateMode(context) else "off" }
    var rateChecked by remember(req) { mutableStateOf(false) }
    var audioApplied by remember(req) { mutableStateOf(false) }
    var localAudio by remember(req) { mutableStateOf<Int?>(null) }
    var modeNote by remember { mutableStateOf<String?>(null) }
    // Familjefiltret (överhoppad scen) och automatisk undertextsynk visas en stund i statusraden
    var note by remember { mutableStateOf<String?>(null) }
    // Stoppad av servern (en vuxen i Föräldraöversikten, administratören eller skärmtiden): serverns/appens förklaring
    var stopped by remember(req) { mutableStateOf<String?>(null) }
    // Slutrapport och stopp av strömmen skickas en gång per uppspelning (Stäng + att vyn stängs gav dubbla anrop)
    val finalSent = remember(req) { booleanArrayOf(false) }
    val closeFocus = remember { FocusRequester() }

    val player = remember {
        // 60 s tidsgräns (Media.http): en omkodning med grafikkort kan ta ~10 s till första segmentet
        val http = Media.http()
        // Avkodarreserv (t.ex. Dolby Vision → HEVC-avkodaren). På TV: ljudutgångens hastighetsstyrning, så att
        // bitström (Dolby/DTS till förstärkaren) och hastighetsändring fungerar ihop
        val renderers = DefaultRenderersFactory(context).setEnableDecoderFallback(true)
        if (tv) renderers.setEnableAudioTrackPlaybackParams(true)
        ExoPlayer.Builder(context, renderers).setMediaSourceFactory(DefaultMediaSourceFactory(http)).build().apply {
            setAudioAttributes(androidx.media3.common.AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true) // hanterar ljudfokus
            // Egen växling av skärmläget: ExoPlayers Surface.setFrameRate (bara sömlösa byten) stängs av så att de inte krockar
            if (frameMode != "off") setVideoChangeFrameRateStrategy(C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_OFF)
        }
    }

    /** Servern bad spelaren sluta (stop i framstegssvaret): stoppa och visa varför */
    fun stoppedByServer(r: ProgressResult) {
        if (stopped != null) return
        player.pause()
        player.stop()
        val st = r.screenTime
        stopped = if (st != null && !st.allowed) st.message ?: "Skärmtiden är slut för idag."
                  else if (Session.kid.value) "En vuxen stoppade uppspelningen"
                  else "Uppspelningen stoppades av administratören"
    }

    fun report(final: Boolean = false) {
        val it = item ?: return
        if (final) { if (finalSent[0]) return; finalSent[0] = true }
        val id = it.id
        val pos = player.currentPosition / 1000.0
        val dur = pb?.duration ?: it.duration ?: 0.0
        // Under trailers/förfilm finns inget framsteg att spara. Positionen sparas bara på servern (ingen egen lokal
        // position) – servern ger 0 för det som setts under 2 minuter, så appen erbjuder då ingen Fortsätt.
        if (pos > 1 && player.currentMediaItemIndex >= mainIndex) {
            if (final) Api.appScope.launch { Api.reportProgress(id, pos, dur) }
            else if (stopped == null) scope.launch {
                val r: ProgressResult? = Api.reportProgress(id, pos, dur)
                if (r != null && r.stop && item?.id == id) stoppedByServer(r)
            }
        }
        if (final && !offline) StreamGate.stop(id)
    }

    // Läs in objekt + uppspelningsbeslut och starta
    LaunchedEffect(req) {
        // Nedladdad fil: spela lokalt (fungerar utan nät)
        Downloads.localFile(req.id)?.let { f ->
            status = "Offline"; offline = true
            // Starta den lokala filen först – nätanropen nedan kan ta lång tid eller misslyckas utan täckning
            player.setMediaItem(M3Item.fromUri(Uri.fromFile(f)), (req.start * 1000).toLong())
            player.prepare(); player.playWhenReady = true
            item = runCatching { Api.get<MediaItem>("/api/items/${req.id}") }.getOrNull()
            // info=1: bara intro/eftertexter – räknas inte som en strömning på servern
            pb = runCatching {
                val caps: Map<String, String?> = withContext(Dispatchers.IO) { Api.capabilities(req.audio, null) }
                Api.get<Playback>("/api/items/${req.id}/playback", caps + ("info" to "1"))
            }.getOrNull()
            return@LaunchedEffect
        }
        try {
            // Ett stopp av samma titel (omstart med annat ljud, nattläge …) måste nå servern före den nya starten
            StreamGate.awaitStop(req.id)
            val it: MediaItem = Api.get("/api/items/${req.id}")
            item = it
            val sub = req.sub ?: it.subtitles?.firstOrNull { s -> s.forced == true && s.bitmap != true }
                ?: it.subtitles?.firstOrNull { s -> Api.subtitleLang.isNotEmpty() && s.lang == Api.subtitleLang && s.bitmap != true }
            // Bio-läge bara för filmer från början, och bara om det är påslaget (/api/me/cinema; saknas hos äldre servrar)
            val cinema = !req.skipPreroll && req.start < 1 && it.kind == "movie" &&
                runCatching { Api.get<CinemaPrefs>("/api/me/cinema").on }.getOrDefault(false)
            // Avkodarlistan (MediaCodecList) är långsam första gången – inte på huvudtråden
            val caps: Map<String, String?> = withContext(Dispatchers.IO) { Api.capabilities(req.audio, sub) }
            val p: Playback = Api.get("/api/items/${req.id}/playback", caps + Api.comfortQuery() +
                ("cinema" to (if (cinema) "1" else null)))
            pb = p
            currentSub = sub
            status = listOfNotNull(when (p.mode) { "direct" -> "Direkt"; "remux" -> "Remux"; else -> "Omkodning" },
                if (p.tonemap == true) "HDR→SDR" else hdrLabel(it.hdr), if (p.remote == true) "utanför hemmet" else null).joinToString(" · ")
            // Alla textundertexter bifogas så att de kan bytas direkt; den valda markeras som standard
            val subs = p.subtitles.map { s ->
                M3Item.SubtitleConfiguration.Builder(Uri.parse(Api.absolute(s.url)))
                    .setId(s.id).setMimeType(MimeTypes.TEXT_VTT).setLanguage(s.lang).setLabel(s.label)
                    .setSelectionFlags(if (s.id == sub?.id) C.SELECTION_FLAG_DEFAULT else 0).build()
            }
            player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                .clearOverridesOfType(C.TRACK_TYPE_AUDIO).clearOverridesOfType(C.TRACK_TYPE_TEXT).setTrackTypeDisabled(C.TRACK_TYPE_TEXT, sub == null || sub.bitmap == true).build()
            val mi = M3Item.Builder()
                .setUri(Api.absolute(p.url))
                .apply { if (p.mode != "direct") setMimeType(MimeTypes.APPLICATION_M3U8) }
                .setSubtitleConfigurations(subs)
                .setMediaMetadata(MediaMetadata.Builder().setTitle(if (it.isEpisode) "${it.showTitle} – ${it.sxe} ${it.title}" else it.title).build())
                .build()
            // Trailers och förfilm först (egna adresser med token), sedan filmen
            val pre = p.preroll.map { e ->
                M3Item.Builder().setUri(Api.absolute(e.url))
                    .setMediaMetadata(MediaMetadata.Builder().setTitle(e.title ?: "Trailer").build()).build()
            }
            prerolls = p.preroll
            mainIndex = pre.size
            if (pre.isEmpty()) player.setMediaItem(mi, (req.start * 1000).toLong())
            else player.setMediaItems(pre + mi, 0, 0L)
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
            val idx = player.currentMediaItemIndex
            prerollLabel = if (idx < mainIndex) prerolls.getOrNull(idx)?.let { e -> if (e.kind == "preroll") "Förfilm" else "Trailer: ${e.title ?: ""}" } else null
            // Bild-i-bild får videons format
            val vs = player.videoSize
            if (pipOk) Pip.aspect = Pip.ratio((vs.width * vs.pixelWidthHeightRatio).toInt(), vs.height)
            skip = when {
                idx < mainIndex -> "Hoppa över"
                p?.recap != null && t >= p.recap.start && t < p.recap.end - 1 -> "Hoppa över sammanfattning"
                p?.intro != null && t >= p.intro.start && t < p.intro.end - 1 -> "Hoppa över intro"
                p?.credits != null && item?.nextId != null && t >= p.credits && t < p.credits + 60 -> "Nästa avsnitt"
                else -> null
            }
            // Familjefiltret i läget "hoppa över scener": planen från /playback (servern tystar svordomarna själv)
            val f = p?.filter
            if (f != null && f.mode == "skip" && idx >= mainIndex && player.isPlaying) {
                val sc = f.skip.firstOrNull { x -> t >= x.start && t < x.end - 0.3 }
                if (sc != null) { player.seekTo((sc.end * 1000).toLong()); note = "Hoppade över: ${sc.label ?: "markerad scen"}" }
            }
            if (++n % 20 == 0 && player.isPlaying) report()
        }
    }
    LaunchedEffect(note) { if (note != null && note?.startsWith("Synkar") != true) { delay(4000); note = null } }

    /**
     * Direktuppspelning (atrack=1): välj ljudspåret i spelaren i stället för att servern remuxar. Serverns spårlista
     * och spelarens ljudgrupper har filens ordning; stämmer inte antalet görs inget (servern får välja).
     */
    fun selectLocalAudio(index: Int, tracks: Tracks = player.currentTracks): Boolean {
        val p = pb ?: return false
        if (p.mode != "direct" || offline) return false
        val pos = p.audio.indexOfFirst { a -> a.index == index }
        val groups = tracks.groups.filter { g -> g.type == C.TRACK_TYPE_AUDIO }
        if (pos < 0 || groups.size != p.audio.size || groups[pos].length < 1) return false
        val g = groups[pos]
        // Format som varken avkodas eller tas emot som bitström: låt servern konvertera
        if (!g.isTrackSupported(0)) return false
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, 0)).build()
        localAudio = index
        return true
    }

    /** Byter skärmläge efter videons bildfrekvens; spelaren väntar medan TV:n/HDMI byter (några svarta sekunder) */
    fun matchFrameRate(fps: Float, width: Int, height: Int) {
        val a = activity ?: return
        val id = TvOutput.pickMode(a, fps, width, height, frameMode == "res") ?: return
        val resume = player.playWhenReady
        player.playWhenReady = false
        modeNote = "Anpassar skärmen till %.3f bilder/s".format(fps).replace('.', ',')
        TvOutput.setMode(a, id)
        scope.launch {
            var n = 0
            while (n++ < 50 && TvOutput.currentModeId(a) != id) delay(100)
            delay(1200)
            modeNote = null
            if (resume) player.playWhenReady = true
        }
    }

    // Avsnitt slut → nästa
    DisposableEffect(req) {
        val l = object : Player.Listener {
            override fun onTracksChanged(tracks: Tracks) {
                // Trailers/förfilm påverkar varken ljudspår eller skärmläge
                if (player.currentMediaItemIndex < mainIndex || tracks.groups.isEmpty()) return
                if (!audioApplied && pb != null) {
                    audioApplied = true
                    pb?.audioSelected?.toIntOrNull()?.let { sel -> selectLocalAudio(sel, tracks) }
                }
                if (frameMode != "off" && !rateChecked) {
                    val vg = tracks.groups.firstOrNull { g -> g.type == C.TRACK_TYPE_VIDEO && g.isSelected } ?: return
                    val vi = (0 until vg.length).firstOrNull { i -> vg.isTrackSelected(i) } ?: return
                    val f = vg.getTrackFormat(vi)
                    rateChecked = true
                    if (f.frameRate > 0f) matchFrameRate(f.frameRate, f.width, f.height)
                }
            }
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) {
                    report(final = true)
                    val next = item?.nextId
                    if (next != null) onPlay(Screen.Play(next, 0.0, null, null)) else onClose()
                }
            }
            override fun onPlayerError(e: androidx.media3.common.PlaybackException) {
                // En trailer som inte går att spela: gå direkt till filmen
                if (player.currentMediaItemIndex < mainIndex) { player.seekTo(mainIndex, 0L); player.prepare(); return }
                error = playerErrorText(e)
            }
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
            // Bild-i-bild pausar också aktiviteten – då ska videon fortsätta (bilar har ingen bild-i-bild)
            if (ev == Lifecycle.Event.ON_PAUSE && activity?.isInPictureInPictureMode != true) { player.pause(); latestReport(false) }
            // Bild-i-bild-fönstret stängt (eller appen i bakgrunden): pausa
            if (ev == Lifecycle.Event.ON_STOP) { player.pause(); latestReport(false) }
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs) }
    }
    // Skärmläget tillbaka till det vanliga när spelaren stängs
    DisposableEffect(Unit) { onDispose { Pip.aspect = null; latestReport(true); player.release(); if (frameMode != "off") TvOutput.restore(activity) } }

    /** Startar om samma titel där man är (t.ex. nytt ljud från servern), utan bio-läge */
    fun restart(audio: Int? = req.audio, sub: SubtitleTrack? = currentSub) {
        val at = if (player.currentMediaItemIndex >= mainIndex) player.currentPosition / 1000.0 else req.start
        report(final = true); player.stop()
        onPlay(Screen.Play(req.id, at, audio, sub, nonce = req.nonce + 1, skipPreroll = true))
    }

    /** Byt undertext utan att starta om strömmen (bildundertexter bränns in av servern och kräver omstart) */
    fun selectSubtitle(s: SubtitleTrack?) {
        val it = item ?: return
        Api.subtitleLang = s?.lang ?: ""
        if (s?.bitmap == true || currentSub?.bitmap == true) {
            // Stoppa den gamla strömmen direkt, annars startar dess nästa segment en ny omkodning på servern
            restart(sub = s); return
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

    /** Automatisk synk av undertextfilen mot ljudet (servern räknar); undertexten laddas om när den är klar */
    fun autoSync(s: SubtitleTrack) {
        val it = item ?: return
        note = "Synkar undertexten…"
        scope.launch {
            val audio: Int? = localAudio ?: pb?.audioSelected?.toIntOrNull() ?: req.audio
            val r = runCatching { Api.autoSyncSubtitle(it.id, s.id, audio) { pr: Double -> note = "Synkar undertexten… ${(pr * 100).toInt()} %" } }
            val job: SubSyncJob? = r.getOrNull()
            note = when {
                r.isFailure -> "Kunde inte synka: ${r.exceptionOrNull()?.message ?: ""}"
                job?.state == "done" -> "Undertexten är synkad" + (job?.result?.offset?.let { o -> " (%+.1f s)".format(o).replace('.', ',') } ?: "")
                job?.state == "unsure" -> "Ingen säker förskjutning hittades – undertexten är oförändrad"
                else -> "Kunde inte synka: ${job?.error ?: "okänt fel"}"
            }
            if (job?.state == "done") restart(sub = s)
        }
    }

    // Statusraden: syntolkning (valt ljudspår) och familjefiltret
    val selAudio: Int? = localAudio ?: pb?.audioSelected?.toIntOrNull() ?: req.audio
    val audioDesc: Boolean = item?.audio?.let { list -> (list.firstOrNull { a -> a.index == selAudio } ?: list.firstOrNull { a -> selAudio == null && a.default == true })?.isAudioDesc } == true
    val extraStatus: String? = listOfNotNull(if (audioDesc) "Syntolkning" else null,
        pb?.filter?.let { f -> if (f.mode == "skip") "Familjefilter: hoppar över scener" else "Familjefilter" }).joinToString(" · ").takeIf { x -> x.isNotEmpty() }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(factory = { ctx -> PlayerView(ctx).apply { this.player = player; setShowSubtitleButton(true); keepScreenOn = true } },
            update = { v -> v.useController = !inPip }, modifier = Modifier.fillMaxSize())
        // Bild-i-bild: bara videon, inga knappar
        if (!inPip) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { report(final = true); onClose() }, modifier = Modifier.size(56.dp).focusRing(RoundedCornerShape(28.dp)).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                Icon(Icons.Filled.Close, "Stäng", tint = Color.White, modifier = Modifier.size(30.dp))
            }
            Spacer(Modifier.width(12.dp))
            Text(item?.let { if (it.isEpisode) "${it.showTitle} · ${it.sxe} · ${it.title}" else it.title } ?: "", color = Color.White, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(prerollLabel ?: modeNote ?: note ?: listOfNotNull(status.takeIf { x -> x.isNotEmpty() }, extraStatus).joinToString(" · "), color = Color.LightGray, fontSize = 12.sp)
            val p = pb
            Spacer(Modifier.width(8.dp))
            IconButton(onClick = { menu = "speed" }, modifier = Modifier.size(56.dp).focusRing(RoundedCornerShape(28.dp)).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                Icon(Icons.Filled.Speed, "Uppspelningshastighet", tint = Color.White, modifier = Modifier.size(28.dp))
            }
            if (pipOk) {
                Spacer(Modifier.width(8.dp))
                IconButton(onClick = { Pip.enter(activity) }, modifier = Modifier.size(56.dp).focusRing(RoundedCornerShape(28.dp)).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                    Icon(Icons.Filled.PictureInPictureAlt, "Bild-i-bild", tint = Color.White, modifier = Modifier.size(28.dp))
                }
            }
            if (p != null && (p.audio.size > 1 || p.subtitles.isNotEmpty() || (item?.subtitles?.isNotEmpty() == true) || !offline)) {
                Spacer(Modifier.width(8.dp))
                IconButton(onClick = { menu = "tracks" }, modifier = Modifier.size(56.dp).focusRing(RoundedCornerShape(28.dp)).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                    Icon(Icons.Filled.Subtitles, "Ljud och undertexter", tint = Color.White, modifier = Modifier.size(28.dp))
                }
            }
            if (p != null && p.chapters.isNotEmpty()) {
                Spacer(Modifier.width(8.dp))
                IconButton(onClick = { menu = "chapters" }, modifier = Modifier.size(56.dp).focusRing(RoundedCornerShape(28.dp)).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                    Icon(Icons.Filled.List, "Kapitel", tint = Color.White, modifier = Modifier.size(28.dp))
                }
            }
        }
        if (menu != null) {
            val p = pb
            AlertDialog(onDismissRequest = { menu = null }, confirmButton = { TextButton(onClick = { menu = null }) { Text("Stäng") } },
                title = { Text(when (menu) { "chapters" -> "Kapitel"; "speed" -> "Hastighet"; else -> "Ljud och undertexter" }) },
                text = {
                    LazyColumn(Modifier.heightIn(max = 420.dp)) {
                        if (menu == "speed") {
                            items(SPEEDS) { (v, label) ->
                                OptionRow(label, v == speed) {
                                    speed = v; player.setPlaybackSpeed(v); menu = null
                                }
                            }
                        } else if (menu == "chapters" && p != null) {
                            val now = player.currentPosition / 1000.0
                            val cur = p.chapters.lastOrNull { c -> c.start <= now }
                            items(p.chapters) { c ->
                                OptionRow("${c.title}   ${fmtTime(c.start)}", c == cur) { player.seekTo(((c.start + 0.05) * 1000).toLong()); menu = null }
                            }
                        } else if (p != null) {
                            if (p.audio.size > 1) {
                                this.item { Text("Ljud", fontWeight = FontWeight.Bold, modifier = Modifier.padding(vertical = 6.dp)) }
                                val sel = localAudio ?: p.audioSelected?.toIntOrNull() ?: req.audio
                                items(p.audio) { a ->
                                    // Syntolkning syns i titelsidans spårlista (vi), som har filens alla flaggor
                                    OptionRow(item?.audio?.firstOrNull { x -> x.index == a.index }?.label ?: a.label, a.index == sel) {
                                        menu = null
                                        // Direktuppspelning: byt i spelaren (ingen omstart, ljudet orört); annars via servern
                                        if (a.index != sel && !selectLocalAudio(a.index)) restart(audio = a.index)
                                    }
                                }
                            }
                            this.item { Text("Undertexter", fontWeight = FontWeight.Bold, modifier = Modifier.padding(vertical = 6.dp)) }
                            this.item { OptionRow("Inga", currentSub == null) { selectSubtitle(null); menu = null } }
                            items(item?.subtitles ?: emptyList()) { s -> OptionRow(s.label, s.id == currentSub?.id) { selectSubtitle(s); menu = null } }
                            // Undertextfiler kan synkas mot ljudet av servern (inbäddade spår kan inte)
                            val cs = currentSub
                            if (!offline && cs != null && p.subtitles.firstOrNull { x -> x.id == cs.id }?.syncable == true) {
                                this.item { CheckRow("Synka automatiskt (mot ljudet)", false) { menu = null; autoSync(cs) } }
                            }
                            // Nattläge/tydligare dialog: servern filtrerar ljudet, så strömmen startas om där man är
                            if (!offline) {
                                this.item { Text("Ljudkomfort", fontWeight = FontWeight.Bold, modifier = Modifier.padding(vertical = 6.dp)) }
                                this.item { CheckRow("Nattläge (jämnare ljudnivå)", Api.nightMode) { Api.nightMode = !Api.nightMode; menu = null; restart() } }
                                this.item { CheckRow("Tydligare dialog", Api.dialogBoost) { Api.dialogBoost = !Api.dialogBoost; menu = null; restart() } }
                            }
                        }
                    }
                })
        }
        skip?.let { label ->
            Button(onClick = {
                val p = pb
                if (label == "Hoppa över") player.seekTo(mainIndex, 0L)
                else if (label == "Hoppa över sammanfattning" && p?.recap != null) player.seekTo((p.recap.end * 1000).toLong())
                else if (label == "Hoppa över intro" && p?.intro != null) player.seekTo((p.intro.end * 1000).toLong())
                else item?.nextId?.let { next -> report(final = true); player.stop(); onPlay(Screen.Play(next, 0.0, null, null)) }
            }, modifier = Modifier.align(Alignment.BottomEnd).padding(end = 32.dp, bottom = 110.dp).height(60.dp)
                .focusRequester(skipFocus).focusRing(RoundedCornerShape(30.dp)),
                colors = ButtonDefaults.buttonColors(containerColor = Color.Black.copy(alpha = 0.75f), contentColor = Color.White)) {
                Icon(Icons.Filled.SkipNext, null); Text(" $label", fontSize = 18.sp)
            }
        }
        // Google TV: flytta fokus till knappen när den dyker upp så att den kan väljas direkt med fjärrkontrollen
        LaunchedEffect(skip) { if (tv && skip != null) runCatching { skipFocus.requestFocus() } }
        val failure: Pair<String, String>? = stopped?.let { s -> "Uppspelningen stoppades" to s } ?: error?.let { e -> "Kunde inte spela" to e }
        failure?.let { (head, text) ->
            Column(Modifier.align(Alignment.Center).widthIn(max = 560.dp).background(Surface2, RoundedCornerShape(14.dp)).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(head, fontWeight = FontWeight.Bold, color = Color.White, fontSize = 18.sp)
                Spacer(Modifier.height(6.dp))
                Text(text, color = Color.LightGray, fontSize = 15.sp)
                Spacer(Modifier.height(16.dp))
                Button(onClick = { report(final = true); onClose() }, modifier = Modifier.height(52.dp).focusRequester(closeFocus).focusRing(RoundedCornerShape(26.dp))) { Text("Stäng", fontSize = 17.sp) }
            }
            // Fjärrkontrollen: fokus på Stäng, så att OK stänger (annars ligger fokus kvar i spelaren bakom)
            LaunchedEffect(head, text) { runCatching { closeFocus.requestFocus() } }
        }
        } // !inPip
    }
}

/** HDR-typ i statusraden (serverns namn) */
private fun hdrLabel(hdr: String?): String? = when (hdr) {
    "hdr10" -> "HDR10"; "hlg" -> "HLG"; "dovi" -> "Dolby Vision"; else -> hdr?.uppercase()
}

private val SPEEDS = listOf(0.75f to "0,75×", 1f to "Normal", 1.25f to "1,25×", 1.5f to "1,5×", 1.75f to "1,75×", 2f to "2×")

@Composable
private fun CheckRow(label: String, checked: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 12.dp, horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = checked, onCheckedChange = { onClick() })
        Spacer(Modifier.width(8.dp))
        Text(label, fontSize = 17.sp)
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
