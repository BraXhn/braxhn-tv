import Foundation

// Nästa avsnitt när avsnittet är slut, utan SwiftUI och AVFoundation (bara Foundation – ren logik). Kontots val
// *Spela nästa avsnitt automatiskt* kommer i svaret från /playback: autoNext = { enabled, countdown }
// (server/routes/playback.js). Samma regler som webben (nextPlan i web/js/player/autoskip.js), Expo-appen
// (nextPlan i apps/expo/src/skipcore.ts) och Android-appen (SkipCore.kt):
// - inget nästa avsnitt: spelaren stängs
// - valet är på och 0 s: nästa avsnitt startar direkt
// - valet är på: kortet "Nästa avsnitt om N s" med Spela nu och Avbryt (Apple TV: fokus på Spela nu, Menu = Avbryt)
// - valet är av: kortet "Nästa avsnitt" utan nedräkning, med Spela nu och Stäng (Apple TV: Menu = Stäng)
// - utan autoNext i svaret från en äldre server gäller 8 s som förut; en nedladdad titel har ingen /playback, och då
//   är valet inte känt: kortet utan nedräkning (en barnprofil med valet av får aldrig nästa avsnitt av sig självt)
// Nästa avsnitt förvärms (/playback?warm=1, Start.warm) när eftertexterna börjar och under nedräkningen, med samma fråga
// som uppspelningen sedan skickar. Anropen: Player.swift. Testas statiskt i test/apple-next.test.js.

/// autoNext i svaret från /playback. countdown tas emot som heltal, decimaltal eller text (som webbens parseInt), och
/// ett fält med fel typ ger nil i stället för att hela svaret inte går att läsa.
struct AutoNext: Decodable, Equatable {
    var enabled: Bool?
    var countdown: Double?

    init(enabled: Bool? = nil, countdown: Double? = nil) {
        self.enabled = enabled
        self.countdown = countdown
    }

    private enum CodingKeys: String, CodingKey { case enabled, countdown }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        enabled = try? c.decodeIfPresent(Bool.self, forKey: .enabled)
        if let i = try? c.decodeIfPresent(Int.self, forKey: .countdown) { countdown = Double(i) }
        else if let d = try? c.decodeIfPresent(Double.self, forKey: .countdown) { countdown = d }
        else if let s = try? c.decodeIfPresent(String.self, forKey: .countdown) { countdown = NextCore.leadingInt(s).map(Double.init) }
    }
}

enum NextCore {
    /// Nedräkningen när servern inte skickar autoNext (äldre server, nedladdad titel)
    static let fallback = 8
    /// Längsta nedräkningen (som webben)
    static let longest = 60

    /// auto = nästa avsnitt startar av sig självt efter seconds sekunder (0 = direkt)
    struct Plan: Equatable {
        let auto: Bool
        let seconds: Int
    }

    /// Som webbens nextPlan: nil = inget nästa avsnitt. Nedräkningen är 0–60 hela sekunder (decimaler kapas, som parseInt).
    static func plan(_ n: AutoNext?, hasNext: Bool) -> Plan? {
        guard hasNext else { return nil }
        guard let n else { return Plan(auto: true, seconds: fallback) }
        var s = fallback
        if let c = n.countdown, c.isFinite { s = Int(min(Double(longest), max(0, c))) }
        return Plan(auto: n.enabled == true, seconds: s)
    }

    /// Vad spelaren gör när avsnittet är slut
    enum End: Equatable {
        /// Inget nästa avsnitt: spelaren stängs
        case close
        /// Valet är på och 0 s: nästa avsnitt direkt
        case next
        /// Kortet: auto = "Nästa avsnitt om N s" med Spela nu och Avbryt; annars "Nästa avsnitt" utan nedräkning med
        /// Spela nu och Stäng (seconds = 0)
        case card(seconds: Int, auto: Bool)
    }

    /// Som webben och Android-appens SkipCore.atEnd. known = false: valet är inte känt (nedladdad titel utan /playback)
    static func end(_ n: AutoNext?, hasNext: Bool, known: Bool = true) -> End {
        guard let p = plan(n, hasNext: hasNext) else { return .close }
        guard known, p.auto else { return .card(seconds: 0, auto: false) }
        return p.seconds == 0 ? .next : .card(seconds: p.seconds, auto: true)
    }

    /// Nedräkningen i kortet: left sekunder kvar. tick() varje sekund; true = starta nästa avsnitt nu.
    struct Countdown: Equatable {
        private(set) var left: Int

        init(seconds: Int) { left = max(0, seconds) }

        mutating func tick() -> Bool {
            if left > 0 { left -= 1 }
            return left <= 0
        }
    }

    /// Eftertexterna går och det finns ett nästa avsnitt: förvärm det (Start.warm frågar högst var 15:e sekund, och
    /// servern håller den förvärmda strömmen i 20 s – så den hålls varm så länge eftertexterna går)
    static func warmsNext(skip: String?, nextKind: String) -> Bool { skip == nextKind }

    /// Heltalet först i texten, som JavaScripts parseInt ("12.7" → 12, " 5 s" → 5, "x" → nil)
    static func leadingInt(_ s: String) -> Int? {
        var t = s.drop(while: { $0 == " " || $0 == "\t" || $0 == "\n" })
        var sign = 1
        if let f = t.first, f == "+" || f == "-" { sign = f == "-" ? -1 : 1; t = t.dropFirst() }
        let digits = t.prefix(while: { $0.isASCII && $0.isNumber })
        guard !digits.isEmpty else { return nil }
        // Ett för stort tal blir inte ett fel: det kapas ändå till 0–60
        return sign * (Int(digits) ?? Int.max)
    }
}
