package net.braxhn.tv

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import coil.Coil
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.intercept.Interceptor
import coil.request.ErrorResult
import coil.request.ImageResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

// Hemma via den publika adressen: när appen är sparad med en publik adress (BraXhn Relay, en domän via routern) och
// står på hemnätet går den direkt till serverns hemadress – API, strömmar (Media3) och bilder (Coil). Då kommer
// förfrågningarna från hemnätet, servern räknar uppspelningen som hemma (remote: false) och reläet slipper trafiken.
// Valet av adress står i LocalPick.kt; här bestäms när provet görs och vad som händer när hemadressen slutar svara.
//
// - Api.saved är adressen användaren sparade och ändras aldrig härifrån. Api.server är adressen som används just nu:
//   den sparade, eller en hemadress som svarat rätt på provet (id och proof exakt som i /api/local).
// - Provet görs när en server öppnas (start med sparad inloggning, inloggning), när appen kommer tillbaka till
//   förgrunden (högst var 30:e sekund) och när nätet byts (ConnectivityManager). Det körs i bakgrunden: tills det är
//   klart används den sparade adressen, så startsidan väntar inte.
// - Nätverksfel mot hemadressen (t.ex. utanför hemmet nu): tillbaka till den sparade adressen och ett nytt försök
//   (Api.request, spelarna via dataSource(), bilderna via images).
//
// SÄKERHET: hemadressen är oftast http. Inloggningen (Authorization) och bildtoken skickas bara till Api.server, och
// Api.server blir en hemadress först när den bevisat att den är just den här servern på hemnätet. Pingen skickas utan
// inloggning och följer inga omdirigeringar. En gammal hemadress som inte längre är bekräftad (annat nät) skrivs om
// till den adress som gäller innan något skickas – även i spellistor och bildadresser som redan byggts.

object Home {
    /** Hemadressen som används just nu (visas i Inställningar), annars null */
    val via = MutableStateFlow<String?>(null)

    /** Hemadresser som bekräftats under körningen – adresser som börjar så skrivs om när de inte längre gäller */
    private val proven: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val gen = AtomicInteger()
    @Volatile private var lastCheck = 0L
    /** Nätet som hemadressen bekräftades på: byts nätet gäller beviset inte längre */
    @Volatile private var homeNet: Network? = null
    private var cm: ConnectivityManager? = null

    /** Anropas en gång från App.onCreate (även när bara musiktjänsten körs, t.ex. i bilen) */
    fun init(c: Context) {
        // Bilderna (AsyncImage) går genom images – samma standardinställningar som Coils egen ImageLoader
        val app = c.applicationContext
        Coil.setImageLoader(object : ImageLoaderFactory {
            override fun newImageLoader(): ImageLoader = ImageLoader.Builder(app).components { add(images) }.build()
        })
        val m = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        cm = m
        runCatching {
            m.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    Bandwidth.reset() // uppkopplingen mättes på ett annat nät
                    if (via.value != null && network != homeNet) leave()
                    check(force = true)
                }
                override fun onLost(network: Network) {
                    if (network == homeNet) leave()
                }
            })
        }
    }

    /** Gör provet i bakgrunden. Utan force högst var 30:e sekund (appen tillbaka i förgrunden). */
    fun check(force: Boolean = false) {
        if (!force && System.currentTimeMillis() - lastCheck < 30_000L) return
        lastCheck = System.currentTimeMillis()
        // Efter provet: utanför hemmet mäts uppkopplingen i bakgrunden (Bandwidth.kt), så att starten inte väntar på den
        Api.appScope.launch { runCatching { checkNow() }; Bandwidth.refresh() }
    }

    /** Byter till serverns hemadress när appen är hemma, annars tillbaka till den sparade. true = hemadressen används. */
    suspend fun checkNow(): Boolean {
        val saved = Api.saved
        val token = Api.token.value
        val g = gen.incrementAndGet()
        lastCheck = System.currentTimeMillis()
        if (saved.isEmpty() || token == null || LocalPick.isLocalUrl(saved)) return false
        val net = cm?.activeNetwork
        val info = try { Api.localInfo(saved) } catch (e: CancellationException) { throw e } catch (e: Exception) { return via.value != null }
        val hit = LocalPick.pick(info, Api.appScope) { url, ms -> ping(url, ms) }
        // Servern, profilen eller ett nyare prov kom emellan: låt det gälla
        if (g != gen.get() || saved != Api.saved || token != Api.token.value) return via.value != null
        Bandwidth.here = info.here // servern ser förfrågan som hemma (då mäts inget)
        if (hit == null || hit == saved || net == null) { leave(); return false }
        proven.add(hit)
        homeNet = net
        Api.server.value = hit
        via.value = hit
        return true
    }

    /** Tillbaka till den sparade adressen. true = hemadressen användes. */
    fun leave(): Boolean {
        val was = via.value != null
        via.value = null
        homeNet = null
        if (was) Api.server.value = Api.saved
        return was
    }

    /** Ny server eller utloggning: glöm hemadressen och avbryt prov som pågår */
    fun reset() {
        gen.incrementAndGet()
        Bandwidth.reset()
        via.value = null
        homeNet = null
    }

    /** Ett nätverksfel mot base: var det hemadressen gås det tillbaka till den sparade. true = försök igen. */
    fun failed(base: String): Boolean = base.isNotEmpty() && base == via.value && leave()

    /**
     * En adress som byggts med en hemadress som inte längre används skrivs om till adressen som gäller nu (den sparade
     * eller en ny hemadress). Allt annat lämnas som det är.
     */
    fun rewrite(url: String): String = LocalPick.rewrite(url, proven, base())

    /**
     * Adressen att använda nu. Har nätet bytts sedan hemadressen bekräftades gäller den inte längre – kontrolleras före
     * varje förfrågan, så att inget skickas till samma IP-adress på ett annat nät innan nätbytet hunnit anmälas.
     */
    fun base(): String {
        if (via.value != null && cm?.activeNetwork != homeNet) leave()
        return Api.server.value
    }

    /** Började adressen med hemadressen som används nu? */
    private fun onHome(url: String): Boolean { val h = via.value ?: return false; return url == h || url.startsWith("$h/") }

    /** Provanropet: utan inloggning, utan omdirigeringar, med kort tidsgräns */
    private suspend fun ping(url: String, ms: Int): LocalPing? = withContext(Dispatchers.IO) {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = ms; c.readTimeout = ms
            c.instanceFollowRedirects = false
            c.useCaches = false
            c.setRequestProperty("Accept", "application/json")
            if (c.responseCode != 200) return@withContext null
            val text = c.inputStream.bufferedReader().use { it.readText() }
            if (text.length > 4096) null else Api.json.decodeFromString<LocalPing>(text)
        } finally { c.disconnect() }
    }

    /**
     * Strömmarna (Media3): adressen skrivs om vid varje anrop, och ett nätverksfel mot hemadressen går tillbaka till den
     * sparade – spelarens egna nya försök (segment, nästa del av filen) går då dit.
     */
    @OptIn(UnstableApi::class)
    fun dataSource(upstream: DataSource.Factory): DataSource.Factory {
        val resolved = ResolvingDataSource.Factory(upstream) { spec ->
            val s = spec.uri.toString()
            val r = rewrite(s)
            if (r == s) spec else spec.withUri(Uri.parse(r))
        }
        return DataSource.Factory { HomeDataSource(resolved.createDataSource()) }
    }

    @OptIn(UnstableApi::class)
    private class HomeDataSource(private val inner: DataSource) : DataSource by inner {
        override fun open(dataSpec: DataSpec): Long {
            val before = rewrite(dataSpec.uri.toString())
            try { return inner.open(dataSpec) }
            catch (e: IOException) {
                // Ett svar från servern (t.ex. 404) är inget nätverksfel – bara när förbindelsen inte gick
                if (e !is HttpDataSource.InvalidResponseCodeException && onHome(before)) leave()
                throw e
            }
        }
    }

    /** Bilderna (Coil): samma omskrivning som strömmarna, ett nytt försök via den sparade adressen vid nätverksfel och
     *  en kontroll av bildtoken när en bild inte går att ladda (Api.imageFailed) */
    val images = object : Interceptor {
        override suspend fun intercept(chain: Interceptor.Chain): ImageResult {
            val req = chain.request
            val data = req.data as? String ?: return chain.proceed(req)
            val url = rewrite(data)
            val res = chain.proceed(if (url == data) req else req.newBuilder().data(url).build())
            if (res is ErrorResult && res.throwable is IOException && onHome(url) && leave()) {
                return chain.proceed(req.newBuilder().data(rewrite(url)).build())
            }
            // Kan vara bildtoken som inte gäller längre (401): Api frågar servern och hämtar då en ny
            if (res is ErrorResult) Api.imageFailed(url)
            return res
        }
    }
}
