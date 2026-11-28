import Foundation
import Security
import AVFoundation

/// Håller serveradress, inloggning och gör alla API-anrop.
@MainActor
final class AppModel: ObservableObject {
    /// Den sparade adressen (ändras bara av inloggningen). Förfrågningarna går till apiBase (Hemma.swift).
    @Published var server: String = UserDefaults.standard.string(forKey: "server") ?? "" { didSet { if server != oldValue { resetHome() } } }
    @Published private(set) var token: String? = Keychain.read("token")
    @Published var user: UserInfo? { didSet { OfflineProfile.changed(self) } } // nedladdningar och köade positioner per profil
    /// Kortlivad token som bara gäller bilder (bild-URL:er kan inte skicka Authorization-header). Sparas i nyckelringen
    /// per server och profil (ImageTokenBook längst ned i filen) och förnyas bara när den snart går ut eller servern svarar 401.
    @Published private(set) var imageToken: String?
    /// När bildtoken i minnet slutar gälla (unix-sekunder) och vems den är ("server profil-id")
    private var imageTokenUntil: Double = 0
    private var imageTokenOwner: String?
    /// Hämtningen som pågår (flera vyer frågar samtidigt vid start – bara en ny token) och senaste 401-kontrollen
    private var imageTokenTask: Task<Void, Never>?
    private var imageTokenGen = 0
    private var imageCheckedAt = Date.distantPast
    @Published var quality: String = UserDefaults.standard.string(forKey: "quality") ?? "auto" {
        didSet { UserDefaults.standard.set(quality, forKey: "quality") }
    }
    @Published var subtitleLang: String = UserDefaults.standard.string(forKey: "sublang") ?? "" {
        didSet { UserDefaults.standard.set(subtitleLang, forKey: "sublang") }
    }
    /// Servern ser anslutningen som utanför hemmet (t.ex. via BraXhn Relay) – kvaliteten kan vara begränsad
    @Published private(set) var remote = false
    /// Donationslänk från servern (donateUrl i /api/status) – bara https till paypal.com/paypal.me, annars nil
    @Published private(set) var donateURL: URL?
    /// Meddelande som visas som en ruta över flikarna (t.ex. när skärmtiden pausade en ljudbok)
    @Published var notice: String?

    var isLoggedIn: Bool { token != nil && !server.isEmpty }
    /// Hemma via den publika adressen: hemadressen som används just nu (Hemma.swift)
    let home = HomeState()

    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 30
        c.httpCookieStorage = nil
        return URLSession(configuration: c)
    }()

    // MARK: URL:er

    func normalized(_ s: String) -> String {
        var s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") { s = "http://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        // Lägg till standardport om ingen port och vanlig http
        if let u = URL(string: s), u.port == nil, u.scheme == "http", u.host != nil, u.path.isEmpty { s += ":8420" }
        return s
    }

    func url(_ path: String, _ query: [URLQueryItem] = []) -> URL? {
        guard var c = URLComponents(string: apiBase + path) else { return nil }
        if !query.isEmpty { c.queryItems = (c.queryItems ?? []) + query }
        return c.url
    }

    /// Relativ URL från servern (t.ex. strömmar) → absolut. Token finns redan med i strömmarnas URL:er.
    func absolute(_ relative: String) -> URL? { URL(string: apiBase + relative) }

    func imageURL(_ item: MediaItem, landscape: Bool = false) -> URL? {
        let type: String?
        if landscape { type = item.thumb ? "thumb" : item.backdrop ? "backdrop" : item.poster ? "poster" : nil }
        else { type = item.poster ? "poster" : item.thumb ? "thumb" : nil }
        guard let t = type, let tok = imageToken else { return nil }
        return url("/api/image/\(item.id)/\(t)", [URLQueryItem(name: "t", value: tok)])
    }

    func backdropURL(_ item: MediaItem) -> URL? {
        guard item.backdrop, let tok = imageToken else { return nil }
        return url("/api/image/\(item.id)/backdrop", [URLQueryItem(name: "t", value: tok)])
    }

    // MARK: Anrop

    private func request(_ path: String, method: String = "GET", query: [URLQueryItem] = [], body: [String: Any]? = nil) async throws -> Data {
        guard let u = url(path, query) else { throw APIError(message: L("Ogiltig serveradress")) }
        var r = URLRequest(url: u)
        r.httpMethod = method
        if let t = token { r.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        if let b = body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: b)
        }
        let pair: (Data, URLResponse)
        do { pair = try await session.data(for: r) } catch {
            // Hemadressen svarar inte (t.ex. utanför hemmet nu): samma anrop via den sparade adressen
            if !isCancellation(error), homeFailed(u) { return try await request(path, method: method, query: query, body: body) }
            throw networkError(error)
        }
        let (data, resp) = pair
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 && token != nil && path != "/api/login" && path != "/api/media-token" && path != "/api/profiles/switch" { logout(); throw APIError(message: L("Du har loggats ut")) }
        if !(200..<300).contains(code) {
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            // Serverns egen förklaring går först (t.ex. 429 vid gissningsspärren, 503/507 när databasen inte kan skrivas)
            let msg = (obj?["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            throw APIError(message: msg ?? httpErrorText(code), need2fa: (obj?["need2fa"] as? Bool) ?? false, needPin: (obj?["needPin"] as? Bool) ?? false,
                           needPassword: (obj?["needPassword"] as? Bool) ?? false, status: code, code: obj?["code"] as? String)
        }
        return data
    }

    func get<T: Decodable>(_ path: String, _ query: [URLQueryItem] = []) async throws -> T {
        let data = try await request(path, query: query)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch is DecodingError {
            // Oväntad form på svaret (t.ex. en mycket gammal eller ny server) – aldrig en krasch, ett begripligt fel
            throw APIError(message: L("Servern svarade med något som appen inte förstår. Uppdatera appen eller servern."))
        }
    }

    /// Rå data från ett autentiserat anrop (t.ex. undertexter för nedladdade filer)
    func data(_ path: String) async throws -> Data {
        try await request(path)
    }

    @discardableResult
    func post(_ path: String, _ body: [String: Any] = [:]) async throws -> Data {
        try await request(path, method: "POST", body: body)
    }

    @discardableResult
    func put(_ path: String, _ body: [String: Any] = [:]) async throws -> Data {
        try await request(path, method: "PUT", body: body)
    }

    // MARK: Inloggning

    func login(server s: String, name: String, password: String, code: String? = nil) async throws {
        let base = try await resolveServer(s)
        server = base
        let status: ServerStatus = try await get("/api/status")
        if status.needsSetup { throw APIError(message: L("Servern är inte konfigurerad än – öppna den i en webbläsare först.")) }
        var body: [String: Any] = ["name": name, "password": password, "app": true]
        if let c = code, !c.isEmpty { body["code"] = c }
        let data = try await request("/api/login", method: "POST", body: body)
        let r = try JSONDecoder().decode(LoginResponse.self, from: data)
        UserDefaults.standard.set(base, forKey: "server")
        Keychain.save("token", r.token)
        token = r.token
        user = r.user
        await refreshImageToken()
        await refreshUser()
    }

    /// Ser till att det finns en bildtoken som gäller minst ett dygn till: den i minnet, den sparade för servern och
    /// profilen, annars en ny (loadImageToken längst ned i filen). force = den sparade fungerar inte längre (401).
    func refreshImageToken(force: Bool = false) async {
        if let running = imageTokenTask {
            await running.value
            if !force { return }
        }
        imageTokenGen &+= 1
        let gen = imageTokenGen
        let task = Task { await self.loadImageToken(force: force) }
        imageTokenTask = task
        await task.value
        if imageTokenGen == gen { imageTokenTask = nil }
    }

    func restore() async {
        guard isLoggedIn else { return }
        if let s: ServerStatus = try? await get("/api/status") {
            user = s.user
            remote = s.remote ?? false
            donateURL = safeDonateURL(s.donateUrl)
            if s.user == nil { logout() } else { await refreshImageToken() }
        }
    }

    /// Läser profilens uppgifter ur /api/status (barnprofil, nedladdningsrätt, utanför hemmet). Inloggningens och
    /// profilbytets svar har bara id, namn och is_admin. Misslyckas anropet behålls det som redan finns.
    func refreshUser() async {
        guard let s: ServerStatus = try? await get("/api/status"), let u = s.user else { return }
        user = u
        remote = s.remote ?? false
        donateURL = safeDonateURL(s.donateUrl)
    }

    func logout() {
        if let t = token, let u = url("/api/logout") {
            var r = URLRequest(url: u); r.httpMethod = "POST"
            r.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
            session.dataTask(with: r).resume()
        }
        Keychain.delete("token")
        // De sparade bildtoken för servern tas också bort (som Expo-appens utloggning)
        Keychain.delete(ImageTokenBook.key(server: server))
        token = nil
        user = nil
        imageToken = nil
        imageTokenOwner = nil
        imageTokenUntil = 0
        resetHome()
    }

    // MARK: Uppspelning

    /// Vad den här enheten kan spela utan hjälp från servern.
    func capabilities(audio: Int?, subtitle: SubtitleTrack?) -> [URLQueryItem] {
        var q: [URLQueryItem] = [
            .init(name: "c", value: "mp4"),
            .init(name: "v", value: "h264,hevc"),
            .init(name: "a", value: "aac,ac3,eac3,mp3,flac,alac"),
            .init(name: "hdr", value: AVPlayer.eligibleForHDRPlayback ? "1" : "0"),
            // Dolby Vision (t.ex. Apple TV 4K kopplad till en Dolby Vision-TV) – då kan även profil 5 spelas orört
            .init(name: "dv", value: AVPlayer.availableHDRModes.contains(.dolbyVision) ? "1" : "0")
        ]
        #if os(iOS)
        // iPhone/iPad: AVPlayer klarar inte Dolby Digital i MPEG-TS-segment (samma HLS-spelare som Safari,
        // som redan skickar nhls=1) – filmen startar aldrig. Servern ger då AAC i TS; fMP4 behåller Dolby.
        q.append(.init(name: "nhls", value: "1"))
        #endif
        if quality != "auto" { q.append(.init(name: "q", value: quality)) }
        if let a = audio { q.append(.init(name: "audio", value: String(a))) }
        if let s = subtitle, s.bitmap == true { q.append(.init(name: "sub", value: s.id)) }
        return q
    }

    /// Rapporterar tittarstatus. Svaret kan säga att uppspelningen ska stoppas (Föräldraöversiktens/administratörens
    /// Stoppa eller skärmtiden) – då anropas onStop med svaret. Utan svar sparas positionen och skickas senare med at;
    /// svarade servern inte alls (inget nät) anropas noAnswer. Svaret ger också skärmtidens status, som gäller när
    /// nätet försvinner (iPhone/iPad, OfflineScreen), och onScreen får den (tiden kvar i spelaren, ScreenLeftCore).
    func reportProgress(id: Int, position: Double, duration: Double, onStop: ((ProgressReply) -> Void)? = nil,
                        noAnswer: (() -> Void)? = nil, onScreen: ((ScreenStatus?) -> Void)? = nil) {
        Task {
            guard let data = await PendingPositions.shared.post(self, kind: ProgressQueue.item, id: id, position: position,
                                                                duration: duration, noAnswer: noAnswer) else { return }
            // Saknas screenTime har profilen ingen skärmtid (servern skickar den bara när en gräns gäller)
            let screen = try? JSONDecoder().decode(ProgressScreen.self, from: data)
            #if os(iOS)
            if let ps = screen { OfflineScreen.note(self, ps.screenTime) }
            #endif
            if let ps = screen { onScreen?(ps.screenTime) }
            guard let r = try? JSONDecoder().decode(ProgressReply.self, from: data), r.stop == true else { return }
            onStop?(r)
        }
    }

    /// Text att visa när servern stoppat uppspelningen (samma texter som webbspelaren)
    func stopText(_ r: ProgressReply) -> String {
        if let st = r.screenTime, st.allowed == false {
            return st.message ?? L("Skärmtiden är slut just nu.")
        }
        return user?.kid == true ? L("En vuxen stoppade uppspelningen.") : L("Uppspelningen stoppades av administratören.")
    }
}

// MARK: - Nyckelring (token sparas krypterat)

enum Keychain {
    private static let service = "net.braxhn.tv"
    static func save(_ key: String, _ value: String) {
        delete(key)
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: key, kSecValueData as String: Data(value.utf8),
                                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]
        SecItemAdd(q as CFDictionary, nil)
    }
    static func read(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: key, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    static func delete(_ key: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
    }
}

func formatTime(_ s: Double) -> String {
    // Int(nan)/Int(inf) kraschar – oväntade värden blir 0:00
    let t = s.isFinite ? Int(max(0, min(s, 1e7))) : 0
    let h = t / 3600, m = (t % 3600) / 60, sec = t % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
}

func formatDuration(_ s: Double?) -> String {
    guard let s = s, s.isFinite, s > 0, s < 1e7 else { return "" }
    let m = max(1, Int((s / 60).rounded()))
    return m >= 60 ? "\(m / 60) h \(m % 60) min" : "\(m) min"
}

// MARK: - Inloggning med kod

// (sist i filen så att radhänvisningarna i test/contracts/apps.json står kvar; private-medlemmar nås från samma fil)
extension AppModel {
    /// Startar inloggning med kod: servern ger en sexsiffrig kod som godkänns från en inloggad telefon eller dator.
    func startQuickConnect(server s: String) async throws -> QuickConnectStart {
        let base = try await resolveServer(s)
        server = base
        let status: ServerStatus = try await get("/api/status")
        if status.needsSetup { throw APIError(message: L("Servern är inte konfigurerad än – öppna den i en webbläsare först.")) }
        #if os(tvOS)
        let body: [String: Any] = ["app": true, "name": "Apple TV", "device": "tvOS"]
        #else
        let body: [String: Any] = ["app": true, "name": "iPhone/iPad", "device": "iOS"]
        #endif
        let data = try await request("/api/quickconnect", method: "POST", body: body)
        return try JSONDecoder().decode(QuickConnectStart.self, from: data)
    }

    /// Frågar om koden har godkänts. Vid "approved" sparas token som vid vanlig inloggning. Returnerar status.
    func pollQuickConnect(secret: String) async throws -> String {
        let r: QuickConnectPoll = try await get("/api/quickconnect/\(secret)")
        if r.status == "approved", let t = r.token, let u = r.user {
            UserDefaults.standard.set(server, forKey: "server")
            Keychain.save("token", t)
            token = t
            user = u
            await refreshImageToken()
            await refreshUser()
        }
        return r.status
    }
}

// MARK: - Profiler, Min lista, bio-läge och tittarkomfort

// (sist i filen av samma skäl som ovan)
extension AppModel {
    /// Byter profil i hushållet (POST /api/profiles/switch). Servern ger en ny apptoken för profilen och
    /// stänger den gamla. Fel PIN ger APIError med needPin (401 – loggar inte ut, se request()).
    func switchProfile(id: Int, pin: String? = nil, password: String? = nil) async throws {
        var body: [String: Any] = ["id": id]
        if let p = pin, !p.isEmpty { body["pin"] = p }
        if let p = password, !p.isEmpty { body["password"] = p }
        let data = try await request("/api/profiles/switch", method: "POST", body: body)
        let r = try JSONDecoder().decode(ProfileSwitchResponse.self, from: data)
        guard let t = r.token, let u = r.user else { throw APIError(message: L("Servern gav ingen ny inloggning för profilen")) }
        Keychain.save("token", t)
        token = t
        user = u
        await refreshImageToken()
        await refreshUser()
        // Alla flikar byggs om (MainTabs har .id(generation)) så att inget från förra profilen visas
        ProfileEvents.shared.generation += 1
    }

    /// Lägger till eller tar bort en titel i Min lista (avsnitt räknas som hela serien på servern)
    func setWatchlist(_ id: Int, _ on: Bool) async throws {
        try await post("/api/items/\(id)/watchlist", ["add": on])
    }

    /// Nattläge (jämnare ljudnivå) och tydligare dialog – sparas på enheten (vyerna använder @AppStorage med samma nycklar)
    var nightMode: Bool {
        get { UserDefaults.standard.bool(forKey: "nightMode") }
        set { UserDefaults.standard.set(newValue, forKey: "nightMode") }
    }
    var clearDialog: Bool {
        get { UserDefaults.standard.bool(forKey: "clearDialog") }
        set { UserDefaults.standard.set(newValue, forKey: "clearDialog") }
    }

    /// Nattläge och tydligare dialog: servern filtrerar ljudet (AAC stereo) när de är på
    func comfortQuery() -> [URLQueryItem] {
        var q: [URLQueryItem] = []
        if nightMode { q.append(.init(name: "night", value: "1")) }
        if clearDialog { q.append(.init(name: "dialog", value: "1")) }
        return q
    }
}

/// Ökas vid profilbyte – flikarna byggs om från början
@MainActor
final class ProfileEvents: ObservableObject {
    static let shared = ProfileEvents()
    @Published var generation = 0
}

extension AppModel {
    /// DELETE-anrop (t.ex. ta bort en inspelning)
    @discardableResult
    func delete(_ path: String) async throws -> Data {
        try await request(path, method: "DELETE")
    }
}

// MARK: - Serveradress, nätverksfel och felkoder

// (sist i filen av samma skäl som ovan)
extension AppModel {
    /// Adresser att prova i tur och ordning. Med http:// eller https:// används adressen som den är. Utan: ett
    /// namn som ser ut som en domän på internet (t.ex. BraXhn Relay, tv.dindomän.se) provas först med https,
    /// en IP-adress, ett namn utan punkt eller .local/.lan/.home först med http och port 8420.
    func serverCandidates(_ raw: String) -> [String] {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = t.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") { return [normalized(t)] }
        let http = normalized(t)
        let hostPart = String(lower.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        // Egen port angiven: det är nästan alltid servern direkt i hemnätet
        if hostPart.contains(":") { return [http] }
        var secure = "https://" + t
        while secure.hasSuffix("/") { secure.removeLast() }
        let isIP = !hostPart.isEmpty && hostPart.allSatisfy { $0.isNumber || $0 == "." }
        let localSuffixes = [".local", ".lan", ".home", ".internal", ".home.arpa", ".localdomain"]
        let local = isIP || !hostPart.contains(".") || localSuffixes.contains { hostPart.hasSuffix($0) }
        return local ? [http, secure] : [secure, http]
    }

    /// Hittar en adress där en BraXhn TV-server svarar på /api/status. Kastar felet från det första försöket.
    func resolveServer(_ raw: String) async throws -> String {
        let list = serverCandidates(raw)
        var first: Error?
        for base in list {
            guard let u = URL(string: base + "/api/status") else { continue }
            var r = URLRequest(url: u)
            // Kortare väntan när det finns fler adresser att prova
            r.timeoutInterval = list.count > 1 ? 8 : 30
            do {
                let (data, resp) = try await session.data(for: r)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                if (200..<300).contains(code), (try? JSONDecoder().decode(ServerStatus.self, from: data)) != nil { return base }
                let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                if first == nil {
                    first = APIError(message: (obj?["error"] as? String) ?? ((200..<300).contains(code)
                        ? L("Adressen svarar, men det verkar inte vara en BraXhn TV-server.") : httpErrorText(code)), status: code)
                }
            } catch {
                if first == nil { first = networkError(error) }
            }
        }
        throw first ?? APIError(message: L("Ogiltig serveradress"))
    }

    /// Nätverksfel med en förklaring som en hemanvändare förstår. Avbrutna anrop släpps igenom som de är.
    func networkError(_ error: Error) -> Error {
        guard let e = error as? URLError else { return error }
        switch e.code {
        case .cancelled:
            return error
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
            return APIError(message: L("Ingen nätverksanslutning. Kontrollera Wi-Fi eller mobildata."))
        case .timedOut:
            return APIError(message: L("Servern svarade inte i tid. Kontrollera att den är igång och att adressen stämmer."))
        case .cannotFindHost, .dnsLookupFailed:
            return APIError(message: L("Hittar inte servern. Kontrollera adressen."))
        case .cannotConnectToHost:
            return APIError(message: L("Kan inte ansluta till servern. Kontrollera att den är igång och att adressen och porten stämmer."))
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot, .clientCertificateRejected:
            return APIError(message: L("Den säkra anslutningen (https) misslyckades. Kontrollera certifikatet eller använd http:// i hemnätet."))
        case .appTransportSecurityRequiresSecureConnection:
            return APIError(message: L("Anslutningen nekades av systemet. Använd https:// eller serverns adress i hemnätet."))
        default:
            return APIError(message: e.localizedDescription)
        }
    }

    /// Text för en felkod när servern (eller en proxy/BraXhn Relay framför den) inte skickade någon förklaring
    func httpErrorText(_ code: Int) -> String {
        switch code {
        case 401: return L("Fel användarnamn eller lösenord.")
        case 403: return L("Det här är inte tillåtet för din profil.")
        case 404: return L("Finns inte på servern.")
        case 429: return L("För många försök – vänta en stund och försök igen.")
        case 502, 503, 504:
            return String(format: L("Servern svarar inte just nu (%d). Ansluter du via BraXhn Relay kan hemservern vara avstängd eller ha tappat anslutningen till reläet."), code)
        case 507: return L("Serverns disk är full – ändringar kan inte sparas just nu.")
        default: return String(format: L("Servern svarade %d"), code)
        }
    }
}

/// Donationslänken godtas bara som https till PayPal (paypal.com, paypal.me) – aldrig en godtycklig adress från servern
func safeDonateURL(_ s: String?) -> URL? {
    guard let s, let u = URL(string: s), u.scheme?.lowercased() == "https", let h = u.host?.lowercased() else { return nil }
    let ok = h == "paypal.com" || h.hasSuffix(".paypal.com") || h == "paypal.me" || h == "www.paypal.me"
    return ok ? u : nil
}

/// Ett fel som inte ska visas: uppgiften avbröts (vyn stängdes eller uppdaterades). Vyer hoppar då över felrutan.
func isCancellation(_ error: Error) -> Bool {
    if error is CancellationError { return true }
    if let e = error as? URLError, e.code == .cancelled { return true }
    return false
}

/// Översatt text (en.lproj/Localizable.strings; svenskan är nyckeln och visas när översättning saknas)
func L(_ s: String) -> String { NSLocalizedString(s, comment: "") }

/// Datum och decimaltecken på appens språk (svenska eller engelska, efter enhetens språkval)
let appLocale: Locale = {
    let lang = Bundle.main.preferredLocalizations.first ?? "sv"
    if Locale.current.language.languageCode?.identifier == lang { return Locale.current }
    return Locale(identifier: lang == "en" ? "en_US" : "sv_SE")
}()

// MARK: - Bildtoken sparad per server och profil

// (sist i filen av samma skäl som ovan)
extension AppModel {
    /// Bildtoken i minnet om den är profilens och gäller minst ett dygn till, annars den sparade i nyckelringen,
    /// sist en ny från servern (som sparas). Vid start innan /api/status svarat: profilen som använde den senast.
    fileprivate func loadImageToken(force: Bool) async {
        guard token != nil, !server.isEmpty else { return }
        let base = server
        let key = ImageTokenBook.key(server: base)
        var book = ImageTokenBook.decode(Keychain.read(key))
        // Första gången och profilen okänd (t.ex. /api/status misslyckades vid start): fråga servern
        if user == nil && book.last == nil { await refreshUser() }
        guard let uid = user?.id ?? book.last, server == base, token != nil else { return }
        let owner = "\(base) \(uid)"
        let now = Date()
        if !force, imageToken != nil, imageTokenOwner == owner,
           imageTokenUntil - now.timeIntervalSince1970 > ImageTokenBook.renewBefore { return }
        if !force, let saved = book.usable(for: uid, now: now) {
            imageToken = saved.token
            imageTokenUntil = saved.until
            imageTokenOwner = owner
            if book.last != uid {
                book.last = uid
                if let s = book.encoded() { Keychain.save(key, s) }
            }
            return
        }
        guard let data = try? await post("/api/media-token"),
              let r = try? JSONDecoder().decode(TokenResponse.self, from: data) else { return }
        // Servern eller profilen byttes medan token hämtades: den hör inte till det som gäller nu
        guard server == base, token != nil, (user?.id ?? uid) == uid else { return }
        let at = Date()
        let until = ImageTokenBook.until(ttl: r.ttl, now: at)
        book = ImageTokenBook.decode(Keychain.read(key)).storing(r.token, until: until, for: uid, now: at)
        if let s = book.encoded() { Keychain.save(key, s) }
        imageToken = r.token
        imageTokenUntil = until
        imageTokenOwner = owner
    }

    /// En bild gick inte att ladda: fråga servern om det var bildtoken (401, t.ex. utknuffad av taket på 50 per
    /// användare) och hämta då en ny. Högst en kontroll i minuten, så att en bild som saknas (404) inte ger en ström av anrop.
    func imageFailed(_ url: URL?) {
        guard let url, let tok = imageToken, url.absoluteString.contains("t=" + tok),
              Date().timeIntervalSince(imageCheckedAt) > 60 else { return }
        imageCheckedAt = Date()
        Task {
            guard let pair = try? await session.data(for: URLRequest(url: url)),
                  (pair.1 as? HTTPURLResponse)?.statusCode == 401, imageToken == tok else { return }
            await refreshImageToken(force: true)
        }
    }
}

/// En sparad bildtoken och när den slutar gälla (unix-sekunder)
struct SavedImageToken: Codable, Equatable {
    let token: String
    let until: Double
}

/// En servers sparade bildtoken per profil (användar-id som text) och profilen som använde bildtoken senast. Sparas
/// som JSON i nyckelringen. Servern sparar högst 50 bildtoken per användare och tar bort de äldsta (server/auth.js
/// IMG_MAX), så en ny token vid varje start skulle knuffa ut andra apparnas. Samma regler som Expo-appen
/// (apps/expo/src/api.ts ensureImageToken): förnya när mindre än ett dygn är kvar.
struct ImageTokenBook: Codable, Equatable {
    var tokens: [String: SavedImageToken] = [:]
    var last: Int?

    /// Förnya när mindre än så här är kvar
    static let renewBefore: TimeInterval = 86400
    /// Servrar som inte skickar ttl ger token som gäller 7 dagar
    static let defaultTTL = 7 * 86400

    /// Nyckeln i nyckelringen (en per server, den sparade adressen)
    static func key(server: String) -> String { "img " + server }

    /// Profilens sparade token, om den gäller minst ett dygn till
    func usable(for user: Int, now: Date) -> SavedImageToken? {
        guard let t = tokens[String(user)], !t.token.isEmpty,
              t.until - now.timeIntervalSince1970 > Self.renewBefore else { return nil }
        return t
    }

    /// Med profilens nya token (tom text tar bort den), utan utgångna token och med profilen som den senaste
    func storing(_ token: String, until: Double, for user: Int, now: Date) -> ImageTokenBook {
        var b = self
        b.tokens = b.tokens.filter { $0.value.until > now.timeIntervalSince1970 }
        b.tokens[String(user)] = token.isEmpty ? nil : SavedImageToken(token: token, until: until)
        b.last = user
        return b
    }

    /// När en ny token slutar gälla: serverns ttl i sekunder (minst en minut)
    static func until(ttl: Int?, now: Date) -> Double {
        now.timeIntervalSince1970 + Double(max(60, ttl ?? defaultTTL))
    }

    /// Läser det sparade; trasigt eller saknas = tomt
    static func decode(_ s: String?) -> ImageTokenBook {
        guard let d = s?.data(using: .utf8), let b = try? JSONDecoder().decode(ImageTokenBook.self, from: d) else { return ImageTokenBook() }
        return b
    }

    func encoded() -> String? {
        (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) }
    }
}
