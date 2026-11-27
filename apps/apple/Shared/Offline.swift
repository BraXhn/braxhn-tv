import SwiftUI
import Network
import CryptoKit

/// Offline-nedladdningar (iPhone/iPad). Servern skapar en mobilanpassad MP4 som laddas ner till appen.
struct OfflineStatus: Decodable {
    let status: String
    let progress: Int?
    let url: String?
    let size: Int?
    let error: String?
}

/// Nedladdning som pågår (behövs när filen blir klar, även efter omstart av appen). tag = bakgrundsuppgiftens märkning
/// (DownloadTag), scope = profilen som får filen ("" eller nil = påbörjad före profilerna). Äldre pending.json har
/// bara id, titel och längd: de räknas som påbörjade före profilerna.
struct PendingDownload: Codable {
    let id: Int
    let title: String
    let subtitle: String
    let duration: Double?
    var scope: String?
    var tag: String?
    var key: String { tag ?? String(id) }
    var owner: String { scope ?? "" }
}

/// Serverns plan för automatisk offline-synk (GET /api/offline/sync)
struct SyncPlan: Decodable {
    let enabled: Bool
    let quality: String
    let wifiOnly: Bool
    let items: [MediaItem]
    let remove: [Int]
}

/// Nätverksbevakning: automatisk synk sker bara på Wi-Fi (eller annat nät som inte är dyrt/begränsat)
private let pathMonitor: NWPathMonitor = {
    let m = NWPathMonitor()
    m.start(queue: DispatchQueue(label: "net.braxhn.tv.network"))
    return m
}()

/// Nedladdningar sparas i Application Support (inte Dokument) och undantas från iCloud-säkerhetskopian.
/// Downloads/<server>-<profil>/ har profilens filer och index.json; Downloads/index.json är listan från före profilerna.
private let downloadsDirectory: URL = {
    let fm = FileManager.default
    var d = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Downloads", isDirectory: true)
    try? fm.createDirectory(at: d, withIntermediateDirectories: true)
    var v = URLResourceValues()
    v.isExcludedFromBackup = true
    try? d.setResourceValues(v)
    return d
}()

/// Profilens mapp ("" = Downloads/ direkt, de gamla nedladdningarna). Skapas vid behov.
private func downloadFolder(_ scope: String, create: Bool = false) -> URL {
    let d = scope.isEmpty ? downloadsDirectory : downloadsDirectory.appendingPathComponent(scope, isDirectory: true)
    if create { try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true) }
    return d
}

// MARK: - Vem är inloggad

/// Inloggningens fingeravtryck och profilen det hör till. Profilen behövs även utan nät (då svarar inte /api/status),
/// så den sparas per fingeravtryck när servern sagt den. Själva token sparas inte här.
enum LoginPrint {
    static func of(_ token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    static func uid(for fp: String) -> Int? { UserDefaults.standard.object(forKey: "dl.uid." + fp) as? Int }

    static func remember(token: String, uid: Int) {
        let k = "dl.uid." + of(token)
        if LoginPrint.uid(for: of(token)) != uid { UserDefaults.standard.set(uid, forKey: k) }
    }

    /// "server-profil" för inloggningen som gäller nu: nil när utloggad eller när profilen inte är känd än
    static func scope(server: String, token: String?) -> String? {
        guard !server.isEmpty, let t = token, let uid = uid(for: of(t)) else { return nil }
        return DownloadScope.of(server: server, uid: uid)
    }
}

/// Anropas när inloggningen eller profilen ändras (AppModel.user) och när appen startar
@MainActor
enum OfflineProfile {
    static func changed(_ model: AppModel) {
        // user kommer alltid från ett anrop med den token som gäller nu (token sätts före user i AppModel)
        if let t = model.token, let u = model.user { LoginPrint.remember(token: t, uid: u.id) }
        #if os(iOS)
        Downloads.shared.open(model: model)
        // Nedladdningar från före profilerna som ingen profil kunde knytas till: huvudkontot får dem
        // Rätten att ladda ner och de nedladdade titlarna kontrolleras mot servern (403/404 tas bort)
        if model.user != nil { Task { await Downloads.shared.online(model: model) } }
        if model.user != nil, Downloads.shared.needsOwner(server: model.server) {
            Task {
                guard let l: ProfileList = try? await model.get("/api/profiles"),
                      let o = l.profiles.first(where: { $0.owner == true }) else { return }
                Downloads.shared.learnOwner(o.id, model: model)
            }
        }
        #endif
        PendingPositions.shared.attach(model)
        PendingPositions.shared.flush()
    }

    /// Finns något nedladdat från servern (någon av dess profiler)? Då frågar Logga ut först.
    static func hasDownloads(_ model: AppModel) -> Bool {
        #if os(iOS)
        return Downloads.shared.hasServerDownloads(model.server)
        #else
        return false
        #endif
    }

    /// Logga ut i Inställningar: väntande positioner skickas först, och allt som laddats ner från servern tas bort
    /// (alla dess profiler). Utloggning för att servern sa 401 tar inte bort något: det syns igen när profilen loggar in.
    static func signOut(_ model: AppModel) async {
        await PendingPositions.shared.flushNow()
        #if os(iOS)
        Downloads.shared.removeServer(model.server)
        #endif
        model.logout()
    }
}

// MARK: - Positioner som väntar på nätet

/// Framsteg som inte kom fram (inget nät, serverfel) sparas per server och profil och skickas i ordning med at när
/// nätet kommer tillbaka, när appen kommer till förgrunden, när profilen blir känd och efter ett lyckat framsteg.
/// Servern behåller då ett senare framsteg från en annan enhet. Reglerna: ProgressQueue i OfflineCore.swift.
@MainActor
final class PendingPositions {
    static let shared = PendingPositions()
    private weak var model: AppModel?
    private var sending = false
    private init() {}

    func attach(_ m: AppModel) {
        guard model !== m else { return }
        model = m
        pathMonitor.pathUpdateHandler = { path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in PendingPositions.shared.flush() }
        }
    }

    private var scope: String? { model.flatMap { LoginPrint.scope(server: $0.server, token: $0.token) } }
    private func load(_ sc: String) -> [PendingProgress] {
        guard let d = UserDefaults.standard.data(forKey: "progress." + sc) else { return [] }
        return (try? JSONDecoder().decode([PendingProgress].self, from: d)) ?? []
    }
    private func save(_ sc: String, _ list: [PendingProgress]) {
        if list.isEmpty { UserDefaults.standard.removeObject(forKey: "progress." + sc) }
        else if let d = try? JSONEncoder().encode(list) { UserDefaults.standard.set(d, forKey: "progress." + sc) }
    }

    /// Skickar ett framsteg (kind: ProgressQueue.item, .book eller .pod). Kom det inte fram sparas positionen och när
    /// den sparades. Ger svaret, eller nil.
    func post(_ model: AppModel, kind: String, id: Int, position: Double, duration: Double, speed: Double? = nil) async -> Data? {
        attach(model)
        let started = Date()
        let sc = scope
        var body: [String: Any] = ["position": position]
        if kind == ProgressQueue.item { body["duration"] = duration }
        if let s = speed { body["speed"] = s }
        do {
            let data = try await model.post(ProgressQueue.path(kind: kind, id: id), body)
            flush()
            return data
        } catch {
            let status = (error as? APIError)?.status ?? 0 // 0 = inget svar
            if !ProgressQueue.finished(status), let sc {
                save(sc, ProgressQueue.record(load(sc), id: id, position: position, duration: duration, kind: kind,
                                              speed: kind == ProgressQueue.book ? speed : nil, now: started))
            }
            return nil
        }
    }

    /// Skickar kön i bakgrunden (om något väntar)
    func flush() {
        guard !sending, let sc = scope, !load(sc).isEmpty else { return }
        Task { await flushNow() }
    }

    /// Skickar kön nu, i ordning; stannar vid första anropet utan svar (ordningen står kvar till nästa gång)
    func flushNow() async {
        guard !sending, let m = model, let sc = scope else { return }
        sending = true
        defer { sending = false }
        for p in load(sc) {
            guard scope == sc else { return } // profilen eller servern byttes under tiden
            let status: Int
            do { _ = try await m.post(ProgressQueue.path(kind: p.kind, id: p.id), ProgressQueue.body(p)); status = 200 }
            catch { status = (error as? APIError)?.status ?? 0 }
            save(sc, ProgressQueue.ack(load(sc), sent: p, status: status))
            if !ProgressQueue.keepGoing(status) { return }
        }
    }
}

// MARK: - Nedladdningar

/// Nedladdningarna gäller en server och profil (Downloads/<server>-<profil>/), som i Android- och Expo-appen: en
/// barnprofil ser inte vad en vuxen laddat ner, och efter utloggning eller profilbyte visas bara den nya profilens.
/// Reglerna (vem som ser vad, flytten från före profilerna) står i OfflineCore.swift.
@MainActor
final class Downloads: ObservableObject {
    static let shared = Downloads()
    /// Det som profilen som är inloggad nu har laddat ner
    @Published private(set) var records: [DownloadRecord] = [] {
        didSet { downloadedIds = Set(records.map { $0.id }) }
    }
    /// Cache så att vyer inte behöver kolla disken vid varje omritning
    @Published private(set) var downloadedIds: Set<Int> = []
    /// Profilens pågående nedladdningar (itemId → 0…1)
    @Published private(set) var active: [Int: Double] = [:]
    /// Profilens avbrutna nedladdningar som kan återupptas (itemId → titel)
    @Published private(set) var resumable: [Int: String] = [:]
    @Published var lastError: String?

    private let dir = downloadsDirectory
    private var pendingURL: URL { dir.appendingPathComponent("pending.json") }
    private func indexURL(_ sc: String) -> URL { downloadFolder(sc).appendingPathComponent("index.json") }
    /// Profilen vars nedladdningar visas (nil = utloggad, eller profilen är inte känd än)
    private(set) var scope: String?
    /// De gamla nedladdningarna visas (samma inloggning som vid uppdateringen, profilen inte känd än)
    private var showLegacy = false
    private var legacyIds: Set<Int> = []
    /// Senaste inloggningen som open() fick (för att läsa in igen efter en ändring)
    private var lastServer = ""
    private var lastToken: String?
    /// Alla profilers pågående nedladdningar, per märkning (DownloadTag) – bara den inloggade profilens visas
    private var pending: [String: PendingDownload] = [:]
    private var progressByTag: [String: Double] = [:]
    private var resumeData: [String: Data] = [:]
    private var syncing = false
    /// Senaste kontrollen mot servern per profil (online)
    private var checked: [String: Date] = [:]
    private var checking = false

    /// Bakgrundssession: nedladdningen fortsätter även när appen ligger i bakgrunden
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.background(withIdentifier: "net.braxhn.tv.downloads")
        c.isDiscretionary = false
        #if os(iOS)
        c.sessionSendsLaunchEvents = true
        #endif
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        return URLSession(configuration: c, delegate: DownloadDelegate(), delegateQueue: q)
    }()

    private init() {
        _ = pathMonitor.currentPath
        migrateFromDocuments()
        if let d = try? Data(contentsOf: pendingURL), let p = try? JSONDecoder().decode([PendingDownload].self, from: d) {
            pending = Dictionary(p.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        }
        // Från före profilerna: en gemensam lista (Downloads/index.json). Den hör till inloggningen som gäller nu.
        if legacy() == nil {
            if !loadList("").isEmpty || pending.values.contains(where: { $0.owner.isEmpty }) {
                saveLegacy(LegacyDownloads(server: UserDefaults.standard.string(forKey: "server") ?? "",
                                           fp: Keychain.read("token").map(LoginPrint.of) ?? ""))
            } else {
                try? FileManager.default.removeItem(at: indexURL(""))
                UserDefaults.standard.removeObject(forKey: autoKey(""))
            }
        }
        // Återanslut till bakgrundssessionen och visa nedladdningar som fortfarande pågår
        session.getAllTasks { [weak self] tasks in
            let tags = tasks.filter { $0.state == .running || $0.state == .suspended }.compactMap { $0.taskDescription }
            Task { @MainActor [weak self] in
                guard let self else { return }
                for t in tags where DownloadTag.parse(t) != nil && self.progressByTag[t] == nil { self.progressByTag[t] = 0.5 }
                self.publish()
            }
        }
    }

    /// Äldre versioner sparade i Dokument/Downloads – flytta dit filerna hör hemma nu
    private func migrateFromDocuments() {
        let fm = FileManager.default
        let old = fm.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Downloads", isDirectory: true)
        guard let files = try? fm.contentsOfDirectory(at: old, includingPropertiesForKeys: nil) else { return }
        for f in files {
            let dest = dir.appendingPathComponent(f.lastPathComponent)
            if fm.fileExists(atPath: dest.path) { try? fm.removeItem(at: f) } else { try? fm.moveItem(at: f, to: dest) }
        }
        if (try? fm.contentsOfDirectory(atPath: old.path))?.isEmpty ?? false { try? fm.removeItem(at: old) }
    }

    // MARK: Lagring per profil

    private func loadList(_ sc: String) -> [DownloadRecord] {
        guard let d = try? Data(contentsOf: indexURL(sc)), let r = try? JSONDecoder().decode([DownloadRecord].self, from: d) else { return [] }
        let folder = downloadFolder(sc)
        return r.filter { FileManager.default.fileExists(atPath: folder.appendingPathComponent($0.file).path) }
    }
    private func saveList(_ sc: String, _ list: [DownloadRecord]) {
        if list.isEmpty { try? FileManager.default.removeItem(at: indexURL(sc)); return }
        _ = downloadFolder(sc, create: true)
        if let d = try? JSONEncoder().encode(list) { try? d.write(to: indexURL(sc), options: .atomic) }
    }
    private func savePending() { if let d = try? JSONEncoder().encode(Array(pending.values)) { try? d.write(to: pendingURL, options: .atomic) } }
    private func legacy() -> LegacyDownloads? {
        UserDefaults.standard.data(forKey: "dl.legacy").flatMap { try? JSONDecoder().decode(LegacyDownloads.self, from: $0) }
    }
    private func saveLegacy(_ l: LegacyDownloads?) {
        if let l, let d = try? JSONEncoder().encode(l) { UserDefaults.standard.set(d, forKey: "dl.legacy") }
        else { UserDefaults.standard.removeObject(forKey: "dl.legacy") }
    }
    private func ownerKey(_ server: String) -> String { "dl.owner." + DownloadScope.clean(server) }
    private func ownerOf(_ server: String) -> Int? { UserDefaults.standard.object(forKey: ownerKey(server)) as? Int }
    /// Avsnitt som den automatiska synken själv laddat ner – bara de tas bort automatiskt (per profil)
    private func autoKey(_ sc: String) -> String { sc.isEmpty ? "autoSyncIds" : "autoSyncIds." + sc }
    private func autoIds(_ sc: String) -> Set<Int> { Set((UserDefaults.standard.array(forKey: autoKey(sc)) as? [Int]) ?? []) }
    private func saveAutoIds(_ sc: String, _ ids: Set<Int>) {
        if ids.isEmpty { UserDefaults.standard.removeObject(forKey: autoKey(sc)) }
        else { UserDefaults.standard.set(Array(ids), forKey: autoKey(sc)) }
    }
    private func moveFile(_ from: URL, _ to: URL) -> Bool {
        let fm = FileManager.default
        if !fm.fileExists(atPath: from.path) { return fm.fileExists(atPath: to.path) }
        try? fm.removeItem(at: to)
        return (try? fm.moveItem(at: from, to: to)) != nil
    }

    // MARK: Vilken profil som visas

    func open(model: AppModel) { open(server: model.server, token: model.token) }

    /// Läser in nedladdningarna för profilen som är inloggad nu: när appen startar, när inloggningen eller profilen
    /// byts och när servern har sagt vilken profil inloggningen hör till. Flyttar då också de gamla nedladdningarna.
    func open(server: String, token: String?) {
        lastServer = server
        lastToken = token
        showLegacy = false
        if let l = legacy() {
            let (nl, fate) = DownloadMigration.fate(l, server: server, fp: token.map(LoginPrint.of),
                                                    uidOf: { LoginPrint.uid(for: $0) }, ownerUid: ownerOf(l.server))
            if nl != l { saveLegacy(nl) }
            switch fate {
            case .assign(let uid): migrate(to: DownloadScope.of(server: l.server, uid: uid))
            case .showHere: showLegacy = true
            case .hidden: break
            }
        }
        let sc = LoginPrint.scope(server: server, token: token)
        if sc != scope { lastError = nil }
        scope = sc
        let own = sc.map { loadList($0) } ?? []
        let old = showLegacy ? loadList("").filter { l in !own.contains { $0.id == l.id } } : []
        legacyIds = Set(old.map { $0.id })
        records = own + old
        publish()
    }

    private func reload() { open(server: lastServer, token: lastToken) }

    /// De gamla nedladdningarna flyttas till profilens mapp och lista (filer som inte gick att flytta väntar till nästa gång)
    private func migrate(to target: String) {
        let old = loadList("")
        let (merged, move) = DownloadMigration.merge(own: loadList(target), legacy: old)
        let folder = downloadFolder(target, create: true)
        let failed = move.filter { !moveFile(dir.appendingPathComponent($0.file), folder.appendingPathComponent($0.file)) }
        saveList(target, merged.filter { !failed.contains($0) })
        // Samma titel fanns redan i profilens mapp: den gamla filen behövs inte
        for o in old where !move.contains(where: { $0.id == o.id }) { try? FileManager.default.removeItem(at: dir.appendingPathComponent(o.file)) }
        saveAutoIds(target, autoIds("").union(autoIds(target)))
        // Nedladdningar som pågick före uppdateringen blir klara i profilens lista
        for (k, var p) in pending where p.owner.isEmpty { p.scope = target; pending[k] = p }
        savePending()
        if failed.isEmpty {
            saveList("", [])
            saveAutoIds("", [])
            saveLegacy(nil)
        } else {
            saveList("", failed)
        }
    }

    /// Huvudkontot behövs för de gamla nedladdningarna (det gick inte att veta vem som laddade ner dem)
    func needsOwner(server: String) -> Bool {
        guard let l = legacy() else { return false }
        return l.ownerOnly && DownloadScope.sameServer(l.server, server)
    }

    /// Huvudkontot på servern (owner i /api/profiles) – de gamla nedladdningarna flyttas dit
    func learnOwner(_ uid: Int, model: AppModel) {
        UserDefaults.standard.set(uid, forKey: ownerKey(model.server))
        open(model: model)
    }

    /// Visas märkningen för profilen som är inloggad nu?
    private func visible(_ tag: String) -> Bool {
        let owner = pending[tag]?.owner ?? DownloadTag.parse(tag)?.scope ?? ""
        if let sc = scope, owner == sc { return true }
        return owner.isEmpty && showLegacy
    }

    private func visibleTag(_ id: Int, in tags: Dictionary<String, Data>.Keys) -> String? {
        tags.first { DownloadTag.parse($0)?.id == id && visible($0) }
    }

    /// Pågående och avbrutna nedladdningar för profilen som är inloggad nu
    private func publish() {
        var a: [Int: Double] = [:]
        for (t, v) in progressByTag where visible(t) { if let id = DownloadTag.parse(t)?.id { a[id] = v } }
        if a != active { active = a }
        var r: [Int: String] = [:]
        for t in resumeData.keys where visible(t) {
            if let id = DownloadTag.parse(t)?.id { r[id] = pending[t]?.title ?? "Nedladdning \(id)" }
        }
        if r != resumable { resumable = r }
    }

    private func setProgress(_ tag: String, _ v: Double?) {
        progressByTag[tag] = v
        if visible(tag), let id = DownloadTag.parse(tag)?.id { active[id] = v }
    }

    // MARK: Uppspelning och nedladdning

    func localURL(for id: Int) -> URL? {
        guard downloadedIds.contains(id), let r = records.first(where: { $0.id == id }) else { return nil }
        let folder: URL
        if legacyIds.contains(id) { folder = dir } else if let sc = scope { folder = downloadFolder(sc) } else { return nil }
        let u = folder.appendingPathComponent(r.file)
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }
    func isDownloaded(_ id: Int) -> Bool { downloadedIds.contains(id) }

    func download(_ item: MediaItem, quality: String, model: AppModel) {
        guard let sc = scope else { lastError = L("Nedladdning går när servern har svarat en gång efter inloggningen. Försök igen om en stund."); return }
        let tag = DownloadTag.make(id: item.id, scope: sc)
        guard progressByTag[tag] == nil, !isDownloaded(item.id) else { return }
        setProgress(tag, 0)
        lastError = nil
        resumeData[tag] = nil
        resumable[item.id] = nil
        pending[tag] = PendingDownload(id: item.id, title: item.isEpisode ? "\(item.showTitle ?? "") – \(item.title)" : item.title,
                                       subtitle: item.isEpisode ? item.sxe : (item.year.map(String.init) ?? ""),
                                       duration: item.duration, scope: sc, tag: tag)
        savePending()
        Task {
            do {
                // 1. Be servern förbereda filen
                _ = try await model.post("/api/items/\(item.id)/offline", ["q": quality])
                var st: OfflineStatus
                repeat {
                    try await Task.sleep(nanoseconds: 3_000_000_000)
                    st = try await model.get("/api/items/\(item.id)/offline", [URLQueryItem(name: "q", value: quality)])
                    if st.status == "error" { throw APIError(message: st.error ?? L("Servern kunde inte skapa filen")) }
                    setProgress(tag, Double(st.progress ?? 0) / 200) // förberedelse = första halvan
                } while st.status != "ready"
                // Den sparade adressen: nedladdningen fortsätter i bakgrunden, kanske på ett annat nät (Hemma.swift)
                guard let rel = st.url, let url = model.savedAbsolute(rel) else { throw APIError(message: L("Ingen nedladdningslänk")) }
                // 2. Ladda ner i bakgrundssessionen (resultatet kommer via DownloadDelegate, med profilen i märkningen)
                let task = session.downloadTask(with: url)
                task.taskDescription = tag
                task.resume()
            } catch {
                if visible(tag) { lastError = error.localizedDescription }
                setProgress(tag, nil)
                pending[tag] = nil
                savePending()
            }
        }
    }

    /// Återupptar en avbruten nedladdning där den slutade
    func retry(_ id: Int) {
        guard let tag = visibleTag(id, in: resumeData.keys), let d = resumeData[tag] else { return }
        resumeData[tag] = nil
        resumable[id] = nil
        lastError = nil
        setProgress(tag, 0.5)
        let task = session.downloadTask(withResumeData: d)
        task.taskDescription = tag
        task.resume()
    }

    func discardResumable(_ id: Int) {
        guard let tag = visibleTag(id, in: resumeData.keys) else { return }
        resumeData[tag] = nil
        resumable[id] = nil
        pending[tag] = nil
        savePending()
    }

    // MARK: Anrop från DownloadDelegate

    fileprivate func progress(_ tag: String, _ p: Double) {
        let v = 0.5 + min(1, max(0, p)) / 2
        // Publicera bara i steg om 1 % – annars ritas vyerna om för varje mottagen bit
        if let old = progressByTag[tag], abs(v - old) < 0.01 { return }
        setProgress(tag, v)
    }

    /// Filen är klar och ligger i mappen för profilen i märkningen. Har de gamla nedladdningarna flyttats under tiden
    /// flyttas filen till profilens mapp. Finns ingen som väntar på filen (borttagen, utloggad) tas den bort.
    fileprivate func finished(_ tag: String, size: Int64) {
        guard let t = DownloadTag.parse(tag) else { return }
        let name = "\(t.id).mp4"
        let from = downloadFolder(t.scope).appendingPathComponent(name)
        setProgress(tag, nil)
        guard let p = pending[tag], !(p.owner.isEmpty && legacy() == nil) else {
            try? FileManager.default.removeItem(at: from)
            pending[tag] = nil
            savePending()
            return
        }
        let sc = p.owner
        let dest = downloadFolder(sc, create: true).appendingPathComponent(name)
        if sc != t.scope { _ = moveFile(from, dest) }
        saveList(sc, loadList(sc).filter { $0.id != t.id } + [DownloadRecord(id: t.id, title: p.title, subtitle: p.subtitle,
                                                                             duration: p.duration, file: name, size: size)])
        pending[tag] = nil
        savePending()
        reload()
    }

    fileprivate func failed(_ tag: String, message: String?, resumeData data: Data?) {
        setProgress(tag, nil)
        if let m = message, visible(tag) { lastError = m }
        if let d = data {
            resumeData[tag] = d
        } else {
            pending[tag] = nil
            savePending()
        }
        publish()
    }

    func remove(_ id: Int) {
        guard let sc = legacyIds.contains(id) ? "" : scope else { return }
        removeFrom(sc, id)
        reload()
    }

    private func removeFrom(_ sc: String, _ id: Int) {
        let list = loadList(sc)
        for r in list where r.id == id { try? FileManager.default.removeItem(at: downloadFolder(sc).appendingPathComponent(r.file)) }
        saveList(sc, list.filter { $0.id != id })
    }

    /// Avbryter bakgrundsuppgifterna med de här märkningarna och glömmer dem
    private func cancel(_ tags: Set<String>) {
        guard !tags.isEmpty else { return }
        for t in tags { pending[t] = nil; progressByTag[t] = nil; resumeData[t] = nil }
        savePending()
        session.getAllTasks { all in
            for task in all where tags.contains(task.taskDescription ?? "") { task.cancel() }
        }
    }

    // MARK: Behörighet

    /// Servern svarar (AppModel.user satt): får kontot inte ladda ner längre tas allt som profilen laddat ner bort, och
    /// nedladdade titlar som profilen inte får se längre eller som inte finns kvar (403/404) tas bort – högst var
    /// sjätte timme. Som Android-appens Downloads.online och Expo-appens online().
    func online(model: AppModel) async {
        guard let sc = scope, let user = model.user else { return }
        if DownloadAccess.removeAll(canDownload: user.canDownload ?? true, count: records.count) {
            cancel(Set(pending.filter { $0.value.owner == sc }.map { $0.key }))
            for r in loadList(sc) { try? FileManager.default.removeItem(at: downloadFolder(sc).appendingPathComponent(r.file)) }
            saveList(sc, [])
            saveAutoIds(sc, [])
            reload()
            lastError = L("Nedladdningarna togs bort eftersom profilen inte får ladda ner längre.")
            return
        }
        let now = Date()
        guard !checking, DownloadAccess.due(last: checked[sc], now: now) else { return }
        checking = true
        defer { checking = false }
        checked[sc] = now
        var gone: [String] = []
        check: for r in loadList(sc) {
            guard scope == sc else { return } // profilen byttes under tiden
            let status: Int
            do { let _: MediaItem = try await model.get("/api/items/\(r.id)"); status = 200 }
            catch { status = (error as? APIError)?.status ?? 0 }
            switch DownloadAccess.verdict(status) {
            case .stop: checked[sc] = nil; break check // inget nät: igen nästa gång
            case .remove: if scope == sc { removeFrom(sc, r.id) }; gone.append(r.title)
            case .keep: break
            }
        }
        if !gone.isEmpty, scope == sc {
            reload()
            lastError = String(format: L("Togs bort eftersom profilen inte får se dem längre: %@"), gone.joined(separator: ", "))
        }
    }

    // MARK: Utloggning

    /// Finns något nedladdat (eller på väg) från servern på enheten, för någon av dess profiler?
    func hasServerDownloads(_ server: String) -> Bool {
        if pending.values.contains(where: { DownloadScope.ofServer($0.owner, server: server) }) { return true }
        if let l = legacy(), DownloadScope.sameServer(l.server, server), !loadList("").isEmpty { return true }
        let fm = FileManager.default
        let dirs = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        return dirs.contains { d in
            DownloadScope.ofServer(d.lastPathComponent, server: server)
                && ((try? fm.contentsOfDirectory(atPath: d.path)) ?? []).contains { $0 != "index.json" }
        }
    }

    /// Utloggning: allt som laddats ner från servern tas bort (alla dess profiler), pågående nedladdningar avbryts
    func removeServer(_ server: String) {
        let fm = FileManager.default
        let l = legacy().flatMap { DownloadScope.sameServer($0.server, server) ? $0 : nil }
        func doomed(_ tag: String) -> Bool {
            let owner = pending[tag]?.owner ?? DownloadTag.parse(tag)?.scope ?? ""
            return DownloadScope.ofServer(owner, server: server) || (l != nil && owner.isEmpty)
        }
        let tags = Set(pending.keys).union(progressByTag.keys).union(resumeData.keys).filter(doomed)
        for t in tags { pending[t] = nil; progressByTag[t] = nil; resumeData[t] = nil }
        savePending()
        // Bakgrundsuppgifterna avbryts (finished() tar bort en fil som ändå blir klar, eftersom ingen väntar på den)
        let legacyToo = l != nil
        session.getAllTasks { all in
            for task in all {
                guard let d = task.taskDescription, let t = DownloadTag.parse(d) else { continue }
                if tags.contains(d) || DownloadScope.ofServer(t.scope, server: server) || (legacyToo && t.scope.isEmpty) { task.cancel() }
            }
        }
        for d in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        where DownloadScope.ofServer(d.lastPathComponent, server: server) { try? fm.removeItem(at: d) }
        for k in UserDefaults.standard.dictionaryRepresentation().keys
        where k.hasPrefix("autoSyncIds.") && DownloadScope.ofServer(String(k.dropFirst("autoSyncIds.".count)), server: server) {
            UserDefaults.standard.removeObject(forKey: k)
        }
        UserDefaults.standard.removeObject(forKey: ownerKey(server))
        if l != nil {
            for r in loadList("") { try? fm.removeItem(at: dir.appendingPathComponent(r.file)) }
            saveList("", [])
            saveAutoIds("", [])
            saveLegacy(nil)
        }
        reload()
    }

    // MARK: Automatisk synk

    private var unmetered: Bool {
        let p = pathMonitor.currentPath
        return p.status == .satisfied && !p.isExpensive && !p.isConstrained
    }

    /// Automatisk synk: servern anger vilka avsnitt som ska finnas offline (nästa osedda i följda serier).
    /// Saknade laddas ner med den vanliga mekaniken; sedda tas bort – men bara de som synken själv laddat ner.
    func autoSync(model: AppModel) async {
        if scope == nil { open(model: model) } // kan köras före onAppear vid start
        guard !syncing, model.isLoggedIn, let sc = scope else { return }
        syncing = true
        defer { syncing = false }
        // Glöm avsnitt som inte längre finns (t.ex. borttagna för hand eller misslyckade) – de kan laddas ner igen
        var auto = autoIds(sc).filter { isDownloaded($0) || active[$0] != nil || resumable[$0] != nil }
        saveAutoIds(sc, auto)
        let have = auto.sorted().map(String.init).joined(separator: ",")
        guard let plan: SyncPlan = try? await model.get("/api/offline/sync", [URLQueryItem(name: "have", value: have)]),
              scope == sc else { return } // profilen byttes under tiden
        for id in plan.remove where auto.contains(id) && isDownloaded(id) {
            remove(id)
            auto.remove(id)
        }
        saveAutoIds(sc, auto)
        guard plan.enabled, !plan.items.isEmpty else { return }
        if plan.wifiOnly && !unmetered {
            // Nätstatus kan vara okänd precis efter start – vänta en stund och kontrollera igen
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if !unmetered || scope != sc { return }
        }
        for item in plan.items where !isDownloaded(item.id) && active[item.id] == nil && resumable[item.id] == nil {
            auto.insert(item.id)
            saveAutoIds(sc, auto)
            download(item, quality: plan.quality, model: model)
        }
    }
}

/// Tar emot händelser från bakgrundssessionen (körs på en seriell kö).
/// Systemets klarsignal för bakgrundssessionen (anropas när alla händelser har levererats)
final class BackgroundDownloadEvents {
    static let shared = BackgroundDownloadEvents()
    private let lock = NSLock()
    private var handler: (() -> Void)?
    func set(_ h: @escaping () -> Void) { lock.lock(); handler = h; lock.unlock() }
    func take() -> (() -> Void)? { lock.lock(); defer { lock.unlock() }; let h = handler; handler = nil; return h }
}

private final class DownloadDelegate: NSObject, URLSessionDownloadDelegate {
    private var lastSent: [Int: Double] = [:]

    #if os(iOS)
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        // Köas efter finished()/failed() på huvudaktören, så att filen hunnit registreras
        Task { @MainActor in BackgroundDownloadEvents.shared.take()?() }
    }
    #endif

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0, let tag = downloadTask.taskDescription, DownloadTag.parse(tag) != nil else { return }
        let p = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
        // Skicka till huvudtråden högst var 1 %
        if let old = lastSent[downloadTask.taskIdentifier], p - old < 0.01, p < 1 { return }
        lastSent[downloadTask.taskIdentifier] = p
        Task { @MainActor in Downloads.shared.progress(tag, p) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        lastSent[downloadTask.taskIdentifier] = nil
        guard let tag = downloadTask.taskDescription, let t = DownloadTag.parse(tag) else { return }
        let code = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = String(format: L("Nedladdningen misslyckades (%d)"), code)
            Task { @MainActor in Downloads.shared.failed(tag, message: msg, resumeData: nil) }
            return
        }
        // Filen måste flyttas innan metoden returnerar – annars tas den bort av systemet. Den läggs i mappen för
        // profilen som startade nedladdningen (märkningen), aldrig i en annan profils.
        let dest = downloadFolder(t.scope, create: true).appendingPathComponent("\(t.id).mp4")
        let fm = FileManager.default
        try? fm.removeItem(at: dest)
        do {
            try fm.moveItem(at: location, to: dest)
        } catch {
            let msg = error.localizedDescription
            Task { @MainActor in Downloads.shared.failed(tag, message: msg, resumeData: nil) }
            return
        }
        let size = ((try? fm.attributesOfItem(atPath: dest.path))?[.size] as? NSNumber)?.int64Value ?? 0
        Task { @MainActor in Downloads.shared.finished(tag, size: size) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lastSent[task.taskIdentifier] = nil
        guard let error, let tag = task.taskDescription, DownloadTag.parse(tag) != nil else { return }
        let ns = error as NSError
        let data = ns.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
        let msg: String? = (ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled && data == nil) ? nil : error.localizedDescription
        Task { @MainActor in Downloads.shared.failed(tag, message: msg, resumeData: data) }
    }
}

struct DownloadsView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var dl = Downloads.shared
    @State private var play: PlayRequest?
    var body: some View {
        List {
            if let e = dl.lastError {
                Section {
                    HStack {
                        Label(e, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                        Spacer()
                        Button { dl.lastError = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain)
                    }
                }
            }
            if !dl.resumable.isEmpty {
                Section("Avbrutna") {
                    ForEach(dl.resumable.keys.sorted(), id: \.self) { id in
                        HStack {
                            Text(dl.resumable[id] ?? "").lineLimit(1)
                            Spacer()
                            Button("Fortsätt") { dl.retry(id) }.buttonStyle(.bordered)
                            Button(role: .destructive) { dl.discardResumable(id) } label: { Image(systemName: "trash") }.buttonStyle(.plain)
                        }
                    }
                }
            }
            if !dl.active.isEmpty {
                Section("Pågår") {
                    ForEach(dl.active.keys.sorted(), id: \.self) { id in
                        let p = dl.active[id] ?? 0
                        HStack { Text(p < 0.5 ? "Förbereder…" : "Laddar ner…").font(.caption); ProgressView(value: p) }
                    }
                }
            }
            if dl.records.isEmpty && dl.active.isEmpty { Text("Inget nedladdat. Öppna en film eller ett avsnitt och välj Ladda ner.").foregroundStyle(.secondary) }
            ForEach(dl.records) { r in
                Button { play = PlayRequest(itemId: r.id, start: 0, audio: nil, subtitle: nil) } label: {
                    VStack(alignment: .leading) {
                        Text(r.title).font(.headline)
                        Text("\(r.subtitle) · \(ByteCountFormatter.string(fromByteCount: r.size, countStyle: .file))").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .onDelete { idx in
                // Översätt index till id:n först – listan ändras när vi tar bort
                let ids = idx.compactMap { dl.records.indices.contains($0) ? dl.records[$0].id : nil }
                for id in ids { dl.remove(id) }
            }
        }
        .navigationTitle("Nedladdat")
        .fullScreenCover(item: $play) { PlayerScreen(request: $0).environmentObject(model) }
    }
}
