package net.braxhn.tv

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class StartCoreTest {
    private val caps = mapOf("c" to "mp4,mkv,webm", "v" to "h264,hevc", "a" to "aac", "atrack" to "1", "q" to null, "audio" to "2", "sub" to null, "hdr" to "0")

    @Test fun bioLageOchStartposition() {
        assertEquals(mapOf("cinema" to "1", "start" to null), StartCore.playExtras(0.0, false))
        assertEquals(mapOf("cinema" to null, "start" to null), StartCore.playExtras(0.0, true)) // omstart: inga trailers
        assertEquals(mapOf("cinema" to null, "start" to "754"), StartCore.playExtras(754.9, false)) // Fortsätt: hela sekunder
        assertEquals(mapOf("cinema" to "1", "start" to null), StartCore.playExtras(0.6, false)) // under 1 s = från början
    }

    private data class Track(val index: Int, val default: Boolean = false)
    private fun pick(defaultAudio: Int?, tracks: List<Track>?) = StartCore.titleAudio(defaultAudio, tracks, { it.index }, { it.default })

    @Test fun ljudspaaretFoljerProfilensSprak() {
        // Filens förvalda spår är engelskt (1), profilen vill ha svenska (2, defaultAudio i titelns svar)
        val tracks = listOf(Track(1, default = true), Track(2))
        // Felet: förut valdes filens förvalda spår och skickades till /playback som audio=1
        assertEquals(1, (tracks.firstOrNull { it.default } ?: tracks.firstOrNull())?.index)
        assertEquals(2, pick(2, tracks))
        // Utan förval (äldre server) eller med ett förval som inte finns i listan: filens förvalda, annars det första
        assertEquals(1, pick(null, tracks))
        assertEquals(1, pick(7, tracks))
        assertEquals(3, pick(null, listOf(Track(3), Track(4))))
        assertNull(pick(2, emptyList()))
        assertNull(pick(2, null))
    }

    @Test fun forvalOchEgetValIFragan() {
        // Förvalet skickas inte: servern väljer profilens språk, samma ström i förvärmningen och uppspelningen
        assertNull(StartCore.playAudio(2, 2))
        assertNull(StartCore.playAudio(null, null))
        // Ett eget val på titelsidan skickas
        assertEquals(1, StartCore.playAudio(1, 2))
        // Förvärmningen och uppspelningen får samma fråga (samma nyckel) med samma val
        val q = { a: Int? -> caps.minus("audio") + ("audio" to a?.toString()) + StartCore.playExtras(0.0, false) }
        val warm = StartCore.warmQuery(q(StartCore.playAudio(2, 2)))
        assertEquals(StartCore.key(5, q(StartCore.playAudio(2, 2)) + ("warm" to "1")), StartCore.key(5, warm))
        assertFalse(warm.containsKey("audio") && warm["audio"] != null)
    }

    @Test fun forvarmningenSkickarSammaFragaSomUppspelningen() {
        val play = caps + StartCore.playExtras(754.9, false)
        val warm = StartCore.warmQuery(play)
        assertEquals("1", warm["warm"])
        assertEquals(play, warm - "warm") // inget annat skiljer – annars tar servern inte över strömmen
        // Nyckeln: ordningen och null-värden spelar ingen roll, ljudspåret och positionen gör det
        assertEquals(StartCore.key(7, warm), StartCore.key(7, warm.entries.reversed().associate { it.key to it.value } + ("x" to null)))
        assertFalse(StartCore.key(7, warm) == StartCore.key(7, warm + ("audio" to "1")))
        assertFalse(StartCore.key(7, warm) == StartCore.key(7, StartCore.warmQuery(caps + StartCore.playExtras(0.0, false))))
        assertFalse(StartCore.key(7, warm) == StartCore.key(8, warm))
    }

    @Test fun sammaFragaForvarmsHogstVar15eSekund() {
        val log = StartCore.WarmLog()
        assertTrue(log.take("a", 1_000))
        assertFalse(log.take("a", 1_000 + StartCore.REPEAT_MS - 1))
        assertTrue(log.take("b", 1_500)) // annan titel eller position
        assertTrue(log.take("a", 1_000 + StartCore.REPEAT_MS))
    }

    private fun scope() = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Test fun playbackSkickasInnanTitelnsSvarKommit() = runBlocking {
        val itemDone = CompletableDeferred<String>()
        val pbAsked = CompletableDeferred<Unit>()
        val dropped = mutableListOf<String>()
        val r = launch(Dispatchers.Default) {
            val (it, p) = StartCore.together(scope(), { itemDone.await() }, { pbAsked.complete(Unit); "pb" }) { p -> dropped += p }
            assertEquals("titel" to "pb", it to p)
        }
        // /playback är skickat medan titelns svar fortfarande väntar
        withTimeout(2_000) { pbAsked.await() }
        assertFalse(itemDone.isCompleted)
        itemDone.complete("titel")
        withTimeout(2_000) { r.join() }
        assertTrue(dropped.isEmpty())
    }

    @Test fun titelnGickInteAttHamtaStrommenStoppas() = runBlocking {
        val s = scope()
        val dropped = CompletableDeferred<String>()
        try {
            StartCore.together(s, { throw IllegalStateException("404") }, { "pb" }) { p -> dropped.complete(p) }
            fail("felet ska kastas")
        } catch (e: IllegalStateException) { assertEquals("404", e.message) }
        assertEquals("pb", withTimeout(2_000) { dropped.await() })
    }

    @Test fun spelarenStangsMedanFragornaPagarStrommenStoppas() = runBlocking {
        val s = scope()
        val pbGate = CompletableDeferred<Unit>()
        val dropped = CompletableDeferred<String>()
        val j = launch(Dispatchers.Default) {
            StartCore.together(s, { CompletableDeferred<String>().await() }, { pbGate.await(); "pb" }) { p -> dropped.complete(p) }
        }
        kotlinx.coroutines.delay(50)
        j.cancelAndJoin() // spelaren stängs
        pbGate.complete(Unit) // svaret kommer efteråt – strömmen ska ändå stoppas
        assertEquals("pb", withTimeout(2_000) { dropped.await() })
    }

    @Test fun felIPlaybackKastasOchIngetStoppas() = runBlocking {
        var dropped: String? = null
        try {
            StartCore.together(scope(), { "titel" }, { throw IllegalStateException("403") }) { p: String -> dropped = p }
            fail("felet ska kastas")
        } catch (e: IllegalStateException) { assertEquals("403", e.message) }
        kotlinx.coroutines.delay(50)
        assertNull(dropped)
    }
}
