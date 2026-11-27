import Foundation

// Nedladdningar per server och profil, och positioner som väntar på nätet – utan filer, nät eller SwiftUI. Samma
// regler som Android-appen (apps/automotive/.../DownloadCore.kt och OfflineCore.kt ProgressQueue) och Expo-appen
// (apps/expo/src/offlinecore.ts scopeOf, progressRequest, ackSent). Filerna, bakgrundssessionen och anropen sköter
// Offline.swift. Swift kompileras inte här: test/apple-offline.test.js kontrollerar reglerna statiskt.

/// En nedladdad titel. file = filens namn i profilens mapp (Downloads/<server>-<profil>/)
struct DownloadRecord: Codable, Identifiable, Hashable {
    let id: Int
    let title: String
    let subtitle: String
    let duration: Double?
    let file: String
    let size: Int64
}

enum DownloadScope {
    /// Serverns del av namnet: bara bokstäver och siffror
    static func clean(_ server: String) -> String {
        String(server.filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(60))
    }

    /// "server-profil": mappen och listan för en profil på en server
    static func of(server: String, uid: Int) -> String { clean(server) + "-" + String(uid) }

    /// Hör mappen till servern (någon av dess profiler)?
    static func ofServer(_ scope: String, server: String) -> Bool {
        let c = clean(server)
        return !c.isEmpty && scope.hasPrefix(c + "-")
    }

    static func sameServer(_ a: String, _ b: String) -> Bool {
        let c = clean(a)
        return !c.isEmpty && c == clean(b)
    }
}

/// Bakgrundsnedladdningens märkning (taskDescription): "id" för de gamla från före profilerna, annars "id profil".
/// Märkningen följer med filen, så att den hamnar hos profilen som startade nedladdningen även om en annan är inloggad nu.
enum DownloadTag {
    static func make(id: Int, scope: String) -> String { scope.isEmpty ? String(id) : "\(id) \(scope)" }

    static func parse(_ s: String?) -> (id: Int, scope: String)? {
        guard let s, !s.isEmpty else { return nil }
        let parts = s.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)
        guard let id = Int(parts[0]), id > 0 else { return nil }
        return (id, parts.count > 1 ? String(parts[1]) : "")
    }
}

/// Nedladdningar från före profilerna (en gemensam lista för alla). server = den sparade adressen och fp =
/// fingeravtrycket av inloggningen ("" = utloggad) när appen uppdaterades. ownerOnly = det går inte att veta vilken
/// profil som laddade ner: bara huvudkontot får dem.
struct LegacyDownloads: Codable, Equatable {
    var server: String
    var fp: String
    var ownerOnly: Bool = false
}

/// Vad som händer med de gamla nedladdningarna just nu
enum LegacyFate: Equatable {
    /// Flyttas till profilens mapp och lista
    case assign(Int)
    /// Samma inloggning som vid uppdateringen men profilen är inte känd än (servern har inte svarat): visas som förut
    case showHere
    /// Visas inte (en annan inloggning, eller väntar på att huvudkontot loggar in)
    case hidden
}

enum DownloadMigration {
    /// De gamla nedladdningarna hör till profilen som var inloggad när appen uppdaterades. Går det inte att veta (ingen
    /// var inloggad, eller inloggningen byttes innan servern hann säga vilken profil den hörde till) får huvudkontot dem.
    /// server = den sparade adressen nu, fp = inloggningen nu (nil = utloggad), uidOf = profilen för ett fingeravtryck
    /// om servern har sagt den, ownerUid = huvudkontot på servern om det är känt. ownerOnly ändras aldrig tillbaka.
    static func fate(_ l: LegacyDownloads, server: String, fp: String?, uidOf: (String) -> Int?, ownerUid: Int?) -> (LegacyDownloads, LegacyFate) {
        var cur = l
        if !cur.ownerOnly {
            if !cur.fp.isEmpty, let uid = uidOf(cur.fp) { return (cur, .assign(uid)) }
            if !cur.fp.isEmpty, fp == cur.fp, DownloadScope.sameServer(server, cur.server) { return (cur, .showHere) }
            // Inloggningen från uppdateringen finns inte längre (eller fanns aldrig) och dess profil blev aldrig känd
            if fp != cur.fp { cur.ownerOnly = true } else { return (cur, .hidden) }
        }
        if let o = ownerUid, DownloadScope.sameServer(server, cur.server) { return (cur, .assign(o)) }
        return (cur, .hidden)
    }

    /// Lägger de gamla posterna i profilens lista. En titel som profilen redan har behålls som den är (den gamla filen
    /// behövs inte). Ger den nya listan och posterna vars filer ska flyttas till profilens mapp.
    static func merge(own: [DownloadRecord], legacy: [DownloadRecord]) -> (list: [DownloadRecord], move: [DownloadRecord]) {
        var have = Set(own.map { $0.id })
        var move: [DownloadRecord] = []
        for r in legacy where !have.contains(r.id) { have.insert(r.id); move.append(r) }
        return (own + move, move)
    }
}

// MARK: - Positioner som väntar på nätet

/// Position som inte kom fram till servern: skickas med at (Unix-sekunder) när nätet är tillbaka
struct PendingProgress: Codable, Equatable {
    let id: Int
    let position: Int64
    let duration: Double
    let at: Int64
    let kind: String
    var speed: Double? = nil
}

enum ProgressQueue {
    static let item = "item"
    static let book = "book"
    static let pod = "pod"
    /// Fler väntande titlar än så sparas inte (de äldsta släpps)
    static let max = 200
    /// Äldre än så skickas inte längre (60 dygn)
    static let maxAge: Int64 = 60 * 86400

    /// En post per titel (och slag), den senaste gäller. Kön står i den ordning positionerna sparades. now = när
    /// positionen gällde: ett anrop som startade före en position som redan sparats ersätter inte den nyare.
    static func record(_ list: [PendingProgress], id: Int, position: Double, duration: Double, kind: String,
                       speed: Double? = nil, now: Date) -> [PendingProgress] {
        let at = Int64(now.timeIntervalSince1970)
        let p = PendingProgress(id: id, position: Int64(Swift.max(0, position.isFinite ? position : 0).rounded()),
                                duration: duration > 0 && duration.isFinite ? duration : 0, at: at, kind: kind, speed: speed)
        if let old = list.first(where: { $0.id == id && $0.kind == kind }), old.at > p.at { return prune(list, now: now) }
        return prune(list.filter { $0.id != id || $0.kind != kind } + [p], now: now)
    }

    /// Ordning (äldst först), högst max poster och inga som är för gamla
    static func prune(_ list: [PendingProgress], now: Date) -> [PendingProgress] {
        let t = Int64(now.timeIntervalSince1970)
        return Array(list.filter { t - $0.at <= maxAge }.sorted { $0.at < $1.at }.suffix(max))
    }

    static func path(kind: String, id: Int) -> String {
        switch kind {
        case book: return "/api/audiobooks/book/\(id)/progress"
        case pod: return "/api/podcasts/episodes/\(id)/progress"
        default: return "/api/items/\(id)/progress"
        }
    }

    /// Kroppen i POST …/progress. Servern behåller ett senare framsteg från en annan enhet (at) för filmer, avsnitt och
    /// ljudböcker; poddavsnittens framsteg tar inte emot at än (server/podcasts.js) – där gäller den som kommer fram sist.
    static func body(_ p: PendingProgress) -> [String: Any] {
        var b: [String: Any] = ["position": p.position, "at": p.at]
        if p.kind == item, p.duration > 0 { b["duration"] = p.duration }
        if p.kind == book, let s = p.speed, s > 0 { b["speed"] = s }
        return b
    }

    /// Klart med posten: servern tog emot den (även som för gammal), eller titeln finns inte / får inte ses längre
    static func finished(_ status: Int) -> Bool { (200..<300).contains(status) || status == 403 || status == 404 }

    /// Bara just den skickade posten tas bort: har en nyare position sparats under tiden ligger den kvar
    static func ack(_ list: [PendingProgress], sent: PendingProgress, status: Int) -> [PendingProgress] {
        finished(status) ? list.filter { $0 != sent } : list
    }

    /// Skicka nästa i kön? Inget svar (0), utloggad, för många anrop eller serverfel: vänta till nästa gång
    static func keepGoing(_ status: Int) -> Bool { status != 0 && status != 401 && status != 429 && status < 500 }
}

// MARK: - Kontrollen av nedladdade titlar när servern svarar igen

enum DownloadAccess {
    /// Högst så ofta per profil (6 timmar)
    static let every: TimeInterval = 6 * 3600

    enum Verdict: Equatable { case keep, remove, stop }

    static func due(last: Date?, now: Date) -> Bool {
        guard let last else { return true }
        return now.timeIntervalSince(last) >= every
    }

    /// Svaret på GET /api/items/:id. 403 (profilen får inte se titeln längre: åldersgräns, bibliotek, familjefilter) och
    /// 404 (finns inte kvar): tas bort. Inget svar, utloggad eller för många anrop: sluta och försök nästa gång.
    /// Annat (serverfel): behåll.
    static func verdict(_ status: Int) -> Verdict {
        switch status {
        case 403, 404: return .remove
        case 0, 401, 429: return .stop
        default: return .keep
        }
    }

    /// Får kontot inte ladda ner längre (canDownload i /api/status) tas allt som profilen laddat ner bort
    static func removeAll(canDownload: Bool, count: Int) -> Bool { !canDownload && count > 0 }
}
