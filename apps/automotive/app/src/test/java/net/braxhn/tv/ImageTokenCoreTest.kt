package net.braxhn.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Bildtoken sparad per server och profil (ImageTokenCore.kt): en ny bara när den snart går ut eller servern svarat 401,
// så att appen inte knuffar ut andra enheters token (taket på 50 per användare). Samma regler som iOS (ImageTokenBook)
// och Expo (ensureImageToken). Körs på JVM: gradle testReleaseUnitTest
class ImageTokenCoreTest {
    private val day = 86_400_000L
    private val now = 1_800_000_000_000L
    private val owner = "https://tv.example.com 3"

    @Test fun startMedSparadTokenHamtarIngenNy() {
        // Appen startar: inget i minnet, men profilen har en sparad som gäller i sex dygn till
        val book = ImageTokenBook().storing("abc", now + 6 * day, 3, now - day)
        assertEquals(ImageTokens.Pick.Saved(SavedImageToken("abc", now + 6 * day)), ImageTokens.pick(book, 3, owner, null, 0L, now, false))
        // Samma sak efter en omstart: det sparade läses tillbaka ur JSON
        val back = ImageTokenBook.decode(book.encoded())
        assertEquals(book, back)
        assertEquals(ImageTokens.Pick.Saved(SavedImageToken("abc", now + 6 * day)), ImageTokens.pick(back, 3, owner, null, 0L, now, false))
    }

    @Test fun tokenIMinnetAnvandsSaLangeDenGallerMerAnEttDygn() {
        assertEquals(ImageTokens.Pick.Keep, ImageTokens.pick(ImageTokenBook(), 3, owner, owner, now + day + 1, now, false))
        // Mindre än ett dygn kvar: ny
        assertEquals(ImageTokens.Pick.Fetch, ImageTokens.pick(ImageTokenBook(), 3, owner, owner, now + day, now, false))
        // En annan profils token i minnet gäller inte
        assertEquals(ImageTokens.Pick.Fetch, ImageTokens.pick(ImageTokenBook(), 3, owner, "https://tv.example.com 7", now + 5 * day, now, false))
    }

    @Test fun sparadSomSnartGarUtErsatts() {
        val book = ImageTokenBook().storing("gammal", now + day - 1, 3, now - 6 * day)
        assertNull(book.usable(3, now))
        assertEquals(ImageTokens.Pick.Fetch, ImageTokens.pick(book, 3, owner, null, 0L, now, false))
    }

    @Test fun efter401HamtasEnNyAvenOmDenSparadeSerGiltigUt() {
        val book = ImageTokenBook().storing("abc", now + 6 * day, 3, now)
        assertEquals(ImageTokens.Pick.Fetch, ImageTokens.pick(book, 3, owner, owner, now + 6 * day, now, true))
    }

    @Test fun varjeProfilHarSinEgen() {
        val book = ImageTokenBook().storing("vuxen", now + 6 * day, 1, now).storing("barn", now + 5 * day, 7, now)
        assertEquals("vuxen", book.usable(1, now)?.token)
        assertEquals("barn", book.usable(7, now)?.token)
        assertEquals(7, book.last)
        assertNull(book.usable(2, now))
        // Byte till barnprofilen: dess sparade, inte vuxnas i minnet
        assertEquals(ImageTokens.Pick.Saved(SavedImageToken("barn", now + 5 * day)),
            ImageTokens.pick(book, 7, "s 7", "s 1", now + 6 * day, now, false))
    }

    @Test fun utgangnaStadasOchTomTextTarBort() {
        val book = ImageTokenBook().storing("a", now + day, 1, now).storing("b", now + 7 * day, 2, now)
        val later = book.storing("c", now + 9 * day, 3, now + 2 * day)
        assertEquals(setOf("2", "3"), later.tokens.keys)
        assertEquals(setOf("3"), later.storing("", 0L, 2, now + 2 * day).tokens.keys)
    }

    @Test fun ttlFranServern() {
        assertEquals(now + 7 * day, ImageTokenBook.until(7 * 86400, now))
        assertEquals(now + 7 * day, ImageTokenBook.until(null, now)) // äldre server utan ttl
        assertEquals(now + 60_000L, ImageTokenBook.until(5, now)) // minst en minut
    }

    @Test fun trasigtSparatGerTomt() {
        assertEquals(ImageTokenBook(), ImageTokenBook.decode(null))
        assertEquals(ImageTokenBook(), ImageTokenBook.decode("{inte json"))
        assertEquals(ImageTokenBook(), ImageTokenBook.decode(""))
        // Okända fält (en senare appversion) gör inget
        assertEquals("x", ImageTokenBook.decode("""{"tokens":{"4":{"token":"x","until":${now + 3 * day},"ny":1}},"last":4,"annat":true}""").usable(4, now)?.token)
    }

    @Test fun bildSomInteLaddasKontrollerasHogstEnGangIMinuten() {
        val url = "https://tv.example.com/api/image/12/poster?t=abc123"
        assertTrue(ImageTokens.shouldCheck(url, "abc123", 0L, now))
        assertFalse(ImageTokens.shouldCheck(url, "abc123", now - 59_000L, now))
        assertTrue(ImageTokens.shouldCheck(url, "abc123", now - 60_000L, now))
        // Adressen har en äldre token (eller ingen): inget att kontrollera
        assertFalse(ImageTokens.shouldCheck(url, "def456", 0L, now))
        assertFalse(ImageTokens.shouldCheck(url, null, 0L, now))
        assertFalse(ImageTokens.shouldCheck("https://tv.example.com/api/image/12/poster", "abc123", 0L, now))
        // Bara hela värdet: en token som börjar likadant räknas inte
        assertFalse(ImageTokens.shouldCheck("https://x/api/image/1/poster?t=abc1234", "abc123", 0L, now))
        assertTrue(ImageTokens.shouldCheck("https://x/api/live/logo/1?t=abc123&v=2", "abc123", 0L, now))
    }
}
