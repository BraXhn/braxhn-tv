using System.Text.Json;
using System.Text.RegularExpressions;

namespace BraXhnTV;

/// <summary>
/// En utgåva på GitHub. SetupUrl är null när utgåvan ännu saknar installationsfil för Windows (den läggs dit en stund
/// efter att utgåvan skapats). ShaUrl är kontrollsummefilen (BraXhnTV-Setup-&lt;version&gt;.exe.sha256) när den finns.
/// </summary>
public sealed record Release(string Version, string PageUrl, string? SetupName = null, string? SetupUrl = null, long SetupSize = 0, string? ShaUrl = null)
{
    public bool HasSetup => SetupUrl != null && SetupName != null && SetupSize > 0;
}

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
    /// Läser svaret från GitHub (releases/latest). null om det inte är en stabil utgåva av appen: utkast,
    /// förhandsversioner och taggar som inte är v&lt;major&gt;.&lt;minor&gt;.&lt;patch&gt; (t.ex. libmpv-…, v1.5.0-beta.3)
    /// erbjuds aldrig. Installationsfilen är den som heter exakt BraXhnTV-Setup-&lt;utgåvans version&gt;.exe och ligger
    /// på GitHub; finns den inte (än) har utgåvan ingen SetupUrl.
    /// </summary>
    public static Release? FromGitHub(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var r = doc.RootElement;
        if (r.ValueKind != JsonValueKind.Object) return null;
        if (Bool(r, "draft") || Bool(r, "prerelease")) return null;
        var tag = Str(r, "tag_name");
        if (!Regex.IsMatch(tag, @"^v\d{1,6}\.\d{1,6}\.\d{1,6}$")) return null;
        var version = tag[1..];
        var rel = new Release(version, Str(r, "html_url"));
        if (!r.TryGetProperty("assets", out var assets) || assets.ValueKind != JsonValueKind.Array) return rel;
        var setupName = $"BraXhnTV-Setup-{version}.exe";
        string? setupUrl = null, shaUrl = null;
        long size = 0;
        foreach (var a in assets.EnumerateArray())
        {
            if (a.ValueKind != JsonValueKind.Object) continue;
            var name = Str(a, "name");
            var url = Str(a, "browser_download_url");
            if (!url.StartsWith("https://github.com/", StringComparison.Ordinal)) continue;
            if (name == setupName && a.TryGetProperty("size", out var sz) && sz.TryGetInt64(out var n) && n > 0) { setupUrl = url; size = n; }
            else if (name == setupName + ".sha256") shaUrl = url;
        }
        return setupUrl == null ? rel : rel with { SetupName = setupName, SetupUrl = setupUrl, SetupSize = size, ShaUrl = shaUrl };
    }

    static string Str(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    static bool Bool(JsonElement r, string name) => r.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}
