using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using SharpCompress.Archives.SevenZip;

namespace BraXhnTV;

/// <summary>
/// En byggnad av libmpv för Windows: BraXhn TV:s egen LGPL-byggnad (zip, SHA-256 ur apps/windows/libmpv.json) eller
/// reserven i mpv-projektets lista på SourceForge (7z, storlek och MD5 ur listan). Size 0 = okänd.
/// </summary>
public sealed record MpvBuild(string Name, string Url, long Size, string? Md5, string Date, string Git, string? Sha256 = null, bool Zip = false, bool Own = false);

/// <summary>Fel när mpv hämtas eller packas upp – med text på svenska och engelska</summary>
public sealed class MpvSourceException(string sv, string en, string? detail = null) : Exception(en)
{
    public string Sv { get; } = sv;
    public string En { get; } = en;
    /// <summary>Tekniskt fel (t.ex. från Windows) som visas under texten</summary>
    public string? Detail { get; } = detail;
}

/// <summary>
/// Var den inbyggda spelaren (libmpv-2.dll) hämtas, och kontrollen av det som hämtats.
///  1. Först BraXhn TV:s egen LGPL-byggnad: en zip i en utgåva i det här repot (taggen libmpv-…). Adressen och
///     SHA-256 står i apps/windows/libmpv.json, som byggs in i appen – en ny byggnad kräver alltså en ny app.
///  2. Reserv (när libmpv.json saknas eller den egna utgåvan inte går att nå): mpv-projektets Windows-byggen
///     (shinchiro/mpv-winbuild-cmake) på SourceForge-projektet mpv-player-windows. Filnamnen innehåller datum och
///     git-hash, så det finns ingen fast adress till "senaste": appen läser projektets RSS-lista för mappen libmpv och
///     väljer den nyaste filen efter mönster. Varianten är x86_64 – inte x86_64-v3, som kräver en processor med AVX2.
/// </summary>
public static class MpvSource
{
    public const string OwnReleases = "https://github.com/BraXhn/braxhn-tv/releases/download/";
    public const string Rss = "https://sourceforge.net/projects/mpv-player-windows/rss?path=/libmpv";
    public const string FilesPage = "https://sourceforge.net/projects/mpv-player-windows/files/libmpv/";
    public const string DllName = "libmpv-2.dll";
    // Rimliga gränser: arkivet är omkring 30 MB och DLL:en omkring 120 MB
    public const long MinArchive = 5L << 20, MaxArchive = 200L << 20, MinDll = 10L << 20, MaxDll = 512L << 20;
    static readonly Regex X64 = new(@"^mpv-dev-x86_64-(\d{8})-git-([0-9a-f]{7,40})\.7z$", RegexOptions.CultureInvariant);
    static readonly XNamespace Media = "http://video.search.yahoo.com/mrss/";

    /// <summary>Nedladdningsadressen för en fil i mappen libmpv (SourceForge skickar vidare till en spegel)</summary>
    public static string DownloadUrl(string name) => FilesPage + Uri.EscapeDataString(name) + "/download";

    /// <summary>
    /// Den egna byggnaden ur libmpv.json: { "tagg": "libmpv-…", "fil": "&lt;filnamn&gt;", "sha256": "…" } (även "tag"/"zip" godtas).
    /// null om filen saknas eller inte ser rätt ut (då används reserven). En adress måste peka på en utgåva i
    /// BraXhn/braxhn-tv; ett filnamn blir en adress i utgåvan med taggen.
    /// </summary>
    public static MpvBuild? FromConfig(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object) return null;
            string S(string n) => r.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "").Trim() : "";
            // båda stavningarna godtas (flödet skriver tagg/fil)
            var tag = S("tag"); if (tag == "") tag = S("tagg"); var zip = S("zip"); if (zip == "") zip = S("fil"); var sha = S("sha256").ToLowerInvariant();
            if (!Regex.IsMatch(tag, @"^libmpv-[0-9A-Za-z.\-]+$") || !Regex.IsMatch(sha, "^[0-9a-f]{64}$")) return null;
            string url, name;
            if (zip.StartsWith("https://", StringComparison.Ordinal))
            {
                if (!zip.StartsWith(OwnReleases, StringComparison.Ordinal) || zip.Contains("..") || zip.Contains('?') || zip.Contains('#') || !zip.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)) return null;
                url = zip; name = zip[(zip.LastIndexOf('/') + 1)..];
            }
            else
            {
                if (!Regex.IsMatch(zip, @"^[0-9A-Za-z._\-]+\.zip$") || zip.StartsWith('.')) return null;
                name = zip; url = OwnReleases + Uri.EscapeDataString(tag) + "/" + Uri.EscapeDataString(zip);
            }
            return new MpvBuild(name, url, 0, null, tag, "", sha, Zip: true, Own: true);
        }
        catch (JsonException) { return null; }
    }

    /// <summary>Den nyaste x86_64-byggnaden i RSS-listan, eller null om ingen fil passar mönstret</summary>
    public static MpvBuild? Pick(string rssXml)
    {
        XDocument doc;
        try { doc = XDocument.Parse(rssXml); }
        catch (System.Xml.XmlException) { return null; }
        MpvBuild? best = null;
        foreach (var item in doc.Descendants("item"))
        {
            var title = ((string?)item.Element("title") ?? "").Trim();
            var name = title.StartsWith("/libmpv/", StringComparison.Ordinal) ? title["/libmpv/".Length..] : "";
            var m = X64.Match(name);
            if (!m.Success) continue;
            var media = item.Element(Media + "content");
            if (!long.TryParse((string?)media?.Attribute("filesize"), out var size) || size < MinArchive || size > MaxArchive) continue;
            var md5 = media?.Elements(Media + "hash").FirstOrDefault(h => (string?)h.Attribute("algo") == "md5")?.Value.Trim().ToLowerInvariant();
            if (md5 != null && !Regex.IsMatch(md5, "^[0-9a-f]{32}$")) md5 = null;
            var b = new MpvBuild(name, DownloadUrl(name), size, md5, m.Groups[1].Value, m.Groups[2].Value);
            if (best == null || string.CompareOrdinal(b.Date, best.Date) > 0) best = b;
        }
        return best;
    }

    /// <summary>Stämmer den nedladdade filen (storlek, SHA-256 eller MD5, och att det är ett zip- eller 7z-arkiv)?</summary>
    public static void CheckArchive(string path, MpvBuild b)
    {
        var len = new FileInfo(path).Length;
        if (b.Size > 0 && len != b.Size)
            throw new MpvSourceException($"Filen blev {len} byte men skulle vara {b.Size}. Försök igen.", $"The file is {len} bytes but should be {b.Size}. Please try again.");
        if (len < MinArchive || len > MaxArchive)
            throw new MpvSourceException($"Filen har en konstig storlek ({len} byte). Försök igen senare.", $"The file has an odd size ({len} bytes). Please try again later.");
        byte[] magic = b.Zip ? [0x50, 0x4B, 0x03, 0x04] : [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C];
        using (var f = File.OpenRead(path))
        {
            var sig = new byte[magic.Length];
            if (f.Read(sig) != sig.Length || !sig.AsSpan().SequenceEqual(magic))
                throw new MpvSourceException("Det som hämtades är inget arkiv. Försök igen senare.", "The download is not an archive. Please try again later.");
        }
        if (b.Sha256 != null)
        {
            using var f = File.OpenRead(path);
            if (Convert.ToHexString(SHA256.HashData(f)).ToLowerInvariant() != b.Sha256)
                throw new MpvSourceException("Filen stämmer inte med kontrollsumman (SHA-256). Den används inte.", "The file does not match its checksum (SHA-256). It is not used.");
        }
        else if (b.Md5 != null)
        {
            using var f = File.OpenRead(path);
            var md5 = Convert.ToHexString(MD5.HashData(f)).ToLowerInvariant();
            if (md5 != b.Md5) throw new MpvSourceException("Filen stämmer inte med kontrollsumman i listan. Försök igen.", "The file does not match the checksum in the list. Please try again.");
        }
    }

    sealed record Entry(string Key, long Size, Func<Stream> Open);

    /// <summary>Filerna i ett zip- eller 7z-arkiv (zip med .NET:s egen uppackning, 7z med SharpCompress)</summary>
    static IDisposable Entries(string archive, bool zip, out List<Entry> list)
    {
        if (zip)
        {
            var z = ZipFile.OpenRead(archive);
            list = z.Entries.Where(e => !e.FullName.EndsWith('/')).Select(e => new Entry(e.FullName, e.Length, e.Open)).ToList();
            return z;
        }
        var a = SevenZipArchive.OpenArchive(archive);
        list = a.Entries.Where(e => !e.IsDirectory && e.Key != null).Select(e => new Entry(e.Key!, e.Size, e.OpenEntryStream)).ToList();
        return a;
    }

    /// <summary>
    /// Packar upp libmpv-2.dll ur arkivet till dest och kontrollerar den (storlek och att den är för 64-bitars Windows).
    /// </summary>
    public static void ExtractDll(string archive, string dest, string machine = "x64", bool zip = false)
    {
        using var _ = Entries(archive, zip, out var entries);
        var entry = entries
            .Where(e => Path.GetFileName(e.Key.Replace('\\', '/')).Equals(DllName, StringComparison.OrdinalIgnoreCase))
            .OrderBy(e => e.Key.Length)
            .FirstOrDefault()
            ?? throw new MpvSourceException("Arkivet innehåller ingen libmpv-2.dll.", "The archive does not contain libmpv-2.dll.");
        if (entry.Size < MinDll || entry.Size > MaxDll)
            throw new MpvSourceException($"libmpv-2.dll i arkivet har en konstig storlek ({entry.Size} byte).", $"libmpv-2.dll in the archive has an odd size ({entry.Size} bytes).");
        var tmp = dest + ".tmp";
        try
        {
            using (var src = entry.Open())
            using (var dst = File.Create(tmp))
                src.CopyTo(dst);
            if (new FileInfo(tmp).Length != entry.Size)
                throw new MpvSourceException("Uppackningen blev ofullständig. Försök igen.", "Unpacking was incomplete. Please try again.");
            var m = Pe.Machine(tmp);
            if (m != machine)
                throw new MpvSourceException($"libmpv-2.dll i arkivet är inte för den här datorn ({m ?? "okänt format"}).", $"libmpv-2.dll in the archive is not for this computer ({m ?? "unknown format"}).");
            File.Move(tmp, dest, true);
        }
        finally { try { File.Delete(tmp); } catch { } }
    }

    /// <summary>
    /// Licenstexterna i arkivet (filer som slutar på .txt eller .md, högst 1 MB styck) till mappen dir, utan
    /// undermappar. Antalet filer som packades upp.
    /// </summary>
    public static int ExtractLicenses(string archive, string dir, bool zip = false)
    {
        using var _ = Entries(archive, zip, out var entries);
        var n = 0;
        foreach (var e in entries)
        {
            var name = Path.GetFileName(e.Key.Replace('\\', '/'));
            if (e.Size > 1 << 20 || !Regex.IsMatch(name, @"^[0-9A-Za-z._\-]+\.(txt|md)$", RegexOptions.IgnoreCase) || name.StartsWith('.')) continue;
            Directory.CreateDirectory(dir);
            using var src = e.Open();
            using var dst = File.Create(Path.Combine(dir, name));
            src.CopyTo(dst);
            n++;
        }
        return n;
    }
}

/// <summary>Vilken processor en Windows-DLL är byggd för (PE-huvudet)</summary>
public static class Pe
{
    /// <summary>"x64", "x86", "arm64" eller null om filen inte är en Windows-DLL</summary>
    public static string? Machine(string path)
    {
        try
        {
            using var f = File.OpenRead(path);
            using var r = new BinaryReader(f);
            if (f.Length < 0x40 || r.ReadUInt16() != 0x5A4D) return null; // "MZ"
            f.Position = 0x3C;
            var pe = r.ReadInt32();
            if (pe <= 0 || pe > f.Length - 6) return null;
            f.Position = pe;
            if (r.ReadUInt32() != 0x00004550) return null; // "PE\0\0"
            return r.ReadUInt16() switch { 0x8664 => "x64", 0x014C => "x86", 0xAA64 => "arm64", var x => "0x" + x.ToString("x4") };
        }
        catch { return null; }
    }
}
