using System.Drawing;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace BraXhnTV;

/// <summary>
/// Spelarraden i den inbyggda spelaren, utan Windows: när musen får visa raderna, skalan, tid kvar och sluttid,
/// titeln överst, hoppa över intro/sammanfattning, kortet med nästa avsnitt, förhandsbilderna och serverns svar.
/// Testas i BraXhnTV.Tests (SpelarradTest). Raderna ritas av Spelare/Reglage.cs.
/// </summary>
public static class Spelarrad
{
    // ---------- musen ----------

    /// <summary>Så här långt (bildpunkter vid 100 %) måste musen flyttas för att räknas – små skakningar räknas inte</summary>
    public const int Jitter = 4;

    /// <summary>Skakningsgränsen i bildpunkter vid skalan scale (150 % → 6)</summary>
    public static int JitterFor(double scale) => Math.Max(Jitter, (int)Math.Round(Jitter * scale));

    /// <summary>
    /// Ska en musrörelse visa raderna? area: spelarens yta på skärmen. cursor: pekaren. cursorOverApp: fönstret överst
    /// under pekaren är appens (inte ett annat program som ligger över bilden). moved: förflyttningen sedan förra
    /// rörelsen som räknades. Pekaren måste vara inom ytan och över appen – rörelser någon annanstans på skärmen
    /// räknas aldrig, inte heller när appens fönster är aktivt. När appen inte är aktiv (pekaren passerar filmen på
    /// väg till ett annat fönster) krävs en dubbelt så lång rörelse.
    /// </summary>
    public static bool MouseWakes(Rectangle area, Point cursor, bool appActive, bool cursorOverApp, Size moved, int jitter = Jitter)
    {
        if (area.Width <= 0 || area.Height <= 0 || !area.Contains(cursor) || !cursorOverApp) return false;
        var limit = appActive ? jitter : 2 * jitter;
        return (long)moved.Width * moved.Width + (long)moved.Height * moved.Height >= (long)limit * limit;
    }

    // ---------- storleken ----------

    /// <summary>
    /// Radernas skala: skärmens DPI (100 % = 96), och på en stor skärm i helskärm minst som på en 1080p-tv
    /// (en 4K-tv med 100 % får 200 %). Aldrig under 100 %.
    /// </summary>
    public static double Scale(int dpi, int heightPx)
    {
        var byDpi = dpi > 0 ? dpi / 96.0 : 1;
        var bySize = Math.Min(2.0, heightPx / 1080.0);
        return Math.Max(1, Math.Max(byDpi, bySize));
    }

    // ---------- tiden till höger ----------

    /// <summary>"−29:36" – tid kvar (tomt utan längd)</summary>
    public static string Remaining(double pos, double dur) =>
        dur > 0 ? "−" + PlayerUi.TimeText(Math.Max(0, dur - Math.Max(0, double.IsNaN(pos) ? 0 : pos))) : "";

    /// <summary>"slutar 22:41" / "ends 10:41 PM" – när filmen är slut med nuvarande hastighet (avrundat till minuten)</summary>
    public static string EndsAt(double pos, double dur, double speed, DateTime now, bool sv)
    {
        if (!(dur > 0)) return "";
        var left = Math.Max(0, dur - Math.Max(0, double.IsNaN(pos) ? 0 : pos)) / (speed > 0 ? speed : 1);
        var end = now.AddSeconds(left);
        end = new DateTime(end.Year, end.Month, end.Day, end.Hour, end.Minute, 0, end.Kind).AddMinutes(end.Second >= 30 ? 1 : 0);
        return sv ? "slutar " + end.ToString("HH:mm", CultureInfo.InvariantCulture) : "ends " + end.ToString("h:mm tt", CultureInfo.InvariantCulture);
    }

    // ---------- titeln överst ----------

    static readonly Regex SxxEyy = new(@"^S(\d+)E(\d+)$", RegexOptions.CultureInvariant);

    /// <summary>
    /// Webbens titel ("Serie · S01E03 · Avsnittet" eller "Film · 2016") som två rader: serien/filmen och resten
    /// ("S1 · E3 · Avsnittet").
    /// </summary>
    public static (string Main, string Sub) SplitTitle(string title)
    {
        var parts = (title ?? "").Split(" · ");
        if (parts.Length == 0) return ("", "");
        var rest = parts.Skip(1).Select(p =>
        {
            var m = SxxEyy.Match(p.Trim());
            return m.Success ? $"S{int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture)} · E{int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture)}" : p;
        });
        return (parts[0], string.Join(" · ", rest));
    }

    // ---------- intro, sammanfattning och eftertexter ----------

    public readonly record struct Span(double Start, double End);

    /// <summary>Det servern vet om titeln (/api/items/:id): intro, sammanfattning, eftertexternas start, förhandsbilder</summary>
    public sealed record Extras(Span? Intro, Span? Recap, double? Credits, bool Trickplay)
    {
        public static readonly Extras None = new(null, null, null, false);
    }

    public enum SkipKind { None, Recap, Intro }

    /// <summary>
    /// Knappen "Hoppa över …" vid positionen pos, och vart den hoppar. Som webbspelaren (web/js/player/autoskip.js
    /// skipPlan): sammanfattningen går före introt, och den sista sekunden visas ingen knapp. Eftertexterna har kortet
    /// med nästa avsnitt (NextUpAt) i stället.
    /// </summary>
    public static (SkipKind Kind, double To) SkipAt(Extras e, double pos)
    {
        if (double.IsNaN(pos)) return (SkipKind.None, 0);
        if (e.Recap is Span r && pos >= r.Start && pos < r.End - 1) return (SkipKind.Recap, r.End);
        if (e.Intro is Span i && pos >= i.Start && pos < i.End - 1) return (SkipKind.Intro, i.End);
        return (SkipKind.None, 0);
    }

    /// <summary>Kortet med nästa avsnitt. SecondsLeft −1 = ingen nedräkning. PlayNow = appen ska starta nästa avsnitt nu.</summary>
    public readonly record struct NextUp(bool Show, int SecondsLeft, bool Auto, bool PlayNow);

    /// <summary>Utan eftertexter visas kortet de sista så här många sekunderna</summary>
    public const int NextUpTail = 30;

    /// <summary>
    /// Kortet med nästa avsnitt: från eftertexternas start (credits), annars de sista 30 sekunderna. Med kontots
    /// "spela nästa avsnitt automatiskt" (autoNext) räknas countdown sekunder ner från eftertexterna och appen byter
    /// när den når 0 (PlayNow). Utan eftertexter, eller när nedräkningen räcker till slutet, räknas tiden kvar ner och
    /// webben byter när filmen tar slut (native-ended, som förut). Utan autoNext: "Spela nu" och "Avbryt" utan nedräkning.
    /// Nedräkningen följer filmens tid, så den står still under paus. dismissed: användaren tryckte Avbryt.
    /// </summary>
    public static NextUp NextUpAt(double pos, double dur, double? credits, bool hasNext, bool autoNext, int countdown, bool dismissed)
    {
        if (!hasNext || dismissed || !(dur > 0) || double.IsNaN(pos)) return default;
        var hasCredits = credits is double c0 && c0 > 0 && c0 < dur;
        var appear = hasCredits ? credits!.Value : dur - NextUpTail;
        if (pos < appear) return default;
        if (!autoNext) return new NextUp(true, -1, false, false);
        var wanted = hasCredits ? appear + Math.Max(0, countdown) : dur;
        var deadline = Math.Min(wanted, dur);
        var left = Math.Max(0, (int)Math.Ceiling(deadline - pos - 1e-9));
        var playNow = hasCredits && wanted < dur && pos >= deadline;
        return new NextUp(true, left, true, playNow);
    }

    // ---------- förhandsbilder (server/trickplay.js: sprite-ark med cols × rows bilder) ----------

    public sealed record Trick(int Interval, int W, int H, int Cols, int Rows, int Count, int First);

    /// <summary>Arket (numret i /api/items/:id/trickplay/:n) och var i det bilden för sekund sec ligger</summary>
    public static (int Sheet, int X, int Y) TrickTile(Trick t, double sec)
    {
        var i = Math.Clamp((int)Math.Floor(Math.Max(0, double.IsNaN(sec) ? 0 : sec) / t.Interval), 0, Math.Max(0, t.Count - 1));
        var per = t.Cols * t.Rows;
        var k = i % per;
        return (i / per + t.First, k % t.Cols * t.W, k / t.Cols * t.H);
    }

    // ---------- serverns svar ----------

    static JsonElement? Parse(string json)
    {
        try { using var d = JsonDocument.Parse(json); return d.RootElement.Clone(); } catch { return null; }
    }
    static double? Num(JsonElement o, string k) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;
    static bool? Bool(JsonElement o, string k) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(k, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : null;
    static string Text(JsonElement o, string k) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
    static Span? SpanOf(JsonElement o, string k)
    {
        if (o.ValueKind != JsonValueKind.Object || !o.TryGetProperty(k, out var v) || v.ValueKind != JsonValueKind.Object) return null;
        var s = Num(v, "start") ?? 0; var e = Num(v, "end");
        return e is double end && end > s && s >= 0 ? new Span(s, end) : null;
    }

    /// <summary>Intro, sammanfattning, eftertexter och förhandsbilder ur /api/items/:id</summary>
    public static Extras ExtrasFromItem(string json)
    {
        if (Parse(json) is not JsonElement o || o.ValueKind != JsonValueKind.Object) return Extras.None;
        var credits = Num(o, "credits");
        return new Extras(SpanOf(o, "intro"), SpanOf(o, "recap"), credits > 0 ? credits : null, Bool(o, "trickplay") == true);
    }

    /// <summary>Kontots uppspelningsval (/api/me/playback-prefs) som spelarraden behöver</summary>
    public sealed record Prefs(bool SkipIntro, bool SkipRecap, bool AutoNext, int Countdown)
    {
        public static readonly Prefs Default = new(false, false, true, 8);
    }

    public static Prefs PrefsFrom(string json)
    {
        if (Parse(json) is not JsonElement o || o.ValueKind != JsonValueKind.Object) return Prefs.Default;
        var cd = Num(o, "nextCountdown");
        return new Prefs(Bool(o, "skipIntro") ?? false, Bool(o, "skipRecap") ?? false, Bool(o, "autoNext") ?? true,
            cd is double c ? Math.Clamp((int)Math.Round(c), 0, 60) : 8);
    }

    /// <summary>Nästa avsnitt (/api/items/:id) på kortet: "S1 · E4 · Namnet"</summary>
    public static string NextTitle(string json)
    {
        if (Parse(json) is not JsonElement o || o.ValueKind != JsonValueKind.Object) return "";
        var name = Text(o, "title").Trim();
        var s = Num(o, "season"); var e = Num(o, "episode");
        var se = s != null && e != null ? $"S{(int)s} · E{(int)e}" : "";
        return string.Join(" · ", new[] { se, name }.Where(x => x.Length > 0));
    }

    /// <summary>Beskrivningen av förhandsbilderna (/api/items/:id/trickplay), null om den inte går att använda</summary>
    public static Trick? TrickFrom(string json)
    {
        if (Parse(json) is not JsonElement o || o.ValueKind != JsonValueKind.Object) return null;
        int I(string k) => (int)(Num(o, k) ?? 0);
        var t = new Trick(I("interval"), I("w"), I("h"), I("cols"), I("rows"), I("count"), Num(o, "first") is double f ? (int)f : 1);
        return t.Interval > 0 && t.W > 0 && t.H > 0 && t.Cols > 0 && t.Rows > 0 && t.Count > 0 ? t : null;
    }
}
