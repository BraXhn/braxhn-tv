import Foundation
#if canImport(UIKit)
import UIKit
#endif

// Feedback och felrapporter – samma som knappen Feedback i webben (web/js/views/support.js), Expo-appen
// (apps/expo/src/feedback.ts) och Android-appen (Feedback.kt, FeedbackCore.kt). En vanlig användares ärende granskas
// av en administratör innan det skickas till utvecklarna; administratörens egna skickas direkt. Här: modellerna,
// reglerna utan vyer (FeedbackCore), var man är i appen (FeedbackTracker) och anropen. Vyerna: FeedbackViews.swift.
//
// Den tekniska informationen: appens namn, version och plattform, sidan, skärmstorleken, språket, titeln man senast
// spelade och det senaste uppspelningsfelet. Aldrig token, adresser eller namn – servern rensar en gång till
// (buildContext i server/support.js) och lägger till sin version och den senaste uppspelningen ur tittarhistoriken.

// MARK: - Modeller (svaren från /api/support, test/contracts/apps.json)

struct FbApp: Decodable {
    let name: String?
    let version: String?
    let platform: String?
}

struct FbTitle: Decodable {
    let id: Int
    let name: String
    let year: Int?
    let format: String?
}

struct FbPlayback: Decodable {
    let item: Int
    let name: String
    let format: String?
    let mode: String?
    let quality: String?
    let position: Double?
    let duration: Double?
    let remote: Bool?
    let minutesAgo: Int?
}

struct TechContext: Decodable {
    let version: String?
    let page: String?
    let browser: String?
    let screen: String?
    let lang: String?
    let app: FbApp?
    let title: FbTitle?
    let lastPlayback: FbPlayback?
    let pageErrors: [String]?
}

struct TicketMsg: Decodable {
    let from: String
    let text: String?
    let created: Int?
    let status: String?
    let version: String?
    let pending: Bool?
}

struct Ticket: Decodable {
    let id: Int
    let kind: String
    let area: String
    let title: String?
    let text: String
    let sentTitle: String?
    let sentText: String?
    let context: TechContext?
    let status: String
    let version: String?
    let created: Int
    let updated: Int?
    let thread: [TicketMsg]
    let canReply: Bool

    private enum CodingKeys: String, CodingKey {
        case id, kind, area, title, text, sentTitle, sentText, context, status, version, created, updated, thread, canReply
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        kind = try c.decode(String.self, forKey: .kind)
        area = try c.decode(String.self, forKey: .area)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        text = try c.decode(String.self, forKey: .text)
        sentTitle = try c.decodeIfPresent(String.self, forKey: .sentTitle)
        sentText = try c.decodeIfPresent(String.self, forKey: .sentText)
        // Sparad teknisk information i en form appen inte känner till (t.ex. ett gammalt ärende från webben) ska inte
        // göra hela listan tom – då visas ärendet utan den
        context = try? c.decodeIfPresent(TechContext.self, forKey: .context)
        status = try c.decode(String.self, forKey: .status)
        version = try c.decodeIfPresent(String.self, forKey: .version)
        created = try c.decode(Int.self, forKey: .created)
        updated = try c.decodeIfPresent(Int.self, forKey: .updated)
        thread = try c.decodeIfPresent([TicketMsg].self, forKey: .thread) ?? []
        canReply = try c.decodeIfPresent(Bool.self, forKey: .canReply) ?? false
    }

    /// Nyckeln i listan: ändras när ärendet ändras, så att svarsrutan börjar om efter ett svar
    var rowKey: String { "\(id)-\(updated ?? created)-\(thread.count)" }
}

struct TicketList: Decodable {
    let tickets: [Ticket]
}

struct SupportPreview: Decodable {
    let context: TechContext
}

struct SupportSent: Decodable {
    let id: Int
    let status: String
    let message: String?
}

struct SupportCount: Decodable {
    let needinfo: Int?
}

/// En rad i den tekniska informationen: rubrik och värde
struct FeedbackRow: Hashable {
    let label: String
    let value: String
}

// MARK: - Regler utan vyer

enum FeedbackCore {
    /// Områdena i samma ordning som webben (nycklarna är namnen i API:t, AREAS i server/support.js)
    static let areas = ["film", "musik", "ljud", "livetv", "uppspelning", "appen", "annat"]
    static let kinds = ["idea", "bug"]
    /// Serverns gräns för meddelandet och svaret (MAX_TEXT, MAX_REPLY)
    static let maxText = 4000
    /// Ett uppspelningsfel räknas så här länge (förval: Något fungerar inte)
    static let errorFresh: TimeInterval = 30 * 60

    /// Vad en sida gäller (förval i "Gäller"). Sidans namn är teknisk information till utvecklarna och skickas alltid på
    /// svenska (som de andra apparna). Inställningar, Profiler, Feedback och Mina ärenden räknas inte: förvalet ska gälla
    /// det man gjorde innan man öppnade Feedback.
    static let pageAreas: [String: String] = [
        "Hem": "appen", "Sök": "appen", "Nedladdat": "appen", "Bibliotek": "film", "Min lista": "film", "Titelsidan": "film",
        "Spelaren": "uppspelning", "Live-TV": "livetv", "Musik": "musik", "Lyssna": "ljud",
    ]
    static func area(ofPage page: String) -> String? { pageAreas[page] }

    /// Förvalet för typen: fel om spelaren visade ett fel den senaste halvtimmen, annars förslag
    static func defaultKind(errorAt: Date?, now: Date) -> String {
        guard let at = errorAt else { return "idea" }
        let age = now.timeIntervalSince(at)
        return age >= 0 && age < errorFresh ? "bug" : "idea"
    }

    /// Plattformen, t.ex. "iOS 18.1 · iPhone · iPhone15,2" eller "tvOS 18.1 · TV · AppleTV14,1" – högst 120 tecken
    static func platform(system: String, version: String, device: String, model: String) -> String {
        let os = [system, version].map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
        return String([os, device, model.trimmingCharacters(in: .whitespaces)].filter { !$0.isEmpty }.joined(separator: " · ").prefix(120))
    }

    /// Appens version som servern godtar (bokstäver, siffror, . + - och _, högst 30 tecken), annars tom
    static func version(_ s: String?) -> String {
        let v = (s ?? "").trimmingCharacters(in: .whitespaces)
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._+-"))
        let ok = !v.isEmpty && v.count <= 30 && v.unicodeScalars.allSatisfy { $0.isASCII && allowed.contains($0) }
        return ok ? v : ""
    }

    /// Skärmen som servern tar emot den (som webben: punkter och skalan): "390×844 @3" eller "1920×1080"
    static func screen(width: Double, height: Double, scale: Double) -> String {
        let s = (scale * 10).rounded() / 10
        let scaleText = s == s.rounded() ? String(Int(s)) : String(s)
        return "\(Int(width.rounded()))×\(Int(height.rounded()))" + (s != 1 && s > 0 ? " @\(scaleText)" : "")
    }

    /// Det appen bifogar (servern rensar och lägger till sitt). errors bara för felrapporter med ett färskt uppspelningsfel.
    static func clientContext(kind: String, version: String, platform: String, page: String, screen: String, lang: String,
                              itemId: Int, playError: String?) -> [String: Any] {
        var c: [String: Any] = [
            "client": ["name": "iOS", "version": version, "platform": platform],
            "route": page, "screen": screen, "lang": lang == "en" ? "en" : "sv",
        ]
        if itemId > 0 { c["itemId"] = itemId }
        if kind == "bug", let e = playError, !e.isEmpty { c["errors"] = ["Uppspelningen: " + e] }
        return c
    }

    /// Uppspelningstid som i webben: "12:05" (minuter och sekunder)
    static func duration(_ s: Double) -> String {
        let t = s.isFinite ? max(0, Int(min(s, 1e7).rounded())) : 0
        return String(format: "%d:%02d", t / 60, t % 60)
    }

    /// Datum och tid i Mina ärenden: unix-sekunder → "27 nov. 14:05" (språket och tidszonen från anroparen)
    static func date(_ seconds: Int, locale: Locale, timeZone: TimeZone) -> String {
        let f = DateFormatter()
        f.locale = locale
        f.timeZone = timeZone
        f.setLocalizedDateFormatFromTemplate("dMMMHHmm")
        return f.string(from: Date(timeIntervalSince1970: TimeInterval(seconds)))
    }

    // Texterna (svenskan är nyckeln i Localizable.strings)

    static func kindName(_ k: String) -> String { k == "idea" ? L("Förslag eller synpunkt") : L("Något fungerar inte") }
    static func kindHint(_ k: String) -> String { k == "idea" ? L("Idéer, önskemål och beröm") : L("Rapportera ett fel") }

    static func areaName(_ a: String) -> String {
        switch a {
        case "film": return L("Film och serier")
        case "musik": return L("Musik")
        case "ljud": return L("Ljudböcker och poddar")
        case "livetv": return L("Live-TV")
        case "uppspelning": return L("Uppspelning")
        case "appen": return L("Appen i allmänhet")
        default: return L("Annat")
        }
    }

    /// Statusen som text ("Åtgärdat i version 1.2.3")
    static func statusText(_ status: String, version: String?) -> String {
        switch status {
        case "pending": return L("Väntar på granskning")
        case "approved": return L("Godkänt – skickat till teamet")
        case "working": return L("Åtgärdas")
        case "needinfo": return L("Behöver mer information")
        case "fixed":
            if let v = version, !v.isEmpty { return String(format: L("Åtgärdat i version %@"), v) }
            return L("Åtgärdat")
        case "rejected": return L("Avslaget")
        default: return status
        }
    }

    enum Tone { case warn, info, ok, err }
    static func statusTone(_ status: String) -> Tone {
        switch status {
        case "pending", "needinfo": return .warn
        case "fixed": return .ok
        case "rejected": return .err
        default: return .info
        }
    }

    static func from(_ who: String) -> String {
        switch who {
        case "team": return L("Teamet")
        case "admin": return L("Administratören")
        default: return L("Du")
        }
    }

    /// Den tekniska informationen som rader – samma ordning och ord som webben (contextHtml) och de andra apparna
    static func contextRows(_ c: TechContext?) -> [FeedbackRow] {
        guard let c else { return [] }
        var rows: [FeedbackRow] = []
        func add(_ k: String, _ v: String?) { if let v, !v.isEmpty { rows.append(FeedbackRow(label: k, value: v)) } }
        add(L("Serverns version"), c.version)
        if let a = c.app { add(L("Skickat från appen"), [a.name, a.version, a.platform].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")) }
        add(L("Sida"), c.page)
        add(L("Webbläsare och enhet"), c.browser)
        add(L("Skärmstorlek"), c.screen)
        add(L("Språk"), c.lang)
        if let t = c.title {
            add(L("Titel"), "#\(t.id) \(t.name)" + (t.year.map { " (\($0))" } ?? "") + (t.format.map { " – \($0)" } ?? ""))
        }
        if let p = c.lastPlayback {
            let pos = p.position.map { FeedbackCore.duration($0) + (p.duration.map { " / " + FeedbackCore.duration($0) } ?? "") }
            let parts: [String?] = ["#\(p.item) \(p.name)", p.format, p.mode, p.quality, pos,
                                    p.remote == true ? L("utanför hemmet") : L("hemma"),
                                    String(format: L("för %d min sedan"), p.minutesAgo ?? 0)]
            add(L("Senaste uppspelningen"), parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
        }
        for e in c.pageErrors ?? [] { add(L("Fel"), e) }
        return rows
    }

    /// Felet som text; en server före 1.3.0 har inte feedback (404)
    static func errorText(_ e: Error) -> String {
        if let a = e as? APIError, a.status == 404 {
            return L("Servern har inte feedback än. Den som sköter servern behöver uppdatera BraXhn TV till version 1.3.0 eller senare.")
        }
        let m = e.localizedDescription
        return m.isEmpty ? L("Ärendet kunde inte skickas – försök igen.") : m
    }

    /// Raden om ärenden som väntar på svar
    static func waitingText(_ n: Int) -> String {
        String(format: n == 1 ? L("Teamet väntar på ditt svar i %d ärende") : L("Teamet väntar på ditt svar i %d ärenden"), n)
    }
}

// MARK: - Var man är i appen och den senaste uppspelningen

@MainActor
final class FeedbackTracker {
    static let shared = FeedbackTracker()
    private(set) var page = "Hem"
    private(set) var area = "appen"
    private var playId = 0
    private var playError: String?
    private var errorAt: Date?

    /// En vy visades (feedbackPage-modifieraren). Sidor som inte gäller något (Inställningar m.fl.) ändrar inget.
    func notePage(_ p: String) {
        guard let a = FeedbackCore.area(ofPage: p) else { return }
        page = p
        area = a
    }

    /// Spelaren startade en titel (error nil) eller visade ett fel
    func notePlayback(_ id: Int, error: String?) {
        if id > 0 { playId = id }
        if let e = error, !e.isEmpty { playError = e; errorAt = Date() }
    }

    func defaultKind() -> String { FeedbackCore.defaultKind(errorAt: errorAt, now: Date()) }

    /// Det appen bifogar: namn, version, plattform, sida, skärm, språk, senast spelade titel och senaste felet
    func clientContext(kind: String) -> [String: Any] {
        let version = FeedbackCore.version(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
        let lang = Bundle.main.preferredLocalizations.first ?? "sv"
        let fresh = defaultKind() == "bug" ? playError : nil
        return FeedbackCore.clientContext(kind: kind, version: version, platform: Self.platformText(), page: page,
                                          screen: Self.screenText(), lang: lang, itemId: playId, playError: fresh)
    }

    private static func platformText() -> String {
        #if canImport(UIKit)
        let d = UIDevice.current
        let device: String
        switch d.userInterfaceIdiom {
        case .pad: device = "iPad"
        case .tv: device = "TV"
        case .phone: device = "iPhone"
        default: device = ""
        }
        return FeedbackCore.platform(system: d.systemName, version: d.systemVersion, device: device, model: modelIdentifier())
        #else
        return ""
        #endif
    }

    /// Modellen, t.ex. "iPhone15,2" (i simulatorn arkitekturen)
    private static func modelIdentifier() -> String {
        var u = utsname()
        uname(&u)
        return withUnsafeBytes(of: &u.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }

    private static func screenText() -> String {
        #if canImport(UIKit)
        let s = UIScreen.main
        return FeedbackCore.screen(width: Double(s.bounds.width), height: Double(s.bounds.height), scale: Double(s.scale))
        #else
        return ""
        #endif
    }
}

// MARK: - Anropen (server/routes/support.js)

extension AppModel {
    var isAdmin: Bool { (user?.is_admin ?? 0) != 0 }

    /// "Visa vad som skickas med": servern svarar med exakt det som skulle sparas (samma funktion som vid Skicka)
    func supportPreview(kind: String) async throws -> TechContext {
        let body: [String: Any] = ["kind": kind, "context": FeedbackTracker.shared.clientContext(kind: kind)]
        let data = try await post("/api/support/context", body)
        return try JSONDecoder().decode(SupportPreview.self, from: data).context
    }

    func sendSupport(kind: String, area: String, text: String, tech: Bool) async throws -> SupportSent {
        let body: [String: Any] = ["kind": kind, "area": area, "text": text, "tech": tech,
                                   "context": tech ? FeedbackTracker.shared.clientContext(kind: kind) : NSNull()]
        let data = try await post("/api/support", body)
        return try JSONDecoder().decode(SupportSent.self, from: data)
    }

    func myTickets() async throws -> [Ticket] {
        let r: TicketList = try await get("/api/support")
        return r.tickets
    }

    /// Svar när teamet bett om mer information (svaret läses inte – Mina ärenden hämtas igen)
    func replyTicket(_ id: Int, text: String) async throws {
        try await post("/api/support/\(id)/reply", ["text": text])
    }

    /// Egna ärenden där teamet väntar på svar (0 vid fel eller äldre server)
    func supportNeedInfo() async -> Int {
        guard let r: SupportCount = try? await get("/api/support/count") else { return 0 }
        return r.needinfo ?? 0
    }
}
