package net.braxhn.tv

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URL
import kotlin.concurrent.thread

class BwCoreTest {
    @Test fun materBaraUtanforHemmet() {
        assertTrue(BwCore.away(savedIsLocal = false, viaHome = false, here = false))
        assertTrue("okänt (äldre server, provet inte klart) räknas som utanför", BwCore.away(false, false, null))
        assertFalse("hemadressen används", BwCore.away(false, true, false))
        assertFalse("servern ser förfrågan som hemma", BwCore.away(false, false, true))
        assertFalse("sparad adress i hemnätet", BwCore.away(true, false, null))
    }

    @Test fun taktenRaknasEfterForstaTredjedelen() {
        // 300 ms svarstid innan något kommer, sedan 1 MB på 1 s: 8000 kbit/s – inte (1 MB / 1,3 s)
        val marks = listOf(0L to 0L) + (0..10).map { (300L + it * 100) to (it * 100_000L) }
        assertEquals(8000, BwCore.rateOf(marks))
        assertEquals(0, BwCore.rateOf(listOf(0L to 0L)))
        // allt i en bit: hela provet
        assertEquals(800, BwCore.rateOf(listOf(0L to 0L, 100L to 10_000L)))
    }

    @Test fun provetSlutarEfterMaxMs() {
        var t = 0L
        val data = ByteArrayInputStream(ByteArray(4 * 1024 * 1024))
        // varje läsning tar 10 ms på klockan: 16 KB / 10 ms ≈ 13 Mbit/s
        val k = BwCore.sample(data, { t.also { t += 10 } }, maxMs = 1000)
        assertTrue("läste inte hela provet", data.available() > 0)
        assertEquals(16 * 1024 * 8 / 10, k)
    }

    @Test fun spelarensMatningEfterStorHamtning() {
        assertEquals(5000, BwCore.fromPlayer(512 * 1024, 5_000_000))
        assertEquals(0, BwCore.fromPlayer(10_000, 5_000_000))
        assertEquals(0, BwCore.fromPlayer(512 * 1024, 0))
    }

    @Test fun enMatningGallerITioMinuter() {
        val m = BwCore.Meter()
        assertEquals(0, m.fresh(0))
        m.note(4000, 1_000)
        assertEquals(4000, m.fresh(1_000 + BwCore.FRESH_MS - 1))
        assertEquals(0, m.fresh(1_000 + BwCore.FRESH_MS))
        m.note(0, 2_000) // ingen mätning ersätter inte en riktig
        assertEquals(4000, m.fresh(2_000))
        m.clear()
        assertEquals(0, m.fresh(2_000))
    }

    @Test fun forvarmningenOchUppspelningenSkickarSammaBw() = runBlocking {
        val m = BwCore.Meter(); val pairs = BwCore.Pairs()
        m.note(6000, 0)
        val key = BwCore.pairKey(7, 30.4)
        val warm = BwCore.forWarm(true, pairs.get(key, 0), m.fresh(0))
        assertEquals(6000, warm); pairs.put(key, warm!!, 0)
        // Spelaren mäter under tiden (förra avsnittet spelas): uppspelningen tar ändå förvärmningens värde
        m.note(9000, 5_000)
        assertEquals(6000, BwCore.forPlay(true, pairs.get(BwCore.pairKey(7, 30.0), 10_000), m.fresh(10_000), { 1 }))
        // nästa förvärmning av samma titel ändrar inte frågan (servern behåller strömmen)
        assertEquals(6000, BwCore.forWarm(true, pairs.get(key, 15_000), m.fresh(15_000)))
        // långt senare: den färska mätningen
        assertEquals(9000, BwCore.forPlay(true, pairs.get(key, 40_000), m.fresh(40_000), { 1 }))
    }

    @Test fun hemmaSkickasIngetOchUtanMatningForvarmsInget() = runBlocking {
        assertNull(BwCore.forWarm(false, 5000, 5000))
        assertNull(BwCore.forWarm(true, null, 0))
        var asked = false
        assertNull(BwCore.forPlay(false, null, 0, { asked = true; 5000 }))
        assertFalse("hemma mäts inget", asked)
    }

    @Test fun uppspelningenVantarHogstWaitMs() = runBlocking {
        assertEquals(3000, BwCore.forPlay(true, null, 0, { delay(50); 3000 }, waitMs = 1000))
        val never = CompletableDeferred<Int>()
        val t0 = System.nanoTime()
        assertNull(BwCore.forPlay(true, null, 0, { never.await() }, waitMs = 200))
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 1000)
        assertNull("misslyckad mätning", BwCore.forPlay(true, null, 0, { 0 }, waitMs = 200))
    }

    /**
     * En lokal server som skickar provet med en bestämd takt (som en strypt anslutning) och 150 ms svarstid. Bara
     * java.net (com.sun.net.httpserver finns inte på Androids classpath för enhetstester).
     */
    private fun throttled(kbps: Int, block: (String) -> Unit) {
        val srv = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        val t = thread(isDaemon = true) {
            runCatching {
                srv.accept().use { sock ->
                    // Läs frågan fram till den tomma raden
                    val inp = sock.getInputStream()
                    var tail = 0
                    while (tail != 0x0d0a0d0a) { val b = inp.read(); if (b < 0) break; tail = (tail shl 8) or b }
                    Thread.sleep(150)
                    val total = 4096 * 1024L
                    val out = sock.getOutputStream()
                    out.write("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: $total\r\nConnection: close\r\n\r\n".toByteArray())
                    val chunk = ByteArray(8192)
                    val t0 = System.nanoTime()
                    var sent = 0L
                    while (sent < total) {
                        out.write(chunk); out.flush(); sent += chunk.size
                        val waitMs = sent * 8 / kbps - (System.nanoTime() - t0) / 1_000_000 // ms när så mycket ska ha gått iväg
                        if (waitMs > 0) Thread.sleep(waitMs)
                    }
                }
            }
        }
        try { block("http://127.0.0.1:${srv.localPort}/api/speedtest?kb=4096") } finally { srv.close(); t.join(2000) }
    }

    @Test fun matningMotStryptServerGerDessTakt() {
        for (kbps in listOf(2_000, 5_000, 20_000)) throttled(kbps) { url ->
            val c = URL(url).openConnection() as HttpURLConnection
            val t0 = System.nanoTime()
            val k = try { BwCore.sample(c.inputStream, { System.nanoTime() / 1_000_000 }) } finally { c.disconnect() }
            val ms = (System.nanoTime() - t0) / 1_000_000
            println("strypt till $kbps kbit/s: mätt $k kbit/s på $ms ms")
            assertTrue("$kbps kbit/s mättes som $k", k > kbps * 0.8 && k < kbps * 1.25)
            assertTrue("provet tog $ms ms", ms < 1600)
        }
    }
}
