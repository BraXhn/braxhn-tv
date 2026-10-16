package net.braxhn.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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
    data class Play(val id: Int, val start: Double, val audio: Int?, val sub: SubtitleTrack?) : Screen()
    data object Live : Screen()
    data object Recordings : Screen()
    data class LivePlay(val id: Int, val title: String) : Screen()
}

class MainActivity : ComponentActivity() {
    override fun onResume() {
        super.onResume()
        // Automatisk offline-synk när appen öppnas eller kommer tillbaka till förgrunden
        Downloads.autoSync()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Accent, background = Bg, surface = Bg, onPrimary = Color.Black)) {
                Surface(Modifier.fillMaxSize(), color = Bg) { AppRoot() }
            }
        }
    }
}

@Composable
fun AppRoot() {
    val token by Api.token.collectAsState()
    if (token == null) { LoginScreen(); return }
    val stack: SnapshotStateList<Screen> = remember { mutableStateListOf(Screen.Home) }
    val current = stack.last()
    val push: (Screen) -> Unit = { stack.add(it) }
    val pop: () -> Unit = { if (stack.size > 1) stack.removeAt(stack.lastIndex) }
    BackHandler(enabled = stack.size > 1) { pop() }

    if (current is Screen.Play) {
        PlayerScreen(current, onClose = pop, onPlay = { stack[stack.lastIndex] = it })
        return
    }
    if (current is Screen.LivePlay) { LivePlayerScreen(current, onClose = pop); return }
    var hasLive by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { hasLive = runCatching { Api.get<LiveChannels>("/api/live/channels").channels.isNotEmpty() }.getOrDefault(false) }
    Row(Modifier.fillMaxSize()) {
        // Sidomeny – större träffytor passar bilskärmar
        NavigationRail(containerColor = Color(0xFF151821)) {
            Spacer(Modifier.height(12.dp))
            Icon(Icons.Filled.PlayCircle, null, tint = Accent, modifier = Modifier.size(40.dp))
            Spacer(Modifier.height(20.dp))
            NavigationRailItem(selected = stack.first() == Screen.Home && current !is Screen.Search && current !is Screen.Settings,
                onClick = { stack.clear(); stack.add(Screen.Home) }, icon = { Icon(Icons.Filled.Home, null) }, label = { Text("Hem") })
            NavigationRailItem(selected = current == Screen.Search, onClick = { stack.clear(); stack.add(Screen.Home); stack.add(Screen.Search) },
                icon = { Icon(Icons.Filled.Search, null) }, label = { Text("Sök") })
            if (hasLive) NavigationRailItem(selected = current == Screen.Live || current == Screen.Recordings, onClick = { stack.clear(); stack.add(Screen.Home); stack.add(Screen.Live) },
                icon = { Icon(Icons.Filled.LiveTv, null) }, label = { Text("Live-TV") })
            NavigationRailItem(selected = current == Screen.Settings, onClick = { stack.clear(); stack.add(Screen.Home); stack.add(Screen.Settings) },
                icon = { Icon(Icons.Filled.Settings, null) }, label = { Text("Inställningar") })
        }
        Column(Modifier.fillMaxSize()) {
            if (stack.size > 1) {
                IconButton(onClick = pop, modifier = Modifier.padding(8.dp).size(56.dp)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Tillbaka", Modifier.size(32.dp)) }
            }
            when (current) {
                is Screen.Home -> HomeScreen(push)
                is Screen.Search -> SearchScreen(push)
                is Screen.Settings -> SettingsScreen(push)
                is Screen.Lib -> LibraryScreen(current.library, push)
                is Screen.Detail -> DetailScreen(current.id, push)
                is Screen.Live -> LiveScreen(onPlay = push, push = push)
                is Screen.Recordings -> RecordingsScreen(onPlay = push)
                is Screen.Play, is Screen.LivePlay -> {}
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
    val scope = rememberCoroutineScope()
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 520.dp).padding(32.dp), verticalArrangement = Arrangement.spacedBy(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Filled.PlayCircle, null, tint = Accent, modifier = Modifier.size(72.dp))
            Text("BraXhn TV", fontSize = 32.sp, fontWeight = FontWeight.Bold)
            Text("Serveradress, t.ex. 192.168.1.10:8420 eller https://tv.dindomän.se", color = Color.Gray, fontSize = 14.sp)
            OutlinedTextField(server, { server = it }, label = { Text("Server") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
            OutlinedTextField(name, { name = it }, label = { Text("Användarnamn") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(pass, { pass = it }, label = { Text("Lösenord") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
            if (needCode) {
                OutlinedTextField(code, { code = it }, label = { Text("Kod från autentiseringsappen") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
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
                if (busy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp) else Text("Logga in", fontSize = 18.sp)
            }
        }
    }
}

// ---------------- kort ----------------

@Composable
fun PosterCard(item: MediaItem, landscape: Boolean = false, width: Int = if (landscape) 280 else 160, onClick: (() -> Unit)?) {
    val h = if (landscape) width * 9 / 16 else width * 3 / 2
    // onClick = null: kortet är bara en bild (t.ex. inuti en rad som själv är klickbar) och tar inte fokus
    val click = if (onClick != null) Modifier.focusRing().clickable(onClick = onClick) else Modifier
    Column(Modifier.width(width.dp).clip(RoundedCornerShape(10.dp)).then(click)) {
        Box(Modifier.size(width.dp, h.dp).clip(RoundedCornerShape(10.dp)).background(
            Brush.linearGradient(listOf(Color.hsv(hue(item.title), 0.5f, 0.4f), Color.hsv(hue(item.title), 0.6f, 0.18f))))) {
            Text(item.showTitle ?: item.title, Modifier.align(Alignment.Center).padding(8.dp), fontWeight = FontWeight.Bold)
            Api.imageUrl(item, landscape)?.let { AsyncImage(model = it, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
            if (item.watched == true) {
                Icon(Icons.Filled.CheckCircle, "Sedd", tint = Color(0xFF4CC38A), modifier = Modifier.align(Alignment.TopEnd).padding(6.dp))
            } else if (item.isShow && (item.watchedEpisodes ?: 0) > 0 && (item.episodes ?: 0) - (item.watchedEpisodes ?: 0) > 0) {
                Text("${(item.episodes ?: 0) - (item.watchedEpisodes ?: 0)}", Modifier.align(Alignment.TopEnd).padding(6.dp).background(Accent, CircleShape).padding(horizontal = 8.dp, vertical = 2.dp), color = Color.Black, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
            if (item.progress > 0f && item.watched != true) {
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(5.dp).background(Color.Black.copy(alpha = 0.5f)))
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth(item.progress).height(5.dp).background(Accent))
            }
        }
        Text(if (landscape && item.isEpisode) item.showTitle ?: item.title else item.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
        Text(if (landscape && item.isEpisode) "${item.sxe} · ${item.title}" else item.subtitleLine, color = Color.Gray, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

fun hue(s: String): Float { var h = 0; for (c in s) h = (h * 31 + c.code) % 360; return h.toFloat() }

@Composable
fun Shelf(title: String, items: List<MediaItem>, landscape: Boolean = false, push: (Screen) -> Unit) {
    Column(Modifier.padding(vertical = 10.dp)) {
        Text(title, fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            items(items, key = { it.id }) { PosterCard(it, landscape) { push(Screen.Detail(it.id)) } }
        }
    }
}

@Composable
fun Loading() = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }

@Composable
fun ErrorText(msg: String) = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(msg, color = Color.Gray) }

// ---------------- hem / bibliotek / sök ----------------

@Composable
fun HomeScreen(push: (Screen) -> Unit) {
    var home by remember { mutableStateOf<HomeResponse?>(null) }
    var libs by remember { mutableStateOf<List<Library>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        Api.refreshImageToken()
        // Musik och ljudböcker har egna vyer – i rutnätet för film/serier blir de tomma
        try { libs = Api.get<List<Library>>("/api/libraries").filter { it.type == "movie" || it.type == "show" }; home = Api.get("/api/home") } catch (e: Exception) { error = e.message }
    }
    val h = home
    when {
        error != null -> ErrorText(error!!)
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
            if (h.forYou.isNotEmpty()) item { Shelf("Nytt för dig", h.forYou, true, push) }
            if (h.continueWatching.isNotEmpty()) item { Shelf("Fortsätt titta", h.continueWatching, true, push) }
            items(h.rows.filter { it.items.isNotEmpty() }, key = { "${it.library.id}:${it.title}" }) { r -> Shelf(r.title, r.items, false, push) }
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
    LaunchedEffect(sort) { items = runCatching { Api.get<LibraryItems>("/api/libraries/${lib.id}/items", mapOf("sort" to sort)).items }.getOrDefault(emptyList()) }
    Column {
        Row(Modifier.padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(lib.name, fontSize = 26.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            listOf("title" to "Titel", "added" to "Senaste", "year" to "År").forEach { (k, n) ->
                FilterChip(selected = sort == k, onClick = { sort = k }, label = { Text(n) })
            }
        }
        items?.let { ItemGrid(it, push = push) } ?: Loading()
    }
}

@Composable
fun SearchScreen(push: (Screen) -> Unit) {
    var q by remember { mutableStateOf("") }
    var res by remember { mutableStateOf<List<MediaItem>>(emptyList()) }
    LaunchedEffect(q) {
        if (q.length < 2) { res = emptyList(); return@LaunchedEffect }
        delay(300)
        res = runCatching { Api.get<List<MediaItem>>("/api/search", mapOf("q" to q)) }.getOrDefault(emptyList())
    }
    Column {
        OutlinedTextField(q, { q = it }, label = { Text("Sök filmer och serier") }, singleLine = true,
            leadingIcon = { Icon(Icons.Filled.Search, null) }, modifier = Modifier.fillMaxWidth().padding(20.dp))
        ItemGrid(res, push = push)
    }
}

@Composable
fun SettingsScreen(push: (Screen) -> Unit) {
    val scope = rememberCoroutineScope()
    var quality by remember { mutableStateOf(Api.quality) }
    var lang by remember { mutableStateOf(Api.subtitleLang) }
    LazyColumn(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Text("Inställningar", fontSize = 26.sp, fontWeight = FontWeight.Bold) }
        item { Text("Server: ${Api.server.value}", color = Color.Gray) }
        item { Text("Kvalitet", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp)) }
        item {
            FlowRowCompat(listOf("auto" to "Automatisk", "orig" to "Original", "1080" to "1080p", "720" to "720p", "480" to "480p", "360" to "360p"), quality) { quality = it; Api.quality = it }
        }
        item { Text("Undertexter som standard", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp)) }
        item {
            FlowRowCompat(listOf("" to "Inga", "sv" to "Svenska", "en" to "Engelska", "no" to "Norska", "da" to "Danska", "fi" to "Finska"), lang) { lang = it; Api.subtitleLang = it }
        }
        item {
            Button(onClick = { scope.launch { Api.logout() } }, colors = ButtonDefaults.buttonColors(containerColor = Surface2, contentColor = Color(0xFFFF5D6C)),
                modifier = Modifier.padding(top = 24.dp).height(52.dp)) { Text("Logga ut") }
        }
        item { Text("Nedladdat för offline", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 20.dp)) }
        item { DownloadsList(push) }
        item { Text("Video kan bara spelas när bilen står parkerad.", color = Color.Gray, fontSize = 13.sp, modifier = Modifier.padding(top = 16.dp)) }
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
    LaunchedEffect(id, reload) { try { item = Api.get("/api/items/$id") } catch (e: Exception) { error = e.message } }
    val it = item ?: run { if (error != null) ErrorText(error!!) else Loading(); return }

    var season by remember(it.id) { mutableIntStateOf(it.next?.season ?: it.children?.firstOrNull()?.season ?: 1) }
    var audio by remember(it.id) { mutableStateOf((it.audio?.firstOrNull { a -> a.default == true } ?: it.audio?.firstOrNull())?.index) }
    var sub by remember(it.id) {
        mutableStateOf(it.subtitles?.firstOrNull { s -> s.forced == true && s.bitmap != true }
            ?: it.subtitles?.firstOrNull { s -> Api.subtitleLang.isNotEmpty() && s.lang == Api.subtitleLang && s.bitmap != true })
    }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                PosterCard(it.copy(position = null), width = 200, onClick = null)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (it.isEpisode) Text("${it.showTitle ?: ""} · ${it.sxe}", color = Color.Gray)
                    Text(it.title, fontSize = 30.sp, fontWeight = FontWeight.Bold)
                    Text(listOfNotNull(it.year?.toString(), if (!it.isShow) formatDuration(it.duration) else it.episodes?.let { n -> "$n avsnitt" },
                        it.rating?.let { r -> "★ %.1f".format(r) }, it.hdr?.uppercase()).joinToString("  ·  "), color = Color.Gray)
                    it.overview?.let { o -> Text(o, color = Color(0xFFCFD3DD), maxLines = 6, overflow = TextOverflow.Ellipsis) }
                    if (!it.isShow) {
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            val pos = it.position ?: 0.0
                            if (pos > 30) {
                                Button(onClick = { push(Screen.Play(it.id, pos, audio, sub)) }, Modifier.height(56.dp)) { Icon(Icons.Filled.PlayArrow, null); Text(" Fortsätt ${formatTime(pos)}", fontSize = 17.sp) }
                                OutlinedButton(onClick = { push(Screen.Play(it.id, 0.0, audio, sub)) }, Modifier.height(56.dp)) { Text("Börja om") }
                            } else {
                                Button(onClick = { push(Screen.Play(it.id, 0.0, audio, sub)) }, Modifier.height(56.dp)) { Icon(Icons.Filled.PlayArrow, null); Text(" Spela", fontSize = 17.sp) }
                            }
                            OutlinedButton(onClick = { scope.launch { runCatching { Api.setWatched(it.id, it.watched != true) }; reload++ } }, Modifier.height(56.dp)) {
                                Text(if (it.watched == true) "Markera osedd" else "Markera sedd")
                            }
                        }
                        DownloadRow(it)
                        it.audio?.takeIf { a -> a.size > 1 }?.let { list ->
                            Text("Ljud", fontWeight = FontWeight.SemiBold)
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(list, key = { a -> a.index }) { a -> FilterChip(selected = audio == a.index, onClick = { audio = a.index }, label = { Text(a.label) }) }
                            }
                        }
                        it.subtitles?.takeIf { s -> s.isNotEmpty() }?.let { list ->
                            Text("Undertext", fontWeight = FontWeight.SemiBold)
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                item { FilterChip(selected = sub == null, onClick = { sub = null }, label = { Text("Inga") }) }
                                items(list, key = { s -> s.id }) { s -> FilterChip(selected = sub?.id == s.id, onClick = { sub = s }, label = { Text(s.label) }) }
                            }
                        }
                    } else {
                        it.next?.let { n ->
                            Button(onClick = { push(Screen.Play(n.id, n.position ?: 0.0, null, null)) }, Modifier.height(56.dp)) {
                                Icon(Icons.Filled.PlayArrow, null); Text(" ${if ((n.position ?: 0.0) > 0) "Fortsätt" else "Spela"} S${n.season}E${n.episode}", fontSize = 17.sp)
                            }
                        }
                    }
                }
            }
        }
        if (it.isShow) {
            val eps = it.children.orEmpty()
            val seasons = eps.mapNotNull { e -> e.season }.distinct().sorted()
            item {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(seasons, key = { s -> s }) { s -> FilterChip(selected = s == season, onClick = { season = s }, label = { Text(if (s == 0) "Special" else "Säsong $s", fontSize = 16.sp) }, modifier = Modifier.height(44.dp)) }
                }
            }
            items(eps.filter { e -> e.season == season }, key = { e -> e.id }) { e ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).focusRing().clickable { push(Screen.Play(e.id, if ((e.position ?: 0.0) > 30) e.position!! else 0.0, null, null)) }.padding(8.dp),
                    horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    PosterCard(e, landscape = true, width = 240, onClick = null)
                    Column(Modifier.weight(1f)) {
                        Text("${e.episode}. ${e.title}", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                        Text(formatDuration(e.duration) + if (e.watched == true) " · Sedd" else "", color = Color.Gray)
                        e.overview?.let { o -> Text(o, color = Color.Gray, maxLines = 3, overflow = TextOverflow.Ellipsis, fontSize = 14.sp) }
                    }
                }
            }
        }
    }
}

@Composable
fun DownloadRow(item: MediaItem) {
    val records by Downloads.records.collectAsState()
    val active by Downloads.active.collectAsState()
    val errors by Downloads.errors.collectAsState()
    val error = errors[item.id]
    val done = records.any { it.id == item.id }
    val p = active[item.id]
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        when {
            done -> OutlinedButton(onClick = { Downloads.remove(item.id) }) { Text("Ta bort nedladdning") }
            p != null -> { LinearProgressIndicator(progress = { p }, modifier = Modifier.width(200.dp)); Text(if (p < 0.5f) "Förbereder…" else "Laddar ner…", color = Color.Gray) }
            else -> listOf("1080" to "Ladda ner HD", "480" to "Ladda ner (liten)").forEach { (q, label) ->
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
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (records.isEmpty()) Text("Inget nedladdat.", color = Color.Gray)
        records.forEach { r ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) { Text(r.title, fontWeight = FontWeight.SemiBold); Text("${r.subtitle} · ${r.size / 1_000_000} MB", color = Color.Gray, fontSize = 13.sp) }
                // Spelas direkt från filen – fungerar utan nät (titelsidan kräver servern)
                TextButton(onClick = { push(Screen.Play(r.id, 0.0, null, null)) }) { Text("Spela") }
                TextButton(onClick = { Downloads.remove(r.id) }) { Text("Ta bort") }
            }
        }
    }
}
