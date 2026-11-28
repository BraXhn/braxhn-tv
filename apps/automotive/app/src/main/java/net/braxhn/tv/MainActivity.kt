package net.braxhn.tv

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRequester
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
import coil.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.put
import java.io.IOException

val Accent = Color(0xFFFF6B4A)
val Bg = Color(0xFF0D0F14)
val Surface2 = Color(0xFF1E2230)

/** Enkel navigering utan extra bibliotek. */
sealed class Screen {
    data object Home : Screen()
    data object Search : Screen()
    data object Settings : Screen()
    data class Lib(val library: Library) : Screen()
    data class Detail(val id: Int) : Screen()
    /** nonce: ny uppspelning av samma titel (t.ex. nattläge på/av); skipPreroll: inget bio-läge (omstart mitt i) */
    data class Play(val id: Int, val start: Double, val audio: Int?, val sub: SubtitleTrack?, val nonce: Int = 0, val skipPreroll: Boolean = false) : Screen()
    data object Live : Screen()
    data object Recordings : Screen()
    /** breaks/autoSkip: reklamavbrott i en inspelning (Hoppa över reklam) */
    data class LivePlay(val id: Int, val title: String, val breaks: List<Marker> = emptyList(), val autoSkip: Boolean = false) : Screen()
    data class VodDetail(val id: Int) : Screen()
    /** kind: "extra" (extramaterial), "vod"/"vodep" (IPTV-film/avsnitt), "catchup" (program ur kanalens arkiv) */
    data class Stream(val kind: String, val id: Int, val title: String, val start: Double = 0.0) : Screen()
    data object Profiles : Screen()
    /** Feedback och felrapporter (Feedback.kt): kind/area = förval, t.ex. från spelaren vid ett fel */
    data class SendFeedback(val kind: String? = null, val area: String? = null) : Screen()
    data object Tickets : Screen()
}

class MainActivity : ComponentActivity() {
    override fun onResume() {
        super.onResume()
        // Offline-synk, provet av hemadressen och positioner som spelats utan nät när appen öppnas eller kommer tillbaka
        Downloads.autoSync(); Bandwidth.visible = true; Home.check(); OfflineSync.flush()
    }

    override fun onPause() {
        super.onPause()
        Bandwidth.visible = false // musiken i bilen eller i bakgrunden behöver ingen mätning
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Startad från Google TV:s Fortsätt titta: öppna titeln
        if (savedInstanceState == null) DeepLink.from(intent)
        addOnPictureInPictureModeChangedListener { info -> Pip.active.value = info.isInPictureInPictureMode }
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Accent, background = Bg, surface = Bg, onPrimary = Color.Black)) {
                Surface(Modifier.fillMaxSize(), color = Bg) { AppRoot() }
            }
        }
    }

    /** Fjärrkontrollens kanal- och sifferknappar går till live-spelaren (KeyHook) före PlayerView och Compose */
    override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
        val h = KeyHook.handler
        if (h != null && h(event)) return true
        return super.dispatchKeyEvent(event)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        DeepLink.from(intent)
    }

    /** Hemknappen under en video (telefon): fortsätt som bild-i-bild */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        Pip.enter(this)
    }
}

@Composable
fun AppRoot() {
    val token by Api.token.collectAsState()
    if (token == null) { LoginScreen(); return }
    // Ny token (inloggning eller profilbyte): börja om på startsidan
    val stack: SnapshotStateList<Screen> = remember(token) { mutableStateListOf(Screen.Home) }
    val current = stack.last()
    val push: (Screen) -> Unit = { stack.add(it) }
    val pop: () -> Unit = { if (stack.size > 1) stack.removeAt(stack.lastIndex) }
    BackHandler(enabled = stack.size > 1) { pop() }
    val link by DeepLink.item.collectAsState()
    LaunchedEffect(link) { link?.let { id -> DeepLink.item.value = null; stack.add(Screen.Detail(id)) } }
    // Förvalet i Feedback följer skärmen man var på
    LaunchedEffect(current) { Feedback.noteScreen(current::class.simpleName.orEmpty()) }
    val car = isCar(LocalContext.current)

    if (current is Screen.Play) {
        // Rapportera felet: spelaren byts mot Feedback (inte i bilen – där finns bara Mina ärenden)
        PlayerScreen(current, onClose = pop, onPlay = { stack[stack.lastIndex] = it },
            onReport = if (car) null else ({ stack[stack.lastIndex] = Screen.SendFeedback("bug", "uppspelning") }))
        return
    }
    if (current is Screen.LivePlay) { LivePlayerScreen(current, onClose = pop, onPlay = push); return }
    if (current is Screen.Stream) { StreamPlayerScreen(current, onClose = pop); return }
    var hasLive by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { hasLive = runCatching { Api.get<LiveChannels>("/api/live/channels").channels.isNotEmpty() }.getOrDefault(false) }
    Row(Modifier.fillMaxSize()) {
        // Sidomeny – större träffytor passar bilskärmar
        NavigationRail(containerColor = Color(0xFF151821)) {
            Spacer(Modifier.height(12.dp))
            Icon(Icons.Filled.PlayCircle, null, tint = Accent, modifier = Modifier.size(40.dp))
            Spacer(Modifier.height(20.dp))
            NavigationRailItem(selected = stack.first() == Screen.Home && current !is Screen.Search && current !is Screen.Settings && current !is Screen.SendFeedback && current != Screen.Tickets,
                onClick = { stack.clear(); stack.add(Screen.Home) }, icon = { Icon(Icons.Filled.Home, null) }, label = { Text(tr(R.string.nav_home)) })
            NavigationRailItem(selected = current == Screen.Search, onClick = { stack.clear(); stack.add(Screen.Home); stack.add(Screen.Search) },
                icon = { Icon(Icons.Filled.Search, null) }, label = { Text(tr(R.string.nav_search)) })
            if (hasLive) NavigationRailItem(selected = current == Screen.Live || current == Screen.Recordings, onClick = { stack.clear(); stack.add(Screen.Home); stack.add(Screen.Live) },
                icon = { Icon(Icons.Filled.LiveTv, null) }, label = { Text(tr(R.string.nav_live)) })
            NavigationRailItem(selected = current == Screen.Settings || current == Screen.Profiles || current is Screen.SendFeedback || current == Screen.Tickets, onClick = { stack.clear(); stack.add(Screen.Home); stack.add(Screen.Settings) },
                icon = { Icon(Icons.Filled.Settings, null) }, label = { Text(tr(R.string.nav_settings)) })
        }
        Column(Modifier.fillMaxSize()) {
            if (stack.size > 1) {
                IconButton(onClick = pop, modifier = Modifier.padding(8.dp).size(56.dp)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, tr(R.string.back), Modifier.size(32.dp)) }
            }
            when (current) {
                is Screen.Home -> HomeScreen(push)
                is Screen.Search -> SearchScreen(push)
                is Screen.Settings -> SettingsScreen(push)
                is Screen.Lib -> LibraryScreen(current.library, push)
                is Screen.Detail -> DetailScreen(current.id, push)
                is Screen.Live -> LiveScreen(onPlay = push, push = push)
                is Screen.Recordings -> RecordingsScreen(onPlay = push)
                is Screen.Profiles -> ProfilesScreen()
                is Screen.VodDetail -> VodDetailScreen(current.id, push)
                is Screen.SendFeedback -> FeedbackScreen(current, onTickets = { stack[stack.lastIndex] = Screen.Tickets }, onClose = pop)
                is Screen.Tickets -> TicketsScreen(onNew = { stack[stack.lastIndex] = Screen.SendFeedback() })
                is Screen.Play, is Screen.LivePlay, is Screen.Stream -> {}
            }
        }
    }
}

// ---------------- inloggning ----------------

@Composable
fun LoginScreen() {
    var server by remember { mutableStateOf(Api.server.value) }
    var name by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var needCode by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var withCode by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    if (withCode) { QuickConnectScreen(server, onCancel = { withCode = false }); return }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 520.dp).padding(32.dp), verticalArrangement = Arrangement.spacedBy(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Filled.PlayCircle, null, tint = Accent, modifier = Modifier.size(72.dp))
            Text(tr(R.string.app_name), fontSize = 32.sp, fontWeight = FontWeight.Bold)
            Text(tr(R.string.login_server_hint), color = Color.Gray, fontSize = 14.sp)
            OutlinedTextField(server, { server = it }, label = { Text(tr(R.string.login_server)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
            OutlinedTextField(name, { name = it }, label = { Text(tr(R.string.login_username)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(pass, { pass = it }, label = { Text(tr(R.string.password)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
            if (needCode) {
                OutlinedTextField(code, { code = it }, label = { Text(tr(R.string.login_code)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
            }
            error?.let { Text(it, color = Color(0xFFFF5D6C)) }
            Button(onClick = {
                busy = true; error = null
                scope.launch {
                    try { Api.login(server, name, pass, if (needCode) code else null) }
                    catch (e: ApiException) { if (e.need2fa) { if (needCode) error = e.message; needCode = true } else error = e.message }
                    catch (e: Exception) { error = e.message ?: e.toString() }
                    busy = false
                }
            }, enabled = !busy && server.isNotBlank() && name.isNotBlank(), modifier = Modifier.fillMaxWidth().height(56.dp)) {
                if (busy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp) else Text(tr(R.string.login_button), fontSize = 18.sp)
            }
            // På TV och i bilen: godkänn en kod från telefonen i stället för att skriva lösenord
            OutlinedButton(onClick = { error = null; withCode = true }, enabled = !busy && server.isNotBlank(),
                modifier = Modifier.fillMaxWidth().height(56.dp)) { Text(tr(R.string.login_with_code), fontSize = 18.sp) }
        }
    }
}

// ---------------- kort ----------------

@Composable
fun PosterCard(item: MediaItem, landscape: Boolean = false, width: Int = if (landscape) 280 else 160, note: String? = null, onClick: (() -> Unit)?) {
    val h = if (landscape) width * 9 / 16 else width * 3 / 2
    // onClick = null: kortet är bara en bild (t.ex. inuti en rad som själv är klickbar) och tar inte fokus
    val click = if (onClick != null) Modifier.focusRing().clickable(onClick = onClick) else Modifier
    Column(Modifier.width(width.dp).clip(RoundedCornerShape(10.dp)).then(click)) {
        Box(Modifier.size(width.dp, h.dp).clip(RoundedCornerShape(10.dp)).background(
            Brush.linearGradient(listOf(Color.hsv(hue(item.title), 0.5f, 0.4f), Color.hsv(hue(item.title), 0.6f, 0.18f))))) {
            Text(item.showTitle ?: item.title, Modifier.align(Alignment.Center).padding(8.dp), fontWeight = FontWeight.Bold)
            Api.imageUrl(item, landscape)?.let { AsyncImage(model = it, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
            if (item.watched == true) {
                Icon(Icons.Filled.CheckCircle, tr(R.string.watched), tint = Color(0xFF4CC38A), modifier = Modifier.align(Alignment.TopEnd).padding(6.dp))
            } else if (item.isShow && (item.watchedEpisodes ?: 0) > 0 && (item.episodes ?: 0) - (item.watchedEpisodes ?: 0) > 0) {
                Text("${(item.episodes ?: 0) - (item.watchedEpisodes ?: 0)}", Modifier.align(Alignment.TopEnd).padding(6.dp).background(Accent, CircleShape).padding(horizontal = 8.dp, vertical = 2.dp), color = Color.Black, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
            if (item.progress > 0f && item.watched != true) {
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(5.dp).background(Color.Black.copy(alpha = 0.5f)))
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth(item.progress).height(5.dp).background(Accent))
            }
        }
        Text(if (landscape && item.isEpisode) item.showTitle ?: item.title else item.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
        Text(note ?: if (landscape && item.isEpisode) "${item.sxe} · ${item.title}" else item.subtitleLine, color = Color.Gray, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

fun hue(s: String): Float { var h = 0; for (c in s) h = (h * 31 + c.code) % 360; return h.toFloat() }

@Composable
fun Shelf(title: String, items: List<MediaItem>, landscape: Boolean = false, push: (Screen) -> Unit, note: ((MediaItem) -> String?)? = null) {
    Column(Modifier.padding(vertical = 10.dp)) {
        Text(title, fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            items(items, key = { it.id }) { PosterCard(it, landscape, note = note?.invoke(it)) { push(Screen.Detail(it.id)) } }
        }
    }
}

@Composable
fun Loading() = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }

@Composable
fun ErrorText(msg: String) = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(msg, color = Color.Gray) }

/** Fel med knappen Försök igen (får fokus på TV, så att fjärrkontrollen inte fastnar på en tom sida) */
@Composable
fun ErrorRetry(msg: String, onRetry: () -> Unit) {
    val fr = remember { androidx.compose.ui.focus.FocusRequester() }
    val tv = isTv(LocalContext.current)
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 560.dp).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(msg, color = Color.Gray)
            Button(onClick = onRetry, modifier = Modifier.height(52.dp).focusRequester(fr).focusRing(RoundedCornerShape(26.dp))) { Text(tr(R.string.retry), fontSize = 17.sp) }
        }
    }
    LaunchedEffect(msg) { if (tv) runCatching { fr.requestFocus() } }
}

// ---------------- hem / bibliotek / sök ----------------

@Composable
fun HomeScreen(push: (Screen) -> Unit) {
    var home by remember { mutableStateOf<HomeResponse?>(null) }
    var extras by remember { mutableStateOf<HomeExtras?>(null) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var libs by remember { mutableStateOf<List<Library>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(attempt) {
        error = null
        Api.refreshImageToken()
        // Barnprofil och nedladdningsrätt (/api/status) – används av spelaren, nedladdningen och bilens mediaspelare
        Session.refresh()
        // Musik och ljudböcker har egna vyer – i rutnätet för film/serier blir de tomma
        try {
            libs = Api.get<List<Library>>("/api/libraries").filter { it.type == "movie" || it.type == "show" }
            // Ett anrop: grundhyllorna (HomeResponse) och de nyare, valfria hyllorna (HomeExtras) ur samma svar
            val text = Api.requestPublic("/api/home", "GET", emptyMap(), null)
            val h = Api.json.decodeFromString<HomeResponse>(text)
            extras = runCatching { Api.json.decodeFromString<HomeExtras>(text) }.getOrNull()
            home = h
            // Google TV: samma titlar i systemets rad Fortsätt titta
            withContext(Dispatchers.IO) { WatchNext.sync(context, h.continueWatching) }
        } catch (e: Exception) { error = e.message ?: e.toString() }
    }
    val h = home
    when {
        error != null && h == null -> ErrorRetry(error ?: "") { attempt++ }
        h == null -> Loading()
        else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 12.dp)) {
            item {
                LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(libs, key = { it.id }) { l ->
                        FilledTonalButton(onClick = { push(Screen.Lib(l)) }, modifier = Modifier.height(52.dp)) {
                            Icon(if (l.type == "show") Icons.Filled.Tv else Icons.Filled.Movie, null); Spacer(Modifier.width(8.dp)); Text(l.name, fontSize = 17.sp)
                        }
                    }
                }
            }
            // Hyllorna i användarens ordning (Anpassa startsidan i webben); dolda hyllor visas inte
            homeShelves(h, extras, push) { e -> scope.launch { AudioRemote.play(context, e) } }
        }
    }
}

@Composable
fun ItemGrid(items: List<MediaItem>, landscape: Boolean = false, push: (Screen) -> Unit) {
    LazyVerticalGrid(GridCells.Adaptive(if (landscape) 280.dp else 160.dp), contentPadding = PaddingValues(20.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        items(items, key = { it.id }) { PosterCard(it, landscape) { push(Screen.Detail(it.id)) } }
    }
}

@Composable
fun LibraryScreen(lib: Library, push: (Screen) -> Unit) {
    var items by remember { mutableStateOf<List<MediaItem>?>(null) }
    var sort by remember { mutableStateOf("title") }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(sort, attempt) {
        error = null
        try { items = Api.get<LibraryItems>("/api/libraries/${lib.id}/items", mapOf("sort" to sort)).items }
        catch (e: Exception) { error = e.message ?: e.toString() }
    }
    Column {
        Row(Modifier.padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(lib.name, fontSize = 26.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            listOf("title" to tr(R.string.sort_title), "added" to tr(R.string.sort_added), "year" to tr(R.string.sort_year)).forEach { (k, n) ->
                FilterChip(selected = sort == k, onClick = { sort = k }, label = { Text(n) })
            }
        }
        val err = error
        if (err != null && items == null) ErrorRetry(err) { attempt++ }
        else items?.let { ItemGrid(it, push = push) } ?: Loading()
    }
}

@Composable
fun SearchScreen(push: (Screen) -> Unit) {
    var q by remember { mutableStateOf("") }
    var res by remember { mutableStateOf<List<MediaItem>>(emptyList()) }
    var lines by remember { mutableStateOf(false) } // repliksökning i undertexterna
    LaunchedEffect(q, lines) {
        if (q.length < 2 || lines) { res = emptyList(); return@LaunchedEffect }
        delay(300)
        res = runCatching { Api.get<List<MediaItem>>("/api/search", mapOf("q" to q)) }.getOrDefault(emptyList())
    }
    Column {
        OutlinedTextField(q, { q = it }, label = { Text(tr(if (lines) R.string.search_lines_hint else R.string.search_hint)) }, singleLine = true,
            leadingIcon = { Icon(Icons.Filled.Search, null) }, modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 8.dp))
        Row(Modifier.padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FilterChip(selected = !lines, onClick = { lines = false }, label = { Text(tr(R.string.search_titles), fontSize = 16.sp) }, modifier = Modifier.height(44.dp))
            FilterChip(selected = lines, onClick = { lines = true }, label = { Text(tr(R.string.search_lines), fontSize = 16.sp) }, modifier = Modifier.height(44.dp))
        }
        if (lines) LinesResults(q, push) else ItemGrid(res, push = push)
    }
}

@Composable
fun SettingsScreen(push: (Screen) -> Unit) {
    val scope = rememberCoroutineScope()
    var quality by remember { mutableStateOf(Api.quality) }
    var lang by remember { mutableStateOf(Api.subtitleLang) }
    // Lyssning (sparas per användare på servern och gäller även bilens mediaspelare)
    var skipBack by remember { mutableStateOf(Api.skipBack) }
    var skipForward by remember { mutableStateOf(Api.skipForward) }
    var skipSilence by remember { mutableStateOf(Api.skipSilence) }
    var normalize by remember { mutableStateOf(Api.normalize) }
    var listenError by remember { mutableStateOf<String?>(null) }
    var night by remember { mutableStateOf(Api.nightMode) }
    var dialog by remember { mutableStateOf(Api.dialogBoost) }
    // Google TV: bildfrekvensväxling och vad TV:n/förstärkaren klarar (läses när sidan öppnas)
    val ctx = LocalContext.current
    val tv = remember { isTv(ctx) }
    var frameRate by remember { mutableStateOf(TvOutput.frameRateMode(ctx)) }
    val output = remember { if (tv) TvOutput.describe(ctx) else null }
    val donate by Session.donateUrl.collectAsState()
    val homeVia by Home.via.collectAsState()
    val kid by Session.kid.collectAsState()
    LaunchedEffect(Unit) {
        Session.refresh()
        Api.refreshListenPrefs()
        skipBack = Api.skipBack; skipForward = Api.skipForward; skipSilence = Api.skipSilence; normalize = Api.normalize
    }
    fun saveListen(body: kotlinx.serialization.json.JsonObject) {
        scope.launch {
            listenError = runCatching { Api.saveListenPrefs(body) }.exceptionOrNull()?.message
            skipBack = Api.skipBack; skipForward = Api.skipForward; skipSilence = Api.skipSilence; normalize = Api.normalize
        }
    }
    LazyColumn(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Text(tr(R.string.nav_settings), fontSize = 26.sp, fontWeight = FontWeight.Bold) }
        item { Text(tr(R.string.settings_server, Api.saved), color = Color.Gray) }
        homeVia?.let { h -> item { Text(tr(R.string.settings_home_direct, h.substringAfter("://")), color = Color.Gray, fontSize = 14.sp) } }
        item {
            OutlinedButton(onClick = { push(Screen.Profiles) }, modifier = Modifier.height(52.dp)) {
                Icon(Icons.Filled.People, null); Spacer(Modifier.width(8.dp)); Text(tr(R.string.switch_profile), fontSize = 17.sp)
            }
        }
        item { Text(tr(R.string.settings_quality), fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp)) }
        item {
            FlowRowCompat(listOf("auto" to tr(R.string.quality_auto), "orig" to tr(R.string.quality_original), "1080" to "1080p", "720" to "720p", "480" to "480p", "360" to "360p"), quality) { quality = it; Api.quality = it }
        }
        item { Text(tr(R.string.settings_default_subs), fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp)) }
        item {
            FlowRowCompat(listOf("" to tr(R.string.none), "sv" to tr(R.string.lang_sv), "en" to tr(R.string.lang_en), "no" to tr(R.string.lang_no), "da" to tr(R.string.lang_da), "fi" to tr(R.string.lang_fi)), lang) { lang = it; Api.subtitleLang = it }
        }
        item { Text(tr(R.string.settings_movie_audio), fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp)) }
        item { FlowRowCompat(listOf("on" to tr(R.string.night_on), "off" to tr(R.string.night_off)), if (night) "on" else "off") { v -> night = v == "on"; Api.nightMode = night } }
        item { FlowRowCompat(listOf("on" to tr(R.string.dialog_on), "off" to tr(R.string.dialog_off)), if (dialog) "on" else "off") { v -> dialog = v == "on"; Api.dialogBoost = dialog } }
        item { Text(tr(R.string.settings_audio_note), color = Color.Gray, fontSize = 13.sp) }
        if (tv) {
            item { Text(tr(R.string.settings_tv), fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp)) }
            item { Text(tr(R.string.settings_frame_rate), color = Color.Gray) }
            item {
                FlowRowCompat(listOf("off" to tr(R.string.frame_off), "rate" to tr(R.string.frame_rate_only), "res" to tr(R.string.frame_rate_res)), frameRate) { v ->
                    frameRate = v; TvOutput.setFrameRateMode(ctx, v)
                }
            }
            item {
                Text(tr(R.string.settings_frame_note),
                    color = Color.Gray, fontSize = 13.sp)
            }
            output?.let { (screen, audio) ->
                item { Text(screen, fontSize = 15.sp) }
                item { Text(audio, fontSize = 15.sp) }
                item {
                    Text(tr(R.string.settings_output_note),
                        color = Color.Gray, fontSize = 13.sp)
                }
            }
        }
        item { Text(tr(R.string.settings_listening), fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp)) }
        item { Text(tr(R.string.settings_skip_back), color = Color.Gray) }
        item {
            FlowRowCompat(Api.skipBackChoices.map { it.toString() to "$it s" }, skipBack.toString()) { v ->
                saveListen(kotlinx.serialization.json.buildJsonObject { put("skipBack", v.toInt()) })
            }
        }
        item { Text(tr(R.string.settings_skip_forward), color = Color.Gray) }
        item {
            FlowRowCompat(Api.skipForwardChoices.map { it.toString() to "$it s" }, skipForward.toString()) { v ->
                saveListen(kotlinx.serialization.json.buildJsonObject { put("skipForward", v.toInt()) })
            }
        }
        item {
            FlowRowCompat(listOf("on" to tr(R.string.skip_silence_on), "off" to tr(R.string.skip_silence_off)), if (skipSilence) "on" else "off") { v ->
                saveListen(kotlinx.serialization.json.buildJsonObject { put("skipSilence", v == "on") })
            }
        }
        item {
            FlowRowCompat(listOf("on" to tr(R.string.normalize_on), "off" to tr(R.string.normalize_off)), if (normalize) "on" else "off") { v ->
                saveListen(kotlinx.serialization.json.buildJsonObject { put("normalize", v == "on") })
            }
        }
        item {
            Text(listenError ?: tr(R.string.settings_sleep_note),
                color = if (listenError != null) Color(0xFFFF5D6C) else Color.Gray, fontSize = 13.sp)
        }
        item {
            // Nedladdningarna hör till inloggningen och tas bort vid utloggning – fråga först (som Expo-appen)
            var confirmLogout by remember { mutableStateOf(false) }
            Button(onClick = { if (Downloads.hasServerDownloads(Api.saved)) confirmLogout = true else scope.launch { Api.logout() } },
                colors = ButtonDefaults.buttonColors(containerColor = Surface2, contentColor = Color(0xFFFF5D6C)),
                modifier = Modifier.padding(top = 24.dp).height(52.dp)) { Text(tr(R.string.logout)) }
            if (confirmLogout) AlertDialog(onDismissRequest = { confirmLogout = false },
                title = { Text(tr(R.string.logout_confirm_title)) }, text = { Text(tr(R.string.logout_confirm_text)) },
                confirmButton = { TextButton(onClick = { confirmLogout = false; scope.launch { Api.logout() } }) { Text(tr(R.string.logout_confirm_button)) } },
                dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text(tr(R.string.cancel)) } })
        }
        // Feedback och felrapporter (Feedback.kt): i bilen bara Mina ärenden
        item { Text(tr(R.string.feedback_section), fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 20.dp)) }
        item { FeedbackEntry(push) }
        item { Text(tr(R.string.settings_downloads), fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 20.dp)) }
        item { DownloadsList(push) }
        item { Text(tr(R.string.settings_parked), color = Color.Gray, fontSize = 13.sp, modifier = Modifier.padding(top = 16.dp)) }
        // Stöd projektet: helt frivilligt, bara en rad här (aldrig för barnprofiler), och bara när servern skickar en PayPal-länk
        val link: String? = donate
        if (link != null && !kid) {
            item {
                TextButton(onClick = {
                    val ok = runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(link)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
                    // Bilar och vissa TV-apparater saknar webbläsare: visa adressen i stället
                    if (!ok) android.widget.Toast.makeText(ctx, ctx.getString(R.string.no_browser, link), android.widget.Toast.LENGTH_LONG).show()
                }, modifier = Modifier.padding(top = 8.dp).focusRing(RoundedCornerShape(20.dp))) { Text(tr(R.string.support_project), color = Color.Gray, fontSize = 14.sp) }
            }
        }
    }
}

@Composable
fun FlowRowCompat(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        items(options, key = { it.first }) { (k, n) -> FilterChip(selected = selected == k, onClick = { onSelect(k) }, label = { Text(n, fontSize = 16.sp) }, modifier = Modifier.height(44.dp)) }
    }
}

// ---------------- detaljer ----------------

@Composable
fun DetailScreen(id: Int, push: (Screen) -> Unit) {
    var item by remember { mutableStateOf<MediaItem?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(id, reload) { error = null; try { item = Api.get("/api/items/$id") } catch (e: Exception) { error = e.message ?: e.toString() } }
    val it = item ?: run { if (error != null) ErrorRetry(error ?: "") { reload++ } else Loading(); return }
    // Google TV: fokus på Spela/Fortsätt när sidan öppnas, så att OK startar direkt
    val playFocus = remember(it.id) { androidx.compose.ui.focus.FocusRequester() }
    val tv = isTv(LocalContext.current)
    LaunchedEffect(it.id) { if (tv) { delay(150); runCatching { playFocus.requestFocus() } } }

    var season by remember(it.id) { mutableIntStateOf(it.next?.season ?: it.children?.firstOrNull()?.season ?: 1) }
    // Ljudspåret: profilens förval som webben (StartCore.titleAudio). Det skickas bara om man valt ett annat – annars
    // väljer servern, så att förvärmningen och uppspelningen får samma ström (StartCore.playAudio)
    val presetAudio = remember(it.id) { StartCore.titleAudio(it.defaultAudio, it.audio, { a -> a.index }, { a -> a.default == true }) }
    var audio by remember(it.id) { mutableStateOf(presetAudio) }
    val playAudio = StartCore.playAudio(audio, presetAudio)
    // Min lista (inWatchlist saknas hos äldre servrar – då visas ingen knapp)
    var inList by remember(it.id) { mutableStateOf(it.inWatchlist == true) }
    val toggleList: () -> Unit = {
        val add = !inList
        inList = add
        scope.launch { if (runCatching { Api.setWatchlist(it.id, add) }.isFailure) inList = !add }
    }
    var sub by remember(it.id) {
        mutableStateOf(it.subtitles?.firstOrNull { s -> s.forced == true && s.bitmap != true }
            ?: it.subtitles?.firstOrNull { s -> Api.subtitleLang.isNotEmpty() && s.lang == Api.subtitleLang && s.bitmap != true })
    }

    // Temamusik enligt profilens val (låg volym, tonas ut när sidan lämnas)
    ThemeMusicEffect(it)
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                PosterCard(it.copy(position = null), width = 200, onClick = null)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (it.isEpisode) Text("${it.showTitle ?: ""} · ${it.sxe}", color = Color.Gray)
                    Text(it.title, fontSize = 30.sp, fontWeight = FontWeight.Bold)
                    Text(listOfNotNull(it.year?.toString(), if (!it.isShow) formatDuration(it.duration) else it.episodes?.let { n -> plural(R.plurals.episodes_n, n) },
                        it.rating?.let { r -> "★ %.1f".format(r) }, it.hdr?.uppercase()).joinToString("  ·  "), color = Color.Gray)
                    it.overview?.let { o -> Text(o, color = Color(0xFFCFD3DD), maxLines = 6, overflow = TextOverflow.Ellipsis) }
                    // Rollista: regi/skapare och de första skådespelarna
                    castLine(it.cast)?.let { c -> Text(c, color = Color.Gray, fontSize = 14.sp, maxLines = 3, overflow = TextOverflow.Ellipsis) }
                    // Eget betyg (stjärnor, halva steg)
                    RatingRow(it)
                    if (!it.isShow) {
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            val pos = it.position ?: 0.0
                            if (pos > 30) {
                                Button(onClick = { push(Screen.Play(it.id, pos, playAudio, sub)) }, Modifier.height(56.dp).focusRequester(playFocus).focusRing(RoundedCornerShape(28.dp)).warmOnFocus(it.id, pos, playAudio, sub)) { Icon(Icons.Filled.PlayArrow, null); Text(" " + tr(R.string.continue_at, formatTime(pos)), fontSize = 17.sp) }
                                OutlinedButton(onClick = { push(Screen.Play(it.id, 0.0, playAudio, sub)) }, Modifier.height(56.dp).warmOnFocus(it.id, 0.0, playAudio, sub)) { Text(tr(R.string.start_over)) }
                            } else {
                                Button(onClick = { push(Screen.Play(it.id, 0.0, playAudio, sub)) }, Modifier.height(56.dp).focusRequester(playFocus).focusRing(RoundedCornerShape(28.dp)).warmOnFocus(it.id, 0.0, playAudio, sub)) { Icon(Icons.Filled.PlayArrow, null); Text(" " + tr(R.string.play), fontSize = 17.sp) }
                            }
                            OutlinedButton(onClick = { scope.launch { runCatching { Api.setWatched(it.id, it.watched != true) }; reload++ } }, Modifier.height(56.dp)) {
                                Text(tr(if (it.watched == true) R.string.mark_unwatched else R.string.mark_watched))
                            }
                            if (it.inWatchlist != null) MyListButton(inList, toggleList)
                        }
                        DownloadRow(it)
                        it.audio?.takeIf { a -> a.size > 1 }?.let { list ->
                            Text(tr(R.string.audio), fontWeight = FontWeight.SemiBold)
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(list, key = { a -> a.index }) { a -> FilterChip(selected = audio == a.index, onClick = { audio = a.index }, label = { Text(a.label) }) }
                            }
                        }
                        it.subtitles?.takeIf { s -> s.isNotEmpty() }?.let { list ->
                            Text(tr(R.string.subtitle), fontWeight = FontWeight.SemiBold)
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                item { FilterChip(selected = sub == null, onClick = { sub = null }, label = { Text(tr(R.string.none)) }) }
                                items(list, key = { s -> s.id }) { s -> FilterChip(selected = sub?.id == s.id, onClick = { sub = s }, label = { Text(s.label) }) }
                            }
                        }
                    } else {
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            it.next?.let { n ->
                                Button(onClick = { push(Screen.Play(n.id, n.position ?: 0.0, null, null)) }, Modifier.height(56.dp).focusRequester(playFocus).focusRing(RoundedCornerShape(28.dp)).warmOnFocus(n.id, n.position ?: 0.0)) {
                                    Icon(Icons.Filled.PlayArrow, null); Text(" ${tr(if ((n.position ?: 0.0) > 0) R.string.continue_word else R.string.play)} S${n.season}E${n.episode}", fontSize = 17.sp)
                                }
                            }
                            if (it.inWatchlist != null) MyListButton(inList, toggleList)
                        }
                    }
                }
            }
        }
        it.extras?.takeIf { x -> x.isNotEmpty() }?.let { x -> item { ExtrasShelf(x, push) } }
        if (it.isShow) {
            val eps = it.children.orEmpty()
            val seasons = eps.mapNotNull { e -> e.season }.distinct().sorted()
            item {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(seasons, key = { s -> s }) { s -> FilterChip(selected = s == season, onClick = { season = s }, label = { Text(if (s == 0) tr(R.string.specials) else tr(R.string.season_n, s), fontSize = 16.sp) }, modifier = Modifier.height(44.dp)) }
                }
            }
            items(eps.filter { e -> e.season == season }, key = { e -> e.id }) { e ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).focusRing().warmOnFocus(e.id, if ((e.position ?: 0.0) > 30) e.position!! else 0.0).clickable { push(Screen.Play(e.id, if ((e.position ?: 0.0) > 30) e.position!! else 0.0, null, null)) }.padding(8.dp),
                    horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    PosterCard(e, landscape = true, width = 240, onClick = null)
                    Column(Modifier.weight(1f)) {
                        Text("${e.episode}. ${e.title}", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                        Text(formatDuration(e.duration) + if (e.watched == true) " · " + tr(R.string.watched) else "", color = Color.Gray)
                        e.overview?.let { o -> Text(o, color = Color.Gray, maxLines = 3, overflow = TextOverflow.Ellipsis, fontSize = 14.sp) }
                    }
                }
            }
        }
    }
}

@Composable
fun MyListButton(inList: Boolean, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = Modifier.height(56.dp)) {
        Icon(if (inList) Icons.Filled.Check else Icons.Filled.Add, null); Text(" " + tr(if (inList) R.string.in_my_list else R.string.my_list))
    }
}

@Composable
fun DownloadRow(item: MediaItem) {
    val records by Downloads.records.collectAsState()
    val active by Downloads.active.collectAsState()
    val errors by Downloads.errors.collectAsState()
    val canDownload by Session.canDownload.collectAsState()
    val error = errors[item.id]
    val done = records.any { it.id == item.id }
    val p = active[item.id]
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        when {
            done -> OutlinedButton(onClick = { Downloads.remove(item.id) }) { Text(tr(R.string.download_remove)) }
            p != null -> { LinearProgressIndicator(progress = { p }, modifier = Modifier.width(200.dp)); Text(tr(if (p < 0.5f) R.string.download_preparing else R.string.download_progress), color = Color.Gray) }
            !canDownload -> {} // kontot får inte ladda ner – servern skulle svara 403
            else -> listOf("1080" to tr(R.string.download_hd), "480" to tr(R.string.download_small)).forEach { (q, label) ->
                // Körs i appens scope – avbryts inte när man lämnar sidan
                OutlinedButton(onClick = { Downloads.start(item, q) }) { Text(label) }
            }
        }
        error?.let { Text(it, color = Color(0xFFFF5D6C), fontSize = 13.sp) }
    }
}

@Composable
fun DownloadsList(push: (Screen) -> Unit) {
    val records by Downloads.records.collectAsState()
    val notice by Downloads.notice.collectAsState()
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        // T.ex. att titlar togs bort för att profilen inte får se dem längre
        notice?.let { n ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(n, color = Color(0xFFFFB454), fontSize = 14.sp, modifier = Modifier.weight(1f))
                TextButton(onClick = { Downloads.notice.value = null }) { Text(tr(R.string.close)) }
            }
        }
        if (records.isEmpty()) Text(tr(R.string.downloads_empty), color = Color.Gray)
        records.forEach { r ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) { Text(r.title, fontWeight = FontWeight.SemiBold); Text("${r.subtitle} · ${r.size / 1_000_000} MB", color = Color.Gray, fontSize = 13.sp) }
                // Spelas direkt från filen – fungerar utan nät (titelsidan kräver servern)
                TextButton(onClick = { push(Screen.Play(r.id, OfflineSync.resumeAt(r.id), null, null)) }) { Text(tr(R.string.play)) }
                TextButton(onClick = { Downloads.remove(r.id) }) { Text(tr(R.string.remove)) }
            }
        }
    }
}

// ---------------- inloggning med kod ----------------

/** Inloggning med kod: visar koden och frågar servern var 3:e sekund tills den godkänts eller gått ut. */
@Composable
fun QuickConnectScreen(serverInput: String, onCancel: () -> Unit) {
    var code by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    BackHandler { onCancel() }
    LaunchedEffect(attempt) {
        code = null; message = null
        val start = try { Api.startQuickConnect(serverInput) } catch (e: Exception) { message = e.message ?: e.toString(); null }
        if (start != null) {
            code = start.code
            while (true) {
                delay(3000)
                try {
                    when (Api.pollQuickConnect(start.secret)) {
                        "approved" -> break // token sparad – appen byter till startsidan
                        "expired" -> { message = str(R.string.qc_code_expired); break }
                    }
                } catch (e: ApiException) {
                    // Servern nekade (4xx) – sluta fråga. Nätverksfel och 5xx (t.ex. reläet tappade servern): försök igen
                    if (e.code in 400..499) { message = e.message; break }
                } catch (e: IOException) { } // tillfälligt nätverksfel: försök igen
            }
        }
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 640.dp).padding(32.dp), verticalArrangement = Arrangement.spacedBy(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(tr(R.string.login_with_code), fontSize = 28.sp, fontWeight = FontWeight.Bold)
            val c = code
            if (c != null) {
                Text(tr(R.string.qc_help), color = Color.Gray, fontSize = 16.sp)
                Text(if (c.length == 6) c.substring(0, 3) + " " + c.substring(3) else c, fontSize = 64.sp, fontWeight = FontWeight.Bold, letterSpacing = 6.sp)
                Text(Api.server.value + "/#/quickconnect", color = Color.Gray, fontSize = 14.sp)
            }
            val m = message
            if (m != null) Text(m, color = if (c != null) Color.Gray else Color(0xFFFF5D6C))
            else CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp)
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                if (m != null) Button(onClick = { attempt++ }, modifier = Modifier.height(56.dp)) { Text(tr(R.string.qc_new_code), fontSize = 18.sp) }
                OutlinedButton(onClick = onCancel, modifier = Modifier.height(56.dp)) { Text(tr(R.string.cancel), fontSize = 18.sp) }
            }
        }
    }
}
