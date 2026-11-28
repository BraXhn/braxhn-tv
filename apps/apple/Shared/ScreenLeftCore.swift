import Foundation

// Skärmtiden i spelaren: "12 min kvar idag" och en varning de sista fem minuterna, utan SwiftUI och AVFoundation (bara
// Foundation – ren logik). Samma regler och ord som webbspelaren (playerLeft i web/js/player/screenleft.js),
// Android-appen (ScreenLeftCore.kt) och Expo-appen (src/screenleft.ts). Bara för profiler med skärmtid och en gräns
// idag (minuter per dag eller en sluttid). Statusen kommer med varje framstegsrapport (screenTime.left, var tionde
// sekund medan filmen spelar; en äldre server utan left ger remaining) och, utan nät, från appens egen räkning
// (ScreenClock.gate i OfflineCore.swift). En paus skickar inga rapporter och räknas inte av servern, så tiden kvar står
// still medan filmen är pausad. Anropen: Player.swift. Testas statiskt i test/apple-screenleft.test.js.

enum ScreenLeftCore {
    /// Sekunder kvar när varningen visas (som WARN_LEFT i webbspelaren)
    static let warnLeft: Double = 5 * 60

    /// Hela minuter kvar (minst 1: den sista minuten visas som 1 min) och om varningen ska synas
    struct Left: Equatable {
        let minutes: Int
        let warn: Bool
    }

    /// nil = ingen skärmtid, ingen gräns idag eller redan slut (då stoppas spelaren i stället)
    static func of(limited: Bool, allowed: Bool, left: Double?) -> Left? {
        guard limited, allowed, let left, left.isFinite else { return nil }
        let l = max(0, left)
        // Högst ett dygn räknas (ett orimligt tal ska inte ge ett fel)
        return Left(minutes: max(1, Int((min(l, 86_400) / 60).rounded(.up))), warn: l <= warnLeft)
    }

    /// Serverns status (framstegssvaret, GET /api/screentime). left = det som tar slut först av dagens tid och
    /// sluttiden; en äldre server utan left ger bara remaining (dagens tid kvar).
    static func ofServer(_ s: ScreenStatus?) -> Left? {
        guard let s else { return nil }
        return of(limited: s.limited, allowed: s.allowed == true, left: s.left ?? s.remaining)
    }

    /// Appens egen räkning utan nät (ScreenClock.gate): left nil = ingen gräns
    static func ofGate(_ g: ScreenGate) -> Left? { of(limited: g.left != nil, allowed: g.allowed, left: g.left.map(Double.init)) }

    /// Läs upp varningen (VoiceOver) när den syns första gången och varje gång minuten ändras – inte var tionde sekund
    static func announce(from old: Left?, to new: Left?) -> Bool {
        guard let n = new, n.warn else { return false }
        guard let o = old, o.warn else { return true }
        return o.minutes != n.minutes
    }

    /// "1 h 5 min" från en timme, annars "45 min" (som webbens fmt). tr = översättningen (L i appen)
    static func amount(_ minutes: Int, tr: (String) -> String = { $0 }) -> String {
        minutes >= 60 ? String(format: tr("%d h %d min"), minutes / 60, minutes % 60) : String(format: tr("%d min"), minutes)
    }

    /// Texterna i spelaren: tiden kvar (kort text på en smal skärm, som webben på telefonen) och varningen de sista
    /// fem minuterna (tom annars)
    static func texts(_ l: Left, compact: Bool, tr: (String) -> String = { $0 }) -> (pill: String, warn: String) {
        let a = amount(l.minutes, tr: tr)
        let pill = String(format: tr(compact ? "⏱ %@ kvar" : "%@ kvar idag"), a)
        let warn = l.warn ? String(format: tr("Skärmtiden tar slut om %d min"), l.minutes) : ""
        return (pill, warn)
    }
}
