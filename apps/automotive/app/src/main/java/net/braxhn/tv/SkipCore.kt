package net.braxhn.tv

// Sammanfattning, intro och eftertexter i spelaren, utan Android (testas på JVM i SkipCoreTest.kt): vilken knapp som
// visas, om den trycks av sig själv efter en kort nedräkning (kontots val, autoSkip i /playback) och vad som händer när
// avsnittet är slut (autoNext). Samma regler som webbspelaren (web/js/player/autoskip.js) och Expo-appen
// (apps/expo/src/skipcore.ts); testfallen är desamma som i test/expo-skip.test.js. Kopplas i PlayerScreen.kt.

object SkipCore {
    /** Sekunder som "Hoppar över intro… Avbryt" visas innan spelaren hoppar (som webben) */
    const val SKIP_DELAY = 3

    /** Nedräkningen till nästa avsnitt när servern inte skickar autoNext (äldre server, ingen kontakt) */
    const val DEFAULT_COUNTDOWN = 8

    enum class Kind { RECAP, INTRO, CREDITS }

    /** En del av avsnittet i sekunder */
    data class Part(val start: Double, val end: Double)

    /**
     * Det spelaren vet om avsnittet ur /playback: delarna, eftertexternas start och vilka delar kontot vill hoppa över
     * av sig självt (autoSkip; tomt hos en äldre server).
     */
    data class Marks(val recap: Part? = null, val intro: Part? = null, val credits: Double? = null, val auto: Set<Kind> = emptySet())

    /** to = tiden att hoppa till, null = nästa avsnitt. auto = hoppa av sig självt efter SKIP_DELAY. */
    data class Plan(val kind: Kind, val to: Double?, val auto: Boolean)

    /**
     * Delen som spelas just nu (t sekunder in), eller null. auto = valet är på och delen har inte redan hoppats över
     * eller avbrutits (done). Sammanfattningen går före introt om de överlappar; eftertexterna bara när det finns ett
     * nästa avsnitt och bara den första minuten (sedan försvinner knappen). Eftertexter vid 0 = okänt.
     */
    fun plan(m: Marks?, t: Double, hasNext: Boolean, done: Set<Kind> = emptySet()): Plan? {
        if (m == null || t.isNaN() || t.isInfinite()) return null
        fun mk(kind: Kind, to: Double?) = Plan(kind, to, kind in m.auto && kind !in done)
        val r = m.recap; val i = m.intro; val c = m.credits
        if (r != null && t >= r.start && t < r.end - 1) return mk(Kind.RECAP, r.end)
        if (i != null && t >= i.start && t < i.end - 1) return mk(Kind.INTRO, i.end)
        if (c != null && c != 0.0 && !c.isNaN() && hasNext && t >= c && t < c + 60) return mk(Kind.CREDITS, null)
        return null
    }

    /** Eftertexterna går: nästa avsnitt förvärms (och hålls varmt) redan nu, som webben */
    fun warmsNext(p: Plan?): Boolean = p?.kind == Kind.CREDITS

    /** auto = nästa avsnitt startar av sig självt efter seconds sekunder (0 = direkt) */
    data class Next(val auto: Boolean, val seconds: Int)

    /**
     * När avsnittet är slut, som nextPlan i webben: present = svaret hade autoNext, enabled och countdown därifrån
     * (countdown som text, så att både 10 och "10" läses som webbens parseInt). Utan autoNext gäller 8 s.
     * null = inget nästa avsnitt.
     */
    /**
     * known = false: inget svar från /playback (nedladdad titel spelad utan nät) – kontots val är okänt, och då startar
     * nästa avsnitt aldrig av sig självt (kortet utan nedräkning; en barnprofil med valet av ska inte få nästa avsnitt).
     * present = false med known: en äldre server utan autoNext – 8 s som webben.
     */
    fun next(present: Boolean, enabled: Boolean?, countdown: String?, hasNext: Boolean, known: Boolean = true): Next? {
        if (!hasNext) return null
        if (!known) return Next(false, DEFAULT_COUNTDOWN)
        if (!present) return Next(true, DEFAULT_COUNTDOWN)
        val s = leadingInt(countdown)?.coerceIn(0, 60) ?: DEFAULT_COUNTDOWN
        return Next(enabled == true, s)
    }

    /** Heltalet först i texten, som JavaScripts parseInt ("12.7" → 12, "x" → null) */
    private fun leadingInt(s: String?): Int? {
        val m = Regex("^\\s*([+-]?\\d+)").find(s ?: return null) ?: return null
        return m.groupValues[1].toBigInteger().coerceIn(Int.MIN_VALUE.toBigInteger(), Int.MAX_VALUE.toBigInteger()).toInt()
    }

    enum class EndAction { CLOSE, PLAY_NEXT, CARD }
    /** auto = kortet räknar ner seconds sekunder och startar nästa avsnitt; annars står det kvar utan nedräkning */
    data class End(val action: EndAction, val seconds: Int = 0, val auto: Boolean = false)

    /**
     * Vad Android-spelaren gör när avsnittet är slut, som webben och Expo-appen. Inget nästa avsnitt: spelaren
     * stängs. Valet på: 0 s = nästa avsnitt direkt, annars kortet "Nästa avsnitt om N s" med Spela nu och Avbryt.
     * Valet av: kortet "Nästa avsnitt" utan nedräkning, med Spela nu och Stäng. I bilen visas inget kort (föraren ska
     * inte få något nytt att läsa, och bilen pausar själv när den rullar): nästa avsnitt direkt när valet är på,
     * annars stängs spelaren.
     */
    fun atEnd(n: Next?, car: Boolean): End = when {
        n == null -> End(EndAction.CLOSE)
        car -> End(if (n.auto) EndAction.PLAY_NEXT else EndAction.CLOSE)
        !n.auto -> End(EndAction.CARD, 0, auto = false)
        n.seconds == 0 -> End(EndAction.PLAY_NEXT)
        else -> End(EndAction.CARD, n.seconds, auto = true)
    }
}
