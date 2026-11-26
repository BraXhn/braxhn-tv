package net.braxhn.tv

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.Collections

// Valet av hemadress (LocalPick.kt): samma regler som Expo-appen (test/local-home.test.js provar dess localpick.ts).
// Körs på JVM utan Android: gradle testReleaseUnitTest
class LocalPickTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    @After fun done() { scope.cancel() }

    private val home = "http://192.168.1.10:8420"
    private val info = LocalInfo(id = "abc123", addrs = listOf(home), n = "1790000000.0123456789abcdef0123456789abcdef", proof = "p".repeat(64))
    private val right = LocalPing(id = info.id, proof = info.proof)

    @Test fun adressenAnvandsNarIdOchProofStammer() = runBlocking {
        val asked = Collections.synchronizedList(mutableListOf<String>())
        val hit = LocalPick.pick(info, scope) { url, ms -> asked += url; assertEquals(LocalPick.PROBE_MS, ms); right }
        assertEquals(home, hit)
        assertEquals(listOf("$home/api/local/ping?n=1790000000.0123456789abcdef0123456789abcdef"), asked)
    }

    @Test fun felIdGerIngenAdress() = runBlocking {
        assertNull(LocalPick.pick(info, scope) { _, _ -> LocalPing(id = "annan", proof = info.proof) })
    }

    @Test fun felProofGerIngenAdress() = runBlocking {
        assertNull(LocalPick.pick(info, scope) { _, _ -> LocalPing(id = info.id, proof = "q".repeat(64)) })
        assertNull(LocalPick.pick(info, scope) { _, _ -> LocalPing(id = info.id, proof = "") })
    }

    @Test fun tomtSvarFranServernProvarIngenting() = runBlocking {
        var calls = 0
        val get: suspend (String, Int) -> LocalPing? = { _, _ -> calls++; right }
        assertNull(LocalPick.pick(info.copy(id = ""), scope, get = get))
        assertNull(LocalPick.pick(info.copy(proof = ""), scope, get = get))
        assertNull(LocalPick.pick(info.copy(n = ""), scope, get = get))
        assertNull(LocalPick.pick(info.copy(addrs = emptyList()), scope, get = get))
        assertNull(LocalPick.pick(null, scope, get = get))
        // Redan på hemnätet med den sparade adressen: inget att prova
        assertNull(LocalPick.pick(info.copy(here = true), scope, get = get))
        assertEquals(0, calls)
    }

    @Test fun ingetSvarITidGerDenSparade() = runBlocking {
        val t0 = System.nanoTime()
        val hit = LocalPick.pick(info, scope, ms = 200) { _, _ -> delay(5_000); right }
        val ms = (System.nanoTime() - t0) / 1_000_000
        assertNull(hit)
        assertTrue("väntade $ms ms", ms < 1_000)
    }

    @Test fun natverksfelGerDenSparade() = runBlocking {
        assertNull(LocalPick.pick(info, scope) { _, _ -> throw IOException("ingen väg") })
        assertNull(LocalPick.pick(info, scope) { _, _ -> null })
    }

    @Test fun alltProvasSamtidigtOchDenSomSvararRattVinner() = runBlocking {
        val other = "http://10.0.0.5:8420"
        val i = info.copy(addrs = listOf(home, other, "http://192.168.1.11:8420"))
        val hit = LocalPick.pick(i, scope) { url, _ ->
            when {
                url.startsWith(home) -> { delay(600); right }                 // rätt men långsam
                url.startsWith(other) -> { delay(50); right }                 // rätt och snabb
                else -> throw IOException("svarar inte")
            }
        }
        assertEquals(other, hit)
        // Den enda som svarar rätt kommer efter att de andra misslyckats
        val hit2 = LocalPick.pick(i, scope) { url, _ -> if (url.startsWith(other)) { delay(100); right } else LocalPing("annan", "x") }
        assertEquals(other, hit2)
    }

    @Test fun baraOriginOchHttpBaraIHemnatet() {
        val i = info.copy(addrs = listOf(
            "http://192.168.1.10:8420", "http://192.168.1.10:8420", // dubblett
            "http://192.168.1.10:8420/api", "http://user:pw@192.168.1.10:8420", "ftp://192.168.1.10", "javascript:alert(1)",
            "http://min.doman.se:8420",                              // publik värd med http: aldrig
            "http://127.0.0.1:8420", "http://localhost:8420",        // enheten själv
            "https://hemma.doman.se",                                // https: certifikatet kontrolleras
            "http://nas.local:8420", "http://tv:8420", "http://172.20.0.2:8420"))
        assertEquals(listOf("http://192.168.1.10:8420", "https://hemma.doman.se", "http://nas.local:8420", "http://tv:8420"), LocalPick.candidates(i))
    }

    @Test fun sparadeAdresserIHemnatetProvasInte() {
        assertTrue(LocalPick.isLocalUrl("http://192.168.1.10:8420"))
        assertTrue(LocalPick.isLocalUrl("http://10.0.0.2:8420"))
        assertTrue(LocalPick.isLocalUrl("http://172.16.5.5:8420"))
        assertTrue(LocalPick.isLocalUrl("http://nas.local:8420"))
        assertTrue(LocalPick.isLocalUrl("http://server:8420"))
        assertFalse(LocalPick.isLocalUrl("https://tv.braxhn.net"))
        assertFalse(LocalPick.isLocalUrl("http://172.32.0.1:8420"))
        assertFalse(LocalPick.isLocalUrl("https://81.10.20.30"))
        assertFalse(LocalPick.isLocalUrl("inte en adress"))
    }

    @Test fun gamlaHemadresserSkrivsOm() {
        val saved = "https://abc.relay.braxhn.net"
        val proven = listOf(home)
        // Hemadressen gäller inte längre: allt som byggts med den går till den sparade
        assertEquals("$saved/api/hls/5/seg1.ts?st=x", LocalPick.rewrite("$home/api/hls/5/seg1.ts?st=x", proven, saved))
        assertEquals(saved, LocalPick.rewrite(home, proven, saved))
        // Hemadressen gäller: ingenting ändras
        assertEquals("$home/api/x", LocalPick.rewrite("$home/api/x", proven, home))
        // En annan värd som bara börjar likadant (port 84201) och andra adresser lämnas
        assertEquals("${home}1/api/x", LocalPick.rewrite("${home}1/api/x", proven, saved))
        assertEquals("$saved/api/x", LocalPick.rewrite("$saved/api/x", proven, saved))
        // Ingen adress vald (utloggad): lämnas
        assertEquals("$home/api/x", LocalPick.rewrite("$home/api/x", proven, ""))
    }
}
