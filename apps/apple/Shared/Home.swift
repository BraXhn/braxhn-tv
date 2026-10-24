import SwiftUI

// MARK: - Modeller för startsidans nya hyllor, profiler och bio-läge
// Alla fält i /api/home som de här typerna läser är valfria: äldre servrar saknar dem (HomeResponse i Models.swift).

/// Egen samling med "Visa på startsidan"
struct CustomShelf: Decodable, Identifiable {
    let id: Int
    let name: String
    let items: [MediaItem]
}

/// Kommande avsnitt (kalendern) – showId saknas för serier som bara finns i Sonarr
struct UpcomingEntry: Decodable, Identifiable {
    let date: String
    let time: String?
    let showId: Int?
    let show: String?
    let season: Int?
    let episode: Int?
    let name: String?
    let poster: Bool?
    let itemId: Int?
    var id: String { "\(showId ?? 0)-\(show ?? "")-\(season ?? 0)-\(episode ?? 0)-\(date)" }
}

struct BecauseSeed: Decodable {
    let id: Int
    let title: String
}

/// "Eftersom du såg …": titlar som liknar en titel man nyss sett
struct BecauseShelf: Decodable, Identifiable {
    let seed: BecauseSeed
    let items: [MediaItem]
    var id: Int { seed.id }
}

struct GenreShelf: Decodable {
    let genre: String
    let items: [MediaItem]
}

/// Fortsätt lyssna: påbörjad ljudbok (type "book") eller poddavsnitt (type "podcast")
struct ListeningEntry: Decodable {
    let type: String
    let id: Int
    let title: String?
    let author: String?
    let cover: Bool?
    let podcast: Int?
    let podcastTitle: String?
    let image: Bool?
    let duration: Double?
    let position: Double?
    var key: String { "\(type)-\(id)" }
}

/// Användarens ordning och dolda hyllor (Anpassa startsidan i webben)
struct HomeLayout: Decodable {
    let order: [String]?
    let hidden: [String]?
}

/// Bio-läge: en trailer eller förfilm som spelas före filmen (Playback.preroll)
struct PrerollEntry: Decodable, Hashable {
    let kind: String?
    let itemId: Int?
    let title: String?
    let url: String
    let mime: String?
    let duration: Double?
}

/// GET /api/me/cinema (saknas hos äldre servrar)
struct CinemaPrefs: Decodable {
    let trailers: Int?
    let preroll: Bool?
    let prerollAvailable: Bool?
}

struct Profile: Decodable, Identifiable, Hashable {
    let id: Int
    let name: String
    let owner: Bool?
    let kid: Bool?
    let hasPin: Bool?
}

struct ProfileList: Decodable {
    let current: Int
    let profiles: [Profile]
}

struct ProfileSwitchResponse: Decodable {
    let token: String?
    let user: UserInfo?
}

// MARK: - Startsidans hyllor i användarens ordning

/// Hyllornas id:n i serverns standardordning (server/homeshelves.js). En sparad ordning kompletteras med nya id:n.
let defaultHomeOrder = ["foryou", "continue", "listening", "watchlist", "upcoming", "because", "recommended", "custom",
                        "recent", "short", "toprated", "onthisday", "genre", "gems", "collections"]

struct HomeShelves: View {
    let home: HomeResponse

    private var order: [String] {
        var o: [String] = []
        for id in (home.homeLayout?.order ?? []) + defaultHomeOrder where !o.contains(id) { o.append(id) }
        let hidden = Set(home.homeLayout?.hidden ?? [])
        return o.filter { !hidden.contains($0) }
    }

    var body: some View {
        ForEach(order, id: \.self) { key in shelf(key) }
    }

    @ViewBuilder private func shelf(_ key: String) -> some View {
        switch key {
        case "foryou":
            if let f = home.forYou, !f.isEmpty { Shelf(title: "Nytt för dig", items: f, landscape: true) }
        case "continue":
            if !home.continueWatching.isEmpty { Shelf(title: "Fortsätt titta", items: home.continueWatching, landscape: true) }
        case "listening":
            if let l = home.listening, !l.isEmpty { ListeningShelf(entries: l) }
        case "watchlist":
            if let w = home.watchlist, !w.isEmpty { Shelf(title: "Min lista", items: w) }
        case "upcoming":
            if let u = home.upcoming, !u.isEmpty { UpcomingShelf(entries: u) }
        case "because":
            if let b = home.because {
                ForEach(b) { s in
                    if !s.items.isEmpty { Shelf(title: "Eftersom du såg \(s.seed.title)", items: s.items) }
                }
            }
        case "recommended":
            if let r = home.recommended, !r.isEmpty { Shelf(title: "Rekommenderat för dig", items: r) }
        case "custom":
            if let c = home.customCollections {
                ForEach(c) { s in
                    if !s.items.isEmpty { Shelf(title: s.name, items: s.items) }
                }
            }
        case "recent":
            ForEach(home.rows) { r in
                if !r.items.isEmpty { Shelf(title: r.title, items: r.items) }
            }
        case "short":
            if let s = home.shortTonight, !s.isEmpty { Shelf(title: "Kort film ikväll", items: s) }
        case "toprated":
            if let t = home.topRated, !t.isEmpty { Shelf(title: "Topprankat i biblioteket", items: t) }
        case "onthisday":
            if let d = home.onThisDay, !d.isEmpty { Shelf(title: "Den här dagen", items: d) }
        case "genre":
            if let g = home.genreOfDay, !g.items.isEmpty { Shelf(title: "Dagens genre: \(g.genre)", items: g.items) }
        case "gems":
            if let g = home.hiddenGems, !g.isEmpty { Shelf(title: "Glömda guldkorn", items: g) }
        default:
            EmptyView()
        }
    }
}

/// Kommer snart: kommande avsnitt av serier i biblioteket (kortet leder till avsnittet eller serien)
struct UpcomingShelf: View {
    @EnvironmentObject var model: AppModel
    let entries: [UpcomingEntry]

    private var width: CGFloat {
        #if os(tvOS)
        return 240
        #else
        return 130
        #endif
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Kommer snart").font(.title3.bold()).padding(.horizontal)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 16) {
                    ForEach(entries) { e in
                        if let id = e.itemId ?? e.showId {
                            NavigationLink(value: Route.item(id)) { card(e) }.cardButton()
                        } else {
                            card(e)
                        }
                    }
                }
                .padding(.horizontal)
                #if os(tvOS)
                .padding(.vertical, 30)
                #endif
            }
        }
    }

    @MainActor private func card(_ e: UpcomingEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            AsyncImage(url: posterURL(e)) { ph in
                if let img = ph.image { img.resizable().scaledToFill() }
                else {
                    ZStack {
                        LinearGradient(colors: [Color(hue: hueFor(e.show ?? ""), saturation: 0.5, brightness: 0.4), Color(hue: hueFor(e.show ?? ""), saturation: 0.6, brightness: 0.18)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                        Text(e.show ?? "").font(.headline).multilineTextAlignment(.center).padding(8)
                    }
                }
            }
            .frame(width: width, height: width * 1.5)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 10))
            Text(e.show ?? e.name ?? "").font(.subheadline.weight(.semibold)).lineLimit(1)
            Text([dateLabel(e.date), sxe(e)].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(width: width)
    }

    @MainActor private func posterURL(_ e: UpcomingEntry) -> URL? {
        guard e.poster == true, let s = e.showId, let t = model.imageToken else { return nil }
        return model.url("/api/image/\(s)/poster", [URLQueryItem(name: "t", value: t)])
    }

    private func sxe(_ e: UpcomingEntry) -> String? {
        guard let s = e.season, let n = e.episode else { return nil }
        return String(format: "S%02dE%02d", s, n)
    }

    /// "Idag", "Imorgon" eller t.ex. "ons 28 okt" ur "YYYY-MM-DD"
    private func dateLabel(_ ymd: String) -> String? {
        let p = DateFormatter()
        p.locale = Locale(identifier: "sv_SE")
        p.dateFormat = "yyyy-MM-dd"
        guard let d = p.date(from: ymd) else { return ymd }
        let cal = Calendar.current
        if cal.isDateInToday(d) { return "Idag" }
        if cal.isDateInTomorrow(d) { return "Imorgon" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "sv_SE")
        f.dateFormat = "EEE d MMM"
        return f.string(from: d)
    }
}

/// Fortsätt lyssna: ljudböcker och poddavsnitt spelas direkt i ljudspelaren
struct ListeningShelf: View {
    @EnvironmentObject var model: AppModel
    let entries: [ListeningEntry]

    private var size: CGFloat {
        #if os(tvOS)
        return 240
        #else
        return 130
        #endif
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Fortsätt lyssna").font(.title3.bold()).padding(.horizontal)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 16) {
                    ForEach(entries, id: \.key) { e in
                        Button { Task { await play(e) } } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                artView(model, path: artPath(e), size: size, symbol: e.type == "book" ? "book" : "mic")
                                if let d = e.duration, d > 0, let p = e.position, p > 0 { ProgressView(value: min(1, p / d)).tint(accent) }
                                Text(e.title ?? "").font(.subheadline.weight(.semibold)).lineLimit(1)
                                Text((e.type == "book" ? e.author : e.podcastTitle) ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            .frame(width: size)
                        }
                        .cardButton()
                    }
                }
                .padding(.horizontal)
                #if os(tvOS)
                .padding(.vertical, 30)
                #endif
            }
        }
    }

    private func artPath(_ e: ListeningEntry) -> String? {
        if e.type == "book" { return e.cover == true ? "/api/audiobooks/cover/\(e.id)" : nil }
        guard e.image == true, let p = e.podcast else { return nil }
        return "/api/podcasts/\(p)/image"
    }

    @MainActor private func play(_ e: ListeningEntry) async {
        if e.type == "book" {
            await SpokenPlayer.shared.play(book: e.id, model: model)
        } else if let p = e.podcast {
            let ep = Episode(id: e.id, podcast: p, podcastTitle: e.podcastTitle, title: e.title ?? "", description: nil, published: nil,
                             duration: e.duration, position: e.position ?? 0, played: false)
            await SpokenPlayer.shared.play(episode: ep, model: model)
        }
    }
}

// MARK: - Min lista

struct WatchlistView: View {
    @EnvironmentObject var model: AppModel
    @State private var items: [MediaItem]?
    @State private var error: String?

    var body: some View {
        ScrollView {
            if let e = error { Text(e).foregroundStyle(.secondary).padding(40) }
            if let it = items {
                if it.isEmpty {
                    Text("Min lista är tom. Lägg till filmer och serier från deras sidor.").foregroundStyle(.secondary).padding(40)
                }
                ItemGrid(items: it)
            } else if error == nil {
                ProgressView().padding(60)
            }
        }
        .navigationTitle("Min lista")
        .task { await load() }
        .refreshable { await load() }
    }

    @MainActor func load() async {
        do {
            items = try await model.get("/api/watchlist")
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

// MARK: - Profiler

struct ProfilesView: View {
    @EnvironmentObject var model: AppModel
    @State private var list: ProfileList?
    @State private var error: String?
    @State private var busy = false
    @State private var ask: SecretRequest?

    /// Profilen kräver PIN (eller huvudkontots lösenord från en barnprofil)
    struct SecretRequest: Identifiable {
        let profile: Profile
        let password: Bool
        var message: String?
        var id: Int { profile.id }
    }

    var body: some View {
        List {
            if let e = error { Text(e).foregroundStyle(.red) }
            if let l = list {
                Section {
                    ForEach(l.profiles) { p in
                        Button { choose(p, current: l.current) } label: {
                            HStack(spacing: 14) {
                                Image(systemName: p.kid == true ? "face.smiling" : "person.crop.circle.fill").font(.title2).foregroundStyle(Color(hue: hueFor(p.name), saturation: 0.6, brightness: 0.9))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(p.name)
                                    let tags: [String] = profileTags(p)
                                    if !tags.isEmpty { Text(tags.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer()
                                if p.id == l.current { Image(systemName: "checkmark") }
                            }
                        }
                        .disabled(busy)
                    }
                } footer: {
                    Text("Varje profil har egen tittarhistorik, Min lista och åldersgräns. Profiler skapas och ändras i webben.")
                }
            } else if error == nil {
                ProgressView()
            }
        }
        .navigationTitle("Byt profil")
        .task { await load() }
        .sheet(item: $ask) { req in
            SecretSheet(request: req) { secret in
                Task { await doSwitch(req.profile, pin: req.password ? nil : secret, password: req.password ? secret : nil) }
            }
        }
    }

    private func profileTags(_ p: Profile) -> [String] {
        var t: [String] = []
        if p.owner == true { t.append("Huvudkonto") }
        if p.kid == true { t.append("Barnprofil") }
        if p.hasPin == true { t.append("PIN") }
        return t
    }

    @MainActor func load() async {
        do {
            list = try await model.get("/api/profiles")
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func choose(_ p: Profile, current: Int) {
        guard p.id != current else { return }
        if p.hasPin == true { ask = SecretRequest(profile: p, password: false); return }
        Task { await doSwitch(p, pin: nil, password: nil) }
    }

    @MainActor func doSwitch(_ p: Profile, pin: String?, password: String?) async {
        busy = true
        defer { busy = false }
        do {
            try await model.switchProfile(id: p.id, pin: pin, password: password)
            ask = nil
        } catch let e as APIError where e.needPin || e.needPassword {
            // Fel eller saknad PIN/lösenord: fråga (igen) med serverns meddelande
            let retry = pin != nil || password != nil
            ask = SecretRequest(profile: p, password: e.needPassword, message: retry ? e.message : nil)
        } catch {
            ask = nil
            self.error = error.localizedDescription
        }
    }
}

/// Ark som frågar efter profilens PIN (eller huvudkontots lösenord)
struct SecretSheet: View {
    @Environment(\.dismiss) private var dismiss
    let request: ProfilesView.SecretRequest
    let submit: (String) -> Void
    @State private var secret = ""

    var body: some View {
        VStack(spacing: 20) {
            Text(request.profile.name).font(.title.bold())
            Text(request.password ? "Ange huvudkontots lösenord för att byta till den här profilen." : "Ange profilens PIN.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
            SecureField(request.password ? "Lösenord" : "PIN", text: $secret)
                #if os(iOS)
                .keyboardType(request.password ? UIKeyboardType.default : UIKeyboardType.numberPad)
                .textContentType(request.password ? UITextContentType.password : UITextContentType.oneTimeCode)
                .padding(12)
                .background(Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
                #endif
            if let m = request.message { Text(m).foregroundStyle(.red).font(.footnote) }
            HStack(spacing: 20) {
                Button("Avbryt") { dismiss() }.buttonStyle(.bordered)
                Button("Byt profil") { submit(secret) }
                    .buttonStyle(.borderedProminent)
                    .disabled(secret.isEmpty)
            }
        }
        .padding(32)
        .frame(maxWidth: 520)
    }
}
