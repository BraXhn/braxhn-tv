package net.braxhn.tv

import java.time.Duration
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZonedDateTime
import java.util.Locale
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

// Uppspelning utan nät, utan Android: kön med positioner som väntar på servern och skärmtiden som räknas i appen.
// Samma regler som Expo-appen (apps/expo/src/offlinecore.ts, test/expo-offline.test.js). Filer, nät och spelaren
// sköter OfflineSync.kt och PlayerScreen.kt. Testas på JVM: app/src/test/.../OfflineCoreTest.kt

// ---------- positioner som väntar på nätet ----------

/**
 * Position som sparats utan kontakt med servern. at = när den sparades (Unix-sekunder), skickas med till servern.
 * kind: ProgressQueue.ITEM (film, avsnitt), BOOK (ljudbok, position i hela boken) eller POD (poddavsnitt).
 */
data class PendingProgress(val id: Int, val position: Long, val duration: Double, val at: Long, val kind: String = ProgressQueue.ITEM)

object ProgressQueue {
    const val ITEM = "item"
    const val BOOK = "book"
    const val POD = "pod"
    /** Fler väntande titlar än så sparas inte (de äldsta släpps) */
    const val MAX = 200
    /** Äldre än så skickas inte längre (60 dygn) */
    const val MAX_AGE_S = 60L * 86400

    /**
     * Sparar positionen i kön: en post per titel (och slag), den senaste gäller. Kön står i den ordning positionerna
     * sparades och skickas i den ordningen. nowMs = när positionen gällde: ett anrop som startade före en position som
     * redan sparats (och sedan inte kom fram) ersätter inte den nyare.
     */
    fun record(list: List<PendingProgress>, id: Int, position: Double, duration: Double, nowMs: Long, kind: String = ITEM): List<PendingProgress> {
        val p = PendingProgress(id, max(0.0, position).roundToLong(), if (duration > 0) duration else 0.0, nowMs / 1000, kind)
        val old = list.firstOrNull { it.id == id && it.kind == kind }
        if (old != null && old.at > p.at) return prune(list, nowMs)
        return prune(list.filter { it.id != id || it.kind != kind } + p, nowMs)
    }

    /** Ordning (äldst först), högst MAX poster och inga som är för gamla */
    fun prune(list: List<PendingProgress>, nowMs: Long): List<PendingProgress> =
        list.filter { nowMs / 1000 - it.at <= MAX_AGE_S }.sortedBy { it.at }.takeLast(MAX)

    fun path(p: PendingProgress) = when (p.kind) {
        BOOK -> "/api/audiobooks/book/${p.id}/progress"
        POD -> "/api/podcasts/episodes/${p.id}/progress"
        else -> "/api/items/${p.id}/progress"
    }

    /**
     * Kroppen i POST …/progress. Servern behåller ett senare framsteg från en annan enhet (at) för filmer, avsnitt,
     * ljudböcker och poddavsnitt.
     */
    fun body(p: PendingProgress): Map<String, Number> =
        if (p.kind == ITEM && p.duration > 0) mapOf("position" to p.position, "duration" to p.duration, "at" to p.at)
        else mapOf("position" to p.position, "at" to p.at)

    /** Klart med posten: servern tog emot den (även som för gammal), eller titeln finns inte / får inte ses längre */
    fun finished(status: Int) = status in 200..299 || status == 403 || status == 404

    /**
     * Efter ett anrop (status 0 = inget svar). Bara just den skickade posten tas bort: har en nyare position för
     * titeln sparats under tiden ligger den kvar. Kom anropet fram men svaret tappades ligger posten kvar och skickas
     * igen – servern svarar då stale (samma at är inte nyare än det som redan sparats), så inget räknas två gånger.
     */
    fun ack(list: List<PendingProgress>, sent: PendingProgress, status: Int): List<PendingProgress> =
        if (finished(status)) list.filter { it != sent } else list

    /** Skicka nästa i kön? Inget svar, utloggad, för många anrop eller serverfel: vänta till nästa gång (ordningen står kvar) */
    fun keepGoing(status: Int) = status != 0 && status != 401 && status != 429 && status < 500
}

/**
 * Sedd (som serverns isWatched i server/resume.js och Expo-appens offlinecore.ts): eftertexterna har börjat (credits,
 * om markeringen ligger i andra halvan) eller högst 8 % av längden är kvar. Fasta 2 minuter gjorde korta avsnitt
 * sedda för tidigt.
 */
object Watched {
    const val LEFT = 0.08
    const val CREDITS_FROM = 0.5
    fun isWatched(position: Double, duration: Double, credits: Double? = null): Boolean {
        if (!(duration > 0) || !(position > 0)) return false
        if (credits != null && credits > duration * CREDITS_FROM && credits < duration && position >= credits) return true
        return duration - position <= duration * LEFT
    }
}

/** Var en nedladdad titel ska börja, ur positionen som sparats i appen (som servern och Expo-appens startAt) */
object ResumePoint {
    /** Under två minuter (eller en fjärdedel av ett kort klipp) och sedd (serverns regel): från början */
    fun start(position: Double, duration: Double, credits: Double? = null): Double {
        if (!(position > 0)) return 0.0
        if (Watched.isWatched(position, duration, credits)) return 0.0
        val d = if (duration > 0) duration else 1e9
        return if (position >= min(120.0, d * 0.25)) position else 0.0
    }
}

// ---------- skärmtid utan nät ----------
// Servern räknar skärmtiden (server/screentime.js) och säger stopp i svaret på framstegen. Utan nät följer appen den
// senaste statusen den fick (GET /api/screentime eller screenTime i framstegssvaret) och räknar själv tiden som spelats
// utan kontakt – en post per uppspelning (ScreenEntry). Posterna lämnas in med POST /api/screentime/offline när nätet
// kommer tillbaka (OfflineSync.kt); servern räknar varje sekund en gång, så samma post kan skickas igen och får växa.

/** Serverns status (GET /api/screentime, screenTime i framstegssvaret). remaining och used i sekunder, daily i minuter. */
data class ScreenStatus(
    val limited: Boolean = false, val day: String? = null, val daily: Int? = null, val used: Double = 0.0, val extra: Int = 0,
    val remaining: Double? = null, val from: String? = null, val until: String? = null, val audio: Boolean = false
)

/**
 * Tid som spelats utan kontakt och som servern inte har fått: id stabilt (samma id när posten växer), at = när
 * uppspelningen började (Unix-sekunder), seconds = hur länge den pågick (väggklocka, utan pauser), audio = ljud.
 */
data class ScreenEntry(val id: String, val at: Long, val seconds: Double, val audio: Boolean = false) {
    val end: Double get() = at + seconds
}

/** Senaste statusen och posterna som servern inte har fått än (de räknas av från statusens tid kvar) */
data class ScreenCache(val status: ScreenStatus, val entries: List<ScreenEntry> = emptyList()) {
    /** Sekunder som spelats utan kontakt på dagen day (yyyy-MM-dd), delat vid midnatt i riktig tid */
    fun offSeconds(day: java.time.LocalDate, zone: java.time.ZoneId, audio: Boolean = status.audio): Double {
        val a = day.atStartOfDay(zone).toEpochSecond().toDouble()
        val b = day.plusDays(1).atStartOfDay(zone).toEpochSecond().toDouble()
        return entries.filter { audio || !it.audio }.sumOf { max(0.0, min(b, it.end) - max(a, it.at.toDouble())) }
    }
}

/**
 * Får profilen spela nu? left = sekunder kvar (null = ingen gräns). reason "limit" (dagens tid slut) eller "window"
 * (utanför klockslagen) när det inte går – med det som behövs för samma besked som servern ger:
 * usedMinutes/totalMinutes ("du har tittat 60 av 60 minuter"), from/until och veckodagen (0 = söndag, som servern).
 */
data class ScreenGate(
    val allowed: Boolean, val left: Long?, val reason: String? = null,
    val usedMinutes: Int = 0, val totalMinutes: Int = 0, val from: String? = null, val until: String? = null, val weekday: Int = 0
)

object ScreenClock {
    /** Längsta glapp som räknas på en gång (som servern: längre glapp är paus eller avbrott) */
    const val CAP = 45.0
    /** En post blir högst så här lång – sedan börjar en ny (servern tar högst 4 timmar per post) */
    const val ENTRY_MAX = 3600.0
    /** Börjar nästa bit senare än så efter postens slut har det varit en paus: en ny post */
    const val GAP = 15.0
    /** Högst så många poster per anrop (som servern; resten skickas nästa gång) */
    const val SEND_MAX = 200
    /** Fler poster än så sparas inte (de äldsta släpps) */
    const val KEEP_MAX = 1000
    /** Äldre än så räknar servern inte (60 dygn) */
    const val KEEP_SECONDS = 60 * 86400L
    private val OK = ScreenGate(true, null)

    fun localDay(t: ZonedDateTime): String = t.toLocalDate().toString() // yyyy-MM-dd, som serverns localDay

    /** Ny status från servern: den räknade tiden ersätter appens, posterna servern inte fått räknas fortfarande av */
    fun fresh(status: ScreenStatus?, entries: List<ScreenEntry> = emptyList()): ScreenCache =
        ScreenCache(status ?: ScreenStatus(limited = false), entries)

    /**
     * seconds spelades fram till now utan kontakt (högst CAP per gång). Hänger biten ihop med senaste posten (samma
     * slag, ingen paus, posten kortare än ENTRY_MAX) växer den posten till now, annars börjar en ny. Posterna sparas
     * även när statusen säger ingen skärmtid – servern avgör (reglerna kan ha ändrats sedan).
     */
    fun addOffline(c: ScreenCache?, now: ZonedDateTime, seconds: Double, audio: Boolean = false): ScreenCache? {
        if (c == null || !(seconds > 0)) return c
        val nowS = now.toInstant().toEpochMilli() / 1000.0
        val start = nowS - min(CAP, seconds)
        val last = c.entries.lastOrNull()
        val list = c.entries.toMutableList()
        if (last != null && last.audio == audio && start <= last.end + GAP && nowS > last.at && nowS - last.at <= ENTRY_MAX) {
            list[list.size - 1] = last.copy(seconds = max(last.seconds, nowS - last.at))
        } else {
            val at = floor(if (last != null) max(start, last.end) else start).toLong()
            if (nowS - at <= 0) return c
            var id = "o$at"
            var k = 1
            while (list.any { it.id == id }) id = "o$at-${k++}"
            list.add(ScreenEntry(id, at, nowS - at, audio))
        }
        val oldest = nowS - KEEP_SECONDS
        return c.copy(entries = list.filter { it.end >= oldest }.takeLast(KEEP_MAX))
    }

    /** Posterna som skickas nu (de äldsta först, högst SEND_MAX) */
    fun batch(entries: List<ScreenEntry>): List<ScreenEntry> = entries.take(SEND_MAX)

    /**
     * Svaret på POST /api/screentime/offline: det servern listar i done tas bort – utom en post som vuxit sedan den
     * skickades (den skickas igen; servern räknar bara det nya).
     */
    fun ack(entries: List<ScreenEntry>, sent: List<ScreenEntry>, done: Collection<String>): List<ScreenEntry> {
        val ok = done.toHashSet()
        return entries.filter { e -> !(e.id in ok && sent.any { it == e }) }
    }

    /**
     * Flytt från äldre appversioner, som bara sparade summan för en dag (offDay, off sekunder). Tiden finns inte
     * hos servern, men inte heller när den spelades: den läggs sist på dagen den hör till (fram till now om det är i
     * dag), i poster om högst ENTRY_MAX, med id som inte ändras om flytten görs igen. Inget kan räknas två gånger:
     * servern räknar varje sekund en gång, och nya poster börjar efter now.
     */
    fun migrate(offDay: String?, off: Double, now: ZonedDateTime): List<ScreenEntry> {
        if (offDay == null || !(off > 0)) return emptyList()
        val day = runCatching { java.time.LocalDate.parse(offDay) }.getOrNull() ?: return emptyList()
        val dayStart = day.atStartOfDay(now.zone).toEpochSecond()
        val end = min(now.toEpochSecond(), day.plusDays(1).atStartOfDay(now.zone).toEpochSecond())
        if (end <= dayStart) return emptyList()
        var at = end - min(off, (end - dayStart).toDouble()).toLong()
        val out = mutableListOf<ScreenEntry>()
        while (at < end) {
            val len = min(ENTRY_MAX.toLong(), end - at)
            out.add(ScreenEntry("m$offDay-${out.size}", at, len.toDouble()))
            at += len
        }
        return out
    }

    /**
     * Samma dag som statusen gäller dess tid kvar och klockslag (med dagens extra tid); en ny dag samma dagliga gräns
     * och klockslag utan extra tid – veckodagarnas egna regler känner appen inte till utan nät. Klockslagen följer
     * väggklockan (som servern); tiden kvar till sluttiden räknas i riktig tid, så att sommartiden blir rätt.
     */
    fun gate(c: ScreenCache?, now: ZonedDateTime, audio: Boolean = false): ScreenGate {
        val s = c?.status ?: return OK
        if (!s.limited || (audio && !s.audio)) return OK
        val today = now.toLocalDate()
        val day = today.toString()
        val same = s.day == day
        val off = c.offSeconds(today, now.zone)
        val remaining = if (same) s.remaining?.let { it - off } else s.daily?.let { it * 60.0 - off }
        val from = toMin(s.from)
        var until = toMin(s.until)
        if (until != null && !same) until = max(0, until - s.extra) // statusens sluttid har dagens extra tid
        val nowMin = now.hour * 60 + now.minute + now.second / 60.0
        var inWindow = true
        var windowLeft: Long? = null
        if (from != null || until != null) {
            val f = from ?: 0
            val e = until ?: 1440
            if (f <= e) {
                inWindow = nowMin >= f && nowMin < e
                if (inWindow && until != null) windowLeft = secondsTo(now, today, e)
            } else { // över midnatt, t.ex. 20:00–02:00
                inWindow = nowMin >= f || nowMin < e
                if (inWindow && until != null) windowLeft = secondsTo(now, if (nowMin >= f) today.plusDays(1) else today, e)
            }
        }
        val weekday = now.dayOfWeek.value % 7
        if (remaining != null && remaining <= 0) {
            val used = (if (same) s.used else 0.0) + off
            val total = (s.daily ?: 0) + (if (same) s.extra else 0)
            return ScreenGate(false, 0, "limit", usedMinutes = Math.round(used / 60).toInt(), totalMinutes = total, weekday = weekday)
        }
        if (!inWindow) return ScreenGate(false, 0, "window", from = s.from, until = until?.let { hhmm(it) } ?: s.until, weekday = weekday)
        val r = remaining?.roundToLong()
        val left = if (r == null) windowLeft else if (windowLeft == null) r else min(r, windowLeft)
        return ScreenGate(true, left)
    }

    /** "HH:MM" i minuter (null om det inte är ett klockslag) */
    fun toMin(s: String?): Int? {
        val m = Regex("^(\\d{1,2}):(\\d{2})$").find(s ?: return null) ?: return null
        val h = m.groupValues[1].toInt(); val mm = m.groupValues[2].toInt()
        return if (h < 24 && mm < 60) h * 60 + mm else null
    }
    fun hhmm(m: Int) = String.format(Locale.ROOT, "%02d:%02d", (m / 60) % 24, m % 60)

    /** Sekunder (riktig tid) från now till klockslaget minutes på dagen date; 1440 = midnatt efter */
    private fun secondsTo(now: ZonedDateTime, date: LocalDate, minutes: Int): Long {
        val end = if (minutes >= 1440) date.plusDays(1).atStartOfDay(now.zone)
                  else ZonedDateTime.of(date, LocalTime.of(minutes / 60, minutes % 60), now.zone)
        return max(0L, Math.round(Duration.between(now, end).toMillis() / 1000.0))
    }
}
