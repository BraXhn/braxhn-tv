package net.braxhn.tv

import kotlin.math.ceil
import kotlin.math.max

// Skärmtiden i spelaren: "12 min kvar idag" och en varning de sista fem minuterna, som webbspelaren
// (web/js/player/screenleft.js playerLeft). Bara för profiler med skärmtid och en gräns idag (minuter per dag eller en
// sluttid). Statusen kommer med varje framstegsrapport (screenTime.left, var tionde sekund medan filmen spelar) och,
// utan nät, från appens egen räkning (ScreenGate). En paus skickar inga rapporter och räknas inte av servern, så tiden
// kvar står still medan filmen är pausad. Ren Kotlin utan Android: testas i ScreenLeftCoreTest.kt.

object ScreenLeftCore {
    /** Sekunder kvar när varningen visas (som WARN_LEFT i webbspelaren) */
    const val WARN_LEFT = 5 * 60.0

    /** Hela minuter kvar (minst 1, den sista minuten visas som 1 min) och om varningen ska synas */
    data class Left(val minutes: Int, val warn: Boolean) {
        /** "1 h 5 min" från en timme, annars "45 min" (som webbens fmt) */
        val hours: Int? get() = if (minutes >= 60) minutes / 60 else null
        val restMinutes: Int get() = if (minutes >= 60) minutes % 60 else minutes
    }

    /** Vad spelaren visar: null = ingen skärmtid, ingen gräns idag eller redan slut (då stoppas spelaren i stället) */
    fun of(limited: Boolean, allowed: Boolean, left: Double?): Left? {
        if (!limited || !allowed || left == null || !left.isFinite()) return null
        val l = max(0.0, left)
        return Left(max(1, ceil(l / 60).toInt()), l <= WARN_LEFT)
    }

    /**
     * Serverns status (framstegssvaret, GET /api/screentime). left = det som tar slut först av dagens tid och sluttiden;
     * en äldre server utan left ger bara remaining (dagens tid kvar).
     */
    fun ofServer(limited: Boolean, allowed: Boolean, left: Double?, remaining: Double?): Left? = of(limited, allowed, left ?: remaining)

    /** Appens egen räkning utan nät (ScreenClock.gate): left null = ingen gräns */
    fun ofGate(g: ScreenGate): Left? = of(g.left != null, g.allowed, g.left?.toDouble())

    /**
     * Var det syns. Telefon och Google TV: tiden kvar i spelarens överkant och en egen varningsrad de sista fem
     * minuterna, som läses upp när minuten ändras. Bilen: bara tiden kvar (i varningens färg de sista minuterna),
     * ingen extra rad och ingen uppläsning – bilen spärrar appen och pausar filmen när den rullar (se README, Körning),
     * men föraren ska inte få något nytt att läsa.
     */
    data class Show(val pill: Boolean, val low: Boolean, val banner: Boolean, val announce: Boolean)

    fun show(l: Left?, car: Boolean): Show? {
        l ?: return null
        return Show(pill = true, low = l.warn, banner = l.warn && !car, announce = l.warn && !car)
    }
}
