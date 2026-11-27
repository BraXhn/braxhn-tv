package net.braxhn.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Spolning i en omkodad ström (SeekCore.kt): när spelaren startar om strömmen vid målet i stället för att vänta på ett
// helt 6 s-segment. Samma fall som webbens seekRestart och Expo-appens test (test/expo-seek.test.js).
// Körs på JVM: gradle testReleaseUnitTest
class SeekCoreTest {
    /** Spellistan som servern ger med processorn (transcodeStarts med h1 i server/stream.js): 0, 1, 2, 4, 6, 12 … och
     *  med hs (≥ 6) … G, B, B+1, B+2, B+4, B+6, B+12 … där B = hs nedåt till jämn sekund */
    private fun fragsOf(dur: Double, hs: Int = 0): List<SeekCore.Frag> {
        val head = { b: Double -> listOf(b, b + 1, b + 2, b + 4) }
        val starts = head(0.0).toMutableList()
        val b = if (hs >= 6) (hs / 2) * 2.0 else 0.0
        var t = 6.0
        if (b == 0.0) { while (t < dur - 0.5) { starts += t; t += 6 } }
        else {
            while (t < b) { starts += t; t += 6 }
            starts += head(b)
            t = b + 6
            while (t < dur - 0.5) { starts += t; t += 6 }
        }
        return starts.mapIndexed { i, s -> SeekCore.Frag(s, (starts.getOrNull(i + 1) ?: dur) - s) }
    }

    private val frags = fragsOf(3600.0)
    private val buf = listOf(0.0 to 30.0)

    @Test fun langtFramUtanforBufferten() = assertTrue(SeekCore.shouldRestart(buf, 1200.0, frags, null, true))
    @Test fun inomBufferten() = assertFalse(SeekCore.shouldRestart(buf, 20.0, frags, null, true))
    @Test fun ingenBildVisadAn() = assertFalse(SeekCore.shouldRestart(buf, 1200.0, frags, null, false))
    @Test fun kortSegmentIBorjan() = assertFalse(SeekCore.shouldRestart(emptyList(), 3.0, frags, null, true))
    @Test fun naraSlutet() = assertFalse(SeekCore.shouldRestart(buf, 3598.0, frags, null, true))
    @Test fun ingenSpellista() = assertFalse(SeekCore.shouldRestart(buf, 1200.0, emptyList(), null, true))
    @Test fun ogiltigPosition() = assertFalse(SeekCore.shouldRestart(buf, Double.NaN, frags, null, true))

    @Test fun serverHarSegmentetKlartEllerKodarDet() {
        // Segment 8 = 30–36 s; servern har 0..7 klara och kodar 8
        assertFalse(SeekCore.shouldRestart(buf, 31.0, frags, 0..7, true))
        assertTrue(SeekCore.shouldRestart(buf, 60.0, frags, 0..7, true))
        // Bakåt inom det servern har kvar (ExoPlayer sparar inte det som spelats): ingen omstart
        val n = SeekCore.fragAt(frags, 1200.0)
        assertFalse(SeekCore.shouldRestart(listOf(1300.0 to 1330.0), 1200.0, frags, (n - 3)..(n + 20), true))
        assertTrue(SeekCore.shouldRestart(listOf(1300.0 to 1330.0), 600.0, frags, (n - 3)..(n + 20), true))
    }

    @Test fun efterEnOmstartArSegmentenKortaVidMalet() {
        val after = fragsOf(3600.0, 1200)
        assertFalse(SeekCore.shouldRestart(emptyList(), 1201.5, after, null, true))
        assertTrue(SeekCore.shouldRestart(emptyList(), 1500.0, after, null, true))
    }

    @Test fun xSegReady() {
        assertEquals(12..20, SeekCore.readyRange("12-20"))
        assertEquals(0..0, SeekCore.readyRange(" 0-0 "))
        assertNull(SeekCore.readyRange("20-12"))
        assertNull(SeekCore.readyRange("12"))
        assertNull(SeekCore.readyRange(""))
        assertNull(SeekCore.readyRange(null))
    }

    @Test fun pid() {
        assertEquals("0a1b2c3d", SeekCore.pidOf("/api/stream/7/hls/master.m3u8?mode=transcode&pid=0a1b2c3d&t=x"))
        assertEquals("0a1b2c3d", SeekCore.pidOf("http://192.168.1.10:8420/api/stream/7/hls/seg-3.ts?pid=0a1b2c3d"))
        assertNull(SeekCore.pidOf("/api/stream/7/hls/master.m3u8?xpid=0a1b2c3d"))
        assertNull(SeekCore.pidOf("/api/stream/7/direct?t=abc"))
        assertNull(SeekCore.pidOf(null))
    }

    @Test fun fjarrkontrollensSteg() {
        assertEquals(25_000L, SeekCore.stepTarget(10_000, 15_000, 3_600_000))
        assertEquals(0L, SeekCore.stepTarget(3_000, -5_000, 3_600_000))
        assertEquals(3_600_000L, SeekCore.stepTarget(3_590_000, 15_000, 3_600_000))
        assertEquals("okänd längd", 25_000L, SeekCore.stepTarget(10_000, 15_000, -1))
    }

    @Test fun segmentetMedT() {
        assertEquals(0, SeekCore.fragAt(frags, 0.0))
        assertEquals(SeekCore.fragAt(frags, 6.0), SeekCore.fragAt(frags, 11.9))
        assertEquals(-1, SeekCore.fragAt(frags, 3601.0))
        assertEquals(-1, SeekCore.fragAt(frags, Double.NaN))
    }
}
