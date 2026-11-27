import SwiftUI

// Vyerna för feedback och felrapporter (modeller, regler och anrop: Feedback.swift). Under Inställningar: Skicka
// feedback och Mina ärenden. I spelaren när uppspelningen inte gick: Rapportera felet. På Apple TV skrivs meddelandet
// med tvOS tangentbord (eller iPhone, Siri-diktering) – samma formulär som på iPhone och iPad. All text visas som vanlig
// text (Text med String, aldrig Markdown).

extension View {
    /// Sidan som Feedback förvalt gäller (FeedbackCore.pageAreas). Sätts varje gång vyn visas, även tillbaka från en undervy.
    @MainActor func feedbackPage(_ page: String) -> some View {
        onAppear { FeedbackTracker.shared.notePage(page) }
    }

    /// På Apple TV kan fjärrkontrollen bara flytta till något som tar fokus: rader med lång text blir fokuserbara
    /// så att de går att bläddra fram till. Ingen skillnad på iPhone och iPad.
    @ViewBuilder func tvFocusable() -> some View {
        #if os(tvOS)
        focusable()
        #else
        self
        #endif
    }
}

private func toneColor(_ t: FeedbackCore.Tone) -> Color {
    switch t {
    case .warn: return Color(red: 1.0, green: 0.78, blue: 0.34)
    case .info: return Color(red: 0.56, green: 0.72, blue: 1.0)
    case .ok: return Color(red: 0.30, green: 0.76, blue: 0.54)
    case .err: return Color(red: 1.0, green: 0.36, blue: 0.42)
    }
}

/// Den tekniska informationen som rader (samma ordning som webben)
struct FeedbackContextRows: View {
    let context: TechContext?
    var body: some View {
        let rows = FeedbackCore.contextRows(context)
        if rows.isEmpty {
            Text("Ingen teknisk information bifogas.").foregroundStyle(.secondary).tvFocusable()
        } else {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                VStack(alignment: .leading, spacing: 2) {
                    Text(r.label).font(.caption).foregroundStyle(.secondary)
                    Text(r.value).font(.subheadline)
                }
                .tvFocusable()
            }
        }
    }
}

// MARK: - Inställningar

/// Avsnittet under Inställningar: Skicka feedback och Mina ärenden, och hur många ärenden teamet väntar på svar i
struct FeedbackSection: View {
    @EnvironmentObject var model: AppModel
    @State private var waiting = 0
    var body: some View {
        Section {
            NavigationLink(destination: FeedbackFormView()) { Text("Skicka feedback") }
            NavigationLink(destination: TicketsView()) {
                Text(waiting > 0 ? String(format: L("Mina ärenden (%d)"), waiting) : L("Mina ärenden"))
            }
            if waiting > 0 { Text(FeedbackCore.waitingText(waiting)).foregroundStyle(toneColor(.warn)) }
        } header: {
            Text("Feedback")
        } footer: {
            Text(model.isAdmin
                 ? L("Har du en idé eller är det något som inte fungerar? Skicka feedback eller en felrapport. Du är administratör: den skickas direkt till utvecklarna.")
                 : L("Har du en idé eller är det något som inte fungerar? Skicka feedback eller en felrapport. En administratör läser den först."))
        }
        .task { waiting = await model.supportNeedInfo() }
    }
}

// MARK: - Formuläret

struct FeedbackFormView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    /// Förval (t.ex. från spelaren: Något fungerar inte, Uppspelning). nil = efter senaste sidan och uppspelningsfelet.
    var initialKind: String? = nil
    var initialArea: String? = nil
    @State private var started = false
    @State private var kind = "idea"
    @State private var area = "appen"
    @State private var text = ""
    @State private var tech = true
    @State private var showContext = false
    @State private var preview: TechContext?
    @State private var previewFailure: String?
    @State private var busy = false
    @State private var failure: String?
    @State private var sent: SupportSent?

    var body: some View {
        Group {
            if let s = sent { thanks(s) } else { form }
        }
        .navigationTitle("Feedback")
        .onAppear {
            guard !started else { return }
            started = true
            kind = initialKind ?? FeedbackTracker.shared.defaultKind()
            area = initialArea ?? FeedbackTracker.shared.area
        }
        // "Visa vad som skickas med": hämtas igen när typen ändras (felrapporter får senaste uppspelningen och felet)
        .task(id: "\(tech) \(showContext) \(kind)") { await loadPreview() }
    }

    private var form: some View {
        List {
            Section {
                ForEach(FeedbackCore.kinds, id: \.self) { k in
                    Button { kind = k } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(FeedbackCore.kindName(k))
                                Text(FeedbackCore.kindHint(k)).font(.footnote).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if kind == k { Image(systemName: "checkmark") }
                        }
                    }
                }
            } header: {
                Text("Typ")
            }
            Section("Gäller") {
                ForEach(FeedbackCore.areas, id: \.self) { a in
                    Button { area = a } label: {
                        HStack { Text(FeedbackCore.areaName(a)); Spacer(); if area == a { Image(systemName: "checkmark") } }
                    }
                }
            }
            Section {
                TextField("T.ex. Tryckte på Spela på en film. Bilden frös efter en minut.", text: $text, axis: .vertical)
                    .lineLimit(4...12)
                    .onChange(of: text) { t in
                        if t.count > FeedbackCore.maxText { text = String(t.prefix(FeedbackCore.maxText)) }
                        failure = nil
                    }
            } header: {
                Text("Meddelande")
            } footer: {
                Text("Vad gjorde du, vad hände och vad hade du väntat dig?")
            }
            Section {
                Button { tech.toggle() } label: {
                    HStack { Text("Skicka med teknisk information"); Spacer(); Text(tech ? L("På") : L("Av")).foregroundStyle(.secondary) }
                }
                if tech {
                    Button { showContext.toggle() } label: { Text((showContext ? "▾ " : "▸ ") + L("Visa vad som skickas med")) }
                    if showContext {
                        if let p = preview { FeedbackContextRows(context: p) }
                        else if let f = previewFailure { Text(f).foregroundStyle(.secondary) }
                        else { ProgressView() }
                    }
                }
            } footer: {
                Text("Appens version, enhet, skärmstorlek och senaste uppspelningen. Aldrig lösenord eller adresser.")
            }
            Section {
                if let f = failure { Text(f).foregroundStyle(toneColor(.err)) }
                Button(busy ? L("Skickar…") : L("Skicka")) { Task { await send() } }
                    .disabled(busy)
                NavigationLink(destination: TicketsView()) { Text("Mina ärenden") }
            } footer: {
                Text((model.isAdmin ? L("Du är administratör: ärendet skickas direkt till utvecklarna.")
                      : L("En administratör läser ärendet först. Det skickas till utvecklarna bara om administratören godkänner det."))
                     + " " + L("Svaret syns under Mina ärenden."))
            }
        }
    }

    private func thanks(_ s: SupportSent) -> some View {
        let approved = s.status == "approved"
        return List {
            Section {
                Text(approved ? L("Tack – ärendet är skickat") : L("Tack – ärendet är mottaget")).font(.title2.bold())
                // Appens egen text (servern svarar på svenska): vanliga användares ärenden granskas först
                Text(approved ? L("Ärendet är skickat till teamet.") : L("Ärendet är mottaget och väntar på granskning."))
                Text("Svaret syns under Mina ärenden.").foregroundStyle(.secondary)
            }
            Section {
                NavigationLink(destination: TicketsView()) { Text("Mina ärenden") }
                Button("Klar") { dismiss() }
            }
        }
    }

    private func loadPreview() async {
        guard tech, showContext else { return }
        preview = nil
        previewFailure = nil
        do { preview = try await model.supportPreview(kind: kind) }
        catch { if !isCancellation(error) { previewFailure = FeedbackCore.errorText(error) } }
    }

    private func send() async {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { failure = L("Skriv ett meddelande."); return }
        busy = true
        failure = nil
        do { sent = try await model.sendSupport(kind: kind, area: area, text: t, tech: tech) }
        catch { if !isCancellation(error) { failure = FeedbackCore.errorText(error) } }
        busy = false
    }
}

/// Formuläret som ett eget fönster (från spelaren): egen navigering så att Mina ärenden går att öppna, Stäng uppe till vänster
struct FeedbackSheet: View {
    @Environment(\.dismiss) private var dismiss
    var kind: String? = nil
    var area: String? = nil
    var body: some View {
        NavigationStack {
            FeedbackFormView(initialKind: kind, initialArea: area)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Stäng") { dismiss() } } }
        }
    }
}

// MARK: - Mina ärenden

struct TicketsView: View {
    @EnvironmentObject var model: AppModel
    @State private var tickets: [Ticket]?
    @State private var failure: String?
    @State private var note: String?
    @State private var reload = 0

    var body: some View {
        List {
            Section {
                Text("Här ser du det du har skickat in, vad som händer med det och teamets svar. Bara du ser dina ärenden.")
                    .foregroundStyle(.secondary)
                if let n = note { Text(n).foregroundStyle(toneColor(.ok)) }
                NavigationLink(destination: FeedbackFormView()) { Text("Nytt ärende") }
            }
            if let list = tickets {
                if list.isEmpty {
                    Section {
                        Text("Inga ärenden än").font(.headline)
                        Text("Har du en idé eller är det något som inte fungerar? Tryck på Nytt ärende.").foregroundStyle(.secondary)
                    }
                }
                ForEach(list, id: \.rowKey) { k in
                    TicketSection(ticket: k) { msg in note = msg; reload += 1 }
                }
            } else if let f = failure {
                Section {
                    Text(f).foregroundStyle(.secondary)
                    Button("Försök igen") { failure = nil; reload += 1 }
                }
            } else {
                Section { ProgressView() }
            }
        }
        .navigationTitle("Mina ärenden")
        .task(id: reload) { await load() }
    }

    private func load() async {
        do { tickets = try await model.myTickets(); failure = nil }
        catch { if !isCancellation(error) { failure = FeedbackCore.errorText(error) } }
    }
}

/// Ett ärende: status, det man skrev, ändringar före godkännandet, svaren och svarsrutan när teamet bett om mer information
struct TicketSection: View {
    @EnvironmentObject var model: AppModel
    let ticket: Ticket
    let onReplied: (String) -> Void
    @State private var reply = ""
    @State private var busy = false
    @State private var failure: String?
    @State private var showContext = false

    private func date(_ s: Int) -> String { FeedbackCore.date(s, locale: appLocale, timeZone: .current) }

    var body: some View {
        let k = ticket
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text([FeedbackCore.kindName(k.kind), FeedbackCore.areaName(k.area), date(k.created)].joined(separator: " · "))
                    .font(.footnote).foregroundStyle(.secondary)
                if let t = k.title, !t.isEmpty { Text(t).font(.headline) }
                Text(k.text)
            }
            .tvFocusable()
            if k.sentText != nil || k.sentTitle != nil {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Administratören ändrade texten innan den skickades:").font(.footnote).foregroundStyle(.secondary)
                    Text([k.sentTitle, k.sentText ?? k.text].compactMap { $0 }.joined(separator: "\n")).foregroundStyle(.secondary)
                }
                .tvFocusable()
            }
            ForEach(Array(k.thread.enumerated()), id: \.offset) { _, m in message(m) }
            if k.canReply {
                TextField("Ditt svar till teamet", text: $reply, axis: .vertical)
                    .lineLimit(3...10)
                    .onChange(of: reply) { t in
                        if t.count > FeedbackCore.maxText { reply = String(t.prefix(FeedbackCore.maxText)) }
                        failure = nil
                    }
                Text(model.isAdmin ? L("Svaret skickas direkt till teamet.") : L("Svaret granskas av en administratör innan det skickas vidare."))
                    .font(.footnote).foregroundStyle(.secondary)
                if let f = failure { Text(f).foregroundStyle(toneColor(.err)) }
                Button(busy ? L("Skickar…") : L("Skicka svaret")) { Task { await send() } }
                    .disabled(busy)
            }
            Button { showContext.toggle() } label: {
                Text((showContext ? "▾ " : "▸ ") + L("Teknisk information som bifogades")).foregroundStyle(.secondary)
            }
            if showContext { FeedbackContextRows(context: k.context) }
        } header: {
            HStack(spacing: 10) {
                Text(verbatim: "#\(k.id)")
                Text(FeedbackCore.statusText(k.status, version: k.version)).foregroundStyle(toneColor(FeedbackCore.statusTone(k.status)))
            }
        }
    }

    private func message(_ m: TicketMsg) -> some View {
        let head = [FeedbackCore.from(m.from), m.created.map { date($0) }, m.pending == true ? L("Väntar på granskning") : nil]
            .compactMap { $0 }.joined(separator: " · ")
        let text = m.text ?? ""
        return VStack(alignment: .leading, spacing: 4) {
            Text(head).font(.caption).foregroundStyle(.secondary)
            if m.status == "reopened" { Text("Ärendet öppnades igen").font(.caption).foregroundStyle(.secondary) }
            if !text.isEmpty { Text(text) }
            else if let st = m.status, st != "reopened" {
                Text(FeedbackCore.statusText(st, version: m.version)).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.leading, 10)
        .overlay(alignment: .leading) {
            Rectangle().fill(m.from == "team" ? accent : Color.secondary.opacity(0.4)).frame(width: 3)
        }
        .tvFocusable()
    }

    private func send() async {
        let t = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { failure = L("Skriv ett svar."); return }
        busy = true
        failure = nil
        do {
            try await model.replyTicket(ticket.id, text: t)
            reply = ""
            onReplied(model.isAdmin ? L("Svaret är skickat till teamet.") : L("Svaret är mottaget och väntar på granskning."))
        } catch {
            if !isCancellation(error) { failure = FeedbackCore.errorText(error) }
        }
        busy = false
    }
}
