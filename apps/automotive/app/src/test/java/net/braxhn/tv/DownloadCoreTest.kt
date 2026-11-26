package net.braxhn.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Nedladdningar per server och profil (DownloadCore.kt): vem som ser vad, flytten från före profilerna och
// kontrollen mot servern. Samma regler som Expo-appen (apps/expo/src/offline.ts). Körs på JVM: gradle testReleaseUnitTest
class DownloadCoreTest {
    private val server = "https://tv.example.com"
    private fun rec(id: Int) = DownloadRecord(id, "Titel $id", "2024", "$id.mp4", 1000L * id)

    // ---------- en mapp per server och profil ----------

    @Test fun varjeProfilHarEgenMapp() {
        assertEquals("httpstvexamplecom-3", DownloadScope.of(server, 3))
        // Vuxen (1) och barn (7) på samma server: olika mappar, samma server
        val vuxen = DownloadScope.of(server, 1)
        val barn = DownloadScope.of(server, 7)
        assertFalse(vuxen == barn)
        assertTrue(DownloadScope.ofServer(vuxen, server) && DownloadScope.ofServer(barn, server))
        // En annan server delar inte mappar (även om adressen börjar likadant)
        assertFalse(DownloadScope.ofServer(DownloadScope.of("https://tv.example.com.evil", 1), server))
        assertFalse(DownloadScope.ofServer("", server))
        assertFalse(DownloadScope.ofServer("-1", ""))
        // Samma regel som OfflineSync: positioner och nedladdningar hör till samma "server-profil"
        assertEquals("1921681108420-2", DownloadScope.of("192.168.1.10:8420", 2))
    }

    // ---------- flytten från före profilerna ----------

    private val uids = mapOf("aaaa" to 7) // inloggningen aaaa hör till profil 7 (barnet)
    private fun fate(l: LegacyDownloads, fp: String?, owner: Int? = null, srv: String = server) =
        DownloadMigration.fate(l, srv, fp, { uids[it] }, owner)

    @Test fun deGamlaHorTillProfilenSomVarInloggad() {
        val l = LegacyDownloads(server, "aaaa")
        // Profilen känd (servern har svarat): flyttas till den, även när någon annan är inloggad nu
        assertEquals(l to LegacyFate.Assign(7), fate(l, "aaaa"))
        assertEquals(l to LegacyFate.Assign(7), fate(l, "bbbb", owner = 1))
        assertEquals(l to LegacyFate.Assign(7), fate(l, null))
    }

    @Test fun profilenInteKandAnVisasForSammaInloggning() {
        // Uppdaterad och startad utan nät: samma inloggning som förut ser sina filmer (inget försvinner)
        val l = LegacyDownloads(server, "cccc")
        assertEquals(l to LegacyFate.ShowHere, fate(l, "cccc"))
    }

    @Test fun gickDetInteAttVetaFarHuvudkontotDem() {
        // Utloggad när appen uppdaterades: bara huvudkontot (owner i /api/profiles) får dem
        val ut = LegacyDownloads(server, "")
        val (l1, f1) = fate(ut, "bbbb")
        assertTrue(l1.ownerOnly)
        assertEquals(LegacyFate.Hidden, f1) // huvudkontot inte känt än: visas inte för någon
        assertEquals(LegacyFate.Assign(1), fate(l1, "bbbb", owner = 1).second)
        // Inloggningen byttes innan servern sa vilken profil den hörde till: också huvudkontot
        val (l2, f2) = fate(LegacyDownloads(server, "cccc"), "dddd")
        assertTrue(l2.ownerOnly)
        assertEquals(LegacyFate.Hidden, f2)
        // ownerOnly ändras aldrig tillbaka, även om samma inloggning skulle dyka upp igen
        assertEquals(LegacyFate.Hidden, fate(l2, "cccc").second)
        // Utloggad nu
        assertTrue(fate(LegacyDownloads(server, "cccc"), null).first.ownerOnly)
    }

    @Test fun enAnnanServerFarInteDeGamla() {
        val l = LegacyDownloads(server, "", ownerOnly = true)
        assertEquals(LegacyFate.Hidden, fate(l, "bbbb", owner = 1, srv = "https://annan.example.com").second)
        assertEquals(LegacyFate.Hidden, fate(LegacyDownloads(server, "cccc"), "cccc", srv = "https://annan.example.com").second)
        // Ingen sparad server alls (ska inte hända): aldrig till någon
        assertEquals(LegacyFate.Hidden, fate(LegacyDownloads("", "", ownerOnly = true), "bbbb", owner = 1, srv = "").second)
    }

    @Test fun flyttenTarInteBortNagot() {
        val own = listOf(rec(1), rec(2))
        val old = listOf(rec(2), rec(3), rec(3), rec(4))
        val (merged, move) = DownloadMigration.merge(own, old)
        // Profilens egen post för titel 2 behålls; 3 och 4 flyttas (en gång)
        assertEquals(listOf(1, 2, 3, 4), merged.map { it.id })
        assertEquals(listOf(3, 4), move.map { it.id })
        assertEquals(own[1], merged[1])
        // Ingen egen lista än
        assertEquals(old.distinctBy { it.id }, DownloadMigration.merge(emptyList(), old).first)
        assertEquals(own to emptyList<DownloadRecord>(), DownloadMigration.merge(own, emptyList()))
    }

    // ---------- när servern svarar igen ----------

    @Test fun titlarSomProfilenInteFarSeTasBort() {
        assertEquals(DownloadAccess.Verdict.REMOVE, DownloadAccess.verdict(403)) // åldersgräns, bibliotek, familjefilter
        assertEquals(DownloadAccess.Verdict.REMOVE, DownloadAccess.verdict(404)) // finns inte kvar
        assertEquals(DownloadAccess.Verdict.KEEP, DownloadAccess.verdict(200))
        assertEquals(DownloadAccess.Verdict.KEEP, DownloadAccess.verdict(500)) // serverfel: tas inte bort
        assertEquals(DownloadAccess.Verdict.KEEP, DownloadAccess.verdict(502))
        assertEquals(DownloadAccess.Verdict.STOP, DownloadAccess.verdict(0)) // inget nät
        assertEquals(DownloadAccess.Verdict.STOP, DownloadAccess.verdict(401)) // utloggad
        assertEquals(DownloadAccess.Verdict.STOP, DownloadAccess.verdict(429))
    }

    @Test fun kontrollenHogstVarSjatteTimme() {
        val t = 1_795_000_000_000L
        assertTrue(DownloadAccess.due(null, t))
        assertFalse(DownloadAccess.due(t, t + 5 * 3600_000L))
        assertTrue(DownloadAccess.due(t, t + 6 * 3600_000L))
    }

    @Test fun allaTasBortNarKontotInteFarLaddaNer() {
        assertTrue(DownloadAccess.removeAll(canDownload = false, count = 3))
        assertFalse(DownloadAccess.removeAll(canDownload = false, count = 0))
        assertFalse(DownloadAccess.removeAll(canDownload = true, count = 3))
    }
}
