using System.Globalization;

namespace BraXhnTV;

/// <summary>Vad en tangent, ett musklick eller en knapp gör i den inbyggda spelaren</summary>
public enum PlayerAction
{
    None, TogglePause, Back10, Forward10, VolumeUp, VolumeDown, Mute, Fullscreen, Escape, Close, Next,
    ToggleSubs, CycleAudio, Stats, Stop,
}

/// <summary>
/// Den inbyggda spelarens reglage utan Windows: tidsformat, klick på tidslinjen, tangentkartan och när raderna syns.
/// Testas i BraXhnTV.Tests (PlayerUiTest). Själva raden ritas av Spelare/ControlBar.cs.
/// </summary>
public static class PlayerUi
{
    /// <summary>"0:05", "12:34", "1:02:03" – som webbspelaren. Okänt eller negativt blir 0:00.</summary>
    public static string TimeText(double seconds)
    {
        if (double.IsNaN(seconds) || double.IsInfinity(seconds) || seconds < 0) seconds = 0;
        var s = (long)Math.Floor(seconds);
        var h = s / 3600; var m = s / 60 % 60; var sec = s % 60;
        return h > 0 ? $"{h}:{m:00}:{sec:00}" : $"{m}:{sec:00}";
    }

    /// <summary>"12:34 / 42:10" (utan längd: bara positionen)</summary>
    public static string TimePair(double pos, double duration) => duration > 0 ? $"{TimeText(Math.Min(pos, duration))} / {TimeText(duration)}" : TimeText(pos);

    /// <summary>
    /// Position (sekunder) för en punkt x på tidslinjen som börjar vid left och är width bildpunkter bred.
    /// Utanför linjen blir början eller slutet.
    /// </summary>
    public static double SeekPosition(int x, int left, int width, double duration)
    {
        if (width <= 0 || !(duration > 0)) return 0;
        var f = Math.Clamp((x - left) / (double)width, 0, 1);
        return f * duration;
    }

    /// <summary>Var på linjen (bildpunkter från left) en position ritas</summary>
    public static int PositionX(double pos, int left, int width, double duration) =>
        duration > 0 ? left + (int)Math.Round(Math.Clamp(pos / duration, 0, 1) * width) : left;

    // Windows virtuella tangentkoder (samma som System.Windows.Forms.Keys)
    public const int VkSpace = 0x20, VkLeft = 0x25, VkUp = 0x26, VkRight = 0x27, VkDown = 0x28, VkEscape = 0x1B,
        VkF11 = 0x7A, VkMediaNext = 0xB0, VkMediaStop = 0xB2, VkMediaPlayPause = 0xB3, VkVolumeMute = 0xAD;

    /// <summary>
    /// Tangentkartan: mellanslag/K paus, ←/→ och J/L 10 s, ↑/↓ volym, F/F11 helskärm, Esc ur helskärm (sedan tillbaka),
    /// Q tillbaka, M ljud av, N nästa avsnitt, S undertext av/på, A byt ljudspår, I statistik, medietangenterna.
    /// Med Ctrl eller Alt nedtryckt: ingenting (Alt+F4, Ctrl+…).
    /// </summary>
    public static PlayerAction ForKey(int vk, bool shift = false, bool ctrl = false, bool alt = false)
    {
        if (ctrl || alt) return PlayerAction.None;
        return vk switch
        {
            VkSpace or 'K' or VkMediaPlayPause => PlayerAction.TogglePause,
            VkLeft or 'J' => PlayerAction.Back10,
            VkRight or 'L' => PlayerAction.Forward10,
            VkUp => PlayerAction.VolumeUp,
            VkDown => PlayerAction.VolumeDown,
            'F' or VkF11 => PlayerAction.Fullscreen,
            VkEscape => PlayerAction.Escape,
            'Q' => PlayerAction.Close,
            'M' or VkVolumeMute => PlayerAction.Mute,
            'N' or VkMediaNext => PlayerAction.Next,
            'S' => PlayerAction.ToggleSubs,
            'A' => PlayerAction.CycleAudio,
            'I' => PlayerAction.Stats,
            VkMediaStop => PlayerAction.Stop,
            _ => PlayerAction.None,
        };
    }

    /// <summary>Raderna (överst och nederst) syns när musen nyss rörde sig, när den är över en rad, vid paus och före starten</summary>
    public static bool ShowBars(double idleSeconds, bool overBar, bool paused, bool started, bool menuOpen) =>
        overBar || menuOpen || !started || paused || idleSeconds < 3;

    /// <summary>Ny volym (0–100) efter ett steg</summary>
    public static int Volume(int current, int step) => Math.Clamp(current + step, 0, 100);

    public static readonly double[] Speeds = [0.75, 1, 1.25, 1.5, 2];
    public static readonly double[] SubScales = [0.75, 1, 1.25, 1.5, 2];
    /// <summary>Sovtimerns val i minuter (0 = av, -1 = när avsnittet/filmen är slut)</summary>
    public static readonly int[] SleepMinutes = [0, 15, 30, 45, 60, 90, -1];

    /// <summary>"1,25×" eller "1.25×" efter språket</summary>
    public static string Factor(double f, CultureInfo c) => f.ToString("0.##", c) + "×";

    /// <summary>Spårets namn i menyn: titel, språk och kodning, t.ex. "Svenska – AC3 5.1"</summary>
    public static string TrackLabel(string? title, string? lang, string? codec, int? channels, int index)
    {
        static string Cap(string x) => x.Length > 0 ? char.ToUpper(x[0], CultureInfo.CurrentCulture) + x[1..] : x;
        var name = !string.IsNullOrWhiteSpace(title) ? title!.Trim() : !string.IsNullOrWhiteSpace(lang) ? Cap(LangName(lang!)) : $"#{index}";
        if (!string.IsNullOrWhiteSpace(title) && !string.IsNullOrWhiteSpace(lang) && !title!.Contains(LangName(lang!), StringComparison.OrdinalIgnoreCase)) name += " (" + LangName(lang!) + ")";
        var tech = string.Join(" ", new[] { codec?.ToUpperInvariant(), channels is > 2 ? (channels == 6 ? "5.1" : channels == 8 ? "7.1" : channels + " kan.") : null }.Where(x => !string.IsNullOrEmpty(x)));
        return tech.Length > 0 ? $"{name} – {tech}" : name;
    }

    static readonly Dictionary<string, (string sv, string en)> Langs = new()
    {
        ["sv"] = ("svenska", "Swedish"), ["swe"] = ("svenska", "Swedish"), ["en"] = ("engelska", "English"), ["eng"] = ("engelska", "English"),
        ["no"] = ("norska", "Norwegian"), ["nb"] = ("norska", "Norwegian"), ["nor"] = ("norska", "Norwegian"), ["nob"] = ("norska", "Norwegian"),
        ["da"] = ("danska", "Danish"), ["dan"] = ("danska", "Danish"), ["fi"] = ("finska", "Finnish"), ["fin"] = ("finska", "Finnish"),
        ["de"] = ("tyska", "German"), ["ger"] = ("tyska", "German"), ["deu"] = ("tyska", "German"), ["fr"] = ("franska", "French"),
        ["fre"] = ("franska", "French"), ["fra"] = ("franska", "French"), ["es"] = ("spanska", "Spanish"), ["spa"] = ("spanska", "Spanish"),
        ["it"] = ("italienska", "Italian"), ["ita"] = ("italienska", "Italian"), ["ja"] = ("japanska", "Japanese"), ["jpn"] = ("japanska", "Japanese"),
    };

    /// <summary>Språkkoden som namn (swe → "svenska"/"Swedish"); okänd kod som den är</summary>
    public static string LangName(string code, bool? sv = null)
    {
        var useSv = sv ?? CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "sv";
        return Langs.TryGetValue(code.Trim().ToLowerInvariant(), out var n) ? (useSv ? n.sv : n.en) : code;
    }
}
