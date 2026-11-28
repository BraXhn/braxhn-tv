import Foundation

// Nedladdningar per server och profil, positioner som väntar på nätet och skärmtiden utan nät – utan filer, nät eller
// SwiftUI. Samma regler som Android-appen (apps/automotive/.../DownloadCore.kt och OfflineCore.kt ProgressQueue och
// ScreenClock) och Expo-appen (apps/expo/src/offlinecore.ts scopeOf, progressRequest, ackSent, screenGate). Filerna, bakgrundssessionen och anropen sköter
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

// MARK: - Skärmtid utan nät

// Servern räknar skärmtiden (server/screentime.js) och säger stopp i svaret på framstegen. Utan nät följer appen den
// senaste statusen den fick (GET /api/screentime eller screenTime i framstegssvaret) och räknar själv tiden som spelats
// utan kontakt. Servern räknar inte framsteg som skickas i efterhand (med at), så den tiden finns bara i appen. Samma
// regler som Android-appens ScreenClock (OfflineCore.kt) och Expo-appens screenGate (offlinecore.ts).

/// Serverns status (GET /api/screentime, screenTime i framstegssvaret). remaining och used i sekunder, daily i minuter.
/// Fält som saknas (t.ex. { limited: false }) får sina standardvärden.
struct ScreenStatus: Codable, Equatable {
    var limited: Bool
    var day: String?
    var daily: Int?
    var used: Double
    var extra: Int
    var remaining: Double?
    var from: String?
    var until: String?
    var audio: Bool

    init(limited: Bool = false, day: String? = nil, daily: Int? = nil, used: Double = 0, extra: Int = 0,
         remaining: Double? = nil, from: String? = nil, until: String? = nil, audio: Bool = false) {
        self.limited = limited
        self.day = day
        self.daily = daily
        self.used = used
        self.extra = extra
        self.remaining = remaining
        self.from = from
        self.until = until
        self.audio = audio
    }

    private enum CodingKeys: String, CodingKey { case limited, day, daily, used, extra, remaining, from, until, audio }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        /// Tal som servern skickar som heltal eller decimaltal
        func num(_ k: CodingKeys) -> Double? {
            if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
            return try? c.decodeIfPresent(Double.self, forKey: k)
        }
        limited = (try? c.decodeIfPresent(Bool.self, forKey: .limited)) ?? false
        day = try? c.decodeIfPresent(String.self, forKey: .day)
        daily = num(.daily).map { Int($0.rounded()) }
        used = num(.used) ?? 0
        extra = num(.extra).map { Int($0.rounded()) } ?? 0
        remaining = num(.remaining)
        from = try? c.decodeIfPresent(String.self, forKey: .from)
        until = try? c.decodeIfPresent(String.self, forKey: .until)
        audio = (try? c.decodeIfPresent(Bool.self, forKey: .audio)) ?? false
    }
}

/// Senaste statusen och tiden som spelats utan kontakt sedan dess (för dagen offDay, yyyy-MM-dd)
struct ScreenCache: Codable, Equatable {
    var status: ScreenStatus
    var offDay: String? = nil
    var offSeconds: Double = 0
}

/// Får profilen spela nu? left = sekunder kvar (nil = ingen gräns). reason "limit" (dagens tid slut) eller "window"
/// (utanför klockslagen) när det inte går – med det som behövs för samma besked som servern ger: usedMinutes och
/// totalMinutes ("du har tittat 60 av 60 minuter"), from/until och veckodagen (0 = söndag, som servern).
struct ScreenGate: Equatable {
    var allowed: Bool
    var left: Int?
    var reason: String? = nil
    var usedMinutes = 0
    var totalMinutes = 0
    var from: String? = nil
    var until: String? = nil
    var weekday = 0
}

enum ScreenClock {
    /// Längsta glapp som räknas på en gång (som servern: längre glapp är paus eller avbrott)
    static let cap: Double = 45
    static let ok = ScreenGate(allowed: true, left: nil)

    /// Kalendern som dagarna och klockslagen räknas i: gregoriansk i enhetens tidszon (som serverns lokala tid)
    static func calendar(_ zone: TimeZone = .current) -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = zone
        return c
    }

    /// yyyy-MM-dd, som serverns localDay
    static func localDay(_ d: Date, _ cal: Calendar) -> String {
        let c = cal.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Ny status från servern: den räknade tiden ersätter det som räknats i appen. nil/saknas = ingen skärmtid.
    static func fresh(_ status: ScreenStatus?) -> ScreenCache { ScreenCache(status: status ?? ScreenStatus(limited: false)) }

    /// Lägger till tid som spelats utan kontakt, på dagen den spelades (högst cap sekunder per gång)
    static func addOffline(_ c: ScreenCache?, now: Date, seconds: Double, calendar cal: Calendar = ScreenClock.calendar()) -> ScreenCache? {
        guard var c, c.status.limited, seconds > 0 else { return c }
        let day = localDay(now, cal)
        let prev = c.offDay == day ? c.offSeconds : 0
        c.offDay = day
        c.offSeconds = prev + min(cap, seconds)
        return c
    }

    /**
     * Samma dag som statusen gäller dess tid kvar och klockslag (med dagens extra tid); en ny dag samma dagliga gräns
     * och klockslag utan extra tid – veckodagarnas egna regler känner appen inte till utan nät. Klockslagen följer
     * väggklockan (som servern); tiden kvar till sluttiden räknas i riktig tid, så att sommartiden blir rätt.
     */
    static func gate(_ c: ScreenCache?, now: Date, calendar cal: Calendar = ScreenClock.calendar(), audio: Bool = false) -> ScreenGate {
        guard let c else { return ok }
        let s = c.status
        if !s.limited || (audio && !s.audio) { return ok }
        let day = localDay(now, cal)
        let same = s.day == day
        let off = c.offDay == day ? c.offSeconds : 0
        let remaining: Double? = same ? s.remaining.map { $0 - off } : s.daily.map { Double($0) * 60 - off }
        let from = toMin(s.from)
        var until = toMin(s.until)
        if let u = until, !same { until = max(0, u - s.extra) } // statusens sluttid har dagens extra tid
        let hms = cal.dateComponents([.hour, .minute, .second], from: now)
        let nowMin = Double((hms.hour ?? 0) * 60 + (hms.minute ?? 0)) + Double(hms.second ?? 0) / 60
        var inWindow = true
        var windowLeft: Int?
        if from != nil || until != nil {
            let f = from ?? 0
            let e = until ?? 1440
            if f <= e {
                inWindow = nowMin >= Double(f) && nowMin < Double(e)
                if inWindow, until != nil { windowLeft = secondsTo(now, days: 0, minutes: e, cal) }
            } else { // över midnatt, t.ex. 20:00–02:00
                inWindow = nowMin >= Double(f) || nowMin < Double(e)
                if inWindow, until != nil { windowLeft = secondsTo(now, days: nowMin >= Double(f) ? 1 : 0, minutes: e, cal) }
            }
        }
        let weekday = (cal.component(.weekday, from: now) + 6) % 7 // söndag = 0, som servern
        if let r = remaining, r <= 0 {
            let used = (same ? s.used : 0) + off
            let total = (s.daily ?? 0) + (same ? s.extra : 0)
            return ScreenGate(allowed: false, left: 0, reason: "limit", usedMinutes: Int((used / 60).rounded()), totalMinutes: total, weekday: weekday)
        }
        if !inWindow {
            return ScreenGate(allowed: false, left: 0, reason: "window", from: s.from, until: until.map { hhmm($0) } ?? s.until, weekday: weekday)
        }
        let r = remaining.map { Int($0.rounded()) }
        let left: Int?
        if let r, let w = windowLeft { left = min(r, w) } else { left = r ?? windowLeft }
        return ScreenGate(allowed: true, left: left)
    }

    /// "HH:MM" i minuter (nil om det inte är ett klockslag)
    static func toMin(_ s: String?) -> Int? {
        guard let s else { return nil }
        let p = s.split(separator: ":", omittingEmptySubsequences: false)
        guard p.count == 2, (1...2).contains(p[0].count), p[1].count == 2,
              p[0].allSatisfy({ $0.isASCII && $0.isNumber }), p[1].allSatisfy({ $0.isASCII && $0.isNumber }),
              let h = Int(p[0]), let m = Int(p[1]), h < 24, m < 60 else { return nil }
        return h * 60 + m
    }

    static func hhmm(_ m: Int) -> String { String(format: "%02d:%02d", (m / 60) % 24, m % 60) }

    /// Sekunder (riktig tid) från now till klockslaget minutes på dagen days dagar fram; 1440 = midnatt efter
    static func secondsTo(_ now: Date, days: Int, minutes: Int, _ cal: Calendar) -> Int {
        let start = cal.startOfDay(for: now)
        guard let date = cal.date(byAdding: .day, value: days + (minutes >= 1440 ? 1 : 0), to: start) else { return 0 }
        var end = date
        if minutes < 1440 {
            var dc = cal.dateComponents([.year, .month, .day], from: date)
            dc.hour = minutes / 60
            dc.minute = minutes % 60
            end = cal.date(from: dc) ?? date
        }
        return max(0, Int(end.timeIntervalSince(now).rounded()))
    }
}
