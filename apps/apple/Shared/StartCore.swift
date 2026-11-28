import Foundation

// Snabbare start, utan SwiftUI och AVFoundation (bara Foundation – ren logik). Samma regler som Android-appen
// (StartCore.kt) och webben (warmPlay och earlyPlayback i web/js/player/video.js):
// 1. Förvärmning: när fokus har stått en stund på Spela, Fortsätt, Börja om eller ett avsnitt (Apple TV), och när
//    titelsidan öppnas (iPhone/iPad), skickas /playback?warm=1 med exakt samma fråga som uppspelningen sedan skickar.
//    Servern startar strömmen men räknar inget som uppspelning, och tar över den bara när den riktiga frågan ger samma
//    ström (warmSig i server/routes/playback.js) – annat ljudspår, annan kvalitet eller en annan adress (hemadressen
//    eller reläet) ger en ny ström, aldrig fel ström.
// 2. /playback skickas samtidigt som titelns uppgifter (/api/items/:id) i stället för efter. Frågan behöver ingenting
//    ur titelns svar: ljudspår och bildundertext kommer från valet på titelsidan, textundertexter skickas aldrig till
//    servern (spelaren väljer dem själv) och bio-läget (cinema=1) avgör servern efter kontots val och titelns typ
//    (bara filmer från början får trailers) – appen behöver inte fråga /api/me/cinema först.
// Anropen: Start.swift, DetailView.swift och Player.swift. Testas statiskt i test/apple-start.test.js.

enum StartCore {
    /// Så länge fokus ska stå kvar på en Spela-knapp innan strömmen förvärms (s). Med fjärrkontrollen rör man sig förbi
    /// knappar och avsnitt i snabb följd – de ska inte starta en ström var (servern har bara en förvärmd per profil).
    static let dwell: Double = 0.7

    /// Samma fråga förvärms högst så här ofta (s, som webben) – servern håller en förvärmd ström i 20 s
    static let repeatAfter: Double = 15

    /// Uppspelningens egna delar av frågan till /playback, utöver förmågorna och nattläge/dialog: bio-läge vid start
    /// från början (inte vid en omstart mitt i, cinema = false) och startpositionen (hela sekunder).
    static func playExtras(start: Double, cinema: Bool) -> [URLQueryItem] {
        var q: [URLQueryItem] = []
        if cinema && start < 1 { q.append(URLQueryItem(name: "cinema", value: "1")) }
        if start >= 1 { q.append(URLQueryItem(name: "start", value: String(Int(start)))) }
        return q
    }

    /// Förvärmningens fråga: uppspelningens fråga plus warm=1 (inget annat får skilja, då passar strömmen inte)
    static func warmQuery(_ play: [URLQueryItem]) -> [URLQueryItem] {
        play.filter { $0.name != "warm" } + [URLQueryItem(name: "warm", value: "1")]
    }

    /// Nyckeln som förvärmningen känns igen på: titeln och hela frågan (poster utan värde skickas inte)
    static func key(id: Int, _ query: [URLQueryItem]) -> String {
        "\(id)?" + query.compactMap { q in q.value.map { "\(q.name)=\($0)" } }.sorted().joined(separator: "&")
    }

    /// Vilka frågor som förvärmts och när: samma fråga högst var repeatAfter sekund
    struct WarmLog {
        private var at: [String: Double] = [:]
        private let repeatAfter: Double

        init(repeatAfter: Double = StartCore.repeatAfter) { self.repeatAfter = repeatAfter }

        /// true = förvärm nu (och kom ihåg det)
        mutating func take(_ key: String, now: Double) -> Bool {
            if let last = at[key], now - last < repeatAfter { return false }
            if at.count > 100 { at.removeAll() }
            at[key] = now
            return true
        }
    }

    /// Ljudspåret som titelsidan visar som valt: profilens förval (defaultAudio i titelns svar – samma regel som webben
    /// och Android-appen), annars filens förvalda spår, annars det första. Förut valdes filens förvalda spår, så
    /// profilens språk gällde inte (barn kunde få engelskt tal fast profilen vill ha svenskt).
    static func titleAudio<A>(defaultAudio: Int?, tracks: [A]?, index: (A) -> Int, isDefault: (A) -> Bool) -> Int? {
        guard let tracks = tracks, let first = tracks.first else { return nil }
        if let d = defaultAudio, let a = tracks.first(where: { index($0) == d }) { return index(a) }
        return index(tracks.first(where: isDefault) ?? first)
    }

    /// Ljudspåret i frågan till /playback (förvärmningen och uppspelningen): inget när valet är titelsidans förval –
    /// då väljer servern profilens språk i den fil som spelas (även när titeln har flera versioner), samma ström som
    /// förvärmningen och Spela på ett avsnitt ger. Ett eget val skickas.
    static func playAudio(chosen: Int?, preset: Int?) -> Int? {
        guard let c = chosen, c != preset else { return nil }
        return c
    }

    /// Titelns uppgifter och /playback samtidigt. playback körs i en egen uppgift som inte avbryts med spelaren, så att
    /// strömmen kan stoppas även om spelaren stängs eller titeln inte gick att hämta: blev svaret aldrig använt får drop
    /// det när det kommer. Fel i item eller playback kastas som förut.
    static func together<I, P: Sendable>(item: () async throws -> I,
                                         playback: @escaping () async throws -> P,
                                         drop: @escaping (P) async -> Void) async throws -> (I, P) {
        let pb = Task { try await playback() }
        do {
            let it = try await item()
            return (it, try await pb.value)
        } catch {
            // Titeln gick inte att hämta (eller /playback misslyckades): en ström som servern ändå startade stoppas
            Task { if let p = try? await pb.value { await drop(p) } }
            throw error
        }
    }
}
