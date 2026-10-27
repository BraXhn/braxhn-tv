package net.braxhn.tv

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.ComponentName
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Rational
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.tvprovider.media.tv.TvContractCompat
import androidx.tvprovider.media.tv.WatchNextProgram
import coil.compose.AsyncImage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.guava.await
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

// ---------- modeller (matchar serverns JSON; alla fält i /api/home här är nya och valfria) ----------

/** "Den här dagen": varför titeln visas (premiär eller sedd för x år sedan) */
@Serializable data class DayNote(val kind: String? = null, val years: Int? = null, val note: String? = null)
/** Bio-läge: trailer eller förfilm som spelas före filmen (Playback.preroll) */
@Serializable data class PrerollEntry(val kind: String = "trailer", val title: String? = null, val url: String, val duration: Double? = null, val itemId: Int? = null)
/** GET /api/me/cinema – användarens bio-läge (ställs in i webben) */
@Serializable data class CinemaPrefs(val trailers: Int = 0, val preroll: Boolean = false, val prerollAvailable: Boolean = false) {
    val on: Boolean get() = trailers > 0 || (preroll && prerollAvailable)
}
/** GET /api/profiles */
@Serializable data class Profile(val id: Int, val name: String, val owner: Boolean = false, val kid: Boolean = false, val maxAge: Int? = null,
                                 val hasPin: Boolean = false, val color: String? = null)
@Serializable data class ProfileList(val current: Int, val profiles: List<Profile> = emptyList())

@Serializable data class ShelfInfo(val id: String, val name: String)
/** Användarens ordning och dolda hyllor (homeLayout i /api/home) */
@Serializable data class HomeLayout(val order: List<String> = emptyList(), val hidden: List<String> = emptyList(), val shelves: List<ShelfInfo> = emptyList())
@Serializable data class CustomShelf(val id: Int, val name: String, val items: List<MediaItem> = emptyList())
@Serializable data class BecauseSeed(val id: Int, val title: String, val kind: String? = null)
@Serializable data class BecauseShelf(val seed: BecauseSeed, val items: List<MediaItem> = emptyList())
@Serializable data class GenreShelf(val genre: String, val items: List<MediaItem> = emptyList())
/** Kommer snart: ett avsnitt de närmaste dagarna (date = ÅÅÅÅ-MM-DD) */
@Serializable data class UpcomingEp(val date: String, val time: String? = null, val showId: Int? = null, val show: String? = null,
                                    val season: Int? = null, val episode: Int? = null, val name: String? = null, val poster: Boolean = false, val itemId: Int? = null)
/** Fortsätt lyssna: påbörjad ljudbok (type "book") eller poddavsnitt (type "podcast") */
@Serializable data class ListenEntry(val type: String, val id: Int, val title: String? = null, val author: String? = null, val podcast: Int? = null,
                                     val podcastTitle: String? = null, val cover: Boolean = false, val image: Boolean = false,
                                     val duration: Double? = null, val position: Double = 0.0)
/** Startsidans nyare hyllor – avkodas ur samma svar som HomeResponse (äldre servrar saknar fälten) */
@Serializable data class HomeExtras(
    val watchlist: List<MediaItem> = emptyList(), val recommended: List<MediaItem> = emptyList(),
    val customCollections: List<CustomShelf> = emptyList(), val upcoming: List<UpcomingEp> = emptyList(),
    val because: List<BecauseShelf> = emptyList(), val topRated: List<MediaItem> = emptyList(), val hiddenGems: List<MediaItem> = emptyList(),
    val shortTonight: List<MediaItem> = emptyList(), val onThisDay: List<MediaItem> = emptyList(), val genreOfDay: GenreShelf? = null,
    val listening: List<ListenEntry> = emptyList(), val homeLayout: HomeLayout? = null
)

// ---------- startsidans hyllor i användarens ordning ----------

/** Standardordningen (som servern) – används när servern inte skickar homeLayout */
private val DEFAULT_ORDER = listOf("foryou", "continue", "listening", "watchlist", "upcoming", "because", "recommended", "custom",
    "recent", "short", "toprated", "onthisday", "genre", "gems")
private val DEFAULT_NAMES = mapOf("foryou" to "Nytt för dig", "continue" to "Fortsätt titta", "listening" to "Fortsätt lyssna",
    "watchlist" to "Min lista", "upcoming" to "Kommer snart", "recommended" to "Rekommenderat för dig", "short" to "Kort film ikväll",
    "toprated" to "Topprankat i biblioteket", "onthisday" to "Den här dagen", "genre" to "Dagens genre", "gems" to "Glömda guldkorn")

/** Lägger startsidans hyllor i LazyColumn i den ordning användaren valt (dolda hyllor hoppas över). */
fun LazyListScope.homeShelves(h: HomeResponse, x: HomeExtras?, push: (Screen) -> Unit, onListen: (ListenEntry) -> Unit) {
    val layout = x?.homeLayout
    val order = layout?.order?.takeIf { it.isNotEmpty() } ?: DEFAULT_ORDER
    val hidden = layout?.hidden?.toSet() ?: emptySet()
    val names = DEFAULT_NAMES + (layout?.shelves?.associate { it.id to it.name } ?: emptyMap())
    fun name(id: String) = names[id] ?: id
    for (id in order) {
        if (id in hidden) continue
        when (id) {
            "foryou" -> if (h.forYou.isNotEmpty()) item(key = "s:foryou") { Shelf(name(id), h.forYou, true, push) }
            "continue" -> if (h.continueWatching.isNotEmpty()) item(key = "s:continue") { Shelf(name(id), h.continueWatching, true, push) }
            "recent" -> items(h.rows.filter { it.items.isNotEmpty() }, key = { "s:recent:${it.library.id}:${it.title}" }) { r -> Shelf(r.title, r.items, false, push) }
        }
        if (x == null) continue
        when (id) {
            "listening" -> if (x.listening.isNotEmpty()) item(key = "s:listening") { ListenShelf(name(id), x.listening, onListen) }
            "watchlist" -> if (x.watchlist.isNotEmpty()) item(key = "s:watchlist") { Shelf(name(id), x.watchlist, false, push) }
            "upcoming" -> if (x.upcoming.isNotEmpty()) item(key = "s:upcoming") { UpcomingShelf(name(id), x.upcoming, push) }
            "because" -> x.because.filter { it.items.isNotEmpty() }.forEachIndexed { i, b ->
                item(key = "s:because:$i:${b.seed.id}") { Shelf("Eftersom du såg ${b.seed.title}", b.items, false, push) }
            }
            "recommended" -> if (x.recommended.isNotEmpty()) item(key = "s:recommended") { Shelf(name(id), x.recommended, false, push) }
            "custom" -> x.customCollections.filter { it.items.isNotEmpty() }.forEach { c ->
                item(key = "s:custom:${c.id}") { Shelf(c.name, c.items, false, push) }
            }
            "short" -> if (x.shortTonight.isNotEmpty()) item(key = "s:short") { Shelf(name(id), x.shortTonight, false, push) }
            "toprated" -> if (x.topRated.isNotEmpty()) item(key = "s:toprated") { Shelf(name(id), x.topRated, false, push) }
            "gems" -> if (x.hiddenGems.isNotEmpty()) item(key = "s:gems") { Shelf(name(id), x.hiddenGems, false, push) }
            "onthisday" -> if (x.onThisDay.isNotEmpty()) item(key = "s:onthisday") { Shelf(name(id), x.onThisDay, false, push, note = { it.onThisDay?.note }) }
            "genre" -> x.genreOfDay?.takeIf { it.items.isNotEmpty() }?.let { g -> item(key = "s:genre") { Shelf("${name(id)}: ${g.genre}", g.items, false, push) } }
        }
    }
}

@Composable
private fun ShelfTitle(title: String) =
    Text(title, fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))

/** Fortsätt lyssna: ljudböcker och poddar spelas i appens ljudspelare (samma som i bilens mediaspelare) */
@Composable
private fun ListenShelf(title: String, list: List<ListenEntry>, onListen: (ListenEntry) -> Unit) {
    val tok by Api.imageToken.collectAsState()
    Column(Modifier.padding(vertical = 10.dp)) {
        ShelfTitle(title)
        LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            items(list, key = { "${it.type}:${it.id}" }) { e ->
                val t = tok
                val img = when {
                    t == null -> null
                    e.type == "book" && e.cover -> Api.url("/api/audiobooks/cover/${e.id}", mapOf("t" to t))
                    e.type == "podcast" && e.image && e.podcast != null -> Api.url("/api/podcasts/${e.podcast}/image", mapOf("t" to t))
                    else -> null
                }
                val label = e.title ?: ""
                Column(Modifier.width(160.dp).clip(RoundedCornerShape(10.dp)).focusRing().clickable { onListen(e) }) {
                    Box(Modifier.size(160.dp).clip(RoundedCornerShape(10.dp)).background(
                        Brush.linearGradient(listOf(Color.hsv(hue(label), 0.5f, 0.4f), Color.hsv(hue(label), 0.6f, 0.18f))))) {
                        Text(label, Modifier.align(Alignment.Center).padding(8.dp), fontWeight = FontWeight.Bold, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        if (img != null) AsyncImage(model = img, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                        val d = e.duration
                        if (d != null && d > 0) {
                            val f = (e.position / d).toFloat().coerceIn(0f, 1f)
                            Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(5.dp).background(Color.Black.copy(alpha = 0.5f)))
                            Box(Modifier.align(Alignment.BottomStart).fillMaxWidth(f).height(5.dp).background(Accent))
                        }
                    }
                    Text(label, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
                    Text((if (e.type == "book") e.author else e.podcastTitle) ?: (if (e.type == "book") "Ljudbok" else "Podd"),
                        color = Color.Gray, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

private val dayFmt = DateTimeFormatter.ofPattern("EEE d MMM", Locale("sv", "SE"))
private fun dayLabel(ymd: String): String = runCatching {
    val d = LocalDate.parse(ymd)
    val today = LocalDate.now()
    when (d) { today -> "Idag"; today.plusDays(1) -> "Imorgon"; else -> d.format(dayFmt) }
}.getOrDefault(ymd)

/** Kommer snart: kommande avsnitt av serier i biblioteket (seriens affisch) */
@Composable
private fun UpcomingShelf(title: String, list: List<UpcomingEp>, push: (Screen) -> Unit) {
    val tok by Api.imageToken.collectAsState()
    Column(Modifier.padding(vertical = 10.dp)) {
        ShelfTitle(title)
        LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            items(list, key = { "${it.showId}:${it.season}:${it.episode}:${it.date}" }) { e ->
                val show = e.show ?: "Serie"
                val sid = e.showId
                val t = tok
                val click = if (sid != null) Modifier.focusRing().clickable { push(Screen.Detail(sid)) } else Modifier
                Column(Modifier.width(160.dp).clip(RoundedCornerShape(10.dp)).then(click)) {
                    Box(Modifier.size(160.dp, 240.dp).clip(RoundedCornerShape(10.dp)).background(
                        Brush.linearGradient(listOf(Color.hsv(hue(show), 0.5f, 0.4f), Color.hsv(hue(show), 0.6f, 0.18f))))) {
                        Text(show, Modifier.align(Alignment.Center).padding(8.dp), fontWeight = FontWeight.Bold)
                        if (sid != null && e.poster && t != null) AsyncImage(model = Api.url("/api/image/$sid/poster", mapOf("t" to t)), contentDescription = null,
                            contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                        Text(dayLabel(e.date), Modifier.align(Alignment.TopStart).padding(6.dp).background(Color.Black.copy(alpha = 0.7f), RoundedCornerShape(6.dp))
                            .padding(horizontal = 6.dp, vertical = 2.dp), color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    }
                    Text(show, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
                    val sxe = if (e.season != null && e.episode != null) "S%02dE%02d".format(e.season, e.episode) else null
                    Text(listOfNotNull(sxe, e.name).joinToString(" · "), color = Color.Gray, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

// ---------- ljudböcker och poddar från startsidan ----------

/** Styr appens ljudspelare (MusicService) – samma kö och sparade position som i bilens mediaspelare. */
object AudioRemote {
    private var controller: MediaController? = null

    /** mediaId som i MusicService: "b:<bok>" eller "pe:<avsnitt>". Anropas från huvudtråden. */
    suspend fun play(ctx: Context, mediaId: String) {
        val app = ctx.applicationContext
        val c = controller?.takeIf { it.isConnected }
            ?: MediaController.Builder(app, SessionToken(app, ComponentName(app, MusicService::class.java))).buildAsync().await().also { controller = it }
        c.setMediaItem(androidx.media3.common.MediaItem.Builder().setMediaId(mediaId).build())
        c.prepare()
        c.play()
    }

    /** Spelar en post från Fortsätt lyssna och visar en kort bekräftelse (eller felet). */
    suspend fun play(ctx: Context, e: ListenEntry) {
        val msg = runCatching { play(ctx, if (e.type == "book") "b:${e.id}" else "pe:${e.id}") }
            .fold({ "Spelas: ${e.title ?: ""}" }, { "Kunde inte spela: ${it.message ?: it}" })
        Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show()
    }
}

// ---------- profiler ----------

private fun profileColor(c: String?): Color =
    c?.let { runCatching { Color(android.graphics.Color.parseColor(it)) }.getOrNull() } ?: Accent

/** Byt profil i hushållet (PIN eller huvudkontots lösenord när servern kräver det). */
@Composable
fun ProfilesScreen() {
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<ProfileList?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var asking by remember { mutableStateOf<Profile?>(null) }
    var askPassword by remember { mutableStateOf(false) }
    var secret by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { runCatching { list = Api.get("/api/profiles") }.onFailure { error = it.message ?: it.toString() } }

    fun switchTo(p: Profile, pin: String?, password: String?) {
        busy = true; error = null
        scope.launch {
            try {
                Api.switchProfile(p.id, pin, password) // ny token → appen startar om på startsidan
                asking = null
            } catch (e: ApiException) {
                if (e.needPassword && password == null) { asking = p; askPassword = true; secret = "" }
                else if (p.hasPin && pin == null) { asking = p; askPassword = false; secret = "" }
                else error = e.message
            } catch (e: Exception) { error = e.message ?: e.toString() }
            busy = false
        }
    }

    val l = list ?: return if (error != null) ErrorText(error!!) else Loading()
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        Text("Vem tittar?", fontSize = 28.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(vertical = 12.dp))
        error?.let { Text(it, color = Color(0xFFFF5D6C), modifier = Modifier.padding(bottom = 8.dp)) }
        LazyVerticalGrid(GridCells.Adaptive(150.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp),
            contentPadding = PaddingValues(bottom = 24.dp)) {
            items(l.profiles, key = { it.id }) { p ->
                val current = p.id == l.current
                Column(Modifier.clip(RoundedCornerShape(14.dp)).focusRing(RoundedCornerShape(14.dp))
                    .background(if (current) Surface2 else Color.Transparent)
                    .clickable(enabled = !busy && !current) { if (p.hasPin) { asking = p; askPassword = false; secret = "" } else switchTo(p, null, null) }
                    .padding(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(Modifier.size(96.dp).clip(CircleShape).background(profileColor(p.color)), contentAlignment = Alignment.Center) {
                        Text(p.name.take(1).uppercase(), fontSize = 40.sp, fontWeight = FontWeight.Bold, color = Color.Black)
                    }
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (p.hasPin) Icon(Icons.Filled.Lock, "PIN", Modifier.size(16.dp), tint = Color.Gray)
                        Text(p.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Text(when { current -> "Används nu"; p.kid -> p.maxAge?.let { "Barn · $it år" } ?: "Barn"; p.owner -> "Huvudkonto"; else -> "" },
                        color = Color.Gray, fontSize = 13.sp)
                }
            }
        }
    }
    asking?.let { p ->
        AlertDialog(onDismissRequest = { if (!busy) asking = null },
            title = { Text(if (askPassword) "Huvudkontots lösenord" else "PIN för ${p.name}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (askPassword) Text("Profilen har högre åldersgräns än den du använder nu.", color = Color.Gray, fontSize = 14.sp)
                    OutlinedTextField(secret, { secret = it }, singleLine = true, label = { Text(if (askPassword) "Lösenord" else "PIN") },
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = if (askPassword) KeyboardType.Password else KeyboardType.NumberPassword))
                    error?.let { Text(it, color = Color(0xFFFF5D6C), fontSize = 14.sp) }
                }
            },
            confirmButton = {
                TextButton(enabled = !busy && secret.isNotBlank(), onClick = {
                    if (askPassword) switchTo(p, null, secret) else switchTo(p, secret, null)
                }) { Text("Byt profil") }
            },
            dismissButton = { TextButton(enabled = !busy, onClick = { asking = null; error = null }) { Text("Avbryt") } })
    }
}

// ---------- Google TV: Fortsätt titta (Watch Next) ----------

/**
 * Lägger "Fortsätt titta" från startsidan i Google TV:s/Android TV:s rad "Fortsätt titta" (Watch Next).
 * Bara på TV; tyst om systemet saknar raden eller nekar (Google TV visar den bara för godkända appar).
 */
object WatchNext {
    private const val PREFIX = "braxhn:"
    // TvContractCompat.PreviewPrograms.TYPE_MOVIE / TYPE_TV_EPISODE (samma värden som i TvContract)
    private const val TYPE_MOVIE = 0
    private const val TYPE_TV_EPISODE = 3
    const val EXTRA_ITEM = "net.braxhn.tv.item"

    fun sync(ctx: Context, items: List<MediaItem>) {
        if (!isTv(ctx)) return
        runCatching { doSync(ctx.applicationContext, items.take(12)) }
    }

    private fun doSync(ctx: Context, items: List<MediaItem>) {
        val cr = ctx.contentResolver
        val existing = HashMap<String, Long>()
        cr.query(TvContractCompat.WatchNextPrograms.CONTENT_URI, WatchNextProgram.PROJECTION, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val p = WatchNextProgram.fromCursor(c)
                val k = p.internalProviderId
                if (k != null && k.startsWith(PREFIX)) existing[k] = p.id
            }
        }
        val keep = HashSet<String>()
        val now = System.currentTimeMillis()
        items.forEachIndexed { n, m ->
            val key = PREFIX + m.id
            keep.add(key)
            val values = program(ctx, m, key, now - n * 60_000L).toContentValues()
            val id = existing[key]
            if (id != null) cr.update(TvContractCompat.buildWatchNextProgramUri(id), values, null, null)
            else cr.insert(TvContractCompat.WatchNextPrograms.CONTENT_URI, values)
        }
        for ((k, id) in existing) if (k !in keep) cr.delete(TvContractCompat.buildWatchNextProgramUri(id), null, null)
    }

    private fun program(ctx: Context, it: MediaItem, key: String, engaged: Long): WatchNextProgram {
        val open = Intent(ctx, MainActivity::class.java).setAction(Intent.ACTION_VIEW).putExtra(EXTRA_ITEM, it.id)
        val b = WatchNextProgram.Builder()
        b.setWatchNextType(if ((it.position ?: 0.0) > 0) TvContractCompat.WatchNextPrograms.WATCH_NEXT_TYPE_CONTINUE
                           else TvContractCompat.WatchNextPrograms.WATCH_NEXT_TYPE_NEXT)
        b.setLastEngagementTimeUtcMillis(engaged)
        b.setType(if (it.isEpisode) TYPE_TV_EPISODE else TYPE_MOVIE)
        b.setTitle(if (it.isEpisode) it.showTitle ?: it.title else it.title)
        if (it.isEpisode) {
            b.setEpisodeTitle(it.title)
            it.season?.let { s -> b.setSeasonNumber(s) }
            it.episode?.let { e -> b.setEpisodeNumber(e) }
        }
        it.overview?.let { o -> b.setDescription(o) }
        Api.imageUrl(it, landscape = true)?.let { u -> b.setPosterArtUri(Uri.parse(u)) }
        val dur = it.duration
        if (dur != null && dur > 0) b.setDurationMillis((dur * 1000).toInt())
        it.position?.let { p -> if (p > 0) b.setLastPlaybackPositionMillis((p * 1000).toInt()) }
        b.setInternalProviderId(key)
        b.setIntentUri(Uri.parse(open.toUri(Intent.URI_INTENT_SCHEME)))
        return b.build()
    }
}

/** Titel att öppna när appen startas från Google TV:s Fortsätt titta (läses av AppRoot) */
object DeepLink {
    val item = MutableStateFlow<Int?>(null)
    fun from(intent: Intent?) {
        val id = intent?.getIntExtra(WatchNext.EXTRA_ITEM, -1) ?: -1
        if (id > 0) item.value = id
    }
}

// ---------- bild-i-bild (telefon och surfplatta) ----------

object Pip {
    /** Videons bildformat medan videospelaren är öppen – null = ingen video, gå inte till bild-i-bild */
    @Volatile var aspect: Rational? = null
    /** Visas appen just nu som bild-i-bild? (spelaren döljer då sina knappar) */
    val active = MutableStateFlow(false)

    /** Bara telefon/surfplatta: bilar och TV-apparen saknar (eller använder inte) bild-i-bild */
    fun supported(ctx: Context): Boolean {
        val pm = ctx.packageManager
        return pm.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE) && !isTv(ctx) && !pm.hasSystemFeature("android.hardware.type.automotive")
    }

    /** Formatet måste ligga mellan 1:2,39 och 2,39:1, annars kastar systemet ett undantag */
    fun ratio(w: Int, h: Int): Rational {
        if (w <= 0 || h <= 0) return Rational(16, 9)
        val r = w.toDouble() / h
        return when { r > 2.39 -> Rational(239, 100); r < 1 / 2.39 -> Rational(100, 239); else -> Rational(w, h) }
    }

    fun enter(activity: Activity?): Boolean {
        val a = activity ?: return false
        val r = aspect ?: return false
        if (!supported(a)) return false
        return runCatching { a.enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(r).build()) }.getOrDefault(false)
    }
}

fun Context.findActivity(): Activity? {
    var c: Context? = this
    while (c is ContextWrapper) { if (c is Activity) return c; c = c.baseContext }
    return null
}
