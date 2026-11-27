package net.braxhn.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.util.Locale

// Feedback och felrapporter (FeedbackCore.kt): förvalet i "Gäller", vad bilen får visa, och den tekniska informationen
// i den form servern tar emot (buildContext i server/support.js). Körs på JVM: gradle testReleaseUnitTest
class FeedbackCoreTest {
    @Test fun omradenaSomServern() {
        // Samma nycklar och ordning som AREAS i server/support.js (och webben)
        assertEquals(listOf("film", "musik", "ljud", "livetv", "uppspelning", "appen", "annat"), FeedbackCore.AREAS)
    }

    @Test fun forvaletFoljerSkarmen() {
        assertEquals("film", FeedbackCore.areaOf("Detail"))
        assertEquals("film", FeedbackCore.areaOf("Lib"))
        assertEquals("film", FeedbackCore.areaOf("VodDetail"))
        assertEquals("uppspelning", FeedbackCore.areaOf("Play"))
        assertEquals("uppspelning", FeedbackCore.areaOf("Stream"))
        assertEquals("livetv", FeedbackCore.areaOf("Live"))
        assertEquals("livetv", FeedbackCore.areaOf("LivePlay"))
        assertEquals("livetv", FeedbackCore.areaOf("Recordings"))
        assertEquals("appen", FeedbackCore.areaOf("Home"))
        // Inställningar, profiler och feedbackens egna skärmar ändrar inte förvalet
        for (s in listOf("Settings", "Profiles", "SendFeedback", "Tickets", "")) assertNull(s, FeedbackCore.areaOf(s))
        assertTrue(FeedbackCore.AREAS.containsAll(listOf("Detail", "Play", "Live", "Home").mapNotNull { FeedbackCore.areaOf(it) }))
    }

    @Test fun bilenFarBaraLasa() {
        assertEquals(FeedbackCore.Mode.READ_ONLY, FeedbackCore.mode(car = true))
        assertEquals(FeedbackCore.Mode.FULL, FeedbackCore.mode(car = false))
    }

    @Test fun felNyligenGerFelrapport() {
        val now = 1_800_000_000_000L
        assertEquals("idea", FeedbackCore.defaultKind(0, now))
        assertEquals("bug", FeedbackCore.defaultKind(now - 60_000, now))
        assertEquals("bug", FeedbackCore.defaultKind(now - FeedbackCore.ERROR_FRESH_MS + 1, now))
        assertEquals("idea", FeedbackCore.defaultKind(now - FeedbackCore.ERROR_FRESH_MS, now))
        assertEquals("idea", FeedbackCore.defaultKind(now + 5_000, now)) // klockan ställd bakåt: inget gammalt fel räknas
    }

    @Test fun plattformOchSkarmISammaFormSomServern() {
        assertEquals("Android 14 (API 34) · TV · Chromecast HD", FeedbackCore.platform("14", 34, "TV", "Chromecast HD"))
        assertEquals("Android 12 (API 31) · car", FeedbackCore.platform("12", 31, FeedbackCore.deviceKind(car = true, tv = false), null))
        assertEquals("phone", FeedbackCore.deviceKind(car = false, tv = false))
        assertEquals("TV", FeedbackCore.deviceKind(car = false, tv = true))
        assertEquals(120, FeedbackCore.platform("14", 34, "phone", "x".repeat(300)).length) // serverns gräns
        // Servern: /^\d{2,5}×\d{2,5}( @[\d.]{1,4})?$/
        val re = Regex("""^\d{2,5}×\d{2,5}( @[\d.]{1,4})?$""")
        assertEquals("1920×1080", FeedbackCore.screen(1920, 1080, 1f))
        assertEquals("1080×2400 @2.6", FeedbackCore.screen(1080, 2400, 2.625f))
        assertEquals("1440×3120 @3.5", FeedbackCore.screen(1440, 3120, 3.5f))
        assertEquals("1280×720 @2", FeedbackCore.screen(1280, 720, 2f))
        for (s in listOf(FeedbackCore.screen(1920, 1080, 1f), FeedbackCore.screen(1080, 2400, 2.625f), FeedbackCore.screen(800, 480, 1.33f))) assertTrue(s, re.matches(s))
    }

    @Test fun tiderSomWebben() {
        assertEquals("0:00", FeedbackCore.duration(0.0))
        assertEquals("1:05", FeedbackCore.duration(65.4))
        assertEquals("125:00", FeedbackCore.duration(7500.0))
        // 1 november 2026 13:05 UTC = 14:05 i Stockholm (vintertid)
        assertEquals("1 Nov 14:05", FeedbackCore.date(1_793_538_300L, ZoneId.of("Europe/Stockholm"), Locale.ENGLISH))
    }
}
