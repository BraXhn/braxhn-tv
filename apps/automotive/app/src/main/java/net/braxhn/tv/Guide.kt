package net.braxhn.tv

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ---------- modeller: /api/iptv/* (tillägg; äldre servrar saknar endpointerna – då visas den gamla kanallistan) ----------

/** Program i TV-guiden. catchup = finns i kanalens arkiv (bara i /api/iptv/epg, för program som börjat) */
@Serializable data class IptvProg(val id: Int, val start: Long, val stop: Long, val title: String, val subtitle: String? = null,
                                  val category: String? = null, val season: Int? = null, val episode: Int? = null,
                                  val isNew: Boolean? = null, val catchup: Boolean? = null)
/** Kanal per profil: favorite = profilens favorit, catchup = dagar i arkivet (0 = inget) */
@Serializable data class IptvChannel(val id: Int, val number: String? = null, val name: String, val logo: Boolean = false, val group: String? = null,
                                     val favorite: Boolean = false, val catchup: Int = 0, val radio: Boolean = false,
                                     val now: IptvProg? = null, val next: IptvProg? = null)
@Serializable data class IptvChannels(val channels: List<IptvChannel> = emptyList(), val vod: Boolean = false)
/** GET /api/iptv/epg: program per kanal-id (nyckeln är id:t som text) */
@Serializable data class IptvEpg(val programs: Map<String, List<IptvProg>> = emptyMap())

@Serializable data class VodProgress(val position: Double = 0.0, val duration: Double? = null, val watched: Boolean = false)
@Serializable data class VodCard(val id: Int, val kind: String = "movie", val name: String, val year: Int? = null, val rating: Double? = null,
                                 val cover: Boolean = false, val progress: VodProgress? = null)
@Serializable data class VodShelf(val key: String? = null, val title: String, val items: List<VodCard> = emptyList())
@Serializable data class VodShelves(val shelves: List<VodShelf> = emptyList())
@Serializable data class VodEpisode(val id: Int, val season: Int? = null, val episode: Int? = null, val title: String? = null, val plot: String? = null,
                                    val duration: Double? = null, val image: Boolean = false, val progress: VodProgress? = null)
@Serializable data class VodDetail(val id: Int, val kind: String = "movie", val name: String, val cover: Boolean = false, val plot: String? = null,
                                   val year: Int? = null, val rating: Double? = null, val genre: String? = null, val cast: String? = null,
                                   val director: String? = null, val duration: Double? = null, val progress: VodProgress? = null,
                                   val episodes: List<VodEpisode> = emptyList())

/** Kanalordningen för kanalbyte i live-spelaren (upp/ned och sifferknappar) – sätts av listan/guiden som öppnade spelaren */
data class ChanRef(val id: Int, val number: String?, val name: String, val catchup: Int = 0)
object LiveNav {
    @Volatile var list: List<ChanRef> = emptyList()
}

private val hhmm = SimpleDateFormat("HH:mm", Locale("sv", "SE"))
private val dayHm = SimpleDateFormat("EEE d MMM HH:mm", Locale("sv", "SE"))
private fun clock(s: Long): String = hhmm.format(Date(s * 1000))
private fun nowSec(): Long = System.currentTimeMillis() / 1000

/** Fönstrets längd i guiden (minuter) och hur långt bakåt man kan bläddra (catch-up) */
private const val WINDOW_MIN = 120
private const val BACK_DAYS = 7

// ---------- Live-TV: guide, filmer och serier ----------

/**
 * Live-TV med TV-guide i rutnät (D-pad: upp/ned mellan kanaler, vänster/höger mellan program – vid kanten bläddrar
 * guiden en timme), favoriter per profil och IPTV-filmer/serier. Äldre servrar: den enkla kanallistan.
 */
@Composable
fun LiveScreen(onPlay: (Screen) -> Unit, push: (Screen) -> Unit) {
    var iptv by remember { mutableStateOf<IptvChannels?>(null) }
    var failed by remember { mutableStateOf(false) }
    var tab by remember { mutableStateOf("guide") }
    LaunchedEffect(Unit) {
        Api.refreshImageToken()
        try { iptv = Api.get<IptvChannels>("/api/iptv/channels") } catch (e: Exception) { failed = true }
    }
    if (failed) { ChannelGrid(onPlay = { s -> onPlay(s) }, push = push); return }
    val d = iptv ?: run { Loading(); return }
    LaunchedEffect(d) { LiveNav.list = d.channels.map { c -> ChanRef(c.id, c.number, c.name, c.catchup) } }
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Live-TV", fontSize = 28.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(vertical = 12.dp))
            Spacer(Modifier.weight(1f))
            val tabs = listOf("guide" to "TV-guide") + (if (d.vod) listOf("movie" to "Filmer", "series" to "Serier") else emptyList())
            tabs.forEach { (k, n) -> FilterChip(selected = tab == k, onClick = { tab = k }, label = { Text(n, fontSize = 16.sp) }, modifier = Modifier.height(44.dp)) }
            OutlinedButton(onClick = { push(Screen.Recordings) }, modifier = Modifier.focusRing(RoundedCornerShape(20.dp))) { Text("Inspelningar") }
        }
        if (d.channels.isEmpty() && tab == "guide") { ErrorText("Inga kanaler – lägg till en källa under Administration i webben."); return }
        when (tab) {
            "movie" -> VodShelvesView("movie", push)
            "series" -> VodShelvesView("series", push)
            else -> TvGuide(d, onPlay)
        }
    }
}

/** Fönstrets start: närmaste halvtimme bakåt */
private fun halfHour(t: Long): Long = t - t % 1800

@Composable
fun TvGuide(data: IptvChannels, onPlay: (Screen) -> Unit) {
    val scope = rememberCoroutineScope()
    var from by remember { mutableStateOf(halfHour(nowSec())) }
    val to: Long = from + WINDOW_MIN * 60L
    var filter by remember { mutableStateOf("all") }
    val favs: SnapshotStateList<Int> = remember { mutableStateListOf<Int>().apply { addAll(data.channels.filter { c -> c.favorite }.map { c -> c.id }) } }
    // Program per kanal för det synliga fönstret (hämtas i block när raderna visas)
    val programs: SnapshotStateMap<Int, List<IptvProg>> = remember(from) { mutableStateMapOf<Int, List<IptvProg>>() }
    var selected by remember { mutableStateOf<Pair<IptvChannel, IptvProg?>?>(null) }
    var pending by remember { mutableStateOf<Pair<Int, String>?>(null) } // (kanal, "first"/"last") fokus efter bläddring
    val groups: List<String> = remember(data) { data.channels.mapNotNull { c -> c.group }.distinct() }
    val shown: List<IptvChannel> = when {
        filter == "fav" -> data.channels.filter { c -> c.id in favs }
        filter.startsWith("g:") -> data.channels.filter { c -> c.group == filter.removePrefix("g:") }
        else -> data.channels
    }
    val listState = rememberLazyListState()
    val block: Int by remember { derivedStateOf { listState.firstVisibleItemIndex / 25 } }
    LaunchedEffect(from, filter, block) {
        // Det synliga blocket och nästa (högst 50 kanaler per anrop)
        val ids: List<Int> = shown.drop(block * 25).take(50).map { c -> c.id }.filter { id -> !programs.containsKey(id) }
        if (ids.isEmpty()) return@LaunchedEffect
        val r: IptvEpg? = runCatching {
            Api.get<IptvEpg>("/api/iptv/epg", mapOf("ids" to ids.joinToString(","), "from" to from.toString(), "to" to to.toString()))
        }.getOrNull()
        for (id in ids) programs[id] = r?.programs?.get(id.toString()) ?: emptyList()
    }

    Column(Modifier.fillMaxSize()) {
        // Filter: alla, favoriter och kanalgrupperna
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(vertical = 4.dp)) {
            item { FilterChip(selected = filter == "all", onClick = { filter = "all" }, label = { Text("Alla") }) }
            item { FilterChip(selected = filter == "fav", onClick = { filter = "fav" }, label = { Text("Favoriter") }) }
            items(groups, key = { g -> "g:$g" }) { g -> FilterChip(selected = filter == "g:$g", onClick = { filter = "g:$g" }, label = { Text(g) }) }
        }
        // Tid: bläddra en timme i taget (bakåt så långt som catch-up räcker)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 4.dp)) {
            val minFrom: Long = halfHour(nowSec()) - BACK_DAYS * 86400L
            TextButton(onClick = { from = (from - 3600).coerceAtLeast(minFrom) }, enabled = from > minFrom) { Text("◀ Tidigare") }
            TextButton(onClick = { from = halfHour(nowSec()) }) { Text("Nu") }
            TextButton(onClick = { from += 3600 }) { Text("Senare ▶") }
            Text(dayHm.format(Date(from * 1000)) + " – " + clock(to), color = Color.Gray)
        }
        if (shown.isEmpty()) { ErrorText(if (filter == "fav") "Inga favoriter än – välj en kanal och Lägg till i favoriter." else "Inga kanaler."); return }
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val chanW: Dp = if (maxWidth < 700.dp) 120.dp else 190.dp
            val gridW: Dp = maxWidth - chanW - 8.dp
            val perMin: Float = gridW.value / WINDOW_MIN
            LazyColumn(state = listState, verticalArrangement = Arrangement.spacedBy(6.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
                // Tidslinjen
                item(key = "tid") {
                    Row {
                        Spacer(Modifier.width(chanW + 8.dp))
                        Box(Modifier.width(gridW).height(22.dp)) {
                            var t: Long = from
                            while (t < to) {
                                Text(clock(t), color = Color.Gray, fontSize = 13.sp, modifier = Modifier.offset(x = (((t - from) / 60f) * perMin).dp))
                                t += 1800
                            }
                        }
                    }
                }
                items(shown, key = { c -> c.id }) { ch ->
                    GuideRow(ch, ch.id in favs, programs[ch.id], from, to, chanW, gridW, perMin, pending,
                        onPending = { p -> pending = p },
                        onShift = { delta -> from = (from + delta).coerceAtLeast(halfHour(nowSec()) - BACK_DAYS * 86400L) },
                        onChannel = { onPlay(Screen.LivePlay(ch.id, ch.name)) },
                        onProgram = { p -> selected = ch to p })
                }
            }
        }
    }

    selected?.let { (ch, p) ->
        val now = nowSec()
        val live = p != null && p.start <= now && p.stop > now
        val past = p != null && p.stop <= now
        val fav = ch.id in favs
        AlertDialog(onDismissRequest = { selected = null },
            title = { Text(p?.title ?: ch.name) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(listOfNotNull(ch.name, p?.let { x -> "${dayHm.format(Date(x.start * 1000))}–${clock(x.stop)}" }).joinToString(" · "), color = Color.Gray)
                    p?.subtitle?.let { s -> Text(s) }
                    if (p == null || live) Button(onClick = { selected = null; onPlay(Screen.LivePlay(ch.id, ch.name)) }) { Icon(Icons.Filled.PlayArrow, null); Text(" Titta live") }
                    if (p != null && live && (p.catchup == true || ch.catchup > 0)) OutlinedButton(onClick = { selected = null; onPlay(Screen.Stream("catchup", p.id, p.title)) }) { Text("Från början") }
                    if (p != null && past && p.catchup == true) Button(onClick = { selected = null; onPlay(Screen.Stream("catchup", p.id, p.title)) }) { Icon(Icons.Filled.PlayArrow, null); Text(" Spela (catch-up)") }
                    if (p != null && past && p.catchup != true) Text("Finns inte i kanalens arkiv.", color = Color.Gray, fontSize = 13.sp)
                    if (p != null && !past) OutlinedButton(onClick = {
                        selected = null
                        scope.launch { runCatching { Api.post("/api/dvr/program", buildJsonObject { put("programId", p.id) }) } }
                    }) { Text("Spela in") }
                    OutlinedButton(onClick = {
                        val on = !fav
                        if (on) favs.add(ch.id) else favs.remove(ch.id)
                        scope.launch {
                            val ok = runCatching { Api.requestPublic("/api/iptv/favorites/${ch.id}", "PUT", emptyMap(), buildJsonObject { put("on", JsonPrimitive(on)) }) }.isSuccess
                            if (!ok) { if (on) favs.remove(ch.id) else favs.add(ch.id) }
                        }
                    }) { Icon(Icons.Filled.Star, null, tint = if (fav) Color(0xFFFFC94A) else Color.Gray); Text(if (fav) " Ta bort från favoriter" else " Lägg till i favoriter") }
                }
            },
            confirmButton = { TextButton(onClick = { selected = null }) { Text("Stäng") } })
    }
}

/** En kanalrad: kanalen till vänster, programmen i fönstret (bredd efter längd) till höger */
@Composable
private fun GuideRow(ch: IptvChannel, fav: Boolean, progs: List<IptvProg>?, from: Long, to: Long, chanW: Dp, gridW: Dp, perMin: Float,
                     pending: Pair<Int, String>?, onPending: (Pair<Int, String>?) -> Unit, onShift: (Long) -> Unit,
                     onChannel: () -> Unit, onProgram: (IptvProg?) -> Unit) {
    val now = nowSec()
    val tok = Api.imageToken.collectAsState().value
    Row(Modifier.height(60.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.width(chanW).fillMaxHeight().clip(RoundedCornerShape(8.dp)).focusRing(RoundedCornerShape(8.dp)).background(Surface2)
            .clickable(onClick = onChannel).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(44.dp, 32.dp), contentAlignment = Alignment.Center) {
                Text(ch.number ?: "", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                if (ch.logo && tok != null) AsyncImage(Api.url("/api/live/logo/${ch.id}", mapOf("t" to tok)), null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
            }
            Spacer(Modifier.width(6.dp))
            Text(ch.name, maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 14.sp, modifier = Modifier.weight(1f))
            if (fav) Icon(Icons.Filled.Star, "Favorit", tint = Color(0xFFFFC94A), modifier = Modifier.size(16.dp))
        }
        Spacer(Modifier.width(8.dp))
        Box(Modifier.width(gridW).fillMaxHeight()) {
            val vis: List<IptvProg> = (progs ?: emptyList()).filter { p -> p.stop > from && p.start < to }
            if (progs != null && vis.isEmpty()) {
                Box(Modifier.fillMaxSize().clip(RoundedCornerShape(6.dp)).focusRing(RoundedCornerShape(6.dp)).background(Surface2.copy(alpha = 0.5f))
                    .clickable { onProgram(null) }.padding(horizontal = 10.dp), contentAlignment = Alignment.CenterStart) {
                    Text("Ingen tablå", color = Color.Gray, fontSize = 13.sp)
                }
            }
            vis.forEachIndexed { i, p ->
                key(p.id) {
                    val s: Long = maxOf(p.start, from)
                    val e: Long = minOf(p.stop, to)
                    val x: Float = ((s - from) / 60f) * perMin
                    val w: Float = (((e - s) / 60f) * perMin - 3f).coerceAtLeast(6f)
                    val live = p.start <= now && p.stop > now
                    val fr = remember { FocusRequester() }
                    val edge: String? = if (i == vis.lastIndex) "last" else if (i == 0) "first" else null
                    val want = pending != null && pending.first == ch.id && (pending.second == edge || (vis.size == 1 && pending.second != null))
                    if (want) LaunchedEffect(from) { runCatching { fr.requestFocus() }; onPending(null) }
                    Column(Modifier.offset(x = x.dp).width(w.dp).fillMaxHeight().clip(RoundedCornerShape(6.dp)).focusRequester(fr)
                        .focusRing(RoundedCornerShape(6.dp))
                        .background(if (live) Color(0xFF2B3247) else if (p.stop <= now) Surface2.copy(alpha = 0.6f) else Surface2)
                        .onPreviewKeyEvent { ev ->
                            if (ev.type != KeyEventType.KeyDown) false
                            else if (ev.key == Key.DirectionRight && i == vis.lastIndex && p.stop > to) { onPending(ch.id to "first"); onShift(3600L); true }
                            else if (ev.key == Key.DirectionLeft && i == 0 && p.start < from) { onPending(ch.id to "last"); onShift(-3600L); true }
                            else false
                        }
                        .clickable { onProgram(p) }.padding(horizontal = 8.dp, vertical = 6.dp)) {
                        Text(p.title, fontWeight = if (live) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp)
                        Text(clock(p.start) + (if (p.catchup == true) "  ⟲" else ""), color = Color.Gray, fontSize = 12.sp, maxLines = 1)
                    }
                }
            }
        }
    }
}

// ---------- IPTV-filmer och serier (Xtream) ----------

@Composable
private fun VodPoster(c: VodCard, onClick: () -> Unit) {
    val tok = Api.imageToken.collectAsState().value
    Column(Modifier.width(150.dp).clip(RoundedCornerShape(10.dp)).focusRing().clickable(onClick = onClick)) {
        Box(Modifier.size(150.dp, 225.dp).clip(RoundedCornerShape(10.dp)).background(
            Brush.linearGradient(listOf(Color.hsv(hue(c.name), 0.5f, 0.4f), Color.hsv(hue(c.name), 0.6f, 0.18f))))) {
            Text(c.name, Modifier.align(Alignment.Center).padding(8.dp), fontWeight = FontWeight.Bold, maxLines = 4, overflow = TextOverflow.Ellipsis)
            if (c.cover && tok != null) AsyncImage(Api.url("/api/iptv/vod/${c.id}/cover.jpg", mapOf("t" to tok)), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            val pr = c.progress
            val d = pr?.duration
            if (pr != null && d != null && d > 0 && !pr.watched) {
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(5.dp).background(Color.Black.copy(alpha = 0.5f)))
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth((pr.position / d).toFloat().coerceIn(0f, 1f)).height(5.dp).background(Accent))
            }
        }
        Text(c.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
        Text(listOfNotNull(c.year?.toString(), c.rating?.let { r -> "★ %.1f".format(r) }).joinToString(" · "), color = Color.Gray, fontSize = 13.sp, maxLines = 1)
    }
}

/** Hyllor: Fortsätt titta, Senast tillagt och de största kategorierna */
@Composable
fun VodShelvesView(kind: String, push: (Screen) -> Unit) {
    var data by remember(kind) { mutableStateOf<VodShelves?>(null) }
    var error by remember(kind) { mutableStateOf<String?>(null) }
    LaunchedEffect(kind) {
        try { data = Api.get<VodShelves>("/api/iptv/vod", mapOf("kind" to kind, "shelves" to "1")) } catch (e: Exception) { error = e.message }
    }
    val d = data ?: run { if (error != null) ErrorText(error ?: "") else Loading(); return }
    if (d.shelves.isEmpty()) { ErrorText(if (kind == "series") "Inga serier från IPTV-källan." else "Inga filmer från IPTV-källan."); return }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
        items(d.shelves) { s ->
            Column(Modifier.padding(vertical = 8.dp)) {
                Text(s.title, fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(vertical = 6.dp))
                LazyRow(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    items(s.items, key = { c -> c.id }) { c -> VodPoster(c) { push(Screen.VodDetail(c.id)) } }
                }
            }
        }
    }
}

/** En IPTV-film (Spela/Fortsätt) eller serie (säsonger och avsnitt) */
@Composable
fun VodDetailScreen(id: Int, push: (Screen) -> Unit) {
    var d by remember(id) { mutableStateOf<VodDetail?>(null) }
    var error by remember(id) { mutableStateOf<String?>(null) }
    LaunchedEffect(id) { try { d = Api.get<VodDetail>("/api/iptv/vod/$id") } catch (e: Exception) { error = e.message } }
    val v = d ?: run { if (error != null) ErrorText(error ?: "") else Loading(); return }
    val seasons: List<Int> = v.episodes.map { e -> e.season ?: 1 }.distinct().sorted()
    var season by remember(v.id) { mutableIntStateOf(seasons.firstOrNull() ?: 1) }
    val tok = Api.imageToken.collectAsState().value
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                Box(Modifier.size(180.dp, 270.dp).clip(RoundedCornerShape(10.dp)).background(Surface2)) {
                    if (v.cover && tok != null) AsyncImage(Api.url("/api/iptv/vod/${v.id}/cover.jpg", mapOf("t" to tok)), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(v.name, fontSize = 28.sp, fontWeight = FontWeight.Bold)
                    Text(listOfNotNull(v.year?.toString(), formatDuration(v.duration).takeIf { s -> s.isNotEmpty() }, v.rating?.let { r -> "★ %.1f".format(r) }, v.genre)
                        .joinToString("  ·  "), color = Color.Gray)
                    v.plot?.let { p -> Text(p, color = Color(0xFFCFD3DD), maxLines = 6, overflow = TextOverflow.Ellipsis) }
                    listOfNotNull(v.director?.let { x -> "Regi: $x" }, v.cast?.let { x -> "Medverkande: $x" }).takeIf { l -> l.isNotEmpty() }?.let { l ->
                        Text(l.joinToString("  ·  "), color = Color.Gray, fontSize = 14.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    }
                    if (v.kind == "movie") {
                        val pos: Double = v.progress?.takeIf { p -> !p.watched }?.position ?: 0.0
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Button(onClick = { push(Screen.Stream("vod", v.id, v.name, if (pos > 30) pos else 0.0)) }, Modifier.height(56.dp)) {
                                Icon(Icons.Filled.PlayArrow, null); Text(if (pos > 30) " Fortsätt ${formatTime(pos)}" else " Spela", fontSize = 17.sp)
                            }
                            if (pos > 30) OutlinedButton(onClick = { push(Screen.Stream("vod", v.id, v.name, 0.0)) }, Modifier.height(56.dp)) { Text("Börja om") }
                        }
                    }
                }
            }
        }
        if (v.kind == "series") {
            if (v.episodes.isEmpty()) item { Text("Inga avsnitt hittades hos leverantören.", color = Color.Gray) }
            item {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(seasons, key = { s -> s }) { s -> FilterChip(selected = s == season, onClick = { season = s }, label = { Text("Säsong $s", fontSize = 16.sp) }, modifier = Modifier.height(44.dp)) }
                }
            }
            items(v.episodes.filter { e -> (e.season ?: 1) == season }, key = { e -> e.id }) { e ->
                val title = listOfNotNull(e.episode?.let { n -> "$n." }, e.title ?: "Avsnitt").joinToString(" ")
                val pos: Double = e.progress?.takeIf { p -> !p.watched }?.position ?: 0.0
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).focusRing().background(Surface2)
                    .clickable { push(Screen.Stream("vodep", e.id, "${v.name} · $title", if (pos > 30) pos else 0.0)) }.padding(12.dp),
                    horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(160.dp, 90.dp).clip(RoundedCornerShape(8.dp)).background(Color(0x22FFFFFF))) {
                        if (e.image && tok != null) AsyncImage(Api.url("/api/iptv/episodes/${e.id}/image.jpg", mapOf("t" to tok)), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    }
                    Column(Modifier.weight(1f)) {
                        Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                        Text(listOfNotNull(formatDuration(e.duration).takeIf { s -> s.isNotEmpty() }, if (e.progress?.watched == true) "Sedd" else if (pos > 30) "Fortsätt ${formatTime(pos)}" else null)
                            .joinToString(" · "), color = Color.Gray, fontSize = 13.sp)
                        e.plot?.let { p -> Text(p, color = Color.Gray, maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 13.sp) }
                    }
                }
            }
        }
    }
}
