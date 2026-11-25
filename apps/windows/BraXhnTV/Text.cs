using System.Globalization;
using System.Reflection;

namespace BraXhnTV;

/// <summary>Svenska eller engelska efter Windows språk</summary>
static class L
{
    public static readonly bool Sv = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName is "sv";
    public static string T(string sv, string en) => Sv ? sv : en;
}

static class AppInfo
{
    public const string Name = "BraXhn TV";
    /// <summary>Appens version, t.ex. "1.4.0" (från bygget)</summary>
    public static readonly string Version =
        (Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0").Split('+')[0];
    public const string Repo = "BraXhn/braxhn-tv";

    /// <summary>Öppnar en adress i standardwebbläsaren</summary>
    public static void OpenExternal(string url)
    {
        if (!Address.External(url)) return;
        try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }
}
