package net.braxhn.tv

// Feedback och felrapporter utan Android (testas på JVM i FeedbackCoreTest.kt): vad skärmen gäller (förval i
// "Gäller"), vad appen får visa var (bilen: bara Mina ärenden), plattformen och skärmen som text i den tekniska
// informationen och tiden för den senaste uppspelningen. Anrop och vyer: Feedback.kt. Samma regler som webben
// (web/js/views/support.js) och Expo-appen (apps/expo/src/feedback.ts). Servern rensar en gång till (server/support.js).

object FeedbackCore {
    /** Områdena i samma ordning som webben; namnen ligger i strings.xml (feedback_area_…) */
    val AREAS = listOf("film", "musik", "ljud", "livetv", "uppspelning", "appen", "annat")
    const val MAX_TEXT = 4000
    /** Ett uppspelningsfel räknas så här länge (förval: Något fungerar inte) */
    const val ERROR_FRESH_MS = 30 * 60_000L

    /**
     * Vad en skärm gäller, efter namnet på Screen-klassen i MainActivity.kt. null = skärmen räknas inte (Inställningar,
     * Profiler, Feedback och Mina ärenden), så att förvalet blir det man gjorde innan man öppnade Feedback.
     */
    fun areaOf(screen: String): String? = when (screen) {
        "Lib", "Detail", "VodDetail" -> "film"
        "Play", "Stream" -> "uppspelning"
        "Live", "Recordings", "LivePlay" -> "livetv"
        "Home", "Search" -> "appen"
        else -> null
    }

    /** Vad en vy får visa. I bilen bara Mina ärenden att läsa – inget att skriva (bilen spärrar appen under körning). */
    enum class Mode { FULL, READ_ONLY }
    fun mode(car: Boolean) = if (car) Mode.READ_ONLY else Mode.FULL

    /** Förvalet för typen: fel om spelaren visade ett fel nyligen, annars förslag */
    fun defaultKind(errorAt: Long, now: Long) = if (errorAt > 0 && now - errorAt in 0 until ERROR_FRESH_MS) "bug" else "idea"

    /** Plattformen, t.ex. "Android 14 (API 34) · TV · Chromecast HD" – högst 120 tecken (serverns gräns) */
    fun platform(release: String, sdk: Int, device: String, model: String?): String =
        listOf("Android ${release.trim()} (API $sdk)".replace("Android  ", "Android "), device, model?.trim().orEmpty())
            .filter { it.isNotBlank() }.joinToString(" · ").take(120)

    /** Enhetstypen i plattformen (samma ord oavsett språk – det är teknisk information till teamet) */
    fun deviceKind(car: Boolean, tv: Boolean) = when { car -> "car"; tv -> "TV"; else -> "phone" }

    /** Skärmen som servern tar emot den: "1920×1080" eller "1080×2400 @2.6" */
    fun screen(width: Int, height: Int, density: Float): String {
        val d = Math.round(density * 10) / 10.0
        val ds = if (d == Math.floor(d)) d.toLong().toString() else d.toString()
        return "${width}×${height}" + if (d != 1.0 && d > 0) " @$ds" else ""
    }

    /** Uppspelningstid som i webben: "12:05" (minuter och sekunder) */
    fun duration(s: Double): String {
        val t = Math.round(s).coerceAtLeast(0)
        return "${t / 60}:${(t % 60).toString().padStart(2, '0')}"
    }

    /** Datum och tid i Mina ärenden: unix-sekunder → "27 nov. 14:05" (mönstret och språket från anroparen) */
    fun date(seconds: Long, zone: java.time.ZoneId, locale: java.util.Locale): String =
        java.time.format.DateTimeFormatter.ofPattern("d MMM HH:mm", locale).format(java.time.Instant.ofEpochSecond(seconds).atZone(zone))
}
