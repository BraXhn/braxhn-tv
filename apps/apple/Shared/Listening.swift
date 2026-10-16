import SwiftUI
import Foundation

// MARK: - Lyssningsinställningar (per användare på servern: /api/me/listening)

struct ListenPrefsDTO: Decodable {
    let normalize: Bool
    let skipBack: Int
    let skipForward: Int
    let skipSilence: Bool?
}

/// Tillåtna hoppintervall (sekunder) – samma som servern accepterar
let listenBackChoices = [5, 10, 15, 30, 45, 60]
let listenForwardChoices = [10, 15, 30, 45, 60, 90]

private func storedChoice(_ key: String, _ def: Int, _ allowed: [Int]) -> Int {
    let v = UserDefaults.standard.integer(forKey: key)
    return allowed.contains(v) ? v : def
}

/// Nästa värde i listan (runt till början)
func nextChoice(_ v: Int, in list: [Int]) -> Int {
    guard let i = list.firstIndex(of: v) else { return list[0] }
    return list[(i + 1) % list.count]
}

/// Jämn ljudnivå och hoppintervall. Sparas på servern (gäller webben och alla appar) och cachas lokalt.
@MainActor
final class ListenSettings: ObservableObject {
    static let shared = ListenSettings()

    @Published private(set) var normalize: Bool = UserDefaults.standard.object(forKey: "listen.normalize") as? Bool ?? true
    @Published private(set) var skipBack: Int = storedChoice("listen.skipBack", 15, listenBackChoices)
    @Published private(set) var skipForward: Int = storedChoice("listen.skipForward", 30, listenForwardChoices)

    private func apply(_ p: ListenPrefsDTO) {
        normalize = p.normalize
        if listenBackChoices.contains(p.skipBack) { skipBack = p.skipBack }
        if listenForwardChoices.contains(p.skipForward) { skipForward = p.skipForward }
        UserDefaults.standard.set(normalize, forKey: "listen.normalize")
        UserDefaults.standard.set(skipBack, forKey: "listen.skipBack")
        UserDefaults.standard.set(skipForward, forKey: "listen.skipForward")
        SpokenPlayer.shared.refreshSkipIntervals()
    }

    func refresh(_ model: AppModel) async {
        if let p: ListenPrefsDTO = try? await model.get("/api/me/listening") { apply(p) }
    }

    func save(_ model: AppModel, _ body: [String: Any]) async {
        guard let data = try? await model.put("/api/me/listening", body),
              let p = try? JSONDecoder().decode(ListenPrefsDTO.self, from: data) else { return }
        apply(p)
    }

    /// Volym för ett spår med känd gain (dB mot -18 LUFS). AVPlayer kan bara dämpa, så tysta låtar höjs inte.
    func volume(gain: Double?) -> Float {
        guard normalize, let g = gain, g.isFinite else { return 1 }
        return Float(min(1.0, max(0.05, pow(10.0, g / 20.0))))
    }
}

// MARK: - Sovtimer

/// Tonar ner och pausar det som spelas (musik eller tal) efter en viss tid, eller när låten/kapitlet/avsnittet tar slut.
@MainActor
final class SleepTimer: ObservableObject {
    static let shared = SleepTimer()
    enum Mode: Equatable { case off, minutes(Int), endOfItem }

    @Published private(set) var mode: Mode = .off
    @Published private(set) var label = ""
    private var deadline: Date?
    private var task: Task<Void, Never>?
    private let fadeSeconds = 10.0

    /// Av → 15 → 30 → 45 → 60 min → när det tar slut → Av
    func cycle() {
        switch mode {
        case .off: set(.minutes(15))
        case .minutes(let m): set(m >= 60 ? .endOfItem : .minutes(m + 15))
        case .endOfItem: set(.off)
        }
    }

    func set(_ m: Mode) {
        task?.cancel()
        task = nil
        mode = m
        applyFade(1)
        switch m {
        case .off:
            deadline = nil
            label = ""
            return
        case .minutes(let n):
            deadline = Date().addingTimeInterval(Double(n) * 60)
            label = "\(n) min"
        case .endOfItem:
            deadline = nil
            label = "slut"
        }
        task = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.tick()
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
        }
    }

    private var spokenActive: Bool { AudioFocus.spokenHasControls }

    private func remaining() -> Double? {
        switch mode {
        case .off: return nil
        case .minutes: return deadline.map { $0.timeIntervalSinceNow }
        case .endOfItem: return spokenActive ? SpokenPlayer.shared.remainingInSection() : MusicPlayer.shared.remainingInTrack()
        }
    }

    private func tick() {
        guard mode != .off else { return }
        guard SpokenPlayer.shared.track != nil || MusicPlayer.shared.current != nil else { set(.off); return }
        guard let left = remaining() else { return }
        applyFade(left < fadeSeconds ? Float(max(0, left / fadeSeconds)) : 1)
        if left <= 0.3 {
            // Paus sparar positionen i ljudböcker och poddar
            if spokenActive { SpokenPlayer.shared.pause() } else { MusicPlayer.shared.pause() }
            set(.off)
            return
        }
        if case .minutes = mode {
            let text = "\(max(1, Int((left / 60).rounded(.up)))) min"
            if text != label { label = text }
        }
    }

    private func applyFade(_ f: Float) {
        SpokenPlayer.shared.setFade(f)
        MusicPlayer.shared.setFade(f)
    }
}

/// Knappens etikett: måne, och kvarvarande tid när timern är på
struct SleepLabel: View {
    @ObservedObject private var st = SleepTimer.shared
    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: st.mode == .off ? "moon" : "moon.fill")
            if st.mode != .off { Text(st.label).font(.caption2) }
        }
        .accessibilityLabel("Sovtimer")
    }
}

/// Inställningsrader för lyssning (visas under Inställningar)
struct ListenSettingsSection: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var ls = ListenSettings.shared
    var body: some View {
        Section {
            Button { Task { await ls.save(model, ["normalize": !ls.normalize]) } } label: {
                HStack { Text("Jämn ljudnivå i musik"); Spacer(); Text(ls.normalize ? "På" : "Av").foregroundStyle(.secondary) }
            }
            Button { Task { await ls.save(model, ["skipBack": nextChoice(ls.skipBack, in: listenBackChoices)]) } } label: {
                HStack { Text("Hopp bakåt"); Spacer(); Text("\(ls.skipBack) s").foregroundStyle(.secondary) }
            }
            Button { Task { await ls.save(model, ["skipForward": nextChoice(ls.skipForward, in: listenForwardChoices)]) } } label: {
                HStack { Text("Hopp framåt"); Spacer(); Text("\(ls.skipForward) s").foregroundStyle(.secondary) }
            }
        } header: {
            Text("Lyssning")
        } footer: {
            Text("Gäller ljudböcker och poddar och sparas på servern för ditt konto. Jämn ljudnivå kan bara sänka för höga låtar. Att hoppa över tystnad finns bara i Android-appen.")
        }
        .task { await ls.refresh(model) }
    }
}
