package net.braxhn.tv

import android.net.Uri
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.guava.future
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.Serializable

// ---- musikmodeller (matchar /api/music) ----
@Serializable data class MAlbum(val id: Int, val title: String, val year: Int? = null, val cover: Boolean = false, val artist: String? = null, val artistId: Int? = null, val tracks: Int? = null)
@Serializable data class MTrack(val id: Int, val title: String, val track: Int? = null, val duration: Double? = null, val albumId: Int? = null,
                                val album: String? = null, val cover: Boolean = false, val artist: String? = null)
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
@Serializable data class MHome(val recentAlbums: List<MAlbum> = emptyList(), val recentlyPlayed: List<MAlbum> = emptyList(), val favorites: List<MTrack> = emptyList())

/**
 * Musik i bilen. Android Automotive visar den här tjänsten i bilens egen mediaspelare – till skillnad
 * från video får musik användas under körning. Fungerar även med Android Auto/Bluetooth-kontroller.
 *
 * Bläddringsträd: root → Spelat nyligen / Nytt / Album / Artister / Spellistor / Favoriter
 * Spår får id "t:<spår>:<sammanhang>" så att hela albumet/listan köas när man väljer en låt.
 */
@OptIn(UnstableApi::class)
class MusicService : MediaLibraryService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var session: MediaLibrarySession? = null
    private var libId: Int? = null
    private var bookLibId: Int? = null
    private var libsLoaded = false
    /** Ljudbok som spelas: filernas startpositioner (för att räkna global position och spara den) */
    private var currentBook: BBook? = null

    override fun onCreate() {
        super.onCreate()
        val http = DefaultHttpDataSource.Factory().setUserAgent("BraXhnTV-Android").setAllowCrossProtocolRedirects(true)
        // Kontots token skickas som header (inte i URL:en)
        Api.token.value?.let { http.setDefaultRequestProperties(mapOf("Authorization" to "Bearer $it")) }
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(http))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .build()
        session = MediaLibrarySession.Builder(this, player, Callback()).build()
        // Spara position för ljudböcker och poddar var 15:e sekund och vid paus
        player.addListener(object : androidx.media3.common.Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) { if (!isPlaying) saveSpoken(player) }
        })
        scope.launch(Dispatchers.Main) { while (true) { delay(15000); if (player.isPlaying) saveSpoken(player) } }
    }

    private fun saveSpoken(player: ExoPlayer) {
        val id = player.currentMediaItem?.mediaId ?: return
        val pos = player.currentPosition / 1000.0
        val p = id.split(":")
        when (p[0]) {
            "bf" -> { val b = currentBook ?: return; val f = b.files.getOrNull(p[2].toInt()) ?: return
                Api.appScope.launch { runCatching { Api.post("/api/audiobooks/book/${b.id}/progress", buildJsonObject { put("position", f.offset + pos) }) } } }
            "pe" -> Api.appScope.launch { runCatching { Api.post("/api/podcasts/episodes/${p[1]}/progress", buildJsonObject { put("position", pos) }) } }
        }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

    override fun onDestroy() {
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
    private fun track(t: MTrack, ctx: String) = MediaItem.Builder()
        .setMediaId("t:${t.id}:$ctx")
        .setUri(trackUri(t.id))
        .setMediaMetadata(MediaMetadata.Builder().setTitle(t.title).setArtist(t.artist).setAlbumTitle(t.album)
            .setArtworkUri(coverUri(t.albumId, t.cover)).setTrackNumber(t.track).setIsBrowsable(false).setIsPlayable(true)
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC).build())
        .build()
    private fun album(a: MAlbum) = folder("al:${a.id}", a.title, listOfNotNull(a.artist, a.year?.toString()).joinToString(" · "), coverUri(a.id, a.cover), MediaMetadata.MEDIA_TYPE_ALBUM)

    private suspend fun loadLibs() {
        if (libsLoaded) return
        Api.refreshImageToken()
        val l: List<Library> = Api.get("/api/libraries")
        libId = l.firstOrNull { it.type == "music" }?.id
        bookLibId = l.firstOrNull { it.type == "audiobook" }?.id
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
            else -> emptyList()
        }
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
        override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> =
            Futures.immediateFuture(LibraryResult.ofItem(folder(ROOT, "BraXhn TV"), params))

        override fun onGetChildren(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, page: Int, pageSize: Int, params: LibraryParams?):
                ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = scope.future {
            if (Api.token.value == null) return@future LibraryResult.ofError(LibraryResult.RESULT_ERROR_SESSION_AUTHENTICATION_EXPIRED)
            try {
                val all = children(parentId)
                val from = (page * pageSize).coerceAtMost(all.size)
                LibraryResult.ofItemList(ImmutableList.copyOf(all.subList(from, (from + pageSize).coerceAtMost(all.size))), params)
            } catch (e: Exception) { LibraryResult.ofError(LibraryResult.RESULT_ERROR_IO) }
        }

        override fun onGetItem(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String): ListenableFuture<LibraryResult<MediaItem>> =
            Futures.immediateFuture(LibraryResult.ofItem(folder(mediaId, mediaId), null))

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
                ListenableFuture<MediaSession.MediaItemsWithStartPosition> = scope.future {
            val one = mediaItems.singleOrNull()?.mediaId
            val parts = one?.split(":")
            if (parts != null && parts[0] == "b") runCatching { bookQueue(parts[1]) }.getOrNull()?.let { return@future it }
            if (parts != null && parts[0] == "pe") runCatching {
                val e = Api.get<PEp>("/api/podcasts/episodes/${parts[1]}")
                MediaSession.MediaItemsWithStartPosition(listOf(epMedia(e)), 0, if (e.played) 0 else (e.position * 1000).toLong())
            }.getOrNull()?.let { return@future it }
            if (parts == null || parts[0] != "bf") currentBook = null
            if (parts != null && parts.size >= 3 && parts[0] == "t") {
                val list = runCatching { tracksOf(parts[2]) }.getOrDefault(emptyList())
                val idx = list.indexOfFirst { it.id.toString() == parts[1] }
                if (idx >= 0) return@future MediaSession.MediaItemsWithStartPosition(list.map { track(it, parts[2]) }, idx, startPositionMs)
            }
            MediaSession.MediaItemsWithStartPosition(resolve(mediaItems), startIndex, startPositionMs)
        }

        override fun onAddMediaItems(mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>): ListenableFuture<MutableList<MediaItem>> =
            Futures.immediateFuture(resolve(mediaItems).toMutableList())
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

    companion object { const val ROOT = "root" }
}

@Serializable data class MSearch(val albums: List<MAlbum> = emptyList(), val tracks: List<MTrack> = emptyList())
