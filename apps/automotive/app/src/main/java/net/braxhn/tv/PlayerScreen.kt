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
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem as M3Item
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsManifest
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(UnstableApi::class)
@Composable
fun PlayerScreen(req: Screen.Play, onClose: () -> Unit, onPlay: (Screen.Play) -> Unit, onReport: (() -> Unit)? = null) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var item by remember(req) { mutableStateOf<MediaItem?>(null) }
    var pb by remember(req) { mutableStateOf<Playback?>(null) }
    var error by remember(req) { mutableStateOf<String?>(null) }
    // Till Feedback: titeln och felet (förval och teknisk information i en felrapport)
    LaunchedEffect(req.id, error) { Feedback.notePlayback(req.id, error) }
    var skip by remember(req) { mutableStateOf<String?>(null) } // "pre" | "recap" | "intro" | "next"
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
    var note by remember { mutableStateOf<String?>(null) }; var noteSticky by remember { mutableStateOf(false) }
    // Stoppad av servern (en vuxen i Föräldraöversikten, administratören eller skärmtiden): serverns/appens förklaring
    var stopped by remember(req) { mutableStateOf<String?>(null) }
    // Skärmtiden kvar idag (ScreenLeftCore): först appens senast kända status, sedan serverns svar på varje
    // framstegsrapport och utan nät appens egen räkning. null = ingen skärmtid eller ingen gräns idag.
    var screenLeft by remember(req) { mutableStateOf<ScreenLeftCore.Left?>(null) }
    val car = remember { isCar(context) }
    // Slutrapport och stopp av strömmen skickas en gång per uppspelning (Stäng + att vyn stängs gav dubbla anrop)
    val finalSent = remember(req) { booleanArrayOf(false) }
    // Ett framstegsanrop åt gången: report körs var tionde sekund, men utan nät tar ett anrop upp till 15 s (tidsgränsen)
    val reporting = remember(req) { booleanArrayOf(false) }
    // Tid som spelats sedan förra rapporten (ms) och förra varvet i bevakningen – räknas som skärmtid utan nät
    val played = remember(req) { longArrayOf(0L, 0L) }
    val closeFocus = remember { FocusRequester() }
    // Spolning i en omkodning (SeekCore): serverns X-Seg-Ready ur segmentens svar, målet för en omstart som pågår
    // (-1 = ingen; tidslinjen visar det), om strömmen har visat bild, och omstartens nummer (en äldre som blir klar
    // senare tar inte över)
    val segReady = remember { SegReady() }
    val pendingSeek = remember { longArrayOf(-1L) }
    val firstFrame = remember { booleanArrayOf(false) }
    val restartGen = remember { intArrayOf(0) }
    var settleJob by remember { mutableStateOf<Job?>(null) }

    val player = remember {
        // 60 s tidsgräns (Media.http): en omkodning med grafikkort kan ta ~10 s till första segmentet
        val http = Media.http(segReady)
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
        stopped = if (st != null && !st.allowed) st.message ?: context.getString(R.string.player_screen_time_up)
                  else if (Session.kid.value) context.getString(R.string.player_stopped_by_adult)
                  else context.getString(R.string.player_stopped_by_admin)
    }

    /** Skärmtiden är slut enligt appens egen räkning (nedladdad titel utan nät): stoppa med serverns besked */
    fun stoppedOffline(g: ScreenGate) {
        if (stopped != null || g.allowed) return
        player.pause()
        player.stop()
        stopped = OfflineSync.message(g)
    }

    fun report(final: Boolean = false) {
        // En nedladdad titel spelas även när servern inte svarade på /api/items/:id (item saknas då)
        val id = item?.id ?: (if (offline) req.id else return)
        // Pågår förra anropet hoppas den här rapporten över; tiden räknas med i nästa
        if (final) { if (finalSent[0]) return; finalSent[0] = true } else if (reporting[0]) return
        val pos = (if (pendingSeek[0] >= 0) pendingSeek[0] else player.currentPosition) / 1000.0
        val dur = pb?.duration ?: item?.duration ?: player.duration.takeIf { d -> d > 0 }?.let { d -> d / 1000.0 } ?: 0.0
        val secs = played[0] / 1000.0; played[0] = 0L; val started = System.currentTimeMillis()
        // Under trailers/förfilm finns inget framsteg att spara. Kommer framsteget inte fram sparas positionen i appen
        // och skickas med at när nätet är tillbaka (OfflineSync); för en nedladdad titel räknas då skärmtiden i appen.
        // Servern ger 0 för det som setts under 2 minuter, så appen erbjuder då ingen Fortsätt.
        if (pos > 1 && player.currentMediaItemIndex >= mainIndex) {
            if (offline) OfflineSync.notePlayed(id, pos, dur)
            val send: suspend () -> Unit = {
                val r: ProgressResult? = Api.reportProgress(id, pos, dur)
                if (r != null) {
                    OfflineSync.noteScreen(r.screenTime); OfflineSync.flush()
                    if (!final && item?.id == id) screenLeft = r.screenTime?.let { st -> ScreenLeftCore.ofServer(st.limited, st.allowed, st.left, st.remaining) }
                    if (!final && r.stop && item?.id == id) stoppedByServer(r)
                } else {
                    OfflineSync.savePosition(id, pos, dur, atMs = started) // en senare sparad position vinner
                    if (offline) { val g = OfflineSync.playedOffline(secs, started); if (!final && req.id == id) { stoppedOffline(g); screenLeft = ScreenLeftCore.ofGate(g) } }
                }
            }
            if (final) Api.appScope.launch { send() }
            else if (stopped == null) { reporting[0] = true; scope.launch { try { send() } finally { reporting[0] = false } } }
        }
        if (final && !offline) StreamGate.stop(id)
    }

    /** Filmen i spelarens kö: strömmen med alla textundertexter (kan bytas direkt), den valda markerad som standard */
    fun mainItem(it: MediaItem, p: Playback, sub: SubtitleTrack?): M3Item {
        val subs = p.subtitles.map { s ->
            M3Item.SubtitleConfiguration.Builder(Uri.parse(Api.absolute(s.url)))
                .setId(s.id).setMimeType(MimeTypes.TEXT_VTT).setLanguage(s.lang).setLabel(s.label)
                .setSelectionFlags(if (s.id == sub?.id) C.SELECTION_FLAG_DEFAULT else 0).build()
        }
        return M3Item.Builder()
            .setUri(Api.absolute(p.url))
            .apply { if (p.mode != "direct") setMimeType(MimeTypes.APPLICATION_M3U8) }
            .setSubtitleConfigurations(subs)
            .setMediaMetadata(MediaMetadata.Builder().setTitle(if (it.isEpisode) "${it.showTitle} – ${it.sxe} ${it.title}" else it.title).build())
            .build()
    }

    /**
     * Spolning i en omkodning: strömmen startas om vid målet (/playback med start och prev). Servern ger korta segment
     * där och stoppar den gamla strömmen. Samma ljudspår, undertext, hastighet och paus som förut; adressen är den som
     * gäller nu (hemadressen hemma). Ett nyare mål (nästa steg med fjärrkontrollen) gör den här omstarten inaktuell.
     */
    fun seekRestart(ms: Long) {
        val it = item ?: return
        val old = pb ?: return
        val gen = ++restartGen[0]
        firstFrame[0] = false
        val sub = currentSub
        val audio: Int? = old.audioSelected?.toIntOrNull() ?: req.audio
        scope.launch {
            val r = runCatching {
                val caps: Map<String, String?> = withContext(Dispatchers.IO) { Api.capabilities(audio, sub) }
                Api.get<Playback>("/api/items/${it.id}/playback", caps + Api.comfortQuery() +
                    ("start" to (ms / 1000).toString()) + ("prev" to SeekCore.pidOf(old.url)))
            }
            val np = r.getOrNull()
            if (gen != restartGen[0] || item?.id != it.id) {
                // Inaktuell: strömmen som just startades behövs inte (uppspelningen fortsätter, inget stopp räknas)
                SeekCore.pidOf(np?.url)?.let { pid -> Api.appScope.launch { runCatching { Api.post("/api/stream/${it.id}/stop?pid=$pid&replaced=1") } } }
                return@launch
            }
            if (np == null) { pendingSeek[0] = -1; error = r.exceptionOrNull()?.message ?: context.getString(R.string.player_unknown_error); return@launch }
            pb = np; prerolls = emptyList(); mainIndex = 0
            // En undertext som valts i spelaren pekar på den gamla strömmens spår – den nya väljer currentSub som standard
            player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_TEXT).build()
            player.setMediaItem(mainItem(it, np, sub), ms)
            player.prepare()
            pendingSeek[0] = -1
        }
    }

    /**
     * En spolning till ms (tidslinjen, fjärrkontrollen, kapitel, hoppa över intro): true = strömmen startas om vid målet
     * i stället för att spelaren hämtar segmentet (SeekCore.shouldRestart). step = fjärrkontrollens eller knapparnas
     * steg: omstarten väntar på nästa tryck (STEP_SETTLE_MS). Den gamla strömmen stoppas direkt i spelaren, så att den
     * inte börjar hämta 6 s-segmentet.
     */
    fun onSeek(ms: Long, step: Boolean): Boolean {
        val p = pb ?: return false
        if (offline || p.mode != "transcode" || stopped != null || error != null || player.currentMediaItemIndex < mainIndex) return false
        if (pendingSeek[0] < 0) {
            val m = player.currentManifest as? HlsManifest
            val frags = m?.mediaPlaylist?.segments?.map { s -> SeekCore.Frag(s.relativeStartTimeUs / 1e6, s.durationUs / 1e6) } ?: emptyList()
            val buffered = listOf(player.currentPosition / 1000.0 to player.bufferedPosition / 1000.0)
            if (!SeekCore.shouldRestart(buffered, ms / 1000.0, frags, segReady.rangeFor(SeekCore.pidOf(p.url)), firstFrame[0])) return false
            player.stop() // behåller kön och playWhenReady (paus förblir paus)
        }
        pendingSeek[0] = ms
        settleJob?.cancel()
        settleJob = scope.launch {
            if (step) delay(SeekCore.STEP_SETTLE_MS)
            seekRestart(pendingSeek[0])
        }
        return true
    }

    /** Appens egna hopp (kapitel, intro, sammanfattning, familjefiltret): som en spolning i tidslinjen */
    fun seekMain(ms: Long) { if (!onSeek(ms, false)) player.seekTo(ms) }

    // Läs in objekt + uppspelningsbeslut och starta
    LaunchedEffect(req) {
        // Nytt avsnitt i samma spelare: en omstart vid spolning i det förra gäller inte
        settleJob?.cancel(); restartGen[0]++; pendingSeek[0] = -1; firstFrame[0] = false
        // Tiden kvar direkt (senast kända status och tid räknad utan nät); serverns svar tar över efter tio sekunder
        screenLeft = ScreenLeftCore.ofGate(OfflineSync.gateNow())
        // Nedladdad fil: spela lokalt (fungerar utan nät)
        Downloads.localFile(req.id)?.let { f ->
            status = context.getString(R.string.player_offline); offline = true
            // Starta den lokala filen först – nätanropen nedan kan ta lång tid eller misslyckas utan täckning
            player.setMediaItem(M3Item.fromUri(Uri.fromFile(f)), (req.start * 1000).toLong())
            player.prepare(); player.playWhenReady = true
            item = runCatching { Api.get<MediaItem>("/api/items/${req.id}") }.getOrNull()
            // Servern svarar inte: skärmtiden enligt senaste kända regler och tiden som räknats i appen
            if (item == null) stoppedOffline(OfflineSync.gateNow())
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
            // Titelns uppgifter och /playback samtidigt (StartCore.together): frågan behöver inget ur titelns svar.
            // Samma fråga som förvärmningen på titelsidan (Start.query), så att servern tar över den strömmen.
            // start: servern förbereder strömmen där uppspelningen börjar (Fortsätt titta) – korta segment just där.
            // cinema=1 vid start från början: servern ger trailers bara för filmer och när bio-läget är på.
            val (it, p) = coroutineScope {
                val itemJob = async { Api.get<MediaItem>("/api/items/${req.id}") }
                val q = Start.query(req.audio, req.sub, req.start, req.skipPreroll)
                StartCore.together(Api.appScope, { itemJob.await() }, { Api.get<Playback>("/api/items/${req.id}/playback", q) }) { np -> Start.drop(req.id, np) }
            }
            item = it
            // Textundertexten väljs i spelaren (den skickas inte till servern): forcerad, annars profilens språk
            val sub = req.sub ?: it.subtitles?.firstOrNull { s -> s.forced == true && s.bitmap != true }
                ?: it.subtitles?.firstOrNull { s -> Api.subtitleLang.isNotEmpty() && s.lang == Api.subtitleLang && s.bitmap != true }
            pb = p
            currentSub = sub
            status = listOfNotNull(when (p.mode) { "direct" -> context.getString(R.string.player_direct); "remux" -> context.getString(R.string.player_remux); else -> context.getString(R.string.player_transcode) },
                if (p.tonemap == true) "HDR→SDR" else hdrLabel(it.hdr), if (p.remote == true) context.getString(R.string.player_remote) else null).joinToString(" · ")
            player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                .clearOverridesOfType(C.TRACK_TYPE_AUDIO).clearOverridesOfType(C.TRACK_TYPE_TEXT).setTrackTypeDisabled(C.TRACK_TYPE_TEXT, sub == null || sub.bitmap == true).build()
            val mi = mainItem(it, p, sub)
            // Trailers och förfilm först (egna adresser med token), sedan filmen
            val pre = p.preroll.map { e ->
                M3Item.Builder().setUri(Api.absolute(e.url))
                    .setMediaMetadata(MediaMetadata.Builder().setTitle(e.title ?: context.getString(R.string.player_trailer)).build()).build()
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
            val nowMs = android.os.SystemClock.elapsedRealtime()
            if (player.isPlaying && played[1] > 0) played[0] += nowMs - played[1]
            played[1] = nowMs
            val p = pb
            val idx = player.currentMediaItemIndex
            prerollLabel = if (idx < mainIndex) prerolls.getOrNull(idx)?.let { e -> if (e.kind == "preroll") context.getString(R.string.player_preroll) else context.getString(R.string.player_trailer_title, e.title ?: "") } else null
            // Bild-i-bild får videons format
            val vs = player.videoSize
            if (pipOk) Pip.aspect = Pip.ratio((vs.width * vs.pixelWidthHeightRatio).toInt(), vs.height)
            skip = when {
                idx < mainIndex -> "pre"
                p?.recap != null && t >= p.recap.start && t < p.recap.end - 1 -> "recap"
                p?.intro != null && t >= p.intro.start && t < p.intro.end - 1 -> "intro"
                p?.credits != null && item?.nextId != null && t >= p.credits && t < p.credits + 60 -> "next"
                else -> null
            }
            // Familjefiltret i läget "hoppa över scener": planen från /playback (servern tystar svordomarna själv)
            val f = p?.filter
            if (f != null && f.mode == "skip" && idx >= mainIndex && player.isPlaying) {
                val sc = f.skip.firstOrNull { x -> t >= x.start && t < x.end - 0.3 }
                if (sc != null) { seekMain((sc.end * 1000).toLong()); note = context.getString(R.string.player_skipped_scene, sc.label ?: context.getString(R.string.player_marked_scene)) }
            }
            if (++n % 20 == 0 && player.isPlaying) report()
        }
    }
    LaunchedEffect(note) { if (note != null && !noteSticky) { delay(4000); note = null } }

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
        modeNote = context.getString(R.string.player_frame_rate, fps)
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
            override fun onRenderedFirstFrame() { firstFrame[0] = true }
            override fun onPlayerError(e: androidx.media3.common.PlaybackException) {
                // En omstart vid spolning pågår: den gamla strömmen gäller inte längre
                if (pendingSeek[0] >= 0) return
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
        val at = if (pendingSeek[0] >= 0) pendingSeek[0] / 1000.0 else if (player.currentMediaItemIndex >= mainIndex) player.currentPosition / 1000.0 else req.start
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
        noteSticky = true; note = context.getString(R.string.player_syncing)
        scope.launch {
            val audio: Int? = localAudio ?: pb?.audioSelected?.toIntOrNull() ?: req.audio
            val r = runCatching { Api.autoSyncSubtitle(it.id, s.id, audio) { pr: Double -> note = context.getString(R.string.player_syncing_progress, (pr * 100).toInt()) } }
            val job: SubSyncJob? = r.getOrNull()
            noteSticky = false; note = when {
                r.isFailure -> context.getString(R.string.player_sync_failed, r.exceptionOrNull()?.message ?: "")
                job?.state == "done" -> job?.result?.offset?.let { o -> context.getString(R.string.player_synced_offset, o) } ?: context.getString(R.string.player_synced)
                job?.state == "unsure" -> context.getString(R.string.player_sync_unsure)
                else -> context.getString(R.string.player_sync_failed, job?.error ?: context.getString(R.string.player_unknown_error))
            }
            if (job?.state == "done") restart(sub = s)
        }
    }

    // Statusraden: syntolkning (valt ljudspår) och familjefiltret
    val selAudio: Int? = localAudio ?: pb?.audioSelected?.toIntOrNull() ?: req.audio
    val audioDesc: Boolean = item?.audio?.let { list -> (list.firstOrNull { a -> a.index == selAudio } ?: list.firstOrNull { a -> selAudio == null && a.default == true })?.isAudioDesc } == true
    val extraStatus: String? = listOfNotNull(if (audioDesc) tr(R.string.audio_description) else null,
        pb?.filter?.let { f -> tr(if (f.mode == "skip") R.string.player_family_skip else R.string.player_family) }).joinToString(" · ").takeIf { x -> x.isNotEmpty() }

    // Spelaren som PlayerView styr: spolningar går först till onSeek (senaste versionen, med aktuella värden)
    val seekHook = rememberUpdatedState<(Long, Boolean) -> Boolean> { ms, step -> onSeek(ms, step) }
    val viewPlayer = remember(player) { SeekingPlayer(player, seekHook, pendingSeek) }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(factory = { ctx -> PlayerView(ctx).apply { this.player = viewPlayer; setShowSubtitleButton(true); keepScreenOn = true } },
            update = { v -> v.useController = !inPip }, modifier = Modifier.fillMaxSize())
        // Bild-i-bild: bara videon, inga knappar
        if (!inPip) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { report(final = true); onClose() }, modifier = Modifier.size(56.dp).focusRing(RoundedCornerShape(28.dp)).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                Icon(Icons.Filled.Close, tr(R.string.close), tint = Color.White, modifier = Modifier.size(30.dp))
            }
            Spacer(Modifier.width(12.dp))
            Text(item?.let { if (it.isEpisode) "${it.showTitle} · ${it.sxe} · ${it.title}" else it.title } ?: "", color = Color.White, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            // Skärmtiden kvar idag (kort text på en smal telefon, som webben)
            val left = screenLeft
            val show = ScreenLeftCore.show(left, car)
            if (left != null && show != null && stopped == null) {
                val amount = left.hours?.let { h -> tr(R.string.player_screen_left_hours, h, left.restMinutes) } ?: tr(R.string.player_screen_left_min, left.minutes)
                val compact = LocalConfiguration.current.screenWidthDp < 600
                Text(tr(if (compact) R.string.player_screen_left_short else R.string.player_screen_left_today, amount),
                    color = if (show.low) LowTime else Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
                    modifier = Modifier.background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(14.dp)).padding(horizontal = 10.dp, vertical = 4.dp))
                Spacer(Modifier.width(8.dp))
            }
            Text(prerollLabel ?: modeNote ?: note ?: listOfNotNull(status.takeIf { x -> x.isNotEmpty() }, extraStatus).joinToString(" · "), color = Color.LightGray, fontSize = 12.sp)
            val p = pb
            Spacer(Modifier.width(8.dp))
            IconButton(onClick = { menu = "speed" }, modifier = Modifier.size(56.dp).focusRing(RoundedCornerShape(28.dp)).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                Icon(Icons.Filled.Speed, tr(R.string.player_speed), tint = Color.White, modifier = Modifier.size(28.dp))
            }
            if (pipOk) {
                Spacer(Modifier.width(8.dp))
                IconButton(onClick = { Pip.enter(activity) }, modifier = Modifier.size(56.dp).focusRing(RoundedCornerShape(28.dp)).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                    Icon(Icons.Filled.PictureInPictureAlt, tr(R.string.player_pip), tint = Color.White, modifier = Modifier.size(28.dp))
                }
            }
            if (p != null && (p.audio.size > 1 || p.subtitles.isNotEmpty() || (item?.subtitles?.isNotEmpty() == true) || !offline)) {
                Spacer(Modifier.width(8.dp))
                IconButton(onClick = { menu = "tracks" }, modifier = Modifier.size(56.dp).focusRing(RoundedCornerShape(28.dp)).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                    Icon(Icons.Filled.Subtitles, tr(R.string.player_tracks), tint = Color.White, modifier = Modifier.size(28.dp))
                }
            }
            if (p != null && p.chapters.isNotEmpty()) {
                Spacer(Modifier.width(8.dp))
                IconButton(onClick = { menu = "chapters" }, modifier = Modifier.size(56.dp).focusRing(RoundedCornerShape(28.dp)).background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(28.dp))) {
                    Icon(Icons.Filled.List, tr(R.string.player_chapters), tint = Color.White, modifier = Modifier.size(28.dp))
                }
            }
        }
        // Varningen de sista fem minuterna (inte i bilen, se ScreenLeftCore.show): texten byts bara när minuten ändras
        val warnLeft = screenLeft
        val warnShow = ScreenLeftCore.show(warnLeft, car)
        if (warnLeft != null && warnShow != null && warnShow.banner && stopped == null) {
            val announce = warnShow.announce
            Text(tr(R.string.player_screen_warn, warnLeft.minutes), color = Color.Black, fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 84.dp).background(LowTime, RoundedCornerShape(18.dp))
                    .padding(horizontal = 16.dp, vertical = 8.dp)
                    .semantics { if (announce) liveRegion = LiveRegionMode.Polite })
        }
        if (menu != null) {
            val p = pb
            AlertDialog(onDismissRequest = { menu = null }, confirmButton = { TextButton(onClick = { menu = null }) { Text(tr(R.string.close)) } },
                title = { Text(tr(when (menu) { "chapters" -> R.string.player_chapters; "speed" -> R.string.player_speed_title; else -> R.string.player_tracks })) },
                text = {
                    LazyColumn(Modifier.heightIn(max = 420.dp)) {
                        if (menu == "speed") {
                            items(SPEEDS) { v ->
                                OptionRow(if (v == 1f) tr(R.string.player_speed_normal) else java.text.NumberFormat.getInstance().format(v.toDouble()) + "×", v == speed) {
                                    speed = v; player.setPlaybackSpeed(v); menu = null
                                }
                            }
                        } else if (menu == "chapters" && p != null) {
                            val now = player.currentPosition / 1000.0
                            val cur = p.chapters.lastOrNull { c -> c.start <= now }
                            items(p.chapters) { c ->
                                OptionRow("${c.title}   ${fmtTime(c.start)}", c == cur) { seekMain(((c.start + 0.05) * 1000).toLong()); menu = null }
                            }
                        } else if (p != null) {
                            if (p.audio.size > 1) {
                                this.item { Text(tr(R.string.audio), fontWeight = FontWeight.Bold, modifier = Modifier.padding(vertical = 6.dp)) }
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
                            this.item { Text(tr(R.string.subtitles), fontWeight = FontWeight.Bold, modifier = Modifier.padding(vertical = 6.dp)) }
                            this.item { OptionRow(tr(R.string.none), currentSub == null) { selectSubtitle(null); menu = null } }
                            items(item?.subtitles ?: emptyList()) { s -> OptionRow(s.label, s.id == currentSub?.id) { selectSubtitle(s); menu = null } }
                            // Undertextfiler kan synkas mot ljudet av servern (inbäddade spår kan inte)
                            val cs = currentSub
                            if (!offline && cs != null && p.subtitles.firstOrNull { x -> x.id == cs.id }?.syncable == true) {
                                this.item { CheckRow(tr(R.string.player_auto_sync), false) { menu = null; autoSync(cs) } }
                            }
                            // Nattläge/tydligare dialog: servern filtrerar ljudet, så strömmen startas om där man är
                            if (!offline) {
                                this.item { Text(tr(R.string.player_comfort), fontWeight = FontWeight.Bold, modifier = Modifier.padding(vertical = 6.dp)) }
                                this.item { CheckRow(tr(R.string.player_night), Api.nightMode) { Api.nightMode = !Api.nightMode; menu = null; restart() } }
                                this.item { CheckRow(tr(R.string.dialog_on), Api.dialogBoost) { Api.dialogBoost = !Api.dialogBoost; menu = null; restart() } }
                            }
                        }
                    }
                })
        }
        skip?.let { kind ->
            Button(onClick = {
                val p = pb
                if (kind == "pre") player.seekTo(mainIndex, 0L)
                else if (kind == "recap" && p?.recap != null) seekMain((p.recap.end * 1000).toLong())
                else if (kind == "intro" && p?.intro != null) seekMain((p.intro.end * 1000).toLong())
                else item?.nextId?.let { next -> report(final = true); player.stop(); onPlay(Screen.Play(next, 0.0, null, null)) }
            }, modifier = Modifier.align(Alignment.BottomEnd).padding(end = 32.dp, bottom = 110.dp).height(60.dp)
                .focusRequester(skipFocus).focusRing(RoundedCornerShape(30.dp)),
                colors = ButtonDefaults.buttonColors(containerColor = Color.Black.copy(alpha = 0.75f), contentColor = Color.White)) {
                Icon(Icons.Filled.SkipNext, null); Text(" " + tr(when (kind) { "pre" -> R.string.player_skip; "recap" -> R.string.player_skip_recap; "intro" -> R.string.player_skip_intro; else -> R.string.player_next_episode }), fontSize = 18.sp)
            }
        }
        // Google TV: flytta fokus till knappen när den dyker upp så att den kan väljas direkt med fjärrkontrollen
        LaunchedEffect(skip) { if (tv && skip != null) runCatching { skipFocus.requestFocus() } }
        val failure: Pair<String, String>? = stopped?.let { s -> tr(R.string.player_stopped) to s } ?: error?.let { e -> tr(R.string.player_failed) to e }
        failure?.let { (head, text) ->
            Column(Modifier.align(Alignment.Center).widthIn(max = 560.dp).background(Surface2, RoundedCornerShape(14.dp)).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(head, fontWeight = FontWeight.Bold, color = Color.White, fontSize = 18.sp)
                Spacer(Modifier.height(6.dp))
                Text(text, color = Color.LightGray, fontSize = 15.sp)
                Spacer(Modifier.height(16.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    // Uppspelningen gick inte (inte ett stopp från skärmtiden eller en vuxen): felet går att rapportera
                    if (error != null && stopped == null && onReport != null)
                        OutlinedButton(onClick = { report(final = true); onReport() }, modifier = Modifier.height(52.dp).focusRing(RoundedCornerShape(26.dp))) { Text(tr(R.string.feedback_report_problem), fontSize = 17.sp) }
                    Button(onClick = { report(final = true); onClose() }, modifier = Modifier.height(52.dp).focusRequester(closeFocus).focusRing(RoundedCornerShape(26.dp))) { Text(tr(R.string.close), fontSize = 17.sp) }
                }
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

/** Skärmtiden de sista minuterna (tiden kvar och varningen) */
private val LowTime = Color(0xFFFFC857)

private val SPEEDS = listOf(0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f)

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

/**
 * Spelaren som PlayerView (tidslinjen, snabbspolning, fjärrkontrollens media- och pilknappar) styr: varje spolning går
 * först till onSeek, som kan starta om strömmen vid målet i stället (omkodning, SeekCore). Medan en omstart pågår
 * visar tidslinjen målet, och nästa steg räknas därifrån.
 */
@OptIn(UnstableApi::class)
private class SeekingPlayer(p: Player, private val onSeek: State<(Long, Boolean) -> Boolean>, private val pending: LongArray) : ForwardingPlayer(p) {
    private fun pos(): Long = if (pending[0] >= 0) pending[0] else super.getCurrentPosition()
    override fun getCurrentPosition(): Long = pos()
    override fun getContentPosition(): Long = if (pending[0] >= 0) pending[0] else super.getContentPosition()
    override fun seekTo(positionMs: Long) { if (!onSeek.value(positionMs, false)) super.seekTo(positionMs) }
    override fun seekTo(mediaItemIndex: Int, positionMs: Long) {
        if (mediaItemIndex != currentMediaItemIndex || !onSeek.value(positionMs, false)) super.seekTo(mediaItemIndex, positionMs)
    }
    override fun seekForward() {
        val t = SeekCore.stepTarget(pos(), seekForwardIncrement, duration)
        if (!onSeek.value(t, true)) super.seekForward()
    }
    override fun seekBack() {
        val t = SeekCore.stepTarget(pos(), -seekBackIncrement, duration)
        if (!onSeek.value(t, true)) super.seekBack()
    }
}

/**
 * X-Seg-Ready ur serverns svar på segmenten (omkodning): vilka segment servern har klara i den pågående körningen, för
 * strömmen (pid) som senast svarade. Läses av onSeek – spolar man dit görs ingen omstart.
 */
@OptIn(UnstableApi::class)
private class SegReady : TransferListener {
    @Volatile private var last: Pair<String, IntRange>? = null
    fun rangeFor(pid: String?): IntRange? = last?.takeIf { pid != null && it.first == pid }?.second
    override fun onTransferInitializing(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {}
    override fun onTransferStart(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {
        val u = dataSpec.uri.toString()
        if (!u.contains("/hls/seg-")) return
        val h = source.responseHeaders.entries.firstOrNull { e -> e.key.equals("X-Seg-Ready", ignoreCase = true) }?.value?.firstOrNull()
        val r = SeekCore.readyRange(h) ?: return
        val pid = SeekCore.pidOf(u) ?: return
        last = pid to r
    }
    override fun onBytesTransferred(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean, bytesTransferred: Int) {}
    override fun onTransferEnd(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {}
}
