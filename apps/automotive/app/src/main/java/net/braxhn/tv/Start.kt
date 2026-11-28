package net.braxhn.tv

import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.focus.onFocusChanged
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// Snabbare start: frågan till /playback, förvärmningen och stopp av en ström som aldrig användes. Reglerna står i
// StartCore.kt (testas på JVM); här är anropen.

object Start {
    private val log = StartCore.WarmLog()

    /**
     * Hela frågan till /playback för en uppspelning från början eller en position. Samma för förvärmningen och
     * uppspelningen (PlayerScreen.kt), så att servern kan ta över den förvärmda strömmen. sub: bara en bildundertext
     * skickas (Api.capabilities), textundertexter väljer spelaren själv.
     */
    suspend fun query(audio: Int?, sub: SubtitleTrack?, start: Double, skipPreroll: Boolean): Map<String, String?> {
        // Avkodarlistan (MediaCodecList) är långsam första gången – inte på huvudtråden
        val caps: Map<String, String?> = withContext(Dispatchers.IO) { Api.capabilities(audio, sub) }
        return caps + Api.comfortQuery() + StartCore.playExtras(start, skipPreroll)
    }

    /** /playback?warm=1 – tyst; servern svarar { warm, mode } och räknar inget som uppspelning */
    fun warm(id: Int, start: Double, audio: Int?, sub: SubtitleTrack?) {
        if (id <= 0) return
        Api.appScope.launch {
            runCatching {
                if (Downloads.localFile(id) != null) return@launch // en nedladdad titel spelas från enheten
                val q = StartCore.warmQuery(query(audio, sub, start, false))
                if (!log.take(StartCore.key(id, q), System.currentTimeMillis())) return@launch
                Api.requestPublic("/api/items/$id/playback", "GET", q, null)
            }
        }
    }

    /** Strömmen som servern startade för p behövs inte (spelaren stängdes eller titeln gick inte att hämta) */
    suspend fun drop(id: Int, p: Playback) {
        val pid = SeekCore.pidOf(p.url) ?: return
        Api.post("/api/stream/$id/stop?pid=$pid")
    }
}

/**
 * Förvärmning när fokus står kvar på knappen (Google TV, tangentbord) i StartCore.DWELL_MS – inte för varje knapp eller
 * avsnitt man rör sig förbi. Samma titel, position, ljudspår och undertext som knappen sedan spelar.
 */
fun Modifier.warmOnFocus(id: Int, start: Double, audio: Int? = null, sub: SubtitleTrack? = null): Modifier = composed {
    var focused by remember { mutableStateOf(false) }
    LaunchedEffect(focused, id, start, audio, sub?.id) {
        if (!focused) return@LaunchedEffect
        delay(StartCore.DWELL_MS)
        Start.warm(id, start, audio, sub)
    }
    this.onFocusChanged { focused = it.isFocused }
}
