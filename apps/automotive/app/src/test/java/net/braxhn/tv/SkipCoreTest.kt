package net.braxhn.tv

import net.braxhn.tv.SkipCore.EndAction
import net.braxhn.tv.SkipCore.Kind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Sammanfattning, intro, eftertexter och nästa avsnitt (SkipCore.kt): samma fall som Expo-appen och webben
// (test/expo-skip.test.js, skipcore.ts och autoskip.js), plus vad Android-spelaren gör i slutet (atEnd).
// Körs på JVM utan Android: gradle testReleaseUnitTest
class SkipCoreTest {
    private val m = SkipCore.Marks(
        recap = SkipCore.Part(0.0, 40.0), intro = SkipCore.Part(30.0, 90.0), credits = 1300.0,
        auto = setOf(Kind.RECAP, Kind.INTRO)
    )
    private fun plan(kind: Kind, to: Double?, auto: Boolean) = SkipCore.Plan(kind, to, auto)

    @Test fun skipPlanRattDelVidRattTid() {
        assertEquals(plan(Kind.RECAP, 40.0, true), SkipCore.plan(m, 5.0, false))
        assertEquals("överlapp: sammanfattningen först", plan(Kind.RECAP, 40.0, true), SkipCore.plan(m, 35.0, false))
        assertEquals("sista sekunden av sammanfattningen", plan(Kind.INTRO, 90.0, true), SkipCore.plan(m, 39.5, false))
        assertNull("sista sekunden av introt: ingen knapp", SkipCore.plan(m, 89.2, false))
        assertNull(SkipCore.plan(m, 500.0, false))
        assertNull("eftertexter utan nästa avsnitt", SkipCore.plan(m, 1310.0, false))
        assertEquals(plan(Kind.CREDITS, null, false), SkipCore.plan(m, 1310.0, true))
        assertNull("efter en minut försvinner knappen", SkipCore.plan(m, 1360.0, true))
        assertNull(SkipCore.plan(null, 5.0, false))
        assertNull(SkipCore.plan(m, Double.NaN, false))
        assertFalse("äldre server: bara knappen", SkipCore.plan(m.copy(auto = emptySet()), 5.0, false)!!.auto)
        assertNull("eftertexter vid 0 = okänt", SkipCore.plan(SkipCore.Marks(credits = 0.0), 0.0, true))
    }

    @Test fun avbrutenDelHoppasInteOverIgen() {
        val done = setOf(Kind.RECAP)
        assertEquals("knappen finns kvar", plan(Kind.RECAP, 40.0, false), SkipCore.plan(m, 5.0, false, done))
        assertTrue("introt gäller fortfarande", SkipCore.plan(m, 50.0, false, done)!!.auto)
    }

    @Test fun eftertexternaFoervarmerNastaAvsnitt() {
        assertTrue(SkipCore.warmsNext(SkipCore.plan(m, 1301.0, true)))
        assertFalse(SkipCore.warmsNext(SkipCore.plan(m, 50.0, true)))
        assertFalse(SkipCore.warmsNext(null))
        val c = SkipCore.Marks(credits = 100.0, auto = setOf(Kind.CREDITS))
        assertEquals("eftertexter med autoSkip: till nästa avsnitt av sig självt", plan(Kind.CREDITS, null, true), SkipCore.plan(c, 120.0, true))
        assertEquals(plan(Kind.CREDITS, null, false), SkipCore.plan(c, 120.0, true, setOf(Kind.CREDITS)))
    }

    @Test fun nextPlanKontotsValGranserOchAldreServer() {
        assertNull(SkipCore.next(true, true, "10", false))
        assertEquals(SkipCore.Next(true, 10), SkipCore.next(true, true, "10", true))
        assertEquals(SkipCore.Next(false, 10), SkipCore.next(true, false, "10", true))
        assertEquals(SkipCore.Next(true, 0), SkipCore.next(true, true, "0", true))
        assertEquals(SkipCore.Next(true, 60), SkipCore.next(true, true, "600", true))
        assertEquals(SkipCore.Next(true, 8), SkipCore.next(true, true, "x", true))
        assertEquals("utan autoNext: 8 s som förut", SkipCore.Next(true, 8), SkipCore.next(false, null, null, true))
        assertEquals(3, SkipCore.SKIP_DELAY)
        // webbens övriga fall (samma svar som webbspelaren)
        assertEquals(SkipCore.Next(false, 3), SkipCore.next(true, false, "3", true))
        assertEquals(SkipCore.Next(true, 0), SkipCore.next(true, true, "-4", true))
        assertEquals(SkipCore.Next(true, 12), SkipCore.next(true, true, "12", true))
        assertEquals("tal med decimaler som parseInt", SkipCore.Next(true, 12), SkipCore.next(true, true, "12.7", true))
        assertEquals("enabled saknas = av", SkipCore.Next(false, 8), SkipCore.next(true, null, null, true))
        assertEquals(SkipCore.Next(true, 60), SkipCore.next(true, true, "99999999999999999999", true))
    }

    @Test fun slutetIAndroidSpelaren() {
        // Av: spelaren stängs (föräldern som stängt av ska inte få nästa avsnitt, varken med eller utan kort)
        assertEquals(EndAction.CLOSE, SkipCore.atEnd(SkipCore.next(true, false, "10", true), car = false).action)
        assertEquals(EndAction.CLOSE, SkipCore.atEnd(SkipCore.next(true, false, "10", true), car = true).action)
        assertEquals("inget nästa avsnitt", EndAction.CLOSE, SkipCore.atEnd(SkipCore.next(true, true, "10", false), car = false).action)
        // På: nedräkningen följer countdown
        assertEquals(SkipCore.End(EndAction.CARD, 10), SkipCore.atEnd(SkipCore.next(true, true, "10", true), car = false))
        assertEquals(SkipCore.End(EndAction.CARD, 25), SkipCore.atEnd(SkipCore.next(true, true, "25", true), car = false))
        assertEquals("0 s = direkt", EndAction.PLAY_NEXT, SkipCore.atEnd(SkipCore.next(true, true, "0", true), car = false).action)
        assertEquals("äldre server: kortet med 8 s", SkipCore.End(EndAction.CARD, 8), SkipCore.atEnd(SkipCore.next(false, null, null, true), car = false))
        // Bilen: inget kort, nästa avsnitt direkt när valet är på
        assertEquals(EndAction.PLAY_NEXT, SkipCore.atEnd(SkipCore.next(true, true, "10", true), car = true).action)
    }
}
