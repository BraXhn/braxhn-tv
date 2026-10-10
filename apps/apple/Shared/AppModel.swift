import Foundation
import Security
import AVFoundation

/// Håller serveradress, inloggning och gör alla API-anrop.
@MainActor
final class AppModel: ObservableObject {
    @Published var server: String = UserDefaults.standard.string(forKey: "server") ?? ""
    @Published private(set) var token: String? = Keychain.read("token")
    @Published var user: UserInfo?
    /// Kortlivad token som bara gäller bilder (bild-URL:er kan inte skicka Authorization-header)
    @Published private(set) var imageToken: String?
    private var imageTokenDate = Date.distantPast
    @Published var quality: String = UserDefaults.standard.string(forKey: "quality") ?? "auto" {
        didSet { UserDefaults.standard.set(quality, forKey: "quality") }
    }
    @Published var subtitleLang: String = UserDefaults.standard.string(forKey: "sublang") ?? "" {
        didSet { UserDefaults.standard.set(subtitleLang, forKey: "sublang") }
    }

    var isLoggedIn: Bool { token != nil && !server.isEmpty }

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
        if let u = URL(string: s), u.port == nil, u.scheme == "http", u.host != nil { s += ":8420" }
        return s
    }

    func url(_ path: String, _ query: [URLQueryItem] = []) -> URL? {
        guard var c = URLComponents(string: server + path) else { return nil }
        if !query.isEmpty { c.queryItems = (c.queryItems ?? []) + query }
        return c.url
    }

    /// Relativ URL från servern (t.ex. strömmar) → absolut. Token finns redan med i strömmarnas URL:er.
    func absolute(_ relative: String) -> URL? { URL(string: server + relative) }

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
        guard let u = url(path, query) else { throw APIError(message: "Ogiltig serveradress") }
        var r = URLRequest(url: u)
        r.httpMethod = method
        if let t = token { r.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        if let b = body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: b)
        }
        let (data, resp) = try await session.data(for: r)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 && token != nil && path != "/api/login" && path != "/api/media-token" { logout(); throw APIError(message: "Du har loggats ut") }
        if !(200..<300).contains(code) {
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let msg = obj?["error"] as? String
            throw APIError(message: msg ?? "Servern svarade \(code)", need2fa: (obj?["need2fa"] as? Bool) ?? false)
        }
        return data
    }

    func get<T: Decodable>(_ path: String, _ query: [URLQueryItem] = []) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await request(path, query: query))
    }

    /// Rå data från ett autentiserat anrop (t.ex. undertexter för nedladdade filer)
    func data(_ path: String) async throws -> Data {
        try await request(path)
    }

    @discardableResult
    func post(_ path: String, _ body: [String: Any] = [:]) async throws -> Data {
        try await request(path, method: "POST", body: body)
    }

    // MARK: Inloggning

    func login(server s: String, name: String, password: String, code: String? = nil) async throws {
        let base = normalized(s)
        server = base
        let status: ServerStatus = try await get("/api/status")
        if status.needsSetup { throw APIError(message: "Servern är inte konfigurerad än – öppna den i en webbläsare först.") }
        var body: [String: Any] = ["name": name, "password": password, "app": true]
        if let c = code, !c.isEmpty { body["code"] = c }
        let data = try await request("/api/login", method: "POST", body: body)
        let r = try JSONDecoder().decode(LoginResponse.self, from: data)
        UserDefaults.standard.set(base, forKey: "server")
        Keychain.save("token", r.token)
        token = r.token
        user = r.user
        await refreshImageToken(force: true)
    }

    /// Hämtar en ny bildtoken (gäller 7 dagar) om den saknas eller är äldre än ett dygn.
    func refreshImageToken(force: Bool = false) async {
        guard token != nil, force || imageToken == nil || Date().timeIntervalSince(imageTokenDate) > 86400 else { return }
        if let data = try? await post("/api/media-token"), let r = try? JSONDecoder().decode(TokenResponse.self, from: data) {
            imageToken = r.token
            imageTokenDate = Date()
        }
    }

    func restore() async {
        guard isLoggedIn else { return }
        if let s: ServerStatus = try? await get("/api/status") {
            user = s.user
            if s.user == nil { logout() } else { await refreshImageToken(force: true) }
        }
    }

    func logout() {
        if let t = token, let u = url("/api/logout") {
            var r = URLRequest(url: u); r.httpMethod = "POST"
            r.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
            session.dataTask(with: r).resume()
        }
        Keychain.delete("token")
        token = nil
        user = nil
        imageToken = nil
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
        if quality != "auto" { q.append(.init(name: "q", value: quality)) }
        if let a = audio { q.append(.init(name: "audio", value: String(a))) }
        if let s = subtitle, s.bitmap == true { q.append(.init(name: "sub", value: s.id)) }
        return q
    }

    func reportProgress(id: Int, position: Double, duration: Double) {
        Task { try? await post("/api/items/\(id)/progress", ["position": position, "duration": duration]) }
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
    let t = max(0, Int(s))
    let h = t / 3600, m = (t % 3600) / 60, sec = t % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
}

func formatDuration(_ s: Double?) -> String {
    guard let s = s, s > 0 else { return "" }
    let m = max(1, Int((s / 60).rounded()))
    return m >= 60 ? "\(m / 60) h \(m % 60) min" : "\(m) min"
}
