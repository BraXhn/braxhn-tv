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
    let credits: Double?
    // detaljvy
    let children: [MediaItem]?
    let next: MediaItemRef?
    let audio: [AudioStream]?
    let subtitles: [SubtitleTrack]?
    let nextId: Int?
    let prevId: Int?
    let height: Int?

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
    enum CodingKeys: String, CodingKey { case continueWatching = "continue", rows }
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
}

struct APIError: LocalizedError {
    let message: String
    var need2fa: Bool = false
    var errorDescription: String? { message }
}

struct TokenResponse: Decodable {
    let token: String
}
