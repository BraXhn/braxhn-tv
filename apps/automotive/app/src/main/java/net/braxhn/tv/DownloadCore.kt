package net.braxhn.tv

import kotlinx.serialization.Serializable

// Nedladdningar per server och profil, utan Android: vilken profil som ser vad, flytten av nedladdningar från före
// profilerna och vad som tas bort när servern svarar igen. Samma regler som Expo-appen (apps/expo/src/offline.ts,
// offlinecore.ts scopeOf och accessVerdict). Filer, DownloadManager och anrop sköter Offline.kt.
// Testas på JVM: app/src/test/.../DownloadCoreTest.kt

/** En nedladdad titel. file = filens namn i profilens mapp (offline/<server>-<profil>/) */
@Serializable data class DownloadRecord(val id: Int, val title: String, val subtitle: String, val file: String, val size: Long = 0)

object DownloadScope {
    /** Serverns del av namnet: bara bokstäver och siffror (samma som OfflineSync) */
    fun clean(server: String): String = server.replace(Regex("[^A-Za-z0-9]"), "").take(60)

    /** "server-profil": mappen och listan för en profil på en server */
    fun of(server: String, uid: Int): String = clean(server) + "-" + uid

    /** Hör mappen till servern (någon av dess profiler)? */
    fun ofServer(scope: String, server: String): Boolean = clean(server).isNotEmpty() && scope.startsWith(clean(server) + "-")

    fun sameServer(a: String, b: String): Boolean = clean(a).isNotEmpty() && clean(a) == clean(b)
}

/**
 * Nedladdningar från före profilerna (appversion 0.7.0 och äldre: en gemensam lista för alla profiler).
 * server = den sparade adressen och fp = fingeravtrycket av inloggningen ("" = utloggad) när appen uppdaterades.
 * ownerOnly = det går inte att veta vilken profil som laddade ner: bara huvudkontot får dem.
 */
@Serializable data class LegacyDownloads(val server: String, val fp: String, val ownerOnly: Boolean = false)

/** Vad som händer med de gamla nedladdningarna just nu */
sealed interface LegacyFate {
    /** Flyttas till profilens mapp och lista */
    data class Assign(val uid: Int) : LegacyFate
    /** Samma inloggning som vid uppdateringen men profilen är inte känd än (servern har inte svarat): visas som förut */
    data object ShowHere : LegacyFate
    /** Visas inte (en annan inloggning, eller väntar på att huvudkontot loggar in) */
    data object Hidden : LegacyFate
}

object DownloadMigration {
    /**
     * De gamla nedladdningarna hör till profilen som var inloggad när appen uppdaterades. Går det inte att veta (ingen
     * var inloggad, eller inloggningen byttes innan servern hann säga vilken profil den hörde till) får huvudkontot dem.
     *
     * server = den sparade adressen nu, fp = fingeravtrycket av inloggningen nu (null = utloggad), uidOf = profilen för
     * ett fingeravtryck om servern har sagt den, ownerUid = huvudkontot på den här servern om det är känt.
     * Ger det nya läget (ownerOnly kan ha slagits på, och ändras aldrig tillbaka) och vad som händer.
     */
    fun fate(l: LegacyDownloads, server: String, fp: String?, uidOf: (String) -> Int?, ownerUid: Int?): Pair<LegacyDownloads, LegacyFate> {
        var cur = l
        if (!cur.ownerOnly) {
            val uid = if (cur.fp.isNotEmpty()) uidOf(cur.fp) else null
            if (uid != null) return cur to LegacyFate.Assign(uid)
            if (cur.fp.isNotEmpty() && fp == cur.fp && DownloadScope.sameServer(server, cur.server)) return cur to LegacyFate.ShowHere
            // Inloggningen från uppdateringen finns inte längre (eller fanns aldrig) och dess profil blev aldrig känd
            if (fp != cur.fp) cur = cur.copy(ownerOnly = true)
            else return cur to LegacyFate.Hidden
        }
        return if (ownerUid != null && DownloadScope.sameServer(server, cur.server)) cur to LegacyFate.Assign(ownerUid)
               else cur to LegacyFate.Hidden
    }

    /**
     * Lägger de gamla posterna i profilens lista. En titel som profilen redan har behålls som den är (den gamla filen
     * behövs då inte). Ger den nya listan och posterna vars filer ska flyttas till profilens mapp.
     */
    fun merge(own: List<DownloadRecord>, legacy: List<DownloadRecord>): Pair<List<DownloadRecord>, List<DownloadRecord>> {
        val have = own.map { it.id }.toSet()
        val move = legacy.filter { it.id !in have }.distinctBy { it.id }
        return (own + move) to move
    }
}

/** Kontrollen av nedladdade titlar när servern svarar igen (som Expo-appens online()) */
object DownloadAccess {
    /** Högst så ofta per profil (6 timmar) */
    const val EVERY_MS = 6 * 3600_000L

    enum class Verdict { KEEP, REMOVE, STOP }

    fun due(lastMs: Long?, nowMs: Long): Boolean = lastMs == null || nowMs - lastMs >= EVERY_MS

    /**
     * Svaret på GET /api/items/:id. 403 (profilen får inte se titeln längre: åldersgräns, bibliotek, familjefilter) och
     * 404 (finns inte kvar): tas bort. Inget svar, utloggad (401 ger kod 0 i appen) eller för många anrop: sluta och
     * försök nästa gång. Annat (serverfel): behåll.
     */
    fun verdict(status: Int): Verdict = when (status) {
        403, 404 -> Verdict.REMOVE
        0, 401, 429 -> Verdict.STOP
        else -> Verdict.KEEP
    }

    /** Får kontot inte ladda ner längre (canDownload i /api/status) tas allt som profilen laddat ner bort */
    fun removeAll(canDownload: Boolean, count: Int): Boolean = !canDownload && count > 0
}
