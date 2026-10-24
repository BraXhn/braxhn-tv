import SwiftUI
import AVKit
import AVFoundation

// MARK: - Modeller (matchar /api/live och /api/dvr, samma endpoints som Android-appens Live.kt)

/// Ett program i guiden. Tiderna är Unix-sekunder; de avkodas som Double så att ett decimaltal aldrig fäller listan.
struct LiveProg: Decodable, Hashable, Identifiable {
    let id: Int
    let start: Double
    let stop: Double
    let title: String
    let subtitle: String?
}

struct LiveChannel: Decodable, Hashable, Identifiable {
    let id: Int
    let number: String?
    let name: String
    let logo: String?
    let now: LiveProg?
    let next: LiveProg?
}

struct LiveChannels: Decodable {
    let channels: [LiveChannel]
}

/// GET /api/live/guide: kanalerna med sina program i tidsfönstret
struct GuideChannel: Decodable, Hashable, Identifiable {
    let id: Int
    let number: String?
    let name: String
    let logo: String?
    let programs: [LiveProg]?
}

struct LiveGuide: Decodable {
    let channels: [GuideChannel]
}

struct Recording: Decodable, Hashable, Identifiable {
    let id: Int
    let title: String
    let subtitle: String?
    let channel_name: String?
    let start: Double
    let stop: Double
    let status: String
    let error: String?
}

struct DvrList: Decodable {
    let scheduled: [Recording]?
    let done: [Recording]?
}

private let hmFormat: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "sv_SE")
    f.dateFormat = "HH:mm"
    return f
}()
private let dayFormat: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "sv_SE")
    f.dateFormat = "EEE d MMM HH:mm"
    return f
}()
func liveTime(_ t: Double) -> String { hmFormat.string(from: Date(timeIntervalSince1970: t)) }
func liveDay(_ t: Double) -> String { dayFormat.string(from: Date(timeIntervalSince1970: t)) }

/// Kanallogotyp (hämtas via servern med bildtoken), annars kanalnumret eller början av namnet
struct ChannelLogo: View {
    @EnvironmentObject var model: AppModel
    let id: Int
    let name: String
    let number: String?
    let hasLogo: Bool
    var width: CGFloat = 72
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.12))
            Text(number ?? String(name.prefix(3))).font(.caption.bold())
            if hasLogo, let t = model.imageToken, let u = model.url("/api/live/logo/\(id)", [URLQueryItem(name: "t", value: t)]) {
                AsyncImage(url: u) { ph in
                    if let img = ph.image { img.resizable().scaledToFit().padding(4).background(Color.black.opacity(0.6)) }
                }
            }
        }
        .frame(width: width, height: width * 2 / 3)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

extension View {
    /// Flera knappar på samma listrad: på iPhone/iPad annars utlöser ett tryck på raden alla knapparna
    @ViewBuilder func rowButton() -> some View {
        #if os(iOS)
        buttonStyle(.borderless)
        #else
        self
        #endif
    }
}

struct LivePlayRequest: Identifiable {
    let id = UUID()
    /// POST-adressen som ger strömmen: /api/live/:cid/play eller /api/dvr/recordings/:rid/play
    let path: String
    let title: String
    let live: Bool
}

// MARK: - Kanaler

struct LiveView: View {
    @EnvironmentObject var model: AppModel
    @State private var data: LiveChannels?
    @State private var error: String?
    @State private var play: LivePlayRequest?

    private var columns: [GridItem] {
        #if os(tvOS)
        return [GridItem(.adaptive(minimum: 560), spacing: 40)]
        #else
        return [GridItem(.adaptive(minimum: 300), spacing: 12)]
        #endif
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    NavigationLink(destination: GuideView()) { Label("TV-guide", systemImage: "list.bullet.rectangle") }
                        .buttonStyle(.bordered)
                    NavigationLink(destination: RecordingsView()) { Label("Inspelningar", systemImage: "record.circle") }
                        .buttonStyle(.bordered)
                    Spacer()
                }
                .padding(.horizontal)
                if let e = error { Text(e).foregroundStyle(.secondary).padding(.horizontal) }
                if let d = data {
                    if d.channels.isEmpty {
                        Text("Inga kanaler – lägg till en källa under Administration i webben.").foregroundStyle(.secondary).padding(.horizontal)
                    }
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 16) {
                        ForEach(d.channels) { ch in
                            Button { play = LivePlayRequest(path: "/api/live/\(ch.id)/play", title: ch.name, live: true) } label: {
                                ChannelRow(channel: ch)
                            }
                            .cardButton()
                        }
                    }
                    .padding(.horizontal)
                } else if error == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(60)
                }
            }
            .padding(.vertical)
        }
        .navigationTitle("Live-TV")
        .task { await load() }
        .refreshable { await load() }
        .fullScreenCover(item: $play) { r in LivePlayerScreen(request: r).environmentObject(model) }
    }

    @MainActor func load() async {
        await model.refreshImageToken()
        do {
            data = try await model.get("/api/live/channels")
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

struct ChannelRow: View {
    let channel: LiveChannel
    var body: some View {
        HStack(spacing: 12) {
            ChannelLogo(id: channel.id, name: channel.name, number: channel.number, hasLogo: channel.logo != nil)
            VStack(alignment: .leading, spacing: 3) {
                Text(channel.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                if let p = channel.now {
                    Text("Nu: \(p.title)").font(.caption).lineLimit(1)
                    ProgressView(value: progress(p)).tint(accent)
                }
                if let n = channel.next {
                    Text("Sen: \(liveTime(n.start)) \(n.title)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    }

    private func progress(_ p: LiveProg) -> Double {
        guard p.stop > p.start else { return 0 }
        return min(1, max(0, (Date().timeIntervalSince1970 - p.start) / (p.stop - p.start)))
    }
}

// MARK: - TV-guide

struct GuideView: View {
    @EnvironmentObject var model: AppModel
    @State private var guide: LiveGuide?
    @State private var error: String?
    @State private var selected: GuidePick?
    @State private var showPick = false
    @State private var message: String?
    @State private var showMessage = false
    @State private var play: LivePlayRequest?

    struct GuidePick { let channel: GuideChannel; let program: LiveProg }

    private var cellWidth: CGFloat {
        #if os(tvOS)
        return 360
        #else
        return 200
        #endif
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if let e = error { Text(e).foregroundStyle(.secondary).padding(.horizontal) }
                if let g = guide {
                    if g.channels.isEmpty { Text("Guiden är tom.").foregroundStyle(.secondary).padding(.horizontal) }
                    ForEach(g.channels) { ch in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 10) {
                                ChannelLogo(id: ch.id, name: ch.name, number: ch.number, hasLogo: ch.logo != nil, width: 54)
                                Text(ch.name).font(.headline)
                            }
                            .padding(.horizontal)
                            ScrollView(.horizontal, showsIndicators: false) {
                                LazyHStack(spacing: 10) {
                                    let now = Date().timeIntervalSince1970
                                    ForEach((ch.programs ?? []).filter { $0.stop > now }) { p in
                                        Button { selected = GuidePick(channel: ch, program: p); showPick = true } label: {
                                            VStack(alignment: .leading, spacing: 3) {
                                                Text("\(liveTime(p.start))–\(liveTime(p.stop))").font(.caption).foregroundStyle(p.start <= now ? accent : .secondary)
                                                Text(p.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                                                if let s = p.subtitle { Text(s).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                                            }
                                            .frame(width: cellWidth, alignment: .leading)
                                            .padding(10)
                                            .background(Color.secondary.opacity(p.start <= now ? 0.22 : 0.1), in: RoundedRectangle(cornerRadius: 10))
                                        }
                                        .cardButton()
                                    }
                                }
                                .padding(.horizontal)
                                #if os(tvOS)
                                .padding(.vertical, 20)
                                #endif
                            }
                        }
                    }
                } else if error == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(60)
                }
            }
            .padding(.vertical)
        }
        .navigationTitle("TV-guide")
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog(selected?.program.title ?? "Program", isPresented: $showPick, titleVisibility: .visible, presenting: selected) { pick in
            let now = Date().timeIntervalSince1970
            if pick.program.start <= now && pick.program.stop > now {
                Button("Titta nu") { play = LivePlayRequest(path: "/api/live/\(pick.channel.id)/play", title: pick.channel.name, live: true) }
            }
            Button("Spela in") { Task { await record(pick.program) } }
            Button("Avbryt", role: .cancel) {}
        } message: { pick in
            Text("\(pick.channel.name) · \(liveDay(pick.program.start))–\(liveTime(pick.program.stop))")
        }
        .alert(message ?? "", isPresented: $showMessage) { Button("OK", role: .cancel) {} }
        .fullScreenCover(item: $play) { r in LivePlayerScreen(request: r).environmentObject(model) }
    }

    @MainActor func load() async {
        await model.refreshImageToken()
        do {
            guide = try await model.get("/api/live/guide", [URLQueryItem(name: "hours", value: "12")])
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    /// Bokar en inspelning av programmet (POST /api/dvr/program)
    @MainActor func record(_ p: LiveProg) async {
        do {
            try await model.post("/api/dvr/program", ["programId": p.id])
            message = "Inspelningen av \(p.title) är bokad."
        } catch { message = error.localizedDescription }
        showMessage = true
    }
}

// MARK: - Inspelningar

struct RecordingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var data: DvrList?
    @State private var error: String?
    @State private var play: LivePlayRequest?
    @State private var removing: Recording?
    @State private var askRemove = false

    var body: some View {
        List {
            if let e = error { Text(e).foregroundStyle(.secondary) }
            if let d = data {
                let done = d.done ?? []
                Section("Inspelat") {
                    if done.isEmpty { Text("Inget inspelat ännu. Boka inspelningar i TV-guiden.").foregroundStyle(.secondary) }
                    ForEach(done) { r in
                        HStack {
                            Button {
                                if r.status == "done" { play = LivePlayRequest(path: "/api/dvr/recordings/\(r.id)/play", title: r.title, live: false) }
                            } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text([r.title, r.subtitle].compactMap { $0 }.joined(separator: " – ")).font(.headline).lineLimit(2)
                                    Text([r.channel_name, liveDay(r.start), statusText(r)].compactMap { $0 }.joined(separator: " · "))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .rowButton()
                            Button(role: .destructive) { removing = r; askRemove = true } label: { Image(systemName: "trash") }
                                .rowButton()
                                .accessibilityLabel("Ta bort")
                        }
                    }
                }
                let scheduled = d.scheduled ?? []
                if !scheduled.isEmpty {
                    Section("Kommande") {
                        ForEach(scheduled) { r in
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(r.title + (r.status == "recording" ? "  ⏺" : "")).font(.headline).lineLimit(2)
                                    Text([r.channel_name, liveDay(r.start)].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button(r.status == "recording" ? "Stoppa" : "Avboka", role: .destructive) { removing = r; askRemove = true }
                                    .rowButton()
                            }
                        }
                    }
                }
            } else if error == nil {
                ProgressView()
            }
        }
        .navigationTitle("Inspelningar")
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog(removing.map { removeQuestion($0) } ?? "", isPresented: $askRemove, titleVisibility: .visible, presenting: removing) { r in
            Button(r.status == "scheduled" ? "Avboka" : "Ta bort", role: .destructive) { Task { await remove(r) } }
            Button("Avbryt", role: .cancel) {}
        }
        .fullScreenCover(item: $play) { r in LivePlayerScreen(request: r).environmentObject(model) }
    }

    private func statusText(_ r: Recording) -> String? {
        switch r.status {
        case "processing": return "Bearbetas"
        case "failed": return "Misslyckades" + (r.error.map { ": \($0)" } ?? "")
        default: return nil
        }
    }

    private func removeQuestion(_ r: Recording) -> String {
        r.status == "scheduled" ? "Avboka \(r.title)?" : r.status == "recording" ? "Stoppa och ta bort \(r.title)?" : "Ta bort inspelningen \(r.title)?"
    }

    @MainActor func load() async {
        do {
            data = try await model.get("/api/dvr")
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    @MainActor func remove(_ r: Recording) async {
        do { try await model.delete("/api/dvr/recordings/\(r.id)") } catch { self.error = error.localizedDescription }
        await load()
    }
}

// MARK: - Spelare för live-TV och inspelningar

@MainActor
final class LivePlayback: ObservableObject {
    let player = AVPlayer()
    @Published var error: String?
    private var failObserver: NSObjectProtocol?
    private var started = false
    private var stopped = false

    init() {
        player.allowsExternalPlayback = true
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        #endif
    }

    func start(_ r: LivePlayRequest, model: AppModel) async {
        guard !started, !stopped else { return }
        started = true
        AudioFocus.willPlay(.video)
        do {
            let data = try await model.post(r.path)
            let u = try JSONDecoder().decode(PlayURL.self, from: data)
            guard !stopped else { return }
            guard let url = model.absolute(u.url) else { throw APIError(message: "Ogiltig ström-URL") }
            let item = AVPlayerItem(url: url)
            let t = AVMutableMetadataItem()
            t.identifier = .commonIdentifierTitle
            t.value = r.title as NSString
            t.extendedLanguageTag = "und"
            item.externalMetadata = [t]
            failObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                Task { @MainActor [weak self] in self?.error = r.live ? "Kanalen kunde inte spelas – alla tuners kan vara upptagna." : "Inspelningen kunde inte spelas." }
            }
            player.replaceCurrentItem(with: item)
            player.play()
        } catch {
            if !stopped { self.error = error.localizedDescription }
        }
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        player.pause()
        player.replaceCurrentItem(with: nil)
        if let o = failObserver { NotificationCenter.default.removeObserver(o); failObserver = nil }
    }
}

/// AVPlayerViewController utan egna tillägg (live-TV och inspelningar)
struct BasicPlayerVC: UIViewControllerRepresentable {
    let player: AVPlayer
    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = AVPlayerViewController()
        vc.player = player
        #if os(iOS)
        vc.allowsPictureInPicturePlayback = true
        #endif
        return vc
    }
    func updateUIViewController(_ vc: AVPlayerViewController, context: Context) {}
}

struct LivePlayerScreen: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let request: LivePlayRequest
    @StateObject private var playback = LivePlayback()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            BasicPlayerVC(player: playback.player).ignoresSafeArea()
            #if os(iOS)
            VStack {
                HStack {
                    Button { close() } label: { Image(systemName: "xmark").font(.title3.bold()).padding(10).background(.ultraThinMaterial, in: Circle()) }
                    Text(request.title + (request.live ? "  · LIVE" : "")).font(.subheadline.weight(.semibold)).lineLimit(1).shadow(radius: 2)
                    Spacer()
                }
                .padding()
                Spacer()
            }
            #endif
            if let e = playback.error {
                VStack(spacing: 14) {
                    Text("Kunde inte spela").font(.headline)
                    Text(e).font(.footnote).foregroundStyle(.secondary)
                    Button("Stäng") { close() }.buttonStyle(.borderedProminent)
                }
                .padding(24).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
        }
        .task { await playback.start(request, model: model) }
        .onDisappear { playback.stop() }
        #if os(iOS)
        .statusBarHidden()
        #endif
    }

    func close() {
        playback.stop()
        dismiss()
    }
}
