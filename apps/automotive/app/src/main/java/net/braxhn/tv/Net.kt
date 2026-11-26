package net.braxhn.tv

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertificateException
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException

// Nätverk, felmeddelanden och inloggningsläge som delas av vyerna. Ligger utanför Api-objektet så att
// radhänvisningarna i test/contracts/apps.json (Api.kt) står kvar.

// ---------- modeller ----------

/** Skärmtiden i svaret på framstegsanropet (barnprofiler med regler): message är serverns förklaring */
@Serializable data class ScreenTimeState(val allowed: Boolean = true, val message: String? = null)
/** POST /api/items/:id/progress – stop = en vuxen/administratören stoppade uppspelningen eller skärmtiden är slut */
@Serializable data class ProgressResult(val watched: Boolean = false, val stop: Boolean = false, val screenTime: ScreenTimeState? = null)

// ---------- inloggningsläget (/api/status) ----------

/** Det appen behöver veta om profilen: barnprofil (inga poddar, rätt text vid Stoppa) och nedladdningsrätt */
object Session {
    val kid = MutableStateFlow(false)
    val canDownload = MutableStateFlow(true)
    /** Stöd projektet: serverns donationslänk (donateUrl i /api/status), bara en https-adress till PayPal – annars null */
    val donateUrl = MutableStateFlow<String?>(null)

    /** Läser /api/status med appens token. Tyst vid fel – det senast kända läget gäller då. */
    suspend fun refresh() {
        if (Api.token.value == null) return
        val st = runCatching { Api.get<ServerStatus>("/api/status") }.getOrNull() ?: return
        donateUrl.value = safeDonateUrl(st.donateUrl)
        val u = st.user ?: return
        kid.value = u.kid
        canDownload.value = u.canDownload
    }

    /** Glöm profilens läge (utloggning, profilbyte) tills nästa refresh() */
    fun reset() { kid.value = false; canDownload.value = true }
}

/** Donationslänken används bara om den är https till paypal.com/paypal.me (inget annat öppnas från serverns fält) */
fun safeDonateUrl(raw: String?): String? {
    val s = raw?.trim()?.takeIf { it.isNotEmpty() && it.length < 500 } ?: return null
    val u = runCatching { Uri.parse(s) }.getOrNull() ?: return null
    if (u.scheme != "https" || !u.userInfo.isNullOrEmpty()) return null
    val host = u.host?.lowercase(Locale.ROOT) ?: return null
    val ok = host == "paypal.com" || host.endsWith(".paypal.com") || host == "paypal.me" || host == "www.paypal.me"
    return if (ok) s else null
}

// ---------- serveradressen ----------

private val IPV4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")
private val HOME_SUFFIX = listOf(".local", ".lan", ".home", ".internal", ".localdomain", ".home.arpa", ".fritz.box")

/** Ett namn som ser ut som en publik domän (t.ex. reläets adress) – inte en IP-adress, ett datornamn eller *.local */
private fun looksPublic(host: String): Boolean {
    val h = host.lowercase(Locale.ROOT)
    if (h.isEmpty() || !h.contains('.') || h.contains(':') || h.startsWith("[")) return false
    if (IPV4.matches(h)) return false
    return HOME_SUFFIX.none { h.endsWith(it) }
}

/**
 * Serveradressen som användaren skrev, som en fullständig adress. Med schema används den som den är (http utan port
 * får 8420). Utan schema: ett domännamn utan port får https (BraXhn Relay eller Let's Encrypt), annars http och 8420.
 */
fun serverAddress(input: String): String {
    var s = input.trim().trimEnd('/')
    val lower = s.lowercase(Locale.ROOT)
    s = when {
        lower.startsWith("https://") -> "https://" + s.substring(8)
        lower.startsWith("http://") -> "http://" + s.substring(7)
        else -> {
            val probe = Uri.parse("http://$s")
            (if (looksPublic(probe.host ?: "") && probe.port == -1) "https://" else "http://") + s
        }
    }
    val u = Uri.parse(s)
    if (u.scheme == "http" && u.port == -1 && !u.encodedAuthority.isNullOrEmpty()) {
        s = u.buildUpon().encodedAuthority(u.encodedAuthority + ":8420").build().toString()
    }
    return s
}

/** Telefonens/TV:ns språk för Accept-Language (serverns felmeddelanden är i dag alltid svenska) */
fun acceptLanguage(): String {
    val tag = runCatching { Locale.getDefault().toLanguageTag() }.getOrNull()
    return if (tag.isNullOrBlank() || tag == "und") "sv" else "$tag, sv;q=0.5"
}

// ---------- begripliga felmeddelanden ----------

/** Text för ett HTTP-fel utan förklaring från servern (t.ex. reläet eller en proxy svarade) */
fun httpErrorText(code: Int): String = when (code) {
    401 -> str(R.string.err_http_401)
    403 -> str(R.string.err_http_403)
    404 -> str(R.string.err_http_404)
    409 -> str(R.string.err_http_409)
    429 -> str(R.string.err_http_429)
    502, 504 -> str(R.string.err_http_502, code)
    503 -> str(R.string.err_http_503)
    507 -> str(R.string.err_http_507)
    else -> str(R.string.err_http_other, code)
}

/** Ett nätverksfel (Javas engelska text) som ett svenskt meddelande */
fun netError(e: IOException): ApiException {
    val msg = when (e) {
        is UnknownHostException -> str(R.string.err_unknown_host)
        is NoRouteToHostException, is ConnectException -> str(R.string.err_connect)
        is SocketTimeoutException -> str(R.string.err_timeout)
        is SSLHandshakeException ->
            if (generateSequence<Throwable>(e) { it.cause }.any { it is CertificateException })
                str(R.string.err_certificate)
            else str(R.string.err_ssl)
        is SSLException -> str(R.string.err_ssl)
        else -> str(R.string.err_network, e.message ?: e.javaClass.simpleName)
    }
    return ApiException(msg)
}

/** Felet från ExoPlayer som text: serverns förklaring (JSON error) om den finns, annars en svensk beskrivning */
@OptIn(UnstableApi::class)
fun playerErrorText(e: PlaybackException): String {
    val chain: List<Throwable> = generateSequence(e.cause) { it.cause }.take(8).toList()
    for (cur in chain) {
        if (cur is HttpDataSource.InvalidResponseCodeException) {
            val code: Int = cur.responseCode
            val body: String? = runCatching { String(cur.responseBody, Charsets.UTF_8) }.getOrNull()
            val msg: String? = body?.let { b -> runCatching { Api.json.parseToJsonElement(b).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull() }
            return msg ?: httpErrorText(code)
        }
        if (cur is UnknownHostException || cur is SSLException || cur is ConnectException || cur is NoRouteToHostException) {
            return netError(cur as IOException).message ?: ""
        }
    }
    return when (e.errorCode) {
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> str(R.string.err_player_timeout)
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED -> str(R.string.err_player_connection)
        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED, PlaybackException.ERROR_CODE_DECODING_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED, PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES ->
            str(R.string.err_player_decode)
        PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED, PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED ->
            str(R.string.err_player_parse)
        else -> str(R.string.err_player_other, e.errorCodeName)
    }
}

// ---------- strömning ----------

object Media {
    /**
     * Tidsgräns för anslutning och läsning av strömmar: en omkodning med grafikkort kan ta ~10 s innan första
     * segmentet finns, och Media3:s standard (8 s) gav då fel och en ny begäran som startade om omkodningen.
     * 60 s som webbspelaren (HLS_VOD.slowPolicy).
     */
    const val TIMEOUT_MS = 60_000

    /** Hemadressen (Hemma.kt): gamla adresser skrivs om, och nätverksfel mot hemadressen går tillbaka till den sparade */
    @OptIn(UnstableApi::class)
    fun http(): androidx.media3.datasource.DataSource.Factory = Home.dataSource(DefaultHttpDataSource.Factory()
        .setAllowCrossProtocolRedirects(true)
        .setUserAgent("BraXhnTV-Android")
        .setConnectTimeoutMs(TIMEOUT_MS)
        .setReadTimeoutMs(TIMEOUT_MS))
}

/**
 * Stopp av en strömning (POST /api/stream/:id/stop utan pid stoppar alla profilens sessioner av titeln). Nästa start
 * av samma titel väntar tills stoppet nått servern – annars kan stoppet komma fram efter den nya starten och döda den.
 */
object StreamGate {
    private val stops = ConcurrentHashMap<Int, Job>()

    fun stop(id: Int) {
        val job = Api.appScope.launch { runCatching { Api.post("/api/stream/$id/stop") } }
        stops[id] = job
        job.invokeOnCompletion { stops.remove(id, job) }
    }

    /** Väntar (högst 10 s) på ett stopp av titeln som ännu inte är klart */
    suspend fun awaitStop(id: Int) {
        val job = stops[id] ?: return
        withTimeoutOrNull(10_000L) { job.join() }
    }
}
