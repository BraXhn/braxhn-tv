package net.braxhn.tv

// Feedback och felrapporter – samma som knappen Feedback i webben (web/js/views/support.js) och Expo-appen: formuläret
// (typ, Gäller, meddelande, teknisk information med förhandsvisning) och Mina ärenden med status, svar och möjlighet att
// svara när teamet ber om mer information. Under Inställningar, och i spelaren när uppspelningen inte gick.
// I bilen bara Mina ärenden att läsa (FeedbackCore.mode) – bilen spärrar dessutom hela appen under körning.
// Anropen: server/routes/support.js. Regler utan Android: FeedbackCore.kt. All text visas som vanlig text.

import android.content.Context
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.time.ZoneId
import java.util.Locale

// ---------- modeller (svaren från /api/support, test/contracts/apps.json) ----------

@Serializable data class FbApp(val name: String? = null, val version: String? = null, val platform: String? = null)
@Serializable data class FbTitle(val id: Int, val name: String, val year: Int? = null, val format: String? = null)
@Serializable data class FbPlayback(val item: Int, val name: String, val format: String? = null, val mode: String? = null, val quality: String? = null,
                                    val position: Double? = null, val duration: Double? = null, val remote: Boolean? = null, val minutesAgo: Int = 0)
@Serializable data class TechContext(val version: String? = null, val page: String? = null, val browser: String? = null, val screen: String? = null,
                                     val lang: String? = null, val app: FbApp? = null, val title: FbTitle? = null, val lastPlayback: FbPlayback? = null,
                                     val pageErrors: List<String> = emptyList())
@Serializable data class TicketMsg(val from: String, val text: String = "", val created: Long = 0, val status: String? = null, val version: String? = null, val pending: Boolean = false)
@Serializable data class Ticket(val id: Int, val kind: String, val area: String, val title: String? = null, val text: String, val sentTitle: String? = null,
                                val sentText: String? = null, val context: TechContext? = null, val status: String, val version: String? = null,
                                val created: Long, val updated: Long = 0, val thread: List<TicketMsg> = emptyList(), val canReply: Boolean = false)
@Serializable data class TicketList(val tickets: List<Ticket>)
@Serializable data class SupportPreview(val context: TechContext)
@Serializable data class SupportSent(val id: Int, val status: String, val message: String? = null)
@Serializable data class SupportCount(val needinfo: Int = 0)

/** Körs appen i en bil (Android Automotive)? */
fun isCar(ctx: Context) = ctx.packageManager.hasSystemFeature("android.hardware.type.automotive")

// ---------- var man är, senaste uppspelningen och anropen ----------

object Feedback {
    @Volatile private var area = "appen"
    @Volatile private var page = "Home"
    @Volatile private var playId = 0
    @Volatile private var playError = ""
    @Volatile private var errorAt = 0L

    /** Navigeringen bytte skärm (AppRoot): namnet på Screen-klassen */
    fun noteScreen(name: String) { FeedbackCore.areaOf(name)?.let { area = it; page = name } }
    /** Spelaren startade en titel (error null) eller visade ett fel */
    fun notePlayback(id: Int, error: String?) {
        playId = id
        if (!error.isNullOrBlank()) { playError = error; errorAt = System.currentTimeMillis() }
    }
    val currentArea: String get() = area
    fun defaultKind() = FeedbackCore.defaultKind(errorAt, System.currentTimeMillis())

    /** Det appen bifogar: namn, version, plattform, sida, skärm, språk, senast spelade titel och senaste felet – inga token eller adresser */
    fun clientContext(ctx: Context, kind: String): JsonObject {
        val version = runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull().orEmpty()
        val dm = ctx.resources.displayMetrics
        val platform = FeedbackCore.platform(Build.VERSION.RELEASE.orEmpty(), Build.VERSION.SDK_INT, FeedbackCore.deviceKind(isCar(ctx), isTv(ctx)), Build.MODEL)
        return buildJsonObject {
            putJsonObject("client") { put("name", "Android"); put("version", version); put("platform", platform) }
            put("route", page)
            put("screen", FeedbackCore.screen(dm.widthPixels, dm.heightPixels, dm.density))
            put("lang", if (Locale.getDefault().language == "sv") "sv" else "en")
            if (playId > 0) put("itemId", playId)
            if (kind == "bug" && defaultKind() == "bug") putJsonArray("errors") { add("Player: $playError") }
        }
    }

    suspend fun preview(ctx: Context, kind: String): TechContext =
        Api.json.decodeFromString<SupportPreview>(Api.post("/api/support/context", buildJsonObject { put("kind", kind); put("context", clientContext(ctx, kind)) })).context
    suspend fun send(ctx: Context, kind: String, area: String, text: String, tech: Boolean): SupportSent =
        Api.json.decodeFromString(Api.post("/api/support", buildJsonObject {
            put("kind", kind); put("area", area); put("text", text); put("tech", tech)
            put("context", if (tech) clientContext(ctx, kind) else JsonNull)
        }))
    suspend fun mine(): List<Ticket> = Api.get<TicketList>("/api/support").tickets
    suspend fun reply(id: Int, text: String) { Api.post("/api/support/$id/reply", buildJsonObject { put("text", text) }) }
    /** Egna ärenden där teamet väntar på svar (0 vid fel) */
    suspend fun needInfo(): Int = runCatching { Api.get<SupportCount>("/api/support/count").needinfo }.getOrDefault(0)
}

/** Felet som text; en server före 1.3.0 har inte feedback (404) */
private fun errText(e: Throwable): String = if ((e as? ApiException)?.code == 404) str(R.string.feedback_old_server) else e.message ?: str(R.string.feedback_failed)

private val AREA_LABELS = listOf(R.string.feedback_area_film, R.string.feedback_area_music, R.string.feedback_area_audio, R.string.feedback_area_live,
    R.string.feedback_area_playback, R.string.feedback_area_app, R.string.feedback_area_other)
@Composable private fun areaLabel(key: String): String = tr(AREA_LABELS.getOrNull(FeedbackCore.AREAS.indexOf(key)) ?: R.string.feedback_area_other)
@Composable private fun kindLabel(kind: String): String = tr(if (kind == "idea") R.string.feedback_kind_idea else R.string.feedback_kind_bug)

/** Statusen som text och färg ("Åtgärdat i version 1.2.3") */
@Composable private fun statusLabel(status: String, version: String?): Pair<String, Color> = when (status) {
    "pending" -> tr(R.string.feedback_status_pending) to Color(0xFFFFC857)
    "approved" -> tr(R.string.feedback_status_approved) to Color(0xFF8FB8FF)
    "working" -> tr(R.string.feedback_status_working) to Color(0xFF8FB8FF)
    "needinfo" -> tr(R.string.feedback_status_needinfo) to Color(0xFFFFC857)
    "fixed" -> (if (version != null) tr(R.string.feedback_status_fixed_in, version) else tr(R.string.feedback_status_fixed)) to Color(0xFF4CC38A)
    "rejected" -> tr(R.string.feedback_status_rejected) to Color(0xFFFF5D6C)
    else -> status to Color.LightGray
}

private fun fmtDate(s: Long) = FeedbackCore.date(s, ZoneId.systemDefault(), Locale.getDefault())

/** Den tekniska informationen som en lista (samma ordning som webben) */
@Composable
private fun ContextList(c: TechContext?) {
    if (c == null) { Text(tr(R.string.feedback_no_context), color = Color.Gray, fontSize = 14.sp); return }
    val rows = mutableListOf<Pair<String, String>>()
    fun add(k: String, v: String?) { if (!v.isNullOrBlank()) rows.add(k to v) }
    add(tr(R.string.feedback_ctx_server), c.version)
    c.app?.let { a -> add(tr(R.string.feedback_ctx_app), listOfNotNull(a.name, a.version, a.platform).filter { it.isNotBlank() }.joinToString(" · ")) }
    add(tr(R.string.feedback_ctx_page), c.page)
    add(tr(R.string.feedback_ctx_browser), c.browser)
    add(tr(R.string.feedback_ctx_screen), c.screen)
    add(tr(R.string.feedback_ctx_lang), c.lang)
    c.title?.let { t -> add(tr(R.string.feedback_ctx_title), "#${t.id} ${t.name}" + (t.year?.let { " ($it)" } ?: "") + (t.format?.let { " – $it" } ?: "")) }
    c.lastPlayback?.let { p ->
        val pos = p.position?.let { FeedbackCore.duration(it) + (p.duration?.let { d -> " / " + FeedbackCore.duration(d) } ?: "") }
        add(tr(R.string.feedback_ctx_playback), listOfNotNull("#${p.item} ${p.name}", p.format, p.mode, p.quality, pos,
            tr(if (p.remote == true) R.string.feedback_away else R.string.feedback_home), tr(R.string.feedback_minutes_ago, p.minutesAgo)).joinToString(" · "))
    }
    for (e in c.pageErrors) add(tr(R.string.feedback_ctx_error), e)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for ((k, v) in rows) Column { Text(k, color = Color.Gray, fontSize = 13.sp); Text(v, fontSize = 15.sp) }
    }
}

// ---------- Inställningar ----------

/** Raden under Inställningar: Skicka feedback och Mina ärenden (i bilen bara Mina ärenden) */
@Composable
fun FeedbackEntry(push: (Screen) -> Unit) {
    val ctx = LocalContext.current
    val mode = remember { FeedbackCore.mode(isCar(ctx)) }
    val admin by Session.admin.collectAsState()
    var waiting by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) { waiting = Feedback.needInfo() }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(tr(if (mode == FeedbackCore.Mode.READ_ONLY) R.string.feedback_car_note else if (admin) R.string.feedback_intro_admin else R.string.feedback_intro), color = Color.Gray)
        if (waiting > 0) Text(plural(R.plurals.feedback_waiting_n, waiting), color = Color(0xFFFFC857))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (mode == FeedbackCore.Mode.FULL) OutlinedButton(onClick = { push(Screen.SendFeedback()) }, modifier = Modifier.height(52.dp).focusRing(RoundedCornerShape(26.dp))) {
                Text(tr(R.string.feedback_send_feedback), fontSize = 17.sp)
            }
            OutlinedButton(onClick = { push(Screen.Tickets) }, modifier = Modifier.height(52.dp).focusRing(RoundedCornerShape(26.dp))) {
                Text(if (waiting > 0) tr(R.string.feedback_my_reports_n, waiting) else tr(R.string.feedback_my_reports), fontSize = 17.sp)
            }
        }
    }
}

// ---------- formuläret ----------

@Composable
fun FeedbackScreen(req: Screen.SendFeedback, onTickets: () -> Unit, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val admin by Session.admin.collectAsState()
    var kind by remember { mutableStateOf(req.kind ?: Feedback.defaultKind()) }
    var area by remember { mutableStateOf(req.area ?: Feedback.currentArea) }
    var text by remember { mutableStateOf("") }
    var tech by remember { mutableStateOf(true) }
    var showCtx by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf<Result<TechContext>?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var sent by remember { mutableStateOf<SupportSent?>(null) }

    // "Visa vad som skickas med": servern svarar med exakt det som skulle sparas (samma funktion som vid Skicka)
    LaunchedEffect(tech, showCtx, kind) {
        if (!tech || !showCtx) return@LaunchedEffect
        preview = null
        preview = runCatching { Feedback.preview(ctx, kind) }
    }

    val done = sent
    if (done != null) {
        val approved = done.status == "approved"
        Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(tr(if (approved) R.string.feedback_thanks_sent else R.string.feedback_thanks_received), fontSize = 26.sp, fontWeight = FontWeight.Bold)
            // Serverns besked på appens språk (servern svarar på svenska)
            Text(tr(if (approved) R.string.feedback_sent_text else R.string.feedback_received_text), fontSize = 17.sp)
            Text(tr(R.string.feedback_reply_where), color = Color.Gray)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = onTickets, modifier = Modifier.height(52.dp).focusRing(RoundedCornerShape(26.dp))) { Text(tr(R.string.feedback_my_reports), fontSize = 17.sp) }
                val fr = remember { FocusRequester() }
                Button(onClick = onClose, modifier = Modifier.height(52.dp).focusRequester(fr).focusRing(RoundedCornerShape(26.dp))) { Text(tr(R.string.feedback_done), fontSize = 17.sp) }
                LaunchedEffect(Unit) { runCatching { fr.requestFocus() } }
            }
        }
        return
    }

    fun send() {
        if (text.isBlank()) { error = str(R.string.feedback_write_message); return }
        busy = true; error = null
        scope.launch {
            runCatching { Feedback.send(ctx, kind, area, text, tech) }.onSuccess { sent = it }.onFailure { error = errText(it) }
            busy = false
        }
    }

    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(bottom = 32.dp)) {
        item { Text(tr(R.string.feedback_title), fontSize = 26.sp, fontWeight = FontWeight.Bold) }
        items(listOf("idea", "bug")) { k ->
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).focusRing(RoundedCornerShape(12.dp)).background(Surface2).clickable { kind = k }.padding(12.dp),
                verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected = kind == k, onClick = { kind = k })
                Spacer(Modifier.width(8.dp))
                Column {
                    Text(kindLabel(k), fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
                    Text(tr(if (k == "idea") R.string.feedback_kind_idea_sub else R.string.feedback_kind_bug_sub), color = Color.Gray, fontSize = 14.sp)
                }
            }
        }
        item { Text(tr(R.string.feedback_applies_to), fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp)) }
        item { FlowRowCompat(FeedbackCore.AREAS.map { it to areaLabel(it) }, area) { area = it } }
        item {
            OutlinedTextField(value = text, onValueChange = { if (it.length <= FeedbackCore.MAX_TEXT) text = it; error = null }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                label = { Text(tr(R.string.feedback_message)) }, placeholder = { Text(tr(R.string.feedback_placeholder)) },
                supportingText = { Text(tr(R.string.feedback_hint)) }, minLines = 4)
        }
        item {
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).focusRing().clickable { tech = !tech }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = tech, onCheckedChange = { tech = it })
                Spacer(Modifier.width(8.dp))
                Text(tr(R.string.feedback_include_tech), fontSize = 16.sp)
            }
        }
        if (tech) {
            item {
                TextButton(onClick = { showCtx = !showCtx }, modifier = Modifier.focusRing(RoundedCornerShape(20.dp))) {
                    Text((if (showCtx) "▾ " else "▸ ") + tr(R.string.feedback_show_included))
                }
            }
            if (showCtx) item {
                val p = preview
                Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Surface2).padding(14.dp)) {
                    when {
                        p == null -> Text(tr(R.string.feedback_loading), color = Color.Gray)
                        p.isFailure -> Text(errText(p.exceptionOrNull()!!), color = Color.Gray)
                        else -> ContextList(p.getOrNull())
                    }
                }
            }
        }
        item { Text(tr(if (admin) R.string.feedback_review_admin else R.string.feedback_review_user) + " " + tr(R.string.feedback_reply_where), color = Color.Gray, fontSize = 14.sp) }
        error?.let { e -> item { Text(e, color = Color(0xFFFF5D6C)) } }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = onTickets, modifier = Modifier.height(52.dp).focusRing(RoundedCornerShape(26.dp))) { Text(tr(R.string.feedback_my_reports), fontSize = 17.sp) }
                Button(onClick = { send() }, enabled = !busy, modifier = Modifier.height(52.dp).focusRing(RoundedCornerShape(26.dp))) {
                    Text(tr(if (busy) R.string.feedback_sending else R.string.feedback_send), fontSize = 17.sp)
                }
            }
        }
    }
}

// ---------- Mina ärenden ----------

@Composable
fun TicketsScreen(onNew: () -> Unit) {
    val ctx = LocalContext.current
    val readOnly = remember { FeedbackCore.mode(isCar(ctx)) == FeedbackCore.Mode.READ_ONLY }
    val admin by Session.admin.collectAsState()
    var list by remember { mutableStateOf<List<Ticket>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(reload) { runCatching { Feedback.mine() }.onSuccess { list = it; error = null }.onFailure { error = errText(it) } }
    val l = list ?: return if (error != null) ErrorRetry(error!!) { error = null; reload++ } else Loading()
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(bottom = 32.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(tr(R.string.feedback_my_reports), fontSize = 26.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                if (!readOnly) Button(onClick = onNew, modifier = Modifier.height(48.dp).focusRing(RoundedCornerShape(24.dp))) { Text(tr(R.string.feedback_new)) }
            }
        }
        item { Text(tr(if (readOnly) R.string.feedback_tickets_car else R.string.feedback_tickets_intro), color = Color.Gray) }
        note?.let { n -> item { Text(n, color = Color(0xFF4CC38A)) } }
        if (l.isEmpty()) item {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Surface2).padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(tr(R.string.feedback_none_yet), fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
                Text(tr(R.string.feedback_none_text), color = Color.Gray)
            }
        }
        items(l, key = { "${it.id}-${it.updated}" }) { k ->
            TicketCard(k, readOnly, admin) { msg -> note = msg; reload++ }
        }
    }
}

@Composable
private fun TicketCard(k: Ticket, readOnly: Boolean, admin: Boolean, onReplied: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var reply by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showCtx by remember { mutableStateOf(false) }
    val repliedText = tr(if (admin) R.string.feedback_reply_sent else R.string.feedback_reply_received)
    val writeReply = tr(R.string.feedback_write_reply)
    val (label, color) = statusLabel(k.status, k.version)
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Surface2).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("#${k.id}", fontWeight = FontWeight.Bold, fontSize = 17.sp)
            Spacer(Modifier.width(10.dp))
            Text(label, color = color, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        }
        Text("${kindLabel(k.kind)} · ${areaLabel(k.area)} · ${fmtDate(k.created)}", color = Color.Gray, fontSize = 14.sp)
        k.title?.let { Text(it, fontWeight = FontWeight.SemiBold, fontSize = 17.sp) }
        Text(k.text, fontSize = 16.sp)
        if (k.sentText != null || k.sentTitle != null) {
            Text(tr(R.string.feedback_admin_edited), color = Color.Gray, fontSize = 13.sp)
            Text(listOfNotNull(k.sentTitle, k.sentText ?: k.text).joinToString("\n"), color = Color.LightGray, fontSize = 15.sp)
        }
        for (m in k.thread) {
            val from = tr(when (m.from) { "team" -> R.string.feedback_from_team; "admin" -> R.string.feedback_from_admin; else -> R.string.feedback_from_you })
            Column(Modifier.fillMaxWidth().padding(top = 4.dp).background(if (m.from == "team") Color(0x22FF6B4A) else Color(0x14FFFFFF), RoundedCornerShape(8.dp)).padding(10.dp)) {
                Text(from + " · " + fmtDate(m.created) + if (m.pending) " · " + tr(R.string.feedback_status_pending) else "", color = Color.Gray, fontSize = 13.sp)
                if (m.status == "reopened") Text(tr(R.string.feedback_reopened), color = Color.Gray, fontSize = 13.sp)
                if (m.text.isNotBlank()) Text(m.text, fontSize = 15.sp)
                else if (m.status != null && m.status != "reopened") Text(statusLabel(m.status, m.version).first, color = Color.Gray, fontSize = 13.sp)
            }
        }
        if (k.canReply && !readOnly) {
            OutlinedTextField(value = reply, onValueChange = { if (it.length <= FeedbackCore.MAX_TEXT) reply = it; error = null }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                label = { Text(tr(R.string.feedback_your_reply)) }, supportingText = { Text(tr(if (admin) R.string.feedback_reply_direct else R.string.feedback_reply_review)) }, minLines = 3)
            error?.let { Text(it, color = Color(0xFFFF5D6C)) }
            Button(onClick = {
                if (reply.isBlank()) { error = writeReply; return@Button }
                busy = true; error = null
                scope.launch {
                    runCatching { Feedback.reply(k.id, reply) }.onSuccess { reply = ""; onReplied(repliedText) }.onFailure { error = errText(it) }
                    busy = false
                }
            }, enabled = !busy, modifier = Modifier.height(48.dp).focusRing(RoundedCornerShape(24.dp))) { Text(tr(if (busy) R.string.feedback_sending else R.string.feedback_send_reply)) }
        } else if (k.canReply) {
            Text(tr(R.string.feedback_reply_elsewhere), color = Color(0xFFFFC857), fontSize = 14.sp)
        }
        TextButton(onClick = { showCtx = !showCtx }, modifier = Modifier.focusRing(RoundedCornerShape(20.dp))) {
            Text((if (showCtx) "▾ " else "▸ ") + tr(R.string.feedback_attached_tech), color = Color.Gray)
        }
        if (showCtx) ContextList(k.context)
    }
}
