import Foundation

// Hemma via den publika adressen (docs/api.md, /api/local): välj serverns adress på hemnätet när den svarar rätt.
// Samma regler som Expo-appen (apps/expo/src/localpick.ts) och Android-appen (LocalPick.kt). Bara Foundation här, så
// att valet går att prova utan app och utan nät. Hemma.swift sköter när provet görs och vilken adress som används.
//
// Servern ger (över den sparade, inloggade adressen) sina hemadresser och ett prov: n och proof. Hemadressens
// /api/local/ping?n=… svarar med samma id och proof bara när förfrågan kommer från hemnätet. En annan maskin med
// samma IP på ett annat nät kan inte svara rätt, så appen skickar sin inloggning dit först när beviset stämmer.

/// GET /api/local (inloggad, från den sparade adressen). Saknade fält blir tomma – då provas inget.
struct LocalInfo: Decodable, Sendable {
    var id = ""
    var here = false
    var addrs: [String] = []
    var n = ""
    var proof = ""

    init(id: String = "", here: Bool = false, addrs: [String] = [], n: String = "", proof: String = "") {
        self.id = id; self.here = here; self.addrs = addrs; self.n = n; self.proof = proof
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        here = (try? c.decode(Bool.self, forKey: .here)) ?? false
        addrs = (try? c.decode([String].self, forKey: .addrs)) ?? []
        n = (try? c.decode(String.self, forKey: .n)) ?? ""
        proof = (try? c.decode(String.self, forKey: .proof)) ?? ""
    }
    private enum CodingKeys: String, CodingKey { case id, here, addrs, n, proof }
}

/// GET <hemadress>/api/local/ping?n= (utan inloggning, svarar bara på hemnätet)
struct LocalPing: Decodable, Sendable {
    let id: String
    let proof: String
}

enum LocalPick {
    /// Så länge (ms) väntar appen på hemadressen innan den fortsätter med den sparade
    static let probeMs = 800
    /// Högst så många adresser provas (servern ger högst fyra)
    static let maxAddrs = 4

    private static let privateV4 = "^(10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|127\\.)[0-9]{1,3}\\.[0-9]{1,3}(\\.[0-9]{1,3})?$"
    /// Bara origin: http(s)://värd[:port], utan sökväg, frågesträng eller inloggningsuppgifter
    private static let origin = "^https?://[^/\\s?#@\\\\]+$"

    private static func host(_ url: String) -> String? {
        guard let h = URLComponents(string: url.trimmingCharacters(in: .whitespaces))?.host?.lowercased(), !h.isEmpty else { return nil }
        return h.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    }

    /// Är adressen redan en adress i hemnätet (IP i privata nät, .local/.lan/.home eller ett namn utan punkt)?
    static func isLocalURL(_ url: String) -> Bool {
        guard let h = host(url) else { return false }
        if h.range(of: privateV4, options: .regularExpression) != nil { return true }
        return h == "localhost" || !h.contains(".") || h.hasSuffix(".local") || h.hasSuffix(".lan") || h.hasSuffix(".home")
    }

    /// Enhetens egen adress (127.x, localhost) är aldrig servern
    private static func isLoopback(_ url: String) -> Bool {
        guard let h = host(url) else { return true }
        return h == "localhost" || h.hasPrefix("127.")
    }

    /**
     Adresserna ur svaret som får provas: bara origin, inga dubbletter, högst maxAddrs. http bara till adresser i
     hemnätet (privat IP, .local/.lan/.home, namn utan punkt) – appen tillåter http i ATS för alla värdar (användare sparar
     servern med http i hemnätet), så begränsningen görs här. https får vara vilken värd som helst (certifikatet kontrolleras).
     */
    static func candidates(_ info: LocalInfo) -> [String] {
        var out: [String] = []
        for raw in info.addrs {
            let a = raw.trimmingCharacters(in: .whitespaces)
            guard a.range(of: origin, options: [.regularExpression, .caseInsensitive]) != nil, !isLoopback(a) else { continue }
            guard a.lowercased().hasPrefix("https://") || isLocalURL(a) else { continue }
            if !out.contains(a) { out.append(a) }
            if out.count == maxAddrs { break }
        }
        return out
    }

    /// Stämmer svaret från pingen exakt med serverns id och provets bevis?
    static func matches(_ info: LocalInfo, _ r: LocalPing?) -> Bool {
        guard let r else { return false }
        return !info.id.isEmpty && !info.proof.isEmpty && r.id == info.id && r.proof == info.proof
    }

    /// Pingens adress på en hemadress (n kodas i frågesträngen)
    static func pingURL(_ base: String, n: String) -> URL? {
        guard var c = URLComponents(string: base + "/api/local/ping") else { return nil }
        c.queryItems = [URLQueryItem(name: "n", value: n)]
        // + kodas inte av URLComponents men betyder mellanslag på servern
        c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return c.url
    }

    /**
     En adress som byggts med en bekräftad hemadress (proven) som inte används längre får adressen som gäller nu
     (current: den sparade eller en annan hemadress). Allt annat lämnas som det är.
     */
    static func rewrite(_ url: String, proven: Set<String>, current: String) -> String {
        guard !current.isEmpty else { return url }
        for h in proven where h != current && !h.isEmpty {
            if url == h || url.hasPrefix(h + "/") || url.hasPrefix(h + "?") { return current + String(url.dropFirst(h.count)) }
        }
        return url
    }

    private enum Probe: Sendable { case hit(String), miss, timeout }

    /**
     Provar alla hemadresser samtidigt. Svaret är den första som svarar med serverns id och rätt bevis inom ms, annars
     nil (servern nås redan hemifrån, inga adresser, fel svar eller inget svar i tid). get hämtar pingen utan inloggning
     och med tidsgräns (ms); nil = inget svar. De andra försöken avbryts när svaret är klart.
     */
    static func pick(_ info: LocalInfo?, ms: Int = probeMs, get: @escaping @Sendable (URL, Int) async -> LocalPing?) async -> String? {
        guard let info, !info.here, !info.id.isEmpty, !info.n.isEmpty, !info.proof.isEmpty else { return nil }
        let tries = candidates(info).compactMap { a in pingURL(a, n: info.n).map { (a, $0) } }
        if tries.isEmpty { return nil }
        return await withTaskGroup(of: Probe.self) { g in
            for (a, u) in tries {
                g.addTask {
                    let r = await get(u, ms)
                    return LocalPick.matches(info, r) ? Probe.hit(a) : Probe.miss
                }
            }
            g.addTask {
                try? await Task.sleep(nanoseconds: UInt64(ms + 50) * 1_000_000)
                return .timeout
            }
            var left = tries.count
            for await r in g {
                switch r {
                case .hit(let a): g.cancelAll(); return a
                case .timeout: g.cancelAll(); return nil
                case .miss:
                    left -= 1
                    if left == 0 { g.cancelAll(); return nil }
                }
            }
            return nil
        }
    }
}
