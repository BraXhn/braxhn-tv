import SwiftUI

struct PlayRequest: Identifiable {
    let id = UUID()
    let itemId: Int
    let start: Double
    let audio: Int?
    let subtitle: SubtitleTrack?
}

/// Enkel väljare som fungerar på både iOS och tvOS (lista i ett ark).
struct OptionButton<T: Hashable>: View {
    let title: String
    let options: [(T, String)]
    @Binding var selection: T
    @State private var open = false
    private var currentLabel: String { options.first(where: { $0.0 == selection })?.1 ?? "–" }
    var body: some View {
        Button { open = true } label: {
            Label("\(title): \(currentLabel)", systemImage: "chevron.up.chevron.down")
        }
        .buttonStyle(.bordered)
        .sheet(isPresented: $open) {
            NavigationStack {
                List(options.indices, id: \.self) { i in
                    Button { selection = options[i].0; open = false } label: {
                        HStack { Text(options[i].1); Spacer(); if options[i].0 == selection { Image(systemName: "checkmark") } }
                    }
                }
                .navigationTitle(title)
            }
        }
    }
}

struct ItemDetailView: View {
    @EnvironmentObject var model: AppModel
    let id: Int
    @State private var item: MediaItem?
    @State private var error: String?
    @State private var play: PlayRequest?
    @State private var season: Int = -1
    @State private var audio: Int = -1
    @State private var subtitle: String = ""
    /// Min lista efter att användaren tryckt (nil = som servern sa i item.inWatchlist)
    @State private var inList: Bool?

    var body: some View {
        Group {
            if let it = item {
                ScrollView { content(it).padding(.bottom, 40) }
            } else if let e = error {
                Text(e).foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .navigationTitle(item?.title ?? "")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task { await load() }
        .fullScreenCover(item: $play, onDismiss: { Task { await load() } }) { req in
            PlayerScreen(request: req).environmentObject(model)
        }
    }

    @MainActor func load() async {
        do {
            let it: MediaItem = try await model.get("/api/items/\(id)")
            item = it
            inList = nil
            if season < 0 { season = it.next?.season ?? it.children?.first?.season ?? 1 }
            if audio < 0 { audio = (it.audio?.first { $0.default == true } ?? it.audio?.first)?.index ?? -1 }
            if subtitle.isEmpty, let subs = it.subtitles {
                subtitle = (subs.first { $0.forced == true && $0.bitmap != true }
                            ?? subs.first { !model.subtitleLang.isEmpty && $0.lang == model.subtitleLang && $0.bitmap != true })?.id ?? "none"
            }
        } catch { self.error = error.localizedDescription }
    }

    @MainActor @ViewBuilder func header(_ it: MediaItem) -> some View {
        ZStack(alignment: .bottomLeading) {
            AsyncImage(url: model.backdropURL(it) ?? model.imageURL(it, landscape: true)) { ph in
                if let img = ph.image { img.resizable().scaledToFill() } else { Color.secondary.opacity(0.15) }
            }
            .frame(height: headerHeight).frame(maxWidth: .infinity).clipped()
            .overlay(LinearGradient(colors: [.clear, Color.black.opacity(0.85)], startPoint: .center, endPoint: .bottom))
            VStack(alignment: .leading, spacing: 6) {
                if it.isEpisode { Text("\(it.showTitle ?? "") · \(it.sxe)").font(.subheadline).foregroundStyle(.secondary) }
                Text(it.title).font(.largeTitle.bold()).lineLimit(2)
                HStack(spacing: 12) {
                    if let y = it.year { Text(String(y)) }
                    if !it.isShow { Text(formatDuration(it.duration)) }
                    if let n = it.episodes, it.isShow { Text("\(n) avsnitt") }
                    if let r = it.rating { Label(String(format: "%.1f", r), systemImage: "star.fill") }
                    if let h = it.hdr { Text(h.uppercased()).font(.caption.bold()).padding(.horizontal, 6).padding(.vertical, 2).overlay(RoundedRectangle(cornerRadius: 4).stroke()) }
                }
                .font(.subheadline).foregroundStyle(.secondary)
            }
            .padding()
        }
    }

    private var headerHeight: CGFloat {
        #if os(tvOS)
        return 520
        #else
        return 280
        #endif
    }

    @MainActor @ViewBuilder func content(_ it: MediaItem) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            header(it)
            if it.isShow { showContent(it) } else { mediaContent(it) }
        }
    }

    private func selectedSubtitle(_ it: MediaItem) -> SubtitleTrack? { it.subtitles?.first { $0.id == subtitle } }

    @MainActor @ViewBuilder func mediaContent(_ it: MediaItem) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                if let p = it.position, p > 30 {
                    Button { play = PlayRequest(itemId: it.id, start: p, audio: audio >= 0 ? audio : nil, subtitle: selectedSubtitle(it)) } label: {
                        Label("Fortsätt från \(formatTime(p))", systemImage: "play.fill")
                    }.buttonStyle(.borderedProminent)
                    Button("Börja om") { play = PlayRequest(itemId: it.id, start: 0, audio: audio >= 0 ? audio : nil, subtitle: selectedSubtitle(it)) }
                        .buttonStyle(.bordered)
                } else {
                    Button { play = PlayRequest(itemId: it.id, start: 0, audio: audio >= 0 ? audio : nil, subtitle: selectedSubtitle(it)) } label: {
                        Label("Spela", systemImage: "play.fill")
                    }.buttonStyle(.borderedProminent)
                }
                Button(it.watched == true ? "Markera osedd" : "Markera sedd") {
                    Task { try? await model.post("/api/items/\(it.id)/watched", ["watched": !(it.watched ?? false)]); await load() }
                }.buttonStyle(.bordered)
            }
            HStack(spacing: 14) {
                watchlistButton(it)
                #if os(iOS)
                DownloadButton(item: it)
                #endif
            }
            HStack(spacing: 14) {
                if let a = it.audio, a.count > 1 {
                    OptionButton<Int>(title: "Ljud", options: a.map { ($0.index, $0.label) }, selection: $audio)
                }
                if let s = it.subtitles, !s.isEmpty {
                    OptionButton<String>(title: "Undertext", options: [("none", "Inga")] + s.map { ($0.id, $0.label) }, selection: $subtitle)
                }
            }
            if let o = it.overview { Text(o).font(.body).foregroundStyle(.secondary) }
            if let c = castLine(it.cast) { Text(c).font(.callout).foregroundStyle(.secondary) }
        }
        .padding(.horizontal)
    }

    @MainActor @ViewBuilder func showContent(_ it: MediaItem) -> some View {
        let eps = it.children ?? []
        let seasons = Array(Set(eps.compactMap { $0.season })).sorted()
        VStack(alignment: .leading, spacing: 16) {
            if let n = it.next {
                Button {
                    play = PlayRequest(itemId: n.id, start: n.position ?? 0, audio: nil, subtitle: nil)
                } label: {
                    Label((n.position ?? 0) > 0 ? "Fortsätt S\(n.season ?? 0)E\(n.episode ?? 0)" : "Spela S\(n.season ?? 0)E\(n.episode ?? 0)", systemImage: "play.fill")
                }
                .buttonStyle(.borderedProminent)
            }
            watchlistButton(it)
            if let o = it.overview { Text(o).foregroundStyle(.secondary) }
            if let c = castLine(it.cast) { Text(c).font(.callout).foregroundStyle(.secondary) }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(seasons, id: \.self) { s in
                        Button(s == 0 ? "Special" : "Säsong \(s)") { season = s }
                            .buttonStyle(.bordered)
                            .tint(s == season ? accent : Color.secondary)
                    }
                }
            }
            ForEach(eps.filter { $0.season == season }) { e in
                Button {
                    play = PlayRequest(itemId: e.id, start: (e.position ?? 0) > 30 ? (e.position ?? 0) : 0, audio: nil, subtitle: nil)
                } label: {
                    HStack(alignment: .top, spacing: 14) {
                        PosterCard(item: e, landscape: true).frame(maxWidth: 250)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(e.episode ?? 0). \(e.title)").font(.headline)
                            Text(formatDuration(e.duration) + (e.watched == true ? " · Sedd" : "")).font(.caption).foregroundStyle(.secondary)
                            if let o = e.overview { Text(o).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
                        }
                        Spacer()
                    }
                }
                .cardButton()
            }
        }
        .padding(.horizontal)
    }
}

#if os(iOS)
struct DownloadButton: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var dl = Downloads.shared
    let item: MediaItem
    @State private var ask = false
    var body: some View {
        if dl.isDownloaded(item.id) {
            Button(role: .destructive) { dl.remove(item.id) } label: { Label("Ta bort nedladdning", systemImage: "trash") }.buttonStyle(.bordered)
        } else if let p = dl.active[item.id] {
            HStack { ProgressView(value: p).frame(width: 160); Text(p < 0.5 ? "Förbereder…" : "Laddar ner…").font(.caption) }
        } else {
            Button { ask = true } label: { Label("Ladda ner för offline", systemImage: "arrow.down.circle") }
                .buttonStyle(.bordered)
                .confirmationDialog("Kvalitet", isPresented: $ask) {
                    Button("Hög (1080p)") { dl.download(item, quality: "1080", model: model) }
                    Button("Mellan (720p)") { dl.download(item, quality: "720", model: model) }
                    Button("Låg (480p, sparar utrymme)") { dl.download(item, quality: "480", model: model) }
                }
        }
    }
}
#endif

// MARK: - Min lista

// (sist i filen så att radhänvisningarna i test/contracts/apps.json står kvar)
extension ItemDetailView {
    /// Lägg till/ta bort i Min lista – bara filmer och serier, och bara när servern skickar inWatchlist
    @MainActor @ViewBuilder func watchlistButton(_ it: MediaItem) -> some View {
        if !it.isEpisode, let on = inList ?? it.inWatchlist {
            Button {
                Task {
                    do { try await model.setWatchlist(it.id, !on); inList = !on } catch {}
                }
            } label: {
                Label(on ? "I Min lista" : "Min lista", systemImage: on ? "checkmark" : "plus")
            }
            .buttonStyle(.bordered)
        }
    }
}
