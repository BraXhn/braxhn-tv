package net.braxhn.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

// Uppspelning utan nät (OfflineCore.kt): kön med positioner och skärmtiden. Samma regler som Expo-appen
// (test/expo-offline.test.js provar dess offlinecore.ts). Körs på JVM utan Android: gradle testReleaseUnitTest
class OfflineCoreTest {
    private val zone = ZoneId.of("Europe/Stockholm")
    private fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int = 0, s: Int = 0) = ZonedDateTime.of(y, mo, d, h, mi, s, 0, zone)
    private fun nov(h: Int, mi: Int = 0, day: Int = 26) = at(2026, 11, day, h, mi)
    private val t0 = 1_795_000_000_000L // ms

    // ---------- kön ----------

    @Test fun positionenSparasMedAtOchSkickasMedDen() {
        val q = ProgressQueue.record(emptyList(), 7, 1234.4, 5400.0, t0)
        assertEquals(listOf(PendingProgress(7, 1234, 5400.0, t0 / 1000)), q)
        assertEquals("/api/items/7/progress", ProgressQueue.path(q[0]))
        assertEquals(mapOf("position" to 1234L, "duration" to 5400.0, "at" to t0 / 1000), ProgressQueue.body(q[0]))
        // Utan känd längd skickas ingen duration
        assertEquals(mapOf("position" to 10L, "at" to t0 / 1000), ProgressQueue.body(ProgressQueue.record(emptyList(), 8, 10.0, 0.0, t0)[0]))
        assertEquals(0L, ProgressQueue.record(emptyList(), 9, -5.0, 0.0, t0)[0].position)
    }

    @Test fun enPostPerTitelISparadOrdning() {
        var q = ProgressQueue.record(emptyList(), 1, 100.0, 0.0, t0)
        q = ProgressQueue.record(q, 2, 200.0, 0.0, t0 + 10_000)
        q = ProgressQueue.record(q, 1, 150.0, 0.0, t0 + 20_000) // samma titel igen: den senaste gäller och hamnar sist
        assertEquals(listOf(2 to 200L, 1 to 150L), q.map { it.id to it.position })
        assertEquals(listOf(t0 / 1000 + 10, t0 / 1000 + 20), q.map { it.at })
    }

    @Test fun ljudbokerOchPoddarIKon() {
        // Bok och podd med samma id som en film är olika poster, var och en med sin adress och sin at
        var q = ProgressQueue.record(emptyList(), 7, 100.0, 5400.0, t0)
        q = ProgressQueue.record(q, 7, 3725.6, 0.0, t0 + 1000, ProgressQueue.BOOK)
        q = ProgressQueue.record(q, 7, 61.0, 0.0, t0 + 2000, ProgressQueue.POD)
        assertEquals(3, q.size)
        assertEquals(listOf("/api/items/7/progress", "/api/audiobooks/book/7/progress", "/api/podcasts/episodes/7/progress"), q.map { ProgressQueue.path(it) })
        assertEquals(mapOf("position" to 3726L, "at" to t0 / 1000 + 1), ProgressQueue.body(q[1])) // boken: position i hela boken
        assertEquals(mapOf("position" to 61L, "at" to t0 / 1000 + 2), ProgressQueue.body(q[2]))
        // En ny position i boken ersätter bara bokens post
        q = ProgressQueue.record(q, 7, 3800.0, 0.0, t0 + 3000, ProgressQueue.BOOK)
        assertEquals(listOf(ProgressQueue.ITEM to 100L, ProgressQueue.POD to 61L, ProgressQueue.BOOK to 3800L), q.map { it.kind to it.position })
        // Barnprofil och podd (403) eller borttaget avsnitt (404): posten släpps
        assertEquals(2, ProgressQueue.ack(q, q[1], 403).size)
    }

    @Test fun ettAnropSomStartadeForeEnNyarePositionErsatterDenInte() {
        // Anropet startade t0 och fick inget svar förrän efter att en nyare position (t0 + 10 s) sparats i kön
        val q = ProgressQueue.record(emptyList(), 5, 600.0, 0.0, t0 + 10_000, ProgressQueue.BOOK)
        val after = ProgressQueue.record(q, 5, 590.0, 0.0, t0, ProgressQueue.BOOK)
        assertEquals(q, after)
        // Samma sekund eller senare: den senast sparade gäller
        assertEquals(620L, ProgressQueue.record(q, 5, 620.0, 0.0, t0 + 10_000, ProgressQueue.BOOK).single().position)
    }

    @Test fun svaretAvgorOmPostenSlapps() {
        val q = ProgressQueue.record(emptyList(), 7, 1234.0, 5400.0, t0)
        val p = q[0]
        assertEquals(emptyList<PendingProgress>(), ProgressQueue.ack(q, p, 200))
        assertEquals(q, ProgressQueue.ack(q, p, 0))    // inget nät
        assertEquals(q, ProgressQueue.ack(q, p, 500))  // serverfel
        assertEquals(q, ProgressQueue.ack(q, p, 401))  // utloggad: skickas efter inloggning
        assertEquals(emptyList<PendingProgress>(), ProgressQueue.ack(q, p, 404)) // titeln finns inte längre
        assertEquals(emptyList<PendingProgress>(), ProgressQueue.ack(q, p, 403)) // får inte ses i profilen längre
        // En nyare position sparad medan den gamla skickades ligger kvar
        val newer = ProgressQueue.record(q, 7, 1300.0, 5400.0, t0 + 10_000)
        assertEquals(1300L, ProgressQueue.ack(newer, p, 200).single().position)
        assertFalse(ProgressQueue.keepGoing(0)); assertFalse(ProgressQueue.keepGoing(503)); assertFalse(ProgressQueue.keepGoing(401))
        assertTrue(ProgressQueue.keepGoing(200)); assertTrue(ProgressQueue.keepGoing(404))
    }

    /** Servern som i server/routes/library.js: ett framsteg med at som inte är nyare än det sparade är stale */
    private class FakeServer {
        val saved = mutableMapOf<Int, Pair<Long, Long>>() // id -> (position, updated)
        var writes = 0
        fun post(p: PendingProgress): Boolean {
            val prev = saved[p.id]
            if (prev != null && prev.second >= p.at) return false
            saved[p.id] = p.position to p.at; writes++; return true
        }
    }

    /** Skickar kön i ordning som OfflineSync.flush: stannar vid första anropet utan svar */
    private fun flush(q0: List<PendingProgress>, send: (PendingProgress) -> Int): List<PendingProgress> {
        var q = q0
        for (p in q0) { val st = send(p); q = ProgressQueue.ack(q, p, st); if (!ProgressQueue.keepGoing(st)) break }
        return q
    }

    @Test fun ingenDubbelrakningNarSvaretTappas() {
        val srv = FakeServer()
        val q = ProgressQueue.record(emptyList(), 7, 1234.0, 5400.0, t0)
        // Anropet kommer fram men svaret tappas: posten ligger kvar
        val left = flush(q) { p -> srv.post(p); 0 }
        assertEquals(q, left)
        // Nästa gång: samma at är inte nyare – servern svarar stale (200) och posten släpps, ingen ny skrivning
        val after = flush(left) { p -> srv.post(p); 200 }
        assertEquals(emptyList<PendingProgress>(), after)
        assertEquals(1, srv.writes)
        // Ett senare framsteg från en annan enhet skrivs inte över av den gamla offline-positionen
        srv.saved[8] = 50L to (t0 / 1000 + 100)
        flush(ProgressQueue.record(emptyList(), 8, 900.0, 0.0, t0)) { p -> srv.post(p); 200 }
        assertEquals(50L, srv.saved[8]!!.first)
    }

    @Test fun koenSkickasIOrdningOchStannarUtanNat() {
        var q = ProgressQueue.record(emptyList(), 1, 10.0, 0.0, t0)
        q = ProgressQueue.record(q, 2, 20.0, 0.0, t0 + 1000)
        q = ProgressQueue.record(q, 3, 30.0, 0.0, t0 + 2000)
        val sent = mutableListOf<Int>()
        // Nätet försvinner vid andra anropet: den tredje skickas inte, de två sista ligger kvar i samma ordning
        val left = flush(q) { p -> sent += p.id; if (p.id == 1) 200 else 0 }
        assertEquals(listOf(1, 2), sent)
        assertEquals(listOf(2, 3), left.map { it.id })
        sent.clear()
        assertEquals(emptyList<PendingProgress>(), flush(left) { p -> sent += p.id; 200 })
        assertEquals(listOf(2, 3), sent)
    }

    @Test fun gamlaOchForMangaPosterSlapps() {
        val old = ProgressQueue.record(emptyList(), 1, 10.0, 0.0, t0)
        val later = t0 + (ProgressQueue.MAX_AGE_S + 1) * 1000
        assertEquals(listOf(2), ProgressQueue.record(old, 2, 5.0, 0.0, later).map { it.id })
        var q = emptyList<PendingProgress>()
        for (i in 1..ProgressQueue.MAX + 5) q = ProgressQueue.record(q, i, 1.0, 0.0, t0 + i * 1000L)
        assertEquals(ProgressQueue.MAX, q.size)
        assertEquals(6, q.first().id) // de äldsta släpps
    }

    @Test fun nedladdadTitelBorjarDarDenSlutade() {
        assertEquals(2400.0, ResumePoint.start(2400.0, 5400.0), 0.0)
        assertEquals(0.0, ResumePoint.start(90.0, 5400.0), 0.0)    // under två minuter: från början
        assertEquals(100.0, ResumePoint.start(100.0, 300.0), 0.0)  // kort klipp: en fjärdedel räcker
        assertEquals(0.0, ResumePoint.start(5300.0, 5400.0), 0.0)  // nästan slut = sedd
        assertEquals(0.0, ResumePoint.start(0.0, 5400.0), 0.0)
        assertEquals(600.0, ResumePoint.start(600.0, 0.0), 0.0)    // okänd längd
    }

    // Samma fall som test/watched.test.js (serverns isWatched)
    @Test fun seddForKortaOchLangaTitlar() {
        val cases = listOf(
            listOf(61.0, 180.0, null, false), listOf(150.0, 180.0, null, false), listOf(166.0, 180.0, null, true),
            listOf(150.0, 180.0, 150.0, true), listOf(140.0, 180.0, 150.0, false),
            listOf(181.0, 300.0, null, false), listOf(240.0, 300.0, null, false), listOf(276.0, 300.0, null, true), listOf(272.0, 300.0, 270.0, true),
            listOf(1201.0, 1320.0, null, false), listOf(1215.0, 1320.0, null, true), listOf(1250.0, 1320.0, 1240.0, true), listOf(500.0, 1320.0, 400.0, false),
            listOf(6510.0, 7200.0, 6500.0, true), listOf(6700.0, 7200.0, null, true), listOf(6500.0, 7200.0, null, false),
            listOf(7100.0, 7200.0, null, true), listOf(3600.0, 7200.0, 6900.0, false),
            listOf(100.0, 0.0, null, false), listOf(0.0, 300.0, null, false), listOf(300.0, 300.0, 9999.0, true))
        for (c in cases) assertEquals("$c", c[3], Watched.isWatched(c[0] as Double, c[1] as Double, c[2] as Double?))
        assertEquals(240.0, ResumePoint.start(240.0, 300.0), 0.0)      // 5 min, en minut kvar: inte sedd, fortsätt
        assertEquals(0.0, ResumePoint.start(272.0, 300.0, 270.0), 0.0) // eftertexterna har börjat
    }

    // ---------- skärmtid ----------

    private val st = ScreenStatus(limited = true, day = "2026-11-26", daily = 60, used = 1800.0, extra = 0, remaining = 1800.0,
        from = "07:00", until = "19:00", audio = false)

    /** Spelar n bitar om step sekunder från from (som spelarens rapport var tionde sekund) */
    private fun play(c0: ScreenCache?, from: ZonedDateTime, n: Int, step: Long = 10, audio: Boolean = false): ScreenCache? {
        var c = c0
        for (i in 1..n) c = ScreenClock.addOffline(c, from.plusSeconds(i * step), step.toDouble(), audio)
        return c
    }

    @Test fun tidKvarOchOfflineTid() {
        assertEquals(ScreenGate(true, null), ScreenClock.gate(null, nov(12)))
        assertTrue(ScreenClock.gate(ScreenClock.fresh(ScreenStatus(limited = false)), nov(12)).allowed)
        assertTrue(ScreenClock.gate(ScreenClock.fresh(null), nov(12)).allowed)
        var c: ScreenCache? = ScreenClock.fresh(st)
        assertEquals(ScreenGate(true, 1800), ScreenClock.gate(c, nov(12)))
        // 20 minuter utan nät från 12:00: en post som växer
        c = play(c, nov(12), 120)
        assertEquals(listOf(ScreenEntry("o" + nov(12).toEpochSecond(), nov(12).toEpochSecond(), 1200.0)), c!!.entries)
        assertEquals(600L, ScreenClock.gate(c, nov(12, 20)).left)
        // Högst 45 s per gång: ett glapp på tio minuter räknas inte som tittande
        val big = ScreenClock.addOffline(c, nov(12, 30), 600.0)!!
        assertEquals(1245.0, big.offSeconds(nov(12).toLocalDate(), zone), 0.0)
        c = play(c, nov(12, 20), 60)
        val out = ScreenClock.gate(c, nov(12, 30))
        assertEquals(ScreenGate(false, 0, "limit", usedMinutes = 60, totalMinutes = 60, weekday = 4), out) // torsdag
        // En ny status från servern ersätter appens räkning men inte posterna som servern inte har fått
        assertEquals(1800.0, ScreenClock.fresh(st, c!!.entries).offSeconds(nov(12).toLocalDate(), zone), 0.0)
        assertTrue(ScreenClock.gate(ScreenClock.fresh(st.copy(remaining = 3600.0), c.entries), nov(12, 30)).allowed)
        // Ingen skärmtid enligt statusen: ingen gräns, men posten sparas (servern avgör)
        val free = play(ScreenClock.fresh(ScreenStatus(limited = false)), nov(12), 3)
        assertEquals(30.0, free!!.entries.single().seconds, 0.0)
        assertTrue(ScreenClock.gate(free, nov(12)).allowed)
        assertNull(ScreenClock.addOffline(null, nov(12), 30.0))
    }

    @Test fun enPostPerUppspelning() {
        val c0 = ScreenClock.fresh(st)
        // Paus (en minut utan bitar): en ny post med eget id
        var c = play(c0, nov(12), 6)
        c = play(c, nov(12, 2), 6)
        assertEquals(2, c!!.entries.size)
        assertEquals(listOf(60.0, 60.0), c.entries.map { it.seconds })
        assertEquals(nov(12, 2).toEpochSecond(), c.entries[1].at)
        assertTrue(c.entries[0].id != c.entries[1].id)
        // Posten växer med samma id och början; bitar som kommer lite sent (nätfelet tog tid) hänger ihop
        val id = c.entries[1].id
        c = ScreenClock.addOffline(c, nov(12, 3).plusSeconds(12), 10.0)
        assertEquals(id, c!!.entries[1].id)
        assertEquals(72.0, c.entries[1].seconds, 0.0)
        // Ljud och video i var sin post
        c = ScreenClock.addOffline(c, nov(12, 3).plusSeconds(20), 8.0, audio = true)
        assertEquals(true, c!!.entries.last().audio)
        assertEquals(3, c.entries.size)
        // Spelar man länge börjar en ny post varje timme, som börjar där den förra slutade (ingen tid två gånger)
        val long = play(c0, nov(14), 450) // 75 minuter
        assertEquals(listOf(3600.0, 900.0), long!!.entries.map { it.seconds })
        assertEquals(long.entries[0].end, long.entries[1].at.toDouble(), 0.0)
        assertEquals(4500.0, long.offSeconds(nov(14).toLocalDate(), zone), 0.0)
        // Klockan ställd bakåt: ingen negativ tid, och nästa bit ger en ny post utan överlapp
        val back = ScreenClock.addOffline(long, nov(14, 30), 10.0)!!
        assertEquals(long.entries, back.entries)
    }

    @Test fun koenTillServern() {
        var c = play(ScreenClock.fresh(st), nov(12), 6)
        c = play(c, nov(12, 5), 6)
        val sent = ScreenClock.batch(c!!.entries)
        assertEquals(2, sent.size)
        // Medan anropet pågår växer den senaste posten: den tas inte bort, utan skickas igen (servern räknar det nya)
        val grown = ScreenClock.addOffline(c, nov(12, 6).plusSeconds(10), 10.0)!!
        val left = ScreenClock.ack(grown.entries, sent, sent.map { it.id })
        assertEquals(listOf(grown.entries[1]), left)
        assertEquals(70.0, left.single().seconds, 0.0)
        // Det servern inte listar i done (till exempel över 200 poster) stannar kvar
        assertEquals(c.entries, ScreenClock.ack(c.entries, sent, emptyList()))
        assertEquals(listOf(c.entries[1]), ScreenClock.ack(c.entries, sent, listOf(c.entries[0].id)))
        // Högst 200 per anrop, de äldsta först
        var many: ScreenCache? = ScreenClock.fresh(st)
        repeat(250) { i -> many = ScreenClock.addOffline(many, nov(8).plusSeconds(i * 120L), 10.0) }
        assertEquals(250, many!!.entries.size)
        assertEquals(many!!.entries.take(200), ScreenClock.batch(many!!.entries))
        // Äldre än 60 dygn sparas inte
        val old = ScreenClock.addOffline(ScreenClock.fresh(st), nov(12).minusDays(61), 10.0)
        assertEquals(emptyList<ScreenEntry>(), ScreenClock.addOffline(old, nov(12), 10.0)!!.entries.dropLast(1))
    }

    @Test fun flyttFranSummanPerDag() {
        // I dag 26 november kl 12:00, 25 minuter sparade: en post som slutar nu
        val now = nov(12)
        val e = ScreenClock.migrate("2026-11-26", 1500.0, now)
        assertEquals(listOf(ScreenEntry("m2026-11-26-0", now.toEpochSecond() - 1500, 1500.0)), e)
        // Samma tid kvar som förut
        assertEquals(1500.0, ScreenClock.fresh(st, e).offSeconds(now.toLocalDate(), zone), 0.0)
        assertEquals(300L, ScreenClock.gate(ScreenClock.fresh(st, e), now).left)
        // Samma flytt igen ger samma id (servern räknar dem inte två gånger)
        assertEquals(e.map { it.id }, ScreenClock.migrate("2026-11-26", 1500.0, now.plusMinutes(5)).map { it.id })
        // En tidigare dag: sist på den dagen, i poster om högst en timme
        val y = ScreenClock.migrate("2026-11-25", 5400.0, now)
        assertEquals(listOf(3600.0, 1800.0), y.map { it.seconds })
        assertEquals(nov(0).toEpochSecond().toDouble(), y.last().end, 0.0)
        assertEquals(0.0, ScreenClock.fresh(st, y).offSeconds(now.toLocalDate(), zone), 0.0)
        // Mer tid än dagen hittills rymmer: bara från midnatt
        assertEquals(1800.0, ScreenClock.migrate("2026-11-26", 7200.0, nov(0, 30)).sumOf { it.seconds }, 0.0)
        // Vintertid: 25 oktober har 25 timmar, posten slutar vid midnatt i riktig tid
        val oct = ScreenClock.migrate("2026-10-25", 600.0, now)
        assertEquals(at(2026, 10, 26, 0).toEpochSecond().toDouble(), oct.single().end, 0.0)
        // Inget sparat, fel form eller en dag i framtiden
        assertEquals(emptyList<ScreenEntry>(), ScreenClock.migrate(null, 600.0, now))
        assertEquals(emptyList<ScreenEntry>(), ScreenClock.migrate("2026-11-26", 0.0, now))
        assertEquals(emptyList<ScreenEntry>(), ScreenClock.migrate("x", 600.0, now))
        assertEquals(emptyList<ScreenEntry>(), ScreenClock.migrate("2026-11-27", 600.0, now))
    }

    @Test fun klockslag() {
        val c = ScreenClock.fresh(st)
        assertFalse(ScreenClock.gate(c, nov(6, 30)).allowed)
        assertEquals(ScreenGate(false, 0, "window", from = "07:00", until = "19:00", weekday = 4), ScreenClock.gate(c, nov(19, 5)))
        assertEquals(600L, ScreenClock.gate(c, nov(18, 50)).left)
        // Bara från eller bara till
        assertNull(ScreenClock.gate(ScreenClock.fresh(st.copy(until = null, remaining = null)), nov(12)).left)
        assertEquals(3600L, ScreenClock.gate(ScreenClock.fresh(st.copy(from = null, remaining = null)), nov(18)).left)
    }

    @Test fun nyDagUtanKontakt() {
        // Dagens tid är slut och har extra tid (sluttiden 19:30) – nästa dag: en ny timme och ingen extra tid
        val ex = ScreenClock.fresh(st.copy(remaining = 0.0, extra = 30, until = "19:30", used = 5400.0))
        assertEquals(ScreenGate(false, 0, "limit", usedMinutes = 90, totalMinutes = 90, weekday = 4), ScreenClock.gate(ex, nov(12)))
        assertEquals(ScreenGate(true, 3600), ScreenClock.gate(ex, nov(12, 0, 27)))
        assertEquals(ScreenGate(false, 0, "window", from = "07:00", until = "19:00", weekday = 5), ScreenClock.gate(ex, nov(19, 10, 27)))
        // Tid som räknats utan nät i går påverkar inte i dag
        val y = ScreenClock.addOffline(ScreenClock.fresh(st), nov(12), 40.0)
        assertEquals(3600L, ScreenClock.gate(y, nov(12, 0, 27)).left)
        // Spelar över midnatt utan nät: en post, men tiden efter midnatt räknas på den nya dagen
        var c: ScreenCache? = ScreenClock.fresh(st.copy(from = null, until = null))
        c = ScreenClock.addOffline(c, at(2026, 11, 26, 23, 59, 50), 30.0)
        c = ScreenClock.addOffline(c, at(2026, 11, 27, 0, 0, 10), 20.0)
        assertEquals(1, c!!.entries.size)
        assertEquals(10.0, c.offSeconds(at(2026, 11, 27, 0).toLocalDate(), zone), 0.0)
        assertEquals(3590L, ScreenClock.gate(c, at(2026, 11, 27, 0, 0, 10)).left)
    }

    @Test fun manadsOchArsskifte() {
        // 31 december 2026 (torsdag i vecka 53) → 1 januari 2027 (fredag): en ny dag
        val c = ScreenClock.fresh(st.copy(day = "2026-12-31", remaining = 0.0))
        assertFalse(ScreenClock.gate(c, at(2026, 12, 31, 12)).allowed)
        assertEquals(ScreenGate(true, 3600), ScreenClock.gate(c, at(2027, 1, 1, 12)))
        assertEquals(5, ScreenClock.gate(c, at(2027, 1, 1, 20)).weekday)
        // 30 november → 1 december
        assertTrue(ScreenClock.gate(ScreenClock.fresh(st.copy(day = "2026-11-30", remaining = 0.0)), at(2026, 12, 1, 12)).allowed)
    }

    @Test fun fonsterOverMidnatt() {
        val night = ScreenClock.fresh(st.copy(from = "20:00", until = "02:00", remaining = null, daily = null))
        assertTrue(ScreenClock.gate(night, nov(23)).allowed)
        assertTrue(ScreenClock.gate(night, nov(1)).allowed)
        assertFalse(ScreenClock.gate(night, nov(12)).allowed)
        assertEquals(1800L, ScreenClock.gate(night, nov(1, 30)).left)
        assertEquals(4 * 3600L, ScreenClock.gate(night, nov(22)).left) // 22:00 → 02:00 nästa dag
        assertEquals(ScreenGate(false, 0, "window", from = "20:00", until = "02:00", weekday = 4), ScreenClock.gate(night, nov(2, 30)))
    }

    @Test fun sommartid29Mars() {
        // Natten mot söndag 29 mars 2026 hoppar klockan från 02:00 till 03:00: 01:30 → 04:00 är 1,5 timme, inte 2,5
        val night = ScreenClock.fresh(st.copy(day = "2026-03-28", from = "22:00", until = "04:00", remaining = null, daily = null))
        assertEquals(90 * 60L, ScreenClock.gate(night, at(2026, 3, 29, 1, 30)).left)
        assertEquals(30 * 60L, ScreenClock.gate(night, at(2026, 3, 29, 3, 30)).left)
        // Klockslag samma dag: 18:50 → 19:00 är fortfarande tio minuter
        val day = ScreenClock.fresh(st.copy(day = "2026-03-29"))
        assertEquals(600L, ScreenClock.gate(day, at(2026, 3, 29, 18, 50)).left)
        assertFalse(ScreenClock.gate(day, at(2026, 3, 29, 3, 30)).allowed) // före 07:00
        // Dagen räknas efter väggklockan: 23:30 lördag och 00:30 söndag är olika dagar trots bara en timme emellan
        var c: ScreenCache? = ScreenClock.fresh(st.copy(day = "2026-03-28", from = null, until = null))
        c = ScreenClock.addOffline(c, at(2026, 3, 28, 23, 59, 50), 30.0)
        assertEquals(1770L, ScreenClock.gate(c, at(2026, 3, 28, 23, 59, 50)).left)
        c = ScreenClock.addOffline(c, at(2026, 3, 29, 3, 0, 5), 30.0)
        assertEquals(3570L, ScreenClock.gate(c, at(2026, 3, 29, 3, 0, 5)).left)
        assertEquals(0, ScreenClock.gate(c, at(2026, 3, 29, 3, 0, 5)).weekday) // söndag
    }

    @Test fun vintertid25Oktober() {
        // Natten mot söndag 25 oktober 2026 går klockan tillbaka från 03:00 till 02:00: 01:30 → 04:00 är 3,5 timmar
        val night = ScreenClock.fresh(st.copy(day = "2026-10-24", from = "22:00", until = "04:00", remaining = null, daily = null))
        assertEquals(210 * 60L, ScreenClock.gate(night, at(2026, 10, 25, 1, 30)).left)
        // 02:30 finns två gånger; ZonedDateTime.of väljer den första (sommartid): 2,5 timmar kvar
        assertEquals(150 * 60L, ScreenClock.gate(night, at(2026, 10, 25, 2, 30)).left)
        val second = at(2026, 10, 25, 2, 30).withLaterOffsetAtOverlap()
        assertEquals(90 * 60L, ScreenClock.gate(night, second).left)
        // Fönstret 07–19 samma dag som vanligt
        val day = ScreenClock.fresh(st.copy(day = "2026-10-25"))
        assertEquals(600L, ScreenClock.gate(day, at(2026, 10, 25, 18, 50)).left)
    }

    @Test fun ljudRaknasBaraNarRegelnGallerLjud() {
        val zero = ScreenClock.fresh(st.copy(remaining = 0.0))
        assertTrue(ScreenClock.gate(zero, nov(12), audio = true).allowed)
        assertFalse(ScreenClock.gate(ScreenClock.fresh(st.copy(remaining = 0.0, audio = true)), nov(12), audio = true).allowed)
    }

    @Test fun klockslagTolkas() {
        assertEquals(19 * 60, ScreenClock.toMin("19:00"))
        assertEquals(7 * 60 + 5, ScreenClock.toMin("7:05"))
        assertNull(ScreenClock.toMin("24:00")); assertNull(ScreenClock.toMin("12:60")); assertNull(ScreenClock.toMin(null)); assertNull(ScreenClock.toMin("x"))
        assertEquals("00:00", ScreenClock.hhmm(1440)); assertEquals("19:30", ScreenClock.hhmm(1170))
    }
}
