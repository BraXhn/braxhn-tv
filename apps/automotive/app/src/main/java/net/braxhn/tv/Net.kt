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
    401 -> "Inloggningen gäller inte längre – logga in igen."
    403 -> "Servern nekade (403)."
    404 -> "Finns inte på servern (404). Servern kan vara äldre än appen."
    409 -> "Upptaget just nu (409) – försök igen om en stund."
    429 -> "För många försök – vänta en stund och försök igen."
    502, 504 -> "Servern svarar inte ($code). Ansluter du via BraXhn Relay kan hemservern vara avstängd eller sakna nät."
    503 -> "Servern är tillfälligt otillgänglig (503) – försök igen om en stund."
    507 -> "Serverns disk är full (507) – säg till den som sköter servern."
    else -> "Servern svarade $code"
}

/** Ett nätverksfel (Javas engelska text) som ett svenskt meddelande */
fun netError(e: IOException): ApiException {
    val msg = when (e) {
        is UnknownHostException -> "Servern hittades inte – kontrollera adressen och att enheten har nät."
        is NoRouteToHostException, is ConnectException -> "Kunde inte ansluta till servern. Är den igång och nås den från det här nätet? Utanför hemmet behövs en https-adress (t.ex. BraXhn Relay)."
        is SocketTimeoutException -> "Servern svarade inte i tid – försök igen."
        is SSLHandshakeException ->
            if (generateSequence<Throwable>(e) { it.cause }.any { it is CertificateException })
                "Serverns certifikat godkänns inte (självsignerat, utgånget eller för en annan adress). Använd http:// i hemnätet, eller ett certifikat från Let's Encrypt eller BraXhn Relay."
            else "Säker anslutning (https) misslyckades. Svarar servern bara på http? Skriv då http:// före adressen."
        is SSLException -> "Säker anslutning (https) misslyckades. Svarar servern bara på http? Skriv då http:// före adressen."
        else -> "Nätverksfel: ${e.message ?: e.javaClass.simpleName}"
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
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "Servern svarade inte i tid. En omkodning kan ta en stund att starta – försök igen."
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED -> "Tappade anslutningen till servern."
        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED, PlaybackException.ERROR_CODE_DECODING_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED, PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES ->
            "Enheten kunde inte avkoda videon. Prova en lägre kvalitet under Inställningar."
        PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED, PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED ->
            "Strömmen från servern gick inte att läsa."
        else -> "Uppspelningen misslyckades (${e.errorCodeName})"
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

    @OptIn(UnstableApi::class)
    fun http(): DefaultHttpDataSource.Factory = DefaultHttpDataSource.Factory()
        .setAllowCrossProtocolRedirects(true)
        .setUserAgent("BraXhnTV-Android")
        .setConnectTimeoutMs(TIMEOUT_MS)
        .setReadTimeoutMs(TIMEOUT_MS)
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
