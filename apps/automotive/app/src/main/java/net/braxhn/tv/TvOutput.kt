package net.braxhn.tv

import android.app.Activity
import android.content.Context
import android.hardware.display.DisplayManager
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.view.Display
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.AudioCapabilities
import kotlin.math.abs

/**
 * Bild och ljud ut från Google TV: vad TV:n (HDR) och förstärkaren/soundbaren (bitström) klarar, så att servern
 * kan skicka filen orörd, och automatisk bildfrekvensväxling (Display.Mode via preferredDisplayModeId).
 * Allt är försiktigt skrivet: ett fel i en kontroll ger bara sämre beslut (servern konverterar), aldrig en krasch.
 */
object TvOutput {
    // ---------- HDR ----------

    private fun display(ctx: Context): Display? = runCatching {
        ctx.getSystemService(DisplayManager::class.java)?.getDisplay(Display.DEFAULT_DISPLAY)
    }.getOrNull()

    /** HDR-typer som skärmen visar (på en TV-box: TV:n via HDMI), med serverns namn: hdr10, hlg, dovi, hdr10plus */
    fun hdrTypes(ctx: Context): Set<String> = runCatching {
        @Suppress("DEPRECATION")
        val types: IntArray = display(ctx)?.hdrCapabilities?.supportedHdrTypes ?: IntArray(0)
        types.mapNotNull { t ->
            when (t) {
                Display.HdrCapabilities.HDR_TYPE_HDR10 -> "hdr10"
                Display.HdrCapabilities.HDR_TYPE_HLG -> "hlg"
                Display.HdrCapabilities.HDR_TYPE_DOLBY_VISION -> "dovi"
                Display.HdrCapabilities.HDR_TYPE_HDR10_PLUS -> "hdr10plus"
                else -> null
            }
        }.toSet()
    }.getOrDefault(emptySet())

    /** Finns en avkodare för 10-bitars HEVC eller AV1 (HDR-filer)? Ändras inte under körning. */
    private val tenBit: Boolean by lazy {
        runCatching {
            MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }.any { info ->
                info.supportedTypes.any { t ->
                    val levels: Array<MediaCodecInfo.CodecProfileLevel> = runCatching { info.getCapabilitiesForType(t).profileLevels }.getOrNull() ?: emptyArray()
                    when (t.lowercase()) {
                        "video/hevc" -> levels.any { pl ->
                            pl.profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10 ||
                                pl.profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10 ||
                                pl.profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10Plus
                        }
                        "video/av01" -> levels.any { pl ->
                            pl.profile == MediaCodecInfo.CodecProfileLevel.AV1ProfileMain10 ||
                                pl.profile == MediaCodecInfo.CodecProfileLevel.AV1ProfileMain10HDR10 ||
                                pl.profile == MediaCodecInfo.CodecProfileLevel.AV1ProfileMain10HDR10Plus
                        }
                        else -> false
                    }
                }
            }
        }.getOrDefault(false)
    }

    /**
     * hdr/hdrt/dv till /playback. HDR skickas bara när både skärmen och avkodaren klarar det – annars tonmappar
     * servern. Dolby Vision kräver dessutom en Dolby Vision-avkodare (annars spelas HDR10-baslagret).
     */
    fun hdrQuery(ctx: Context, decoders: Set<String>): Map<String, String?> {
        val types = hdrTypes(ctx).filter { it != "dovi" || "video/dolby-vision" in decoders }
        if (!tenBit || types.isEmpty()) return mapOf("hdr" to "0")
        return mapOf("hdr" to "1", "hdrt" to types.joinToString(","), "dv" to (if ("dovi" in types) "1" else null))
    }

    // ---------- ljud: bitström (passthrough) ----------

    /**
     * Format som förstärkaren/soundbaren tar emot som bitström (HDMI/eARC), enligt Media3 – samma kontroll som
     * ExoPlayers ljudutgång gör när den väljer bitström. Namnen: ac3, eac3, eac3-joc (Atmos), dts, dts-hd, truehd.
     */
    @OptIn(UnstableApi::class)
    fun bitstream(ctx: Context): Set<String> = runCatching {
        @Suppress("DEPRECATION")
        val caps = AudioCapabilities.getCapabilities(ctx)
        val out = mutableSetOf<String>()
        if (caps.supportsEncoding(C.ENCODING_AC3)) out += "ac3"
        if (caps.supportsEncoding(C.ENCODING_E_AC3)) out += "eac3"
        if (caps.supportsEncoding(C.ENCODING_E_AC3_JOC)) out += "eac3-joc"
        if (caps.supportsEncoding(C.ENCODING_DTS)) out += "dts"
        if (caps.supportsEncoding(C.ENCODING_DTS_HD)) out += "dts-hd"
        if (caps.supportsEncoding(C.ENCODING_DOLBY_TRUEHD)) out += "truehd"
        out.toSet()
    }.getOrDefault(emptySet())

    /**
     * Surroundformat utöver grundlistan som enheten spelar: egen avkodare (blir PCM) eller bitström till förstärkaren.
     * Servern skickar dem då orörda (direkt), i stället för att konvertera till E-AC-3 eller AAC.
     */
    fun surroundCodecs(ctx: Context, decoders: Set<String>): List<String> {
        val bs = bitstream(ctx)
        val out = mutableListOf<String>()
        if ("audio/ac3" in decoders || "ac3" in bs) out += "ac3"
        if ("audio/eac3" in decoders || "audio/eac3-joc" in decoders || "eac3" in bs || "eac3-joc" in bs) out += "eac3"
        if ("audio/vnd.dts" in decoders || "audio/vnd.dts.hd" in decoders || "dts" in bs || "dts-hd" in bs) out += "dts"
        if ("audio/true-hd" in decoders || "truehd" in bs) out += "truehd"
        return out
    }

    /** Text för inställningarna: vad TV:n och förstärkaren klarar just nu */
    fun describe(ctx: Context): Pair<String, String> {
        val hdr = hdrTypes(ctx)
        val hdrNames = listOfNotNull(
            if ("hdr10" in hdr) "HDR10" else null, if ("hdr10plus" in hdr) "HDR10+" else null,
            if ("hlg" in hdr) "HLG" else null, if ("dovi" in hdr) "Dolby Vision" else null
        )
        val screen = when {
            hdrNames.isEmpty() -> "Skärmen: SDR (HDR-filer tonmappas av servern)"
            !tenBit -> "Skärmen: ${hdrNames.joinToString(", ")} – men enheten saknar avkodare för 10-bitars video"
            else -> "Skärmen: ${hdrNames.joinToString(", ")}"
        }
        val bs = bitstream(ctx)
        val names = listOfNotNull(
            if ("ac3" in bs) "Dolby Digital" else null, if ("eac3" in bs) "Dolby Digital Plus" else null,
            if ("eac3-joc" in bs) "Dolby Atmos (DD+)" else null, if ("truehd" in bs) "Dolby TrueHD" else null,
            if ("dts" in bs) "DTS" else null, if ("dts-hd" in bs) "DTS-HD" else null
        )
        val audio = if (names.isEmpty()) "Förstärkaren: bara PCM – ljudet avkodas i enheten eller konverteras av servern"
            else "Bitström till förstärkaren: ${names.joinToString(", ")}"
        return screen to audio
    }

    // ---------- bildfrekvensväxling ----------

    /** "off" = av, "rate" = bara bildfrekvens, "res" = bildfrekvens och upplösning. Sparas per enhet. */
    fun frameRateMode(ctx: Context): String =
        ctx.getSharedPreferences("braxhn", Context.MODE_PRIVATE).getString("frameRate", "off")?.takeIf { it in FRAME_MODES } ?: "off"
    fun setFrameRateMode(ctx: Context, v: String) {
        ctx.getSharedPreferences("braxhn", Context.MODE_PRIVATE).edit().putString("frameRate", v).apply()
    }
    private val FRAME_MODES = setOf("off", "rate", "res")

    @Suppress("DEPRECATION")
    private fun displayOf(a: Activity): Display? = runCatching { a.windowManager.defaultDisplay }.getOrNull()

    /**
     * Hur väl en uppdateringsfrekvens passar videon: 1, 2 … = exakt 1×, 2× … bildfrekvensen (bäst lägst),
     * 11, 12 … = nästan (t.ex. 24 Hz för 23,976 bilder/s), null = passar inte.
     */
    fun rateScore(refresh: Float, fps: Float): Int? {
        if (fps < 10f || refresh <= 0f) return null
        for (n in 1..6) if (abs(refresh - n * fps) / (n * fps) < 0.0003f) return n
        for (n in 1..6) if (abs(refresh - n * fps) / (n * fps) < 0.0015f) return 10 + n
        return null
    }

    /**
     * Skärmläget som passar videon bäst, eller null om det nuvarande redan passar (eller inget gör det).
     * withRes: välj också det minsta läget som rymmer videon (TV:n skalar då upp i stället för boxen).
     */
    fun pickMode(a: Activity, fps: Float, width: Int, height: Int, withRes: Boolean): Int? = runCatching {
        val d = displayOf(a) ?: return@runCatching null
        val cur = d.mode
        val modes = d.supportedModes?.toList() ?: emptyList()
        if (fps <= 0f || modes.isEmpty()) return@runCatching null
        val curSize = cur.physicalWidth to cur.physicalHeight
        val size: Pair<Int, Int> = if (withRes && width > 0 && height > 0) {
            modes.filter { m -> m.physicalWidth >= width && m.physicalHeight >= height && rateScore(m.refreshRate, fps) != null }
                .map { m -> m.physicalWidth to m.physicalHeight }.distinct()
                .minByOrNull { (w, h) -> w.toLong() * h } ?: curSize
        } else curSize
        val best = modes.filter { m -> m.physicalWidth == size.first && m.physicalHeight == size.second }
            .mapNotNull { m -> rateScore(m.refreshRate, fps)?.let { s -> m to s } }
            .minByOrNull { it.second } ?: return@runCatching null
        if (best.first.modeId == cur.modeId) return@runCatching null
        // Nuvarande läge är redan en exakt multipel i rätt upplösning: byt inte (varje byte ger några svarta sekunder)
        val curScore = rateScore(cur.refreshRate, fps)
        if (curScore != null && curScore < 10 && size == curSize) return@runCatching null
        best.first.modeId
    }.getOrNull()

    fun currentModeId(a: Activity): Int? = runCatching { displayOf(a)?.mode?.modeId }.getOrNull()

    /** Ber systemet om skärmläget (0 = systemets eget val, dvs. tillbaka till det vanliga) */
    fun setMode(a: Activity, id: Int) {
        runCatching {
            val w = a.window ?: return
            val lp = w.attributes
            if (lp.preferredDisplayModeId == id) return
            lp.preferredDisplayModeId = id
            w.attributes = lp
        }
    }

    fun restore(a: Activity?) { if (a != null) setMode(a, 0) }
}
