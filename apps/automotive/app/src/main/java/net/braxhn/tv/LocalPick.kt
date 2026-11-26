package net.braxhn.tv

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import java.net.URI
import java.net.URLEncoder
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

// Hemma via den publika adressen (docs/api.md, /api/local): välj serverns adress på hemnätet när den svarar rätt.
// Samma regler som Expo-appen (apps/expo/src/localpick.ts). Inget Android här, så att valet testas på JVM
// (app/src/test/.../LocalPickTest.kt). Hemma.kt sköter när provet görs och vilken adress som används.
//
// Servern ger (över den sparade, inloggade adressen) sina hemadresser och ett prov: n och proof. Hemadressens
// /api/local/ping?n=… svarar med samma id och proof bara när förfrågan kommer från hemnätet. En annan maskin med
// samma IP på ett annat nät kan inte svara rätt, så appen skickar sin inloggning dit först när beviset stämmer.

/** GET /api/local (inloggad, från den sparade adressen) */
@Serializable data class LocalInfo(val id: String = "", val here: Boolean = false, val addrs: List<String> = emptyList(), val n: String = "", val proof: String = "")
/** GET <hemadress>/api/local/ping?n= (utan inloggning, svarar bara på hemnätet) */
@Serializable data class LocalPing(val id: String = "", val proof: String = "")

object LocalPick {
    /** Så länge väntar appen på hemadressen innan den fortsätter med den sparade */
    const val PROBE_MS = 800

    /** Högst så många adresser provas (servern ger högst fyra) */
    const val MAX_ADDRS = 4

    /** Bara origin: http(s)://värd[:port], utan sökväg, frågesträng eller inloggningsuppgifter */
    private val ORIGIN = Regex("^https?://[^/\\s?#@\\\\]+$", RegexOption.IGNORE_CASE)
    private val PRIVATE_V4 = Regex("^(10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|127\\.)\\d{1,3}\\.\\d{1,3}(\\.\\d{1,3})?$")

    /** Är adressen redan en adress i hemnätet (IP i privata nät, .local/.lan/.home eller ett namn utan punkt)? */
    fun isLocalUrl(url: String): Boolean {
        val host = runCatching { URI(url.trim()).host }.getOrNull()?.lowercase(Locale.ROOT)?.trim('[', ']') ?: return false
        if (host.isEmpty()) return false
        if (PRIVATE_V4.matches(host)) return true
        return host == "localhost" || !host.contains('.') || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home")
    }

    /** Enhetens egen adress (127.x, localhost) är aldrig servern */
    private fun isLoopback(url: String): Boolean {
        val host = runCatching { URI(url).host }.getOrNull()?.lowercase(Locale.ROOT) ?: return true
        return host == "localhost" || host.startsWith("127.")
    }

    /**
     * Adresserna ur svaret som får provas: bara origin, inga dubbletter, högst MAX_ADDRS. http bara till adresser i
     * hemnätet (privat IP, .local/.lan/.home, namn utan punkt) – Androids network_security_config kan inte begränsa
     * klartext till IP-intervall, så det görs här. https får vara vilken värd som helst (certifikatet kontrolleras).
     */
    fun candidates(info: LocalInfo): List<String> =
        info.addrs.map { it.trim() }.filter { ORIGIN.matches(it) && !isLoopback(it) }
            .filter { it.startsWith("https://", ignoreCase = true) || isLocalUrl(it) }
            .distinct().take(MAX_ADDRS)

    /** Stämmer svaret från pingen exakt med serverns id och provets bevis? */
    fun matches(info: LocalInfo, r: LocalPing?): Boolean =
        r != null && info.id.isNotEmpty() && info.proof.isNotEmpty() && r.id == info.id && r.proof == info.proof

    /**
     * En adress som byggts med en bekräftad hemadress (proven) som inte används längre får adressen som gäller nu
     * (current: den sparade eller en annan hemadress). Allt annat lämnas som det är.
     */
    fun rewrite(url: String, proven: Collection<String>, current: String): String {
        if (current.isEmpty()) return url
        for (h in proven) {
            if (h == current || h.isEmpty()) continue
            if (url == h || url.startsWith("$h/") || url.startsWith("$h?")) return current + url.substring(h.length)
        }
        return url
    }

    /**
     * Provar alla hemadresser samtidigt. Svaret är den första som svarar med serverns id och rätt bevis inom ms, annars
     * null (servern nås redan hemifrån, inga adresser, fel svar eller inget svar i tid).
     *
     * get hämtar pingen utan inloggning och med tidsgräns (ms); null eller ett undantag = inget svar. Proven körs i
     * scope, så att ett anrop som inte går att avbryta (blockerande nätverk) inte håller kvar den som väntar: svaret
     * kommer senast efter ms + 50.
     */
    suspend fun pick(info: LocalInfo?, scope: CoroutineScope, ms: Int = PROBE_MS, get: suspend (url: String, timeoutMs: Int) -> LocalPing?): String? {
        if (info == null || info.here || info.id.isEmpty() || info.n.isEmpty() || info.proof.isEmpty()) return null
        val addrs = candidates(info)
        if (addrs.isEmpty()) return null
        val q = URLEncoder.encode(info.n, "UTF-8")
        val hit = CompletableDeferred<String?>()
        val left = AtomicInteger(addrs.size)
        for (a in addrs) scope.launch {
            val r = try { get("$a/api/local/ping?n=$q", ms) } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
            if (matches(info, r)) hit.complete(a) else if (left.decrementAndGet() == 0) hit.complete(null)
        }
        return withTimeoutOrNull(ms + 50L) { hit.await() }
    }
}
