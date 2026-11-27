package net.braxhn.tv

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

// Bildtoken sparad per server och profil, utan Android (testas på JVM i ImageTokenCoreTest.kt). Servern sparar högst
// 50 bildtoken per användare och tar bort de äldsta (IMG_MAX i server/auth.js), så en ny token vid varje start knuffar
// ut andra enheters och deras bilder slutar visas. Samma regler som iOS-appen (ImageTokenBook i
// apps/apple/Shared/AppModel.swift) och Expo-appen (ensureImageToken i apps/expo/src/api.ts): förnya när mindre än
// ett dygn är kvar eller när servern svarar 401 på en bild. Lagringen och anropen: Api.kt (refreshImageToken, imageFailed).

/** En sparad bildtoken och när den slutar gälla (ms sedan 1970) */
@Serializable data class SavedImageToken(val token: String, val until: Long)

/**
 * En servers sparade bildtoken per profil (användar-id som text) och profilen som använde bildtoken senast (för start
 * innan servern sagt vilken profil inloggningen hör till). Sparas som JSON i appens privata inställningar, som inloggningen.
 */
@Serializable data class ImageTokenBook(val tokens: Map<String, SavedImageToken> = emptyMap(), val last: Int? = null) {

    /** Profilens sparade token, om den gäller minst ett dygn till */
    fun usable(user: Int, nowMs: Long): SavedImageToken? =
        tokens[user.toString()]?.takeIf { it.token.isNotEmpty() && it.until - nowMs > RENEW_BEFORE_MS }

    /** Med profilens nya token (tom text tar bort den), utan utgångna token och med profilen som den senaste */
    fun storing(token: String, until: Long, user: Int, nowMs: Long): ImageTokenBook {
        val kept = tokens.filterValues { it.until > nowMs } - user.toString()
        return ImageTokenBook(if (token.isEmpty()) kept else kept + (user.toString() to SavedImageToken(token, until)), user)
    }

    fun encoded(): String = JSON.encodeToString(this)

    companion object {
        /** Förnya när mindre än så här är kvar (ett dygn) */
        const val RENEW_BEFORE_MS = 86_400_000L
        /** Servrar som inte skickar ttl ger token som gäller 7 dygn */
        const val DEFAULT_TTL_S = 7 * 86400
        private val JSON = Json { ignoreUnknownKeys = true }

        /** Nyckeln i inställningarna: en per server (den sparade adressen) */
        fun key(server: String) = "img $server"

        /** När en ny token slutar gälla: serverns ttl i sekunder (minst en minut) */
        fun until(ttlS: Int?, nowMs: Long): Long = nowMs + maxOf(60, ttlS ?: DEFAULT_TTL_S) * 1000L

        /** Läser det sparade; trasigt eller saknas = tomt */
        fun decode(s: String?): ImageTokenBook =
            if (s.isNullOrEmpty()) ImageTokenBook() else runCatching { JSON.decodeFromString<ImageTokenBook>(s) }.getOrDefault(ImageTokenBook())
    }
}

object ImageTokens {
    /** Vad refreshImageToken ska göra */
    sealed interface Pick {
        /** Token i minnet är profilens och gäller minst ett dygn till */
        data object Keep : Pick
        /** Använd den sparade (ingen förfrågan till servern) */
        data class Saved(val token: SavedImageToken) : Pick
        /** Hämta en ny från servern (POST /api/media-token) */
        data object Fetch : Pick
    }

    /**
     * owner = "server profil" för det som gäller nu, memOwner/memUntil = token i minnet (null/0 = ingen),
     * force = den som används fungerar inte längre (servern svarade 401 på en bild).
     */
    fun pick(book: ImageTokenBook, user: Int, owner: String, memOwner: String?, memUntil: Long, nowMs: Long, force: Boolean): Pick {
        if (force) return Pick.Fetch
        if (memOwner == owner && memUntil - nowMs > ImageTokenBook.RENEW_BEFORE_MS) return Pick.Keep
        return book.usable(user, nowMs)?.let { Pick.Saved(it) } ?: Pick.Fetch
    }

    /** Minsta tid mellan två kontroller av en bild som inte gick att ladda */
    const val CHECK_EVERY_MS = 60_000L

    /**
     * En bild gick inte att ladda: ska appen fråga servern om det var bildtoken (401)? Bara för en adress med token som
     * gäller nu, och högst en gång i minuten, så att en bild som saknas (404) inte ger en ström av anrop.
     */
    fun shouldCheck(url: String, token: String?, lastCheckMs: Long, nowMs: Long): Boolean =
        !token.isNullOrEmpty() && Regex("[?&]t=" + Regex.escape(token) + "(&|$)").containsMatchIn(url) && nowMs - lastCheckMs >= CHECK_EVERY_MS
}
