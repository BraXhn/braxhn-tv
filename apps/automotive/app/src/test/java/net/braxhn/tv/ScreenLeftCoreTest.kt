package net.braxhn.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

// Skärmtiden i spelaren (ScreenLeftCore.kt): samma fall som webbens playerLeft (test/screentime-follows.test.js) och
// Expo-appens (test/expo-screenleft.test.js). Körs på JVM utan Android: gradle testReleaseUnitTest
class ScreenLeftCoreTest {
    private val zone = ZoneId.of("Europe/Stockholm")

    @Test fun somWebben() {
        assertEquals(300.0, ScreenLeftCore.WARN_LEFT, 0.0)
        assertNull("ingen skärmtid", ScreenLeftCore.of(false, true, 720.0))
        assertNull("ingen gräns idag", ScreenLeftCore.of(true, true, null))
        assertNull("slut: spelaren stoppas i stället", ScreenLeftCore.of(true, false, 0.0))
        assertNull(ScreenLeftCore.of(true, true, Double.NaN))
        assertEquals(ScreenLeftCore.Left(12, false), ScreenLeftCore.of(true, true, 720.0))
        assertEquals(ScreenLeftCore.Left(6, false), ScreenLeftCore.of(true, true, 301.0))
        assertEquals(ScreenLeftCore.Left(5, true), ScreenLeftCore.of(true, true, 300.0))
        assertEquals("sista minuten visas som 1 min", ScreenLeftCore.Left(1, true), ScreenLeftCore.of(true, true, 20.0))
        assertEquals(ScreenLeftCore.Left(1, true), ScreenLeftCore.of(true, true, 0.0))
        assertEquals(ScreenLeftCore.Left(1, true), ScreenLeftCore.of(true, true, -5.0))
    }

    @Test fun timmarOchMinuter() {
        val a = ScreenLeftCore.of(true, true, 65 * 60.0)!!
        assertEquals(1, a.hours); assertEquals(5, a.restMinutes)
        val b = ScreenLeftCore.of(true, true, 120 * 60.0)!!
        assertEquals(2, b.hours); assertEquals(0, b.restMinutes)
        val c = ScreenLeftCore.of(true, true, 59 * 60.0 + 1)!!
        assertEquals("60 min blir 1 h 0 min", 1, c.hours); assertEquals(0, c.restMinutes)
        val d = ScreenLeftCore.of(true, true, 45 * 60.0)!!
        assertNull(d.hours); assertEquals(45, d.restMinutes)
    }

    @Test fun serverUtanLeftGerRemaining() {
        assertEquals(ScreenLeftCore.Left(3, true), ScreenLeftCore.ofServer(true, true, 170.0, 1800.0))
        assertEquals("äldre server", ScreenLeftCore.Left(30, false), ScreenLeftCore.ofServer(true, true, null, 1800.0))
        assertNull(ScreenLeftCore.ofServer(true, true, null, null))
    }

    @Test fun utanNatFranAppensRakning() {
        val c = ScreenClock.fresh(ScreenStatus(limited = true, day = "2026-11-28", daily = 30, used = 1500.0, remaining = 300.0))
        val now = ZonedDateTime.of(2026, 11, 28, 10, 0, 0, 0, zone)
        assertEquals(ScreenLeftCore.Left(5, true), ScreenLeftCore.ofGate(ScreenClock.gate(c, now)))
        // Två minuter spelade utan nät (45 s per gång som mest, som servern räknar glapp)
        var x: ScreenCache? = c
        repeat(12) { x = ScreenClock.addOffline(x, now, 10.0) }
        assertEquals(ScreenLeftCore.Left(3, true), ScreenLeftCore.ofGate(ScreenClock.gate(x, now)))
        // Sluttiden kommer först: 20:00 och klockan är 19:58:30
        val win = ScreenClock.fresh(ScreenStatus(limited = true, day = "2026-11-28", remaining = 3600.0, until = "20:00"))
        assertEquals(ScreenLeftCore.Left(2, true), ScreenLeftCore.ofGate(ScreenClock.gate(win, ZonedDateTime.of(2026, 11, 28, 19, 58, 30, 0, zone))))
        // Ingen skärmtid och ingen gräns: inget visas
        assertNull(ScreenLeftCore.ofGate(ScreenClock.gate(ScreenClock.fresh(null), now)))
        assertNull(ScreenLeftCore.ofGate(ScreenGate(true, null)))
        // Slut: spelaren stoppas i stället
        assertNull(ScreenLeftCore.ofGate(ScreenGate(false, 0, "limit")))
    }

    @Test fun pausRaknasInte() {
        // Under en paus skickas inga rapporter och appen räknar inget: samma status ger samma tid kvar
        val c = ScreenClock.fresh(ScreenStatus(limited = true, day = "2026-11-28", remaining = 400.0))
        val before = ScreenClock.gate(c, ZonedDateTime.of(2026, 11, 28, 10, 0, 0, 0, zone))
        val after = ScreenClock.gate(c, ZonedDateTime.of(2026, 11, 28, 10, 10, 0, 0, zone))
        assertEquals(ScreenLeftCore.ofGate(before), ScreenLeftCore.ofGate(after))
        assertEquals(ScreenLeftCore.Left(7, false), ScreenLeftCore.ofGate(after))
    }

    @Test fun bilenFarIngenVarningsrad() {
        val warn = ScreenLeftCore.of(true, true, 200.0)
        val ok = ScreenLeftCore.of(true, true, 2000.0)
        assertEquals(ScreenLeftCore.Show(pill = true, low = true, banner = true, announce = true), ScreenLeftCore.show(warn, car = false))
        val car = ScreenLeftCore.show(warn, car = true)!!
        assertTrue(car.pill); assertTrue(car.low); assertFalse(car.banner); assertFalse(car.announce)
        assertEquals(ScreenLeftCore.Show(pill = true, low = false, banner = false, announce = false), ScreenLeftCore.show(ok, car = false))
        assertEquals(ScreenLeftCore.show(ok, car = false), ScreenLeftCore.show(ok, car = true))
        assertNull(ScreenLeftCore.show(null, car = false))
    }
}
