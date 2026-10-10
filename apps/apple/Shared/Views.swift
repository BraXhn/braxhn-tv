import SwiftUI

enum Route: Hashable {
    case item(Int)
    case library(Library)
}

extension View {
    func withRoutes() -> some View {
        navigationDestination(for: Route.self) { r in
            switch r {
            case .item(let id): ItemDetailView(id: id)
            case .library(let l): LibraryView(library: l)
            }
        }
    }

    @ViewBuilder func cardButton() -> some View {
        #if os(tvOS)
        buttonStyle(.card)
        #else
        buttonStyle(.plain)
        #endif
    }
}

let accent = Color(red: 1.0, green: 0.42, blue: 0.29)

// MARK: - Rot

struct RootView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        Group {
            if model.isLoggedIn { MainTabs() } else { LoginView() }
        }
        .tint(accent)
        .task { await model.restore() }
    }
}

struct MainTabs: View {
    var body: some View {
        TabView {
            NavigationStack { HomeView().withRoutes() }
                .tabItem { Label("Hem", systemImage: "house") }
            NavigationStack { SearchView().withRoutes() }
                .tabItem { Label("Sök", systemImage: "magnifyingglass") }
            NavigationStack { SettingsView() }
                .tabItem { Label("Inställningar", systemImage: "gearshape") }
        }
    }
}

// MARK: - Inloggning

struct LoginView: View {
    @EnvironmentObject var model: AppModel
    @State private var server = UserDefaults.standard.string(forKey: "server") ?? ""
    @State private var name = ""
    @State private var password = ""
    @State private var code = ""
    @State private var needCode = false
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "play.rectangle.fill").font(.system(size: 64)).foregroundStyle(accent)
            Text("BraXhn TV").font(.largeTitle.bold())
            Text("Ange adressen till din server, t.ex. 192.168.1.10:8420 eller https://tv.dindomän.se")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Group {
                TextField("Serveradress", text: $server)
                    .textContentType(.URL)
                TextField("Användarnamn", text: $name)
                    .textContentType(.username)
                SecureField("Lösenord", text: $password)
                    .textContentType(.password)
                if needCode {
                    TextField("Kod från autentiseringsappen", text: $code)
                        .textContentType(.oneTimeCode)
                        #if os(iOS)
                        .keyboardType(.numberPad)
                        #endif
                }
            }
            #if os(iOS)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(12)
            .background(Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
            #endif
            if let e = error { Text(e).foregroundStyle(.red).font(.footnote) }
            Button {
                Task {
                    busy = true; error = nil
                    do { try await model.login(server: server, name: name, password: password, code: needCode ? code : nil) }
                    catch let e as APIError where e.need2fa {
                        // Servern kräver tvåstegskod – visa fältet (felmeddelande bara om en kod redan skickats)
                        if needCode { self.error = e.message }
                        needCode = true
                    }
                    catch { self.error = error.localizedDescription }
                    busy = false
                }
            } label: {
                HStack { if busy { ProgressView() }; Text("Logga in") }.frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy || server.isEmpty || name.isEmpty)
        }
        .padding(32)
        .frame(maxWidth: 520)
    }
}

// MARK: - Kort och hyllor

struct PosterCard: View {
    @EnvironmentObject var model: AppModel
    let item: MediaItem
    var landscape = false

    private var width: CGFloat {
        #if os(tvOS)
        return landscape ? 420 : 240
        #else
        return landscape ? 250 : 130
        #endif
    }
    private var height: CGFloat { landscape ? width * 9 / 16 : width * 1.5 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .bottomLeading) {
                AsyncImage(url: model.imageURL(item, landscape: landscape)) { phase in
                    if let img = phase.image { img.resizable().scaledToFill() } else { placeholder }
                }
                .frame(width: width, height: height)
                .clipped()
                if item.progress > 0 && item.watched != true {
                    Rectangle().fill(Color.black.opacity(0.5)).frame(width: width, height: 5)
                    Rectangle().fill(accent).frame(width: width * item.progress, height: 5)
                }
            }
            .overlay(alignment: .topTrailing) { badge.padding(6) }
            .clipShape(RoundedRectangle(cornerRadius: 10))
            Text(landscape && item.isEpisode ? (item.showTitle ?? item.title) : item.title)
                .font(.subheadline.weight(.semibold)).lineLimit(1)
            Text(landscape && item.isEpisode ? "\(item.sxe) · \(item.title)" : item.subtitleLine)
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(width: width)
    }

    private var placeholder: some View {
        ZStack {
            LinearGradient(colors: [Color(hue: hueFor(item.title), saturation: 0.5, brightness: 0.4),
                                    Color(hue: hueFor(item.title), saturation: 0.6, brightness: 0.18)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Text(item.showTitle ?? item.title).font(.headline).multilineTextAlignment(.center).padding(8)
        }
    }

    @ViewBuilder private var badge: some View {
        if item.watched == true {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.white, .green).font(.title3)
        } else if item.isShow, let n = item.episodes, let w = item.watchedEpisodes, w > 0, n - w > 0 {
            Text("\(n - w)").font(.caption.bold()).padding(.horizontal, 7).padding(.vertical, 3)
                .background(accent, in: Capsule()).foregroundStyle(.black)
        }
    }
}

func hueFor(_ s: String) -> Double {
    var h = 0
    for c in s.unicodeScalars { h = (h * 31 + Int(c.value)) % 360 }
    return Double(h) / 360
}

struct Shelf: View {
    let title: String
    let items: [MediaItem]
    var landscape = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.title3.bold()).padding(.horizontal)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 16) {
                    ForEach(items) { it in
                        NavigationLink(value: Route.item(it.id)) { PosterCard(item: it, landscape: landscape) }
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
}

// MARK: - Hem

struct HomeView: View {
    @EnvironmentObject var model: AppModel
    @State private var home: HomeResponse?
    @State private var libs: [Library] = []
    @State private var error: String?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
                if let e = error { Text(e).foregroundStyle(.secondary).padding() }
                if !libs.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(libs) { l in
                                NavigationLink(value: Route.library(l)) {
                                    Label(l.name, systemImage: l.type == "show" ? "tv" : "film")
                                        .padding(.horizontal, 16).padding(.vertical, 10)
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                        .padding(.horizontal)
                    }
                }
                if let h = home {
                    if !h.continueWatching.isEmpty { Shelf(title: "Fortsätt titta", items: h.continueWatching, landscape: true) }
                    ForEach(h.rows) { r in
                        if !r.items.isEmpty { Shelf(title: r.title, items: r.items) }
                    }
                } else if error == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(60)
                }
            }
            .padding(.vertical)
        }
        .navigationTitle("BraXhn TV")
        .onAppear { Task { await model.refreshImageToken(); await load() } }
        .refreshable { await load() }
    }

    @MainActor func load() async {
        do {
            async let h: HomeResponse = model.get("/api/home")
            async let l: [Library] = model.get("/api/libraries")
            let (hh, ll) = try await (h, l)
            home = hh
            libs = ll
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

// MARK: - Bibliotek och sök

struct ItemGrid: View {
    let items: [MediaItem]
    var landscape = false
    private var columns: [GridItem] {
        #if os(tvOS)
        return [GridItem(.adaptive(minimum: landscape ? 420 : 240), spacing: 40)]
        #else
        return [GridItem(.adaptive(minimum: landscape ? 250 : 130), spacing: 14)]
        #endif
    }
    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 24) {
            ForEach(items) { it in
                NavigationLink(value: Route.item(it.id)) { PosterCard(item: it, landscape: landscape) }.cardButton()
            }
        }
        .padding()
    }
}

struct LibraryView: View {
    @EnvironmentObject var model: AppModel
    let library: Library
    @State private var items: [MediaItem] = []
    @State private var sort = "title"
    @State private var loading = true
    private let sorts: [(key: String, name: String)] = [("title", "Titel"), ("added", "Senast tillagda"), ("year", "År")]

    var body: some View {
        ScrollView {
            HStack {
                ForEach(sorts, id: \.key) { o in
                    Button(o.name) { sort = o.key; Task { await load() } }
                        .buttonStyle(.bordered)
                        .tint(sort == o.key ? accent : Color.secondary)
                }
                Spacer()
            }
            .padding(.horizontal)
            if loading { ProgressView().padding(40) }
            ItemGrid(items: items)
        }
        .navigationTitle(library.name)
        .task { await load() }
    }

    @MainActor func load() async {
        loading = true
        if let r: LibraryItems = try? await model.get("/api/libraries/\(library.id)/items", [URLQueryItem(name: "sort", value: sort)]) { items = r.items }
        loading = false
    }
}

struct SearchView: View {
    @EnvironmentObject var model: AppModel
    @State private var query = ""
    @State private var results: [MediaItem] = []

    var body: some View {
        ScrollView {
            if results.isEmpty && query.count >= 2 { Text("Inga träffar").foregroundStyle(.secondary).padding(40) }
            ItemGrid(items: results.filter { !$0.isEpisode })
            let eps = results.filter { $0.isEpisode }
            if !eps.isEmpty {
                Text("Avsnitt").font(.title3.bold()).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal)
                ItemGrid(items: eps, landscape: true)
            }
        }
        .navigationTitle("Sök")
        .searchable(text: $query, prompt: "Filmer och serier")
        .task(id: query) {
            guard query.count >= 2 else { results = []; return }
            try? await Task.sleep(nanoseconds: 300_000_000)
            if let r: [MediaItem] = try? await model.get("/api/search", [URLQueryItem(name: "q", value: query)]) { results = r }
        }
    }
}

// MARK: - Inställningar

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    private let qualities: [(key: String, name: String)] = [("auto", "Automatisk"), ("orig", "Original"), ("1080", "1080p"), ("720", "720p"), ("480", "480p"), ("360", "360p")]
    private let langs: [(key: String, name: String)] = [("", "Inga"), ("sv", "Svenska"), ("en", "Engelska"), ("no", "Norska"), ("da", "Danska"), ("fi", "Finska")]

    var body: some View {
        List {
            Section("Server") {
                LabeledContent("Adress", value: model.server)
                LabeledContent("Inloggad som", value: model.user?.name ?? "–")
            }
            Section("Kvalitet") {
                ForEach(qualities, id: \.key) { o in
                    Button { model.quality = o.key } label: { HStack { Text(o.name); Spacer(); if model.quality == o.key { Image(systemName: "checkmark") } } }
                }
            }
            Section("Undertexter som standard") {
                ForEach(langs, id: \.key) { o in
                    Button { model.subtitleLang = o.key } label: { HStack { Text(o.name); Spacer(); if model.subtitleLang == o.key { Image(systemName: "checkmark") } } }
                }
            }
            Section {
                Button("Logga ut", role: .destructive) { model.logout() }
            }
            Section { Text("BraXhn TV – fri mediaserver utan prenumeration").font(.footnote).foregroundStyle(.secondary) }
        }
        .navigationTitle("Inställningar")
    }
}
