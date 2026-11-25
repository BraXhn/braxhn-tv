using System.Text.RegularExpressions;

namespace BraXhnTV;

/// <summary>Serveradresser, samma regler som Expo-appen (apps/expo/src/api.ts normalizeServer).</summary>
public static class Address
{
    public const string Default = "https://tv.braxhn.net";

    /// <summary>
    /// Adressen som användaren skrev → fullständig adress. Domännamn får https, IP-adresser och namn i hemnätet
    /// http och port 8420. Tom sträng = ogiltig adress.
    /// </summary>
    public static string Normalize(string? input)
    {
        var s = (input ?? "").Trim().TrimEnd('/');
        if (s.Length == 0 || s.Any(char.IsWhiteSpace)) return "";
        if (s.Contains("://") && !Regex.IsMatch(s, "^https?://", RegexOptions.IgnoreCase)) return "";
        if (!Regex.IsMatch(s, "^https?://", RegexOptions.IgnoreCase))
        {
            var host = s.Split('/')[0].Split(':')[0];
            var local = Regex.IsMatch(host, @"^\d{1,3}(\.\d{1,3}){3}$") || !host.Contains('.')
                || Regex.IsMatch(host, @"\.(local|lan|home)$", RegexOptions.IgnoreCase);
            s = !local ? "https://" + s : "http://" + (s.Split('/')[0].Contains(':') ? s : InsertPort(s));
        }
        if (!Uri.TryCreate(s, UriKind.Absolute, out var u) || (u.Scheme != "http" && u.Scheme != "https") || u.Host.Length == 0)
            return "";
        // Bara servern: ingen sökväg efter adressen, inga frågor eller ankare
        var port = u.IsDefaultPort ? "" : ":" + u.Port;
        var path = u.AbsolutePath.TrimEnd('/');
        return $"{u.Scheme}://{u.Host.ToLowerInvariant()}{port}{path}";
    }

    static string InsertPort(string s)
    {
        var i = s.IndexOf('/');
        return i < 0 ? s + ":8420" : s[..i] + ":8420" + s[i..];
    }

    /// <summary>Namnet som visas för en server: värdnamnet utan protokoll och standardport</summary>
    public static string Label(string url) =>
        Regex.Replace(Regex.Replace(url, "^https?://", "", RegexOptions.IgnoreCase), ":8420$", "");

    /// <summary>Samma ursprung (protokoll, värd och port) som servern?</summary>
    public static bool SameOrigin(string url, string server) =>
        Uri.TryCreate(url, UriKind.Absolute, out var a) && Uri.TryCreate(server, UriKind.Absolute, out var b)
        && a.Scheme == b.Scheme && string.Equals(a.Host, b.Host, StringComparison.OrdinalIgnoreCase) && a.Port == b.Port;

    /// <summary>Länkar som får öppnas i standardwebbläsaren eller e-postprogrammet</summary>
    public static bool External(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && (u.Scheme == "http" || u.Scheme == "https" || u.Scheme == "mailto");
}
