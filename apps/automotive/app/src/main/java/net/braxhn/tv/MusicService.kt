package net.braxhn.tv

import android.net.Uri
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.CommandButton
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.isActive
import kotlinx.coroutines.cancel
import kotlinx.coroutines.guava.future
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.Serializable
import java.util.concurrent.ConcurrentHashMap

// ---- musikmodeller (matchar /api/music) ----
@Serializable data class MAlbum(val id: Int, val title: String, val year: Int? = null, val cover: Boolean = false, val artist: String? = null, val artistId: Int? = null, val tracks: Int? = null)
@Serializable data class MTrack(val id: Int, val title: String, val track: Int? = null, val duration: Double? = null, val albumId: Int? = null,
                                val album: String? = null, val cover: Boolean = false, val artist: String? = null, val gain: Double? = null)
@Serializable data class MAlbumDetail(val id: Int, val title: String, val artist: String? = null, val cover: Boolean = false, val trackList: List<MTrack> = emptyList())
@Serializable data class MArtist(val id: Int, val name: String, val albums: Int? = null)
@Serializable data class MArtistDetail(val id: Int, val name: String, val albums: List<MAlbum> = emptyList(), val popular: List<MTrack> = emptyList())
@Serializable data class MPlaylist(val id: Int, val name: String, val tracks: Int? = null)
@Serializable data class MPlaylistDetail(val id: Int, val name: String, val trackList: List<MTrack> = emptyList())
@Serializable data class BFile(val id: Int, val idx: Int, val offset: Double = 0.0, val duration: Double? = null)
@Serializable data class BBook(val id: Int, val title: String, val author: String? = null, val duration: Double? = null, val cover: Boolean = false,
                               val position: Double = 0.0, val finished: Boolean = false, val files: List<BFile> = emptyList())
@Serializable data class BList(@kotlinx.serialization.SerialName("continue") val cont: List<BBook> = emptyList(), val books: List<BBook> = emptyList())
@Serializable data class PPod(val id: Int, val title: String? = null, val author: String? = null, val image: Boolean = false, val unplayed: Int = 0)
@Serializable data class PEp(val id: Int, val podcast: Int, val podcastTitle: String? = null, val title: String, val duration: Double? = null,
                             val position: Double = 0.0, val played: Boolean = false, val published: Long? = null)
@Serializable data class PList(val podcasts: List<PPod> = emptyList(), val latest: List<PEp> = emptyList())
@Serializable data class PDetail(val id: Int, val title: String? = null, val image: Boolean = false, val episodes: List<PEp> = emptyList())
@Serializable data class MHome(val recentAlbums: List<MAlbum> = emptyList(), val recentlyPlayed: List<MAlbum> = emptyList(), val favorites: List<MTrack> = emptyList(),
                               val smart: List<MSmart> = emptyList())
@Serializable data class MSmart(val id: String, val name: String, val count: Int = 0)
@Serializable data class MSmartDetail(val id: String, val name: String? = null, val trackList: List<MTrack> = emptyList())

/**
 * Musik i bilen. Android Automotive visar den här tjänsten i bilens egen mediaspelare – till skillnad
 * från video får musik användas under körning. Fungerar även med Android Auto/Bluetooth-kontroller.
 *
 * Bläddringsträd: root → Spelat nyligen / Nytt / Smarta listor / Album / Artister / Spellistor / Favoriter
 * Spår får id "t:<spår>:<sammanhang>" så att hela albumet/listan köas när man väljer en låt.
 */
@OptIn(UnstableApi::class)
class MusicService : MediaLibraryService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var session: MediaLibrarySession? = null
    @Volatile private var libId: Int? = null
    @Volatile private var bookLibId: Int? = null
    @Volatile private var libsLoaded = false
    @Volatile private var libsAt = 0L
    /** Ljudbok som spelas: filernas startpositioner (för att räkna global position och spara den) */
    @Volatile private var currentBook: BBook? = null

    private var exo: ExoPlayer? = null
    /** Spårens gain (dB mot -18 LUFS) för jämn ljudnivå – fylls när spår listas */
    private val gains = ConcurrentHashMap<Int, Double>()
    /** Volym för aktuellt spår (jämn ljudnivå, bara dämpning) och sovtimerns nedtoning */
    private var baseVolume = 1f
    private var fade = 1f
    /** Sovtimer: 0 = av, >0 = minuter, -1 = när låten/filen/avsnittet tar slut */
    private var sleepMode = 0
    private var sleepDeadline = 0L
    private var sleepShownMin = -1
    private var sleepJob: Job? = null
    private val sleepCommand = SessionCommand(CMD_SLEEP, Bundle.EMPTY)

    /** Bläddringsträdet cachas en kort stund – bilens mediaspelare frågar ofta efter samma sida */
    private class Cached(val at: Long, val items: List<MediaItem>)
    private val childCache = ConcurrentHashMap<String, Cached>()

    override fun onCreate() {
        super.onCreate()
        val http = DefaultHttpDataSource.Factory().setUserAgent("BraXhnTV-Android").setAllowCrossProtocolRedirects(true)
        // Kontots token skickas som header (inte i URL:en) och läses vid varje anrop – den kan bytas medan tjänsten lever
        val authed = ResolvingDataSource.Factory(http) { spec ->
            val t = Api.token.value
            if (t != null) spec.withAdditionalHeaders(mapOf("Authorization" to "Bearer $t")) else spec
        }
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(authed))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .build()
        exo = player
        // Hopp bakåt/framåt enligt lyssningsinställningarna (läses vid varje hopp – kan ändras medan tjänsten lever)
        val skipping = object : ForwardingPlayer(player) {
            override fun seekBack() = seekBy(-Api.skipBack * 1000L)
            override fun seekForward() = seekBy(Api.skipForward * 1000L)
            override fun getSeekBackIncrement(): Long = Api.skipBack * 1000L
            override fun getSeekForwardIncrement(): Long = Api.skipForward * 1000L
            private fun seekBy(ms: Long) {
                var t = player.currentPosition + ms
                val d = player.duration
                if (d != C.TIME_UNSET && d > 0) t = t.coerceAtMost(d)
                player.seekTo(t.coerceAtLeast(0L))
            }
        }
        session = MediaLibrarySession.Builder(this, skipping, Callback()).build()
        session?.setCustomLayout(ImmutableList.of(sleepButton()))
        // Spara position för ljudböcker och poddar var 15:e sekund och vid paus
        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) { if (!isPlaying) saveSpoken(player) }
            // Spelade låtar syns under "Spelat nyligen" (som i webben och iOS)
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                val p = mediaItem?.mediaId?.split(":") ?: return
                val tid = if (p[0] == "t") p.getOrNull(1)?.toIntOrNull() else null
                // Jämn ljudnivå för musik (ExoPlayer kan bara dämpa), hoppa över tystnad bara i poddar
                baseVolume = if (tid != null && Api.normalize) gainVolume(gains[tid]) else 1f
                player.setVolume(baseVolume * fade)
                player.setSkipSilenceEnabled(p[0] == "pe" && Api.skipSilence)
                if (tid != null) Api.appScope.launch { runCatching { Api.post("/api/music/tracks/$tid/played") } }
            }
            // Byte av fil/avsnitt: spara slutpositionen för det föregående
            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                if (oldPosition.mediaItemIndex == newPosition.mediaItemIndex) return
                val prev = oldPosition.mediaItem?.mediaId ?: return
                saveSpoken(prev, oldPosition.positionMs / 1000.0)
            }
        })
        scope.launch(Dispatchers.Main) { while (true) { delay(15000); if (player.isPlaying) saveSpoken(player) } }
        // Ny inloggning: läs om bibliotek och bläddringsträd
        scope.launch { Api.token.collect { libsLoaded = false; childCache.clear() } }
    }

    // ---------- jämn ljudnivå och sovtimer ----------
    private fun gainVolume(gain: Double?): Float {
        if (gain == null || gain.isNaN()) return 1f
        return Math.pow(10.0, gain / 20.0).coerceIn(0.05, 1.0).toFloat()
    }

    private fun setFade(f: Float) {
        fade = f
        exo?.setVolume(baseVolume * fade)
    }

    private fun sleepButton(): CommandButton {
        val name = when {
            sleepMode > 0 -> "Sovtimer: ${sleepShownMin.coerceAtLeast(1)} min"
            sleepMode < 0 -> "Sovtimer: vid slutet"
            else -> "Sovtimer"
        }
        return CommandButton.Builder()
            .setDisplayName(name)
            .setIconResId(if (sleepMode == 0) R.drawable.ic_sleep else R.drawable.ic_sleep_on)
            .setSessionCommand(sleepCommand)
            .build()
    }

    private fun updateSleepButton() { session?.setCustomLayout(ImmutableList.of(sleepButton())) }

    /** Av → 15 → 30 → 45 → 60 min → när låten/avsnittet tar slut → Av */
    private fun cycleSleep() = setSleep(when { sleepMode == 0 -> 15; sleepMode in 1..45 -> sleepMode + 15; sleepMode >= 60 -> -1; else -> 0 })

    private fun setSleep(mode: Int) {
        sleepJob?.cancel()
        sleepJob = null
        sleepMode = mode
        sleepDeadline = if (mode > 0) System.currentTimeMillis() + mode * 60_000L else 0L
        sleepShownMin = mode
        setFade(1f)
        // Exakt paus i slutet av spåret (annars går spelaren vidare till nästa)
        exo?.setPauseAtEndOfMediaItems(mode < 0)
        if (mode != 0) sleepJob = scope.launch(Dispatchers.Main) {
            while (isActive) { sleepTick(); delay(250) }
        }
        updateSleepButton()
    }

    private fun sleepTick() {
        val p = exo ?: return
        val left = if (sleepMode > 0) (sleepDeadline - System.currentTimeMillis()) / 1000.0 else {
            val d = p.duration
            if (d == C.TIME_UNSET || d <= 0) return
            (d - p.currentPosition) / 1000.0 / p.playbackParameters.speed.coerceAtLeast(0.1f)
        }
        setFade(if (left < SLEEP_FADE) (left / SLEEP_FADE).coerceIn(0.0, 1.0).toFloat() else 1f)
        if (left <= 0.3) {
            p.pause() // sparar positionen via onIsPlayingChanged
            setSleep(0)
            return
        }
        if (sleepMode > 0) {
            val m = Math.ceil(left / 60.0).toInt()
            if (m != sleepShownMin) { sleepShownMin = m; updateSleepButton() }
        }
    }

    private fun saveSpoken(player: Player) {
        val id = player.currentMediaItem?.mediaId ?: return
        saveSpoken(id, player.currentPosition / 1000.0)
    }

    private fun saveSpoken(mediaId: String, pos: Double) {
        val p = mediaId.split(":")
        when (p[0]) {
            "bf" -> {
                // bf:<bok>:<fil> – kontrollera att det är samma bok som currentBook (kan ha bytts)
                val bookId = p.getOrNull(1)?.toIntOrNull() ?: return
                val b = currentBook?.takeIf { it.id == bookId } ?: return
                val f = b.files.getOrNull(p.getOrNull(2)?.toIntOrNull() ?: return) ?: return
                Api.appScope.launch { runCatching { Api.post("/api/audiobooks/book/$bookId/progress", buildJsonObject { put("position", f.offset + pos) }) } }
            }
            "pe" -> { val epId = p.getOrNull(1) ?: return
                Api.appScope.launch { runCatching { Api.post("/api/podcasts/episodes/$epId/progress", buildJsonObject { put("position", pos) }) } } }
        }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

    override fun onDestroy() {
        sleepJob?.cancel()
        session?.let { saveSpoken(it.player) }
        session?.run { player.release(); release() }
        session = null
        scope.cancel()
        super.onDestroy()
    }

    // ---------- hjälpare ----------
    private val audioCaps = "mp3,aac,flac,opus,vorbis"
    private fun trackUri(id: Int) = Uri.parse(Api.absolute("/api/music/tracks/$id/stream?a=$audioCaps&br=256"))
    private fun coverUri(albumId: Int?, has: Boolean): Uri? {
        val t = Api.imageToken.value ?: return null
        return if (albumId != null && has) Uri.parse(Api.url("/api/music/cover/$albumId", mapOf("t" to t))) else null
    }
    private fun folder(id: String, title: String, sub: String? = null, art: Uri? = null, type: Int = MediaMetadata.MEDIA_TYPE_FOLDER_MIXED) =
        MediaItem.Builder().setMediaId(id).setMediaMetadata(
            MediaMetadata.Builder().setTitle(title).setSubtitle(sub).setArtworkUri(art).setIsBrowsable(true).setIsPlayable(false).setMediaType(type).build()
        ).build()
    private fun track(t: MTrack, ctx: String): MediaItem { t.gain?.let { gains[t.id] = it }; return trackItem(t, ctx) }
    private fun trackItem(t: MTrack, ctx: String) = MediaItem.Builder()
        .setMediaId("t:${t.id}:$ctx")
        .setUri(trackUri(t.id))
        .setMediaMetadata(MediaMetadata.Builder().setTitle(t.title).setArtist(t.artist).setAlbumTitle(t.album)
            .setArtworkUri(coverUri(t.albumId, t.cover)).setTrackNumber(t.track).setIsBrowsable(false).setIsPlayable(true)
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC).build())
        .build()
    private fun album(a: MAlbum) = folder("al:${a.id}", a.title, listOfNotNull(a.artist, a.year?.toString()).joinToString(" · "), coverUri(a.id, a.cover), MediaMetadata.MEDIA_TYPE_ALBUM)

    private suspend fun loadLibs() {
        // Bildtokenen förnyas av Api när den är äldre än ett dygn (gäller 7 dygn)
        Api.refreshImageToken()
        if (libsLoaded && System.currentTimeMillis() - libsAt < LIBS_TTL) return
        Api.refreshListenPrefs()
        val l: List<Library> = Api.get("/api/libraries")
        libId = l.firstOrNull { it.type == "music" }?.id
        bookLibId = l.firstOrNull { it.type == "audiobook" }?.id
        libsAt = System.currentTimeMillis()
        libsLoaded = true
    }
    private suspend fun lib(): Int? { loadLibs(); return libId }

    private fun img(path: String): Uri? { val t = Api.imageToken.value ?: return null; return Uri.parse(Api.url(path, mapOf("t" to t))) }
    private fun playable(id: String, title: String, sub: String?, art: Uri?, type: Int) = MediaItem.Builder().setMediaId(id).setMediaMetadata(
        MediaMetadata.Builder().setTitle(title).setSubtitle(sub).setArtist(sub).setArtworkUri(art).setIsBrowsable(false).setIsPlayable(true).setMediaType(type).build()).build()
    private fun bookItem(b: BBook) = playable("b:${b.id}", b.title, listOfNotNull(b.author, if (b.position > 30 && !b.finished) "påbörjad" else null).joinToString(" · "),
        if (b.cover) img("/api/audiobooks/cover/${b.id}") else null, MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
    private fun epItem(e: PEp) = playable("pe:${e.id}", e.title, listOfNotNull(e.podcastTitle, if (e.played) "lyssnad" else null).joinToString(" · "),
        img("/api/podcasts/${e.podcast}/image"), MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE)
    private fun epMedia(e: PEp) = epItem(e).buildUpon().setUri(Uri.parse(Api.absolute("/api/podcasts/episodes/${e.id}/stream"))).build()

    /** Bok → kö med en post per fil, startar i rätt fil och på rätt ställe */
    private suspend fun bookQueue(id: String): MediaSession.MediaItemsWithStartPosition? {
        val b = Api.get<BBook>("/api/audiobooks/book/$id")
        if (b.files.isEmpty()) return null
        currentBook = b
        val pos = if (b.finished) 0.0 else b.position
        val idx = b.files.indexOfLast { it.offset <= pos }.coerceAtLeast(0)
        val items = b.files.mapIndexed { i, f ->
            MediaItem.Builder().setMediaId("bf:${b.id}:$i").setUri(Uri.parse(Api.absolute("/api/audiobooks/files/${f.id}/stream?a=$audioCaps")))
                .setMediaMetadata(MediaMetadata.Builder().setTitle(b.title).setArtist(b.author).setAlbumTitle(b.title)
                    .setArtworkUri(if (b.cover) img("/api/audiobooks/cover/${b.id}") else null).setTrackNumber(i + 1)
                    .setIsBrowsable(false).setIsPlayable(true).setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK_CHAPTER).build()).build()
        }
        return MediaSession.MediaItemsWithStartPosition(items, idx, ((pos - b.files[idx].offset) * 1000).toLong().coerceAtLeast(0))
    }

    /** Spår i ett sammanhang (album, spellista, favoriter …) – används både för bläddring och kö. */
    private suspend fun tracksOf(ctx: String): List<MTrack> {
        val (kind, id) = ctx.split("-", limit = 2).let { it[0] to it.getOrNull(1) }
        return when (kind) {
            "al" -> Api.get<MAlbumDetail>("/api/music/albums/$id").trackList
            "pl" -> Api.get<MPlaylistDetail>("/api/music/playlists/$id").trackList
            "ar" -> Api.get<MArtistDetail>("/api/music/artists/$id").popular
            "fav" -> lib()?.let { Api.get<MHome>("/api/music/$it/home").favorites } ?: emptyList()
            "sm" -> lib()?.let { Api.get<MSmartDetail>("/api/music/$it/smart/$id").trackList } ?: emptyList()
            else -> emptyList()
        }
    }

    private suspend fun cachedChildren(parent: String): List<MediaItem> {
        val now = System.currentTimeMillis()
        val hit = childCache[parent]
        if (hit != null && now - hit.at < CACHE_TTL) return hit.items
        val items = children(parent)
        childCache[parent] = Cached(now, items)
        return items
    }

    private suspend fun children(parent: String): List<MediaItem> {
        loadLibs()
        // Ljudböcker och poddar fungerar även utan musikbibliotek
        when {
            parent == "books" -> { val bl = bookLibId ?: return emptyList(); val r = Api.get<BList>("/api/audiobooks/$bl", mapOf("sort" to "recent"))
                return (r.cont + r.books.filter { b -> r.cont.none { it.id == b.id } }).map(::bookItem) }
            parent == "pods" -> { val r = Api.get<PList>("/api/podcasts")
                return listOf(folder("podlatest", "Senaste avsnitten", type = MediaMetadata.MEDIA_TYPE_FOLDER_PODCASTS)) +
                    r.podcasts.map { folder("pod:${it.id}", it.title ?: "Podd", if (it.unplayed > 0) "${it.unplayed} nya" else it.author, if (it.image) img("/api/podcasts/${it.id}/image") else null, MediaMetadata.MEDIA_TYPE_PODCAST) } }
            parent == "podlatest" -> return Api.get<PList>("/api/podcasts").latest.map(::epItem)
            parent.startsWith("pod:") -> { val d = Api.get<PDetail>("/api/podcasts/${parent.removePrefix("pod:")}"); return d.episodes.take(100).map { epItem(it.copy(podcastTitle = d.title)) } }
        }
        val l = lib()
        if (parent == ROOT) return listOfNotNull(
            l?.let { folder("recent", "Spelat nyligen", type = MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS) },
            l?.let { folder("new", "Nytt", type = MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS) },
            l?.let { folder("smart", "Smarta listor", type = MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS) },
            l?.let { folder("albums", "Album", type = MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS) },
            l?.let { folder("artists", "Artister", type = MediaMetadata.MEDIA_TYPE_FOLDER_ARTISTS) },
            l?.let { folder("playlists", "Spellistor", type = MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS) },
            l?.let { folder("favorites", "Favoriter", type = MediaMetadata.MEDIA_TYPE_PLAYLIST) },
            bookLibId?.let { folder("books", "Ljudböcker", type = MediaMetadata.MEDIA_TYPE_FOLDER_AUDIO_BOOKS) },
            folder("pods", "Poddar", type = MediaMetadata.MEDIA_TYPE_FOLDER_PODCASTS)
        )
        if (l == null) return emptyList()
        return when {
            parent == "recent" -> Api.get<MHome>("/api/music/$l/home").recentlyPlayed.map(::album)
            parent == "new" -> Api.get<MHome>("/api/music/$l/home").recentAlbums.map(::album)
            parent == "albums" -> Api.get<List<MAlbum>>("/api/music/$l/albums", mapOf("sort" to "artist")).map(::album)
            parent == "artists" -> Api.get<List<MArtist>>("/api/music/$l/artists").map { folder("ar:${it.id}", it.name, "${it.albums ?: 0} album", null, MediaMetadata.MEDIA_TYPE_ARTIST) }
            parent == "playlists" -> Api.get<List<MPlaylist>>("/api/music/playlists").map { folder("pl:${it.id}", it.name, "${it.tracks ?: 0} låtar", null, MediaMetadata.MEDIA_TYPE_PLAYLIST) }
            parent == "favorites" -> tracksOf("fav").map { track(it, "fav") }
            parent == "smart" -> Api.get<MHome>("/api/music/$l/home").smart.map { folder("sm:${it.id}", it.name, "${it.count} låtar", null, MediaMetadata.MEDIA_TYPE_PLAYLIST) }
            parent.startsWith("sm:") -> { val id = parent.removePrefix("sm:"); tracksOf("sm-$id").map { track(it, "sm-$id") } }
            parent.startsWith("al:") -> { val id = parent.removePrefix("al:"); tracksOf("al-$id").map { track(it, "al-$id") } }
            parent.startsWith("pl:") -> { val id = parent.removePrefix("pl:"); tracksOf("pl-$id").map { track(it, "pl-$id") } }
            parent.startsWith("ar:") -> {
                val d = Api.get<MArtistDetail>("/api/music/artists/${parent.removePrefix("ar:")}")
                d.albums.map(::album)
            }
            else -> emptyList()
        }
    }

    private inner class Callback : MediaLibrarySession.Callback {
        /** Sovtimerns knapp (visas i bilens mediaspelare och i aviseringen) kräver ett eget sessionskommando */
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
            val r = super.onConnect(session, controller)
            if (!r.isAccepted) return r
            return MediaSession.ConnectionResult.accept(r.availableSessionCommands.buildUpon().add(sleepCommand).build(), r.availablePlayerCommands)
        }

        override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo, customCommand: SessionCommand, args: Bundle): ListenableFuture<SessionResult> {
            if (customCommand.customAction == CMD_SLEEP) {
                cycleSleep()
                return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
            }
            return super.onCustomCommand(session, controller, customCommand, args)
        }

        override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> =
            Futures.immediateFuture(LibraryResult.ofItem(folder(ROOT, "BraXhn TV"), params))

        override fun onGetChildren(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, page: Int, pageSize: Int, params: LibraryParams?):
                ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = scope.future {
            if (Api.token.value == null) return@future LibraryResult.ofError(LibraryResult.RESULT_ERROR_SESSION_AUTHENTICATION_EXPIRED)
            try {
                val all = cachedChildren(parentId)
                // Räkna i Long – page * pageSize kan slå runt för stora värden (t.ex. pageSize = Int.MAX_VALUE)
                val size = all.size.toLong()
                val ps = pageSize.toLong().coerceAtLeast(0L)
                val from = (page.toLong().coerceAtLeast(0L) * ps).coerceIn(0L, size)
                val to = (from + ps).coerceIn(from, size)
                LibraryResult.ofItemList(ImmutableList.copyOf(all.subList(from.toInt(), to.toInt())), params)
            } catch (e: Exception) { LibraryResult.ofError(LibraryResult.RESULT_ERROR_IO) }
        }

        override fun onGetItem(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String): ListenableFuture<LibraryResult<MediaItem>> =
            scope.future { LibraryResult.ofItem(itemFor(mediaId), null) }

        override fun onSearch(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, params: LibraryParams?): ListenableFuture<LibraryResult<Void>> {
            scope.future {
                val n = runCatching { searchItems(query).size }.getOrDefault(0)
                session.notifySearchResultChanged(browser, query, n, params)
            }
            return Futures.immediateFuture(LibraryResult.ofVoid())
        }

        override fun onGetSearchResult(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, page: Int, pageSize: Int, params: LibraryParams?):
                ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = scope.future {
            LibraryResult.ofItemList(ImmutableList.copyOf(runCatching { searchItems(query) }.getOrDefault(emptyList())), params)
        }

        /** Valt spår → köa hela sammanhanget (albumet/listan) och starta på rätt låt. */
        override fun onSetMediaItems(mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long):
                ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
            // Spara positionen i boken/podden som spelas innan kön byts – currentBook ersätts nedan och
            // de senare paus-/bytehändelserna kan då inte längre spara den
            mediaSession.player.currentMediaItem?.mediaId?.let { saveSpoken(it, mediaSession.player.currentPosition / 1000.0) }
            return scope.future { setItems(mediaItems, startIndex, startPositionMs) }
        }

        private suspend fun setItems(mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): MediaSession.MediaItemsWithStartPosition {
            val one = mediaItems.singleOrNull()?.mediaId
            val parts = one?.split(":")
            if (parts != null && parts[0] == "b") runCatching { bookQueue(parts[1]) }.getOrNull()?.let { return it }
            if (parts != null && parts[0] == "pe") runCatching {
                val e = Api.get<PEp>("/api/podcasts/episodes/${parts[1]}")
                MediaSession.MediaItemsWithStartPosition(listOf(epMedia(e)), 0, if (e.played) 0 else (e.position * 1000).toLong())
            }.getOrNull()?.let { return it }
            if (parts == null || parts[0] != "bf") currentBook = null
            if (parts != null && parts.size >= 3 && parts[0] == "t") {
                val list = runCatching { tracksOf(parts[2]) }.getOrDefault(emptyList())
                val idx = list.indexOfFirst { it.id.toString() == parts[1] }
                if (idx >= 0) return MediaSession.MediaItemsWithStartPosition(list.map { track(it, parts[2]) }, idx, startPositionMs)
            }
            return MediaSession.MediaItemsWithStartPosition(resolve(mediaItems), startIndex, startPositionMs)
        }

        override fun onAddMediaItems(mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>): ListenableFuture<MutableList<MediaItem>> =
            Futures.immediateFuture(resolve(mediaItems).toMutableList())
    }

    /** Ett enskilt objekt: från cachen om det nyss visats, annars från servern; spelbara id:n blir aldrig mappar. */
    private suspend fun itemFor(mediaId: String): MediaItem {
        if (mediaId == ROOT) return folder(ROOT, "BraXhn TV")
        childCache.values.firstNotNullOfOrNull { c -> c.items.firstOrNull { it.mediaId == mediaId } }?.let { return it }
        val p = mediaId.split(":")
        val real = runCatching {
            when (p[0]) {
                "b" -> bookItem(Api.get<BBook>("/api/audiobooks/book/${p[1]}"))
                "pe" -> epItem(Api.get<PEp>("/api/podcasts/episodes/${p[1]}"))
                "al" -> album(Api.get<MAlbumDetail>("/api/music/albums/${p[1]}").let { d -> MAlbum(d.id, d.title, artist = d.artist, cover = d.cover) })
                else -> null
            }
        }.getOrNull()
        if (real != null) return real
        return when (p[0]) {
            "t" -> {
                val tid = p.getOrNull(1)?.toIntOrNull()
                val stub = playable(mediaId, "Låt", null, null, MediaMetadata.MEDIA_TYPE_MUSIC)
                if (tid != null) stub.buildUpon().setUri(trackUri(tid)).build() else stub
            }
            "b" -> playable(mediaId, "Ljudbok", null, null, MediaMetadata.MEDIA_TYPE_AUDIO_BOOK)
            "bf" -> playable(mediaId, "Ljudbok", null, null, MediaMetadata.MEDIA_TYPE_AUDIO_BOOK_CHAPTER)
            "pe" -> playable(mediaId, "Avsnitt", null, null, MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE)
            else -> folder(mediaId, mediaId)
        }
    }

    private fun resolve(items: List<MediaItem>): List<MediaItem> = items.map { mi ->
        val parts = mi.mediaId.split(":")
        if (parts.size >= 2 && parts[0] == "t" && mi.localConfiguration == null) mi.buildUpon().setUri(trackUri(parts[1].toInt())).build() else mi
    }

    private suspend fun searchItems(q: String): List<MediaItem> {
        val l = lib() ?: return emptyList()
        val r = Api.get<MSearch>("/api/music/$l/search", mapOf("q" to q))
        return r.albums.map(::album) + r.tracks.map { track(it, "al-${it.albumId}") }
    }

    companion object {
        const val ROOT = "root"
        private const val CMD_SLEEP = "net.braxhn.tv.SLEEP"
        private const val SLEEP_FADE = 10.0
        private const val CACHE_TTL = 60_000L
        private const val LIBS_TTL = 12 * 60 * 60 * 1000L
    }
}

@Serializable data class MSearch(val albums: List<MAlbum> = emptyList(), val tracks: List<MTrack> = emptyList())
