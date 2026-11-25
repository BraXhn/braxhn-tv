using System.Text.Json;
using System.Text.RegularExpressions;

namespace BraXhnTV;

/// <summary>En utgåva på GitHub med installationsfil för Windows</summary>
public sealed record Release(string Version, string SetupUrl, string SetupName, string PageUrl);

public static class Versions
{
    /// <summary>
    /// Jämför två versioner som "1.4.0" och "1.5.0-beta.3". Negativt om a är äldre än b. En förhandsversion är äldre
    /// än den stabila med samma nummer.
    /// </summary>
    public static int Compare(string a, string b)
    {
        var (na, pa) = Split(a);
        var (nb, pb) = Split(b);
        for (var i = 0; i < 3; i++) if (na[i] != nb[i]) return na[i].CompareTo(nb[i]);
        if (pa == pb) return 0;
        if (pa.Length == 0) return 1;
        if (pb.Length == 0) return -1;
        var xa = pa.Split('.'); var xb = pb.Split('.');
        for (var i = 0; i < Math.Min(xa.Length, xb.Length); i++)
        {
            var c = int.TryParse(xa[i], out var ia) && int.TryParse(xb[i], out var ib) ? ia.CompareTo(ib) : string.CompareOrdinal(xa[i], xb[i]);
            if (c != 0) return c;
        }
        return xa.Length.CompareTo(xb.Length);
    }

    static (int[] nums, string pre) Split(string v)
    {
        v = (v ?? "").Trim().TrimStart('v', 'V').Split('+')[0];
        var dash = v.IndexOf('-');
        var pre = dash < 0 ? "" : v[(dash + 1)..];
        var core = dash < 0 ? v : v[..dash];
        var nums = new int[3];
        var parts = core.Split('.');
        for (var i = 0; i < 3 && i < parts.Length; i++) int.TryParse(parts[i], out nums[i]);
        return (nums, pre);
    }

    /// <summary>
    /// Läser svaret från GitHub (releases/latest). null om utgåvan saknar installationsfil för Windows
    /// (BraXhnTV-Setup-&lt;version&gt;.exe), är ett utkast eller en förhandsversion.
    /// </summary>
    public static Release? FromGitHub(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var r = doc.RootElement;
        if (r.ValueKind != JsonValueKind.Object) return null;
        if (Bool(r, "draft") || Bool(r, "prerelease")) return null;
        var tag = r.TryGetProperty("tag_name", out var t) ? t.GetString() ?? "" : "";
        if (!Regex.IsMatch(tag, @"^v?\d+\.\d+\.\d+")) return null;
        var page = r.TryGetProperty("html_url", out var h) ? h.GetString() ?? "" : "";
        if (!r.TryGetProperty("assets", out var assets) || assets.ValueKind != JsonValueKind.Array) return null;
        foreach (var a in assets.EnumerateArray())
        {
            var name = a.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
            var url = a.TryGetProperty("browser_download_url", out var u) ? u.GetString() ?? "" : "";
            if (Regex.IsMatch(name, @"^BraXhnTV-Setup-[0-9A-Za-z.\-]+\.exe$") && url.StartsWith("https://github.com/", StringComparison.Ordinal))
                return new Release(tag.TrimStart('v'), url, name, page);
        }
        return null;
    }

    static bool Bool(JsonElement r, string name) => r.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}
