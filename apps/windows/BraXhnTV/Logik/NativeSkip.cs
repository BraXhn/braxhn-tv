using System.Globalization;

namespace BraXhnTV;

/// <summary>
/// "Webbspelaren används eftersom …": webben skickar native-skip när den inte lämnar över en film till mpv
/// (web/js/player/nativeplan.js skipMessage), och appen säger själv till när mpv saknas eller är avstängd.
/// </summary>
public static class NativeSkip
{
    /// <summary>Orsaken som en mening (utan "Webbspelaren används eftersom")</summary>
    public static string Describe(string why, string mode, IReadOnlyList<string> reasons, bool remote, int bwKbps, bool sv)
    {
        string T(string s, string e) => sv ? s : e;
        var detail = reasons.Count > 0 ? " (" + string.Join(", ", reasons) + ")" : "";
        var where = remote
            ? T(" – utanför hemmet", " – away from home") + (bwKbps > 0 ? T($", uppmätt {Mbit(bwKbps)} Mbit/s", $", measured {Mbit(bwKbps)} Mbit/s") : "")
            : "";
        return why switch
        {
            _ when why.StartsWith("mode:", StringComparison.Ordinal) => (mode == "remux"
                ? T("servern packar om filen i stället för att skicka den orörd", "the server repackages the file instead of sending it untouched")
                : T("servern valde omkodning", "the server chose to convert the video")) + detail + where,
            "familjefilter" => T("familjefiltret är på för profilen (mpv kan inte tysta och hoppa över än)", "the family filter is on for the profile (mpv can't mute and skip yet)"),
            "trailers" => T("trailers visas före filmen (bio-läget)", "trailers play before the film (cinema mode)"),
            "off" => T("den inbyggda spelaren är avstängd i appens meny", "the built-in player is turned off in the app menu"),
            "mpv" => T("mpv kunde inte laddas", "mpv could not be loaded") + detail,
            _ => T("servern svarade inte som väntat", "the server did not answer as expected") + detail,
        };
    }

    static string Mbit(int kbps) => (kbps / 1000.0).ToString(kbps >= 10000 ? "0" : "0.#", CultureInfo.CurrentCulture);
}
