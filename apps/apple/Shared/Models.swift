import Foundation

struct UserInfo: Codable, Equatable {
    let id: Int
    let name: String
    let is_admin: Int
}

struct ServerStatus: Decodable {
    let needsSetup: Bool
    let version: String
    let user: UserInfo?
    let publicUrl: String?
}

struct LoginResponse: Decodable {
    let token: String
    let user: UserInfo
}

struct Library: Decodable, Identifiable, Hashable {
    let id: Int
    let name: String
    let type: String
    let count: Int?
}

struct AudioStream: Decodable, Hashable, Identifiable {
    let index: Int
    let codec: String?
    let lang: String?
    let title: String?
    let channels: Int?
    let `default`: Bool?
    var id: Int { index }
    var label: String {
        [lang?.uppercased() ?? "Ljud", title, codec?.uppercased(), channels.map { "\($0)ch" }]
            .compactMap { $0 }.joined(separator: " · ")
    }
}

struct SubtitleTrack: Decodable, Hashable, Identifiable {
    let id: String
    let label: String
    let lang: String?
    let forced: Bool?
    let bitmap: Bool?
}

struct Marker: Decodable, Hashable {
    let start: Double
    let end: Double
}

/// Film, serie eller avsnitt. Samma struktur används för listor och detaljvy (detaljfälten är valfria).
struct MediaItem: Decodable, Identifiable, Hashable {
    let id: Int
    let kind: String
    let title: String
    let year: Int?
    let poster: Bool
    let backdrop: Bool
    let thumb: Bool
    let duration: Double?
    let rating: Double?
    let overview: String?
    let hdr: String?
    // avsnitt
    let season: Int?
    let episode: Int?
    let show: Int?
    let showTitle: String?
    // tittarstatus
    let position: Double?
    let watched: Bool?
    let episodes: Int?
    let watchedEpisodes: Int?
    let intro: Marker?
    let recap: Marker?
    let credits: Double?
    // detaljvy
    let children: [MediaItem]?
    let next: MediaItemRef?
    let audio: [AudioStream]?
    let subtitles: [SubtitleTrack]?
    let nextId: Int?
    let prevId: Int?
    let height: Int?
    let cast: [CastMember]?
    /// I Min lista (bara i detaljvyn; saknas hos äldre servrar)
    let inWatchlist: Bool?

    static func == (a: MediaItem, b: MediaItem) -> Bool { a.id == b.id && a.position == b.position && a.watched == b.watched }
    func hash(into h: inout Hasher) { h.combine(id) }

    var isShow: Bool { kind == "show" }
    var isEpisode: Bool { kind == "episode" }
    var sxe: String {
        guard let s = season, let e = episode else { return "" }
        return String(format: "S%02dE%02d", s, e)
    }
    var progress: Double {
        guard let p = position, let d = duration, d > 0 else { return 0 }
        return min(1, p / d)
    }
    var subtitleLine: String {
        if isEpisode { return showTitle.map { "\($0) · \(sxe)" } ?? sxe }
        if isShow { return [year.map(String.init), episodes.map { "\($0) avsnitt" }].compactMap { $0 }.joined(separator: " · ") }
        return year.map(String.init) ?? ""
    }
}

/// "Nästa avsnitt" i serievyn – innehåller bara det vi behöver för att starta uppspelning.
struct CastMember: Decodable, Hashable {
    let id: Int
    let name: String
    let role: String?
    let character: String?
}

/// Rollistan som en textrad, t.ex. "Regi: X · Medverkande: A, B, C" (nil om den saknas)
func castLine(_ cast: [CastMember]?) -> String? {
    guard let cast = cast, !cast.isEmpty else { return nil }
    var lead: [String] = []
    for c in cast where (c.role ?? "cast") != "cast" && !lead.contains(c.name) { lead.append(c.name) }
    let actors = cast.filter { ($0.role ?? "cast") == "cast" }.prefix(8).map { $0.name }
    var parts: [String] = []
    if !lead.isEmpty { parts.append((cast.contains { $0.role == "creator" } ? "Skapad av: " : "Regi: ") + lead.joined(separator: ", ")) }
    if !actors.isEmpty { parts.append("Medverkande: " + actors.joined(separator: ", ")) }
    return parts.isEmpty ? nil : parts.joined(separator: "  ·  ")
}

struct MediaItemRef: Decodable, Hashable {
    let id: Int
    let season: Int?
    let episode: Int?
    let position: Double?
}

struct HomeRow: Decodable, Identifiable {
    let library: Library
    let title: String
    let items: [MediaItem]
    var id: Int { library.id }
}

struct HomeResponse: Decodable {
    let continueWatching: [MediaItem]
    let rows: [HomeRow]
    /// Nya avsnitt av serier man följer (saknas hos äldre servrar)
    let forYou: [MediaItem]?
    // Hyllor som nyare servrar skickar (Home.swift). Alla är valfria och avkodas med try? – ett fält med
    // oväntad form ger bara en hylla mindre, aldrig en tom startsida.
    let watchlist: [MediaItem]?
    let recommended: [MediaItem]?
    let customCollections: [CustomShelf]?
    let upcoming: [UpcomingEntry]?
    let because: [BecauseShelf]?
    let topRated: [MediaItem]?
    let hiddenGems: [MediaItem]?
    let shortTonight: [MediaItem]?
    let onThisDay: [MediaItem]?
    let genreOfDay: GenreShelf?
    let listening: [ListeningEntry]?
    let homeLayout: HomeLayout?
    enum CodingKeys: String, CodingKey {
        case continueWatching = "continue", rows, forYou, watchlist, recommended, customCollections, upcoming, because
        case topRated, hiddenGems, shortTonight, onThisDay, genreOfDay, listening, homeLayout
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        continueWatching = try c.decode([MediaItem].self, forKey: .continueWatching)
        rows = try c.decode([HomeRow].self, forKey: .rows)
        forYou = try c.decodeIfPresent([MediaItem].self, forKey: .forYou)
        watchlist = (try? c.decodeIfPresent([MediaItem].self, forKey: .watchlist)) ?? nil
        recommended = (try? c.decodeIfPresent([MediaItem].self, forKey: .recommended)) ?? nil
        customCollections = (try? c.decodeIfPresent([CustomShelf].self, forKey: .customCollections)) ?? nil
        upcoming = (try? c.decodeIfPresent([UpcomingEntry].self, forKey: .upcoming)) ?? nil
        because = (try? c.decodeIfPresent([BecauseShelf].self, forKey: .because)) ?? nil
        topRated = (try? c.decodeIfPresent([MediaItem].self, forKey: .topRated)) ?? nil
        hiddenGems = (try? c.decodeIfPresent([MediaItem].self, forKey: .hiddenGems)) ?? nil
        shortTonight = (try? c.decodeIfPresent([MediaItem].self, forKey: .shortTonight)) ?? nil
        onThisDay = (try? c.decodeIfPresent([MediaItem].self, forKey: .onThisDay)) ?? nil
        genreOfDay = (try? c.decodeIfPresent(GenreShelf.self, forKey: .genreOfDay)) ?? nil
        listening = (try? c.decodeIfPresent([ListeningEntry].self, forKey: .listening)) ?? nil
        homeLayout = (try? c.decodeIfPresent(HomeLayout.self, forKey: .homeLayout)) ?? nil
    }
}

struct LibraryItems: Decodable {
    let library: Library
    let items: [MediaItem]
}

struct PlaybackSubtitle: Decodable, Hashable {
    let id: String
    let label: String
    let lang: String?
    let url: String
}

struct Playback: Decodable {
    let mode: String
    let url: String
    let reasons: [String]
    let subtitles: [PlaybackSubtitle]
    let intro: Marker?
    let recap: Marker?
    let credits: Double?
    let duration: Double?
    let quality: String?
    let remote: Bool?
    let tonemap: Bool?
    let chapters: [Chapter]?
    let audio: [AudioStream]?
    let audioSelected: String?
    /// Bio-läge: trailers/förfilm före filmen (bara med cinema=1 och när bio-läget är på; Player.swift)
    let preroll: [PrerollEntry]?
}

struct Chapter: Decodable, Hashable, Identifiable {
    let start: Double
    let end: Double
    let title: String
    var id: Double { start }
}

struct APIError: LocalizedError {
    let message: String
    var need2fa: Bool = false
    /// Profilbyte (POST /api/profiles/switch): profilen kräver PIN, eller huvudkontots lösenord från en barnprofil
    var needPin: Bool = false
    var needPassword: Bool = false
    var errorDescription: String? { message }
}

struct TokenResponse: Decodable {
    let token: String
}

/// Inloggning med kod (POST /api/quickconnect): koden visas på skärmen, nyckeln används för att polla
struct QuickConnectStart: Decodable {
    let secret: String
    let code: String
}

/// Svar från GET /api/quickconnect/:secret – status pending, approved eller expired; token och user bara vid approved
struct QuickConnectPoll: Decodable {
    let status: String
    let token: String?
    let user: UserInfo?
}
