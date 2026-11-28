import Foundation
import Combine
import Network

// Hemma via den publika adressen: när appen är sparad med en publik adress (BraXhn Relay, en domän via routern) och
// står på hemnätet går den direkt till serverns hemadress – API, strömmar (AVPlayer) och bilder. Då kommer
// förfrågningarna från hemnätet, servern räknar uppspelningen som hemma (remote: false) och reläet slipper trafiken.
// Valet av adress står i LocalPick.swift; här bestäms när provet görs och vad som händer när hemadressen slutar svara.
// Samma regler som Android-appen (apps/automotive/…/Hemma.kt).
//
// - AppModel.server är adressen användaren sparade och ändras aldrig härifrån. apiBase är adressen som används just nu:
//   den sparade, eller en hemadress som svarat rätt på provet (id och proof exakt som i /api/local).
// - Provet görs när en server öppnas (start med sparad inloggning, inloggning), när appen kommer tillbaka till
//   förgrunden (högst var 30:e sekund) och när nätet byts (NWPathMonitor). Det körs i bakgrunden: tills det är klart
//   används den sparade adressen, så startsidan väntar inte.
// - Nätverksfel mot hemadressen (t.ex. utanför hemmet nu): tillbaka till den sparade adressen och ett nytt försök
//   (request() i AppModel, filmen i PlayerController).
//
// SÄKERHET: hemadressen är oftast http. Inloggningen (Authorization), bild- och strömtoken går bara till apiBase, och
// apiBase blir en hemadress först när den bevisat att den är just den här servern på hemnätet. Pingen skickas utan
// inloggning, utan kakor och följer inga omdirigeringar. Byts nätet slutar hemadressen gälla innan nästa förfrågan
// byggs, och filmen som spelas byter till adressen som gäller (en gammal hemadress skrivs om). Nedladdningar (iOS)
// använder alltid den sparade adressen: de fortsätter i bakgrunden, kanske på ett annat nät.

/// Hemadressen för en AppModel (lagras i AppModel.home och används bara från huvudtråden, som AppModel)
final class HomeState {
    /// Hemadressen som används just nu (visas i Inställningar), annars nil
    var via: String?
    /// Hemadresser som bekräftats under körningen – adresser som börjar så skrivs om när de inte längre gäller
    var proven = Set<String>()
    var gen = 0
    var lastCheck = Date.distantPast
    /// Nätets generation när hemadressen bekräftades: byts nätet gäller beviset inte längre
    var netGen = 0
    /// Prov som pågår: så länge mäts inte uppkopplingen (Bandwidth.kick) – appen kan vara hemma fast servern ännu
    /// ser anslutningen via den sparade adressen
    var checking = 0
    let net = HomeNet()
}

/// Bevakar nätet (NWPathMonitor). generation ökar vid varje ändring av nätet efter det första beskedet; den läses före
/// varje förfrågan, så den hålls med ett lås och uppdateras direkt på monitorns kö (inte först på huvudtråden).
final class HomeNet: @unchecked Sendable {
    private let lock = NSLock()
    private var key: String?
    private var gen = 0
    private var monitor: NWPathMonitor?

    var generation: Int { lock.lock(); defer { lock.unlock() }; return gen }

    /// Startar bevakningen en gång. changed anropas (på monitorns kö) när nätet ändrats.
    func start(_ changed: @escaping @Sendable () -> Void) {
        lock.lock(); defer { lock.unlock() }
        guard monitor == nil else { return }
        let m = NWPathMonitor()
        m.pathUpdateHandler = { [weak self] p in
            // Gränssnitt, vägar ut (gateways) och status: ett byte av Wi-Fi-nät går nästan alltid via en ändring här
            let ifs = p.availableInterfaces.map { "\($0.type):\($0.name)" }.joined(separator: ",")
            let gws = p.gateways.map { "\($0)" }.joined(separator: ",")
            if self?.update("\(p.status)|\(ifs)|\(gws)") == true { changed() }
        }
        m.start(queue: DispatchQueue(label: "net.braxhn.tv.home"))
        monitor = m
    }

    private func update(_ k: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let old = key else { key = k; return false }
        if old == k { return false }
        key = k
        gen += 1
        return true
    }
}

/// Pingen och /api/local: egen session utan kakor och cache, som inte följer omdirigeringar
enum HomePing {
    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 15
        return URLSession(configuration: c, delegate: NoRedirect(), delegateQueue: nil)
    }()

    /// Provanropet: utan inloggning, med kort tidsgräns. nil = inget eller fel svar.
    static func ping(_ url: URL, _ ms: Int) async -> LocalPing? {
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: Double(ms) / 1000)
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let pair = try? await session.data(for: r), (pair.1 as? HTTPURLResponse)?.statusCode == 200,
              pair.0.count <= 4096 else { return nil }
        return try? JSONDecoder().decode(LocalPing.self, from: pair.0)
    }

    /// GET /api/local från den sparade adressen (inloggad). Kastar vid fel (t.ex. en äldre server utan /api/local).
    static func info(_ saved: String, token: String) async throws -> LocalInfo {
        guard let u = URL(string: saved + "/api/local") else { throw URLError(.badURL) }
        var r = URLRequest(url: u)
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: r)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(LocalInfo.self, from: data)
    }
}

extension Notification.Name {
    /// Hemadressen slutade gälla (annat nät eller nätverksfel) – spelaren byter till adressen som gäller nu
    static let homeLeft = Notification.Name("net.braxhn.tv.homeLeft")
}

extension AppModel {
    /// Adressen att använda nu. Har nätet bytts sedan hemadressen bekräftades gäller den inte längre – kontrolleras före
    /// varje förfrågan, så att inget skickas till samma IP-adress på ett annat nät innan nätbytet hunnit anmälas.
    var apiBase: String {
        if home.via != nil, home.net.generation != home.netGen { leaveHome() }
        return home.via ?? server
    }

    /// Gör provet i bakgrunden. Utan force högst var 30:e sekund (appen tillbaka i förgrunden).
    func checkHome(force: Bool = false) {
        guard force || Date().timeIntervalSince(home.lastCheck) > 30 else { return }
        home.lastCheck = Date()
        Task {
            home.checking += 1
            await checkHomeNow()
            home.checking -= 1
            // Utanför hemmet: mät uppkopplingen i bakgrunden nu, inte när filmen startar (Bandwidth.swift)
            Bandwidth.kick(self)
        }
    }

    /// Byter till serverns hemadress när appen är hemma, annars tillbaka till den sparade. true = hemadressen används.
    @discardableResult
    func checkHomeNow() async -> Bool {
        home.net.start { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.leaveHome()
                self.checkHome(force: true)
            }
        }
        let saved = server, current = token
        home.gen += 1
        let g = home.gen
        home.lastCheck = Date()
        guard !saved.isEmpty, let tok = current, !LocalPick.isLocalURL(saved) else { return false }
        let netGen = home.net.generation
        guard let info = try? await HomePing.info(saved, token: tok) else { return home.via != nil }
        let hit = await LocalPick.pick(info) { u, ms in await HomePing.ping(u, ms) }
        // Servern, profilen eller ett nyare prov kom emellan: låt det gälla
        guard g == home.gen, saved == server, tok == token else { return home.via != nil }
        guard let hit, hit != saved, netGen == home.net.generation else { leaveHome(); return false }
        home.proven.insert(hit)
        home.netGen = netGen
        if home.via != hit {
            objectWillChange.send()
            home.via = hit
            // remote (Inställningar) följer med: nu räknar servern anslutningen som hemma
            await refreshUser()
        }
        return true
    }

    /// Tillbaka till den sparade adressen. true = hemadressen användes. Kan anropas medan en vy ritas (apiBase), så
    /// vyerna och spelaren får beskedet efteråt.
    @discardableResult
    func leaveHome() -> Bool {
        guard home.via != nil else { return false }
        home.via = nil
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.objectWillChange.send()
            NotificationCenter.default.post(name: .homeLeft, object: self)
            await self.refreshUser()
        }
        return true
    }

    /// Ny server: glöm hemadressen och avbryt prov som pågår
    func resetHome() {
        home.gen += 1
        leaveHome()
    }

    /// Ett nätverksfel mot u: var det hemadressen går appen tillbaka till den sparade. true = försök igen.
    func homeFailed(_ u: URL) -> Bool {
        guard let h = home.via, u.absoluteString.hasPrefix(h + "/") else { return false }
        return leaveHome()
    }

    /// En adress byggd med en hemadress som inte längre gäller → samma adress via den som gäller nu, annars nil
    func homeRewrite(_ u: URL) -> URL? {
        let s = u.absoluteString, r = LocalPick.rewrite(s, proven: home.proven, current: apiBase)
        return r == s ? nil : URL(string: r)
    }

    /// Relativ URL via den sparade adressen – för det som fortsätter utan appen (nedladdningar i bakgrunden)
    func savedAbsolute(_ relative: String) -> URL? { URL(string: server + relative) }
}
