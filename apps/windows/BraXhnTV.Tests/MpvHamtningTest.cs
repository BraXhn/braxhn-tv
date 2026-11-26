using System.IO.Compression;
using System.Security.Cryptography;
using BraXhnTV;
using BraXhnTV.Spelare;
using Xunit;

/// <summary>"Servern för gammal": webben lämnar bara över till den inbyggda spelaren från server 1.4.1</summary>
public class ServerVersionTest
{
    [Theory]
    [InlineData("{\"api\":1,\"needsSetup\":false,\"version\":\"1.3.0\",\"name\":\"BraXhn TV\"}", "1.3.0")]
    [InlineData("{\"version\":\"1.5.0-beta.2\",\"name\":\"BraXhn TV\"}", "1.5.0-beta.2")]
    [InlineData("{\"version\":\"1.3.0\",\"name\":\"Jellyfin\"}", null)]
    [InlineData("{\"name\":\"BraXhn TV\"}", null)]
    [InlineData("{\"version\":\"<script>\",\"name\":\"BraXhn TV\"}", null)]
    [InlineData("<html>inte json</html>", null)]
    [InlineData("[1,2]", null)]
    public void Versionen_ur_api_status(string json, string? expected) => Assert.Equal(expected, ServerInfo.VersionFromStatus(json));

    [Theory]
    [InlineData("1.3.0", true)]   // ärende #4: kroken till den inbyggda spelaren finns inte i webbappen
    [InlineData("1.4.0", true)]
    [InlineData("1.4.1-beta.1", true)]
    [InlineData("1.4.1", false)]
    [InlineData("1.4.2", false)]
    [InlineData("1.5.0-beta.1", false)]
    [InlineData("2.0.0", false)]
    [InlineData(null, false)]     // okänd (servern svarade inte): ingen varning
    public void Servern_for_gammal_for_den_inbyggda_spelaren(string? version, bool tooOld) => Assert.Equal(tooOld, ServerInfo.TooOldForNative(version));
}

/// <summary>Hämtningen av mpv: valet i SourceForge-listan, kontrollen av arkivet och uppackningen av libmpv-2.dll</summary>
public class MpvHamtningTest
{
    static string Fil(string name) => Path.Combine(AppContext.BaseDirectory, "Filer", name);

    [Fact]
    public void Valjer_nyaste_x86_64_och_inte_v3_i686_eller_aarch64()
    {
        var b = MpvSource.Pick(File.ReadAllText(Fil("libmpv-rss.xml")));
        Assert.NotNull(b);
        Assert.Equal("mpv-dev-x86_64-20261108-git-55d3feb45c.7z", b!.Name);
        Assert.Equal("https://sourceforge.net/projects/mpv-player-windows/files/libmpv/mpv-dev-x86_64-20261108-git-55d3feb45c.7z/download", b.Url);
        Assert.Equal(31733282, b.Size);
        Assert.Equal("c5752f29461773e8c945fde5547bf511", b.Md5);
        Assert.Equal("20261108", b.Date);
        Assert.Equal("55d3feb45c", b.Git);
    }

    static string Item(string title, long size = 31_000_000, string md5 = "0123456789abcdef0123456789abcdef") => $"""
        <item><title><![CDATA[{title}]]></title><link>https://example.com/x</link>
        <media:content xmlns:media="http://video.search.yahoo.com/mrss/" url="https://evil.example/{title}" filesize="{size}"><media:hash algo="md5">{md5}</media:hash></media:content></item>
        """;
    static string Rss(params string[] items) => $"<?xml version=\"1.0\"?><rss version=\"2.0\"><channel>{string.Join("", items)}</channel></rss>";

    [Fact]
    public void Ordningen_i_listan_spelar_ingen_roll_och_adressen_byggs_av_appen()
    {
        var b = MpvSource.Pick(Rss(Item("/libmpv/mpv-dev-x86_64-20260101-git-aaaaaaa.7z"), Item("/libmpv/mpv-dev-x86_64-20261231-git-bbbbbbb.7z"), Item("/libmpv/mpv-dev-x86_64-20260601-git-ccccccc.7z")));
        Assert.Equal("mpv-dev-x86_64-20261231-git-bbbbbbb.7z", b!.Name);
        // Adressen i listan (media:content) används inte – bara namnet, som måste följa mönstret
        Assert.StartsWith(MpvSource.FilesPage, b.Url);
    }

    [Fact]
    public void Inget_som_passar_ger_null()
    {
        Assert.Null(MpvSource.Pick(Rss(Item("/libmpv/mpv-dev-x86_64-v3-20261108-git-55d3feb45c.7z"), Item("/libmpv/mpv-dev-i686-20261108-git-55d3feb45c.7z"))));
        Assert.Null(MpvSource.Pick(Rss(Item("/libmpv/../mpv-dev-x86_64-20261108-git-55d3feb45c.7z"), Item("/libmpv/mpv-dev-x86_64-20261108-git-55d3feb45c.7z.exe"))));
        Assert.Null(MpvSource.Pick(Rss(Item("/libmpv/mpv-dev-x86_64-20261108-git-55d3feb45c.7z", size: 1000))));          // för liten
        Assert.Null(MpvSource.Pick(Rss(Item("/libmpv/mpv-dev-x86_64-20261108-git-55d3feb45c.7z", size: 900L << 20))));    // för stor
        Assert.Null(MpvSource.Pick("<html>SourceForge är nere</html"));
        Assert.Null(MpvSource.Pick(""));
        // En konstig kontrollsumma ignoreras (storleken kontrolleras ändå)
        Assert.Null(MpvSource.Pick(Rss(Item("/libmpv/mpv-dev-x86_64-20261108-git-55d3feb45c.7z", md5: "xyz")))!.Md5);
    }

    static MpvBuild Build(string file, long? size = null, string? md5 = null)
    {
        using var f = File.OpenRead(file);
        return new MpvBuild("x.7z", "https://x", size ?? f.Length, md5 ?? Convert.ToHexString(MD5.HashData(f)).ToLowerInvariant(), "20261108", "abc");
    }

    [Fact]
    public void Arkivet_kontrolleras_mot_listan()
    {
        // Testarkivet är litet; storleken fylls ut till arkivets minsta rimliga storlek (resten kontrolleras som vanligt)
        var tmp = Directory.CreateTempSubdirectory("bxtv-7z-").FullName;
        var a = Path.Combine(tmp, "mpv.7z");
        using (var f = File.Create(a)) { f.Write(File.ReadAllBytes(Fil("mpv-test.7z"))); f.SetLength(MpvSource.MinArchive); }
        MpvSource.CheckArchive(a, Build(a));
        Assert.Throws<MpvSourceException>(() => MpvSource.CheckArchive(Fil("mpv-test.7z"), Build(Fil("mpv-test.7z"))));
        MpvSource.CheckArchive(a, Build(a) with { Md5 = null });
        var e = Assert.Throws<MpvSourceException>(() => MpvSource.CheckArchive(a, Build(a, size: 31733282)));
        Assert.Contains("byte", e.Sv);
        Assert.Throws<MpvSourceException>(() => MpvSource.CheckArchive(a, Build(a, md5: "00000000000000000000000000000000")));
        // En HTML-sida i stället för arkivet (t.ex. en spegel som svarar med en felsida)
        var dir = Directory.CreateTempSubdirectory("bxtv-7z-").FullName;
        try
        {
            var html = Path.Combine(dir, "x.7z");
            File.WriteAllText(html, "<!doctype html><html>…</html>");
            Assert.Throws<MpvSourceException>(() => MpvSource.CheckArchive(html, Build(html)));
        }
        finally { Directory.Delete(dir, true); Directory.Delete(tmp, true); }
    }

    [Fact]
    public void Packar_upp_libmpv_2_dll_och_kontrollerar_den()
    {
        var dir = Directory.CreateTempSubdirectory("bxtv-7z-").FullName;
        try
        {
            var dll = Path.Combine(dir, "libmpv-2.dll");
            MpvSource.ExtractDll(Fil("mpv-test.7z"), dll);
            Assert.Equal(11 * 1024 * 1024, new FileInfo(dll).Length);
            Assert.Equal("x64", Pe.Machine(dll));
            Assert.False(File.Exists(dll + ".tmp"));

            // 32-bitarsvarianten (i686): packas inte upp, och ingen fil blir kvar
            var x86 = Path.Combine(dir, "x86", "libmpv-2.dll");
            Directory.CreateDirectory(Path.GetDirectoryName(x86)!);
            var e = Assert.Throws<MpvSourceException>(() => MpvSource.ExtractDll(Fil("mpv-test-x86.7z"), x86));
            Assert.Contains("x86", e.Sv);
            Assert.False(File.Exists(x86));
            Assert.False(File.Exists(x86 + ".tmp"));

            e = Assert.Throws<MpvSourceException>(() => MpvSource.ExtractDll(Fil("mpv-test-utan-dll.7z"), Path.Combine(dir, "ingen.dll")));
            Assert.Contains("libmpv-2.dll", e.Sv);
        }
        finally { Directory.Delete(dir, true); }
    }

    /// <summary>Det riktiga arkivet från SourceForge (sätt BRAXHN_MPV_7Z till en nedladdad mpv-dev-x86_64-….7z)</summary>
    [Fact]
    public void Riktigt_arkiv_fran_SourceForge()
    {
        var a = Environment.GetEnvironmentVariable("BRAXHN_MPV_7Z");
        if (string.IsNullOrEmpty(a) || !File.Exists(a)) return;
        var dir = Directory.CreateTempSubdirectory("bxtv-7z-").FullName;
        try
        {
            var dll = Path.Combine(dir, "libmpv-2.dll");
            MpvSource.ExtractDll(a, dll);
            Assert.Equal("x64", Pe.Machine(dll));
            Assert.True(new FileInfo(dll).Length > MpvSource.MinDll);
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void Pe_huvudet()
    {
        var dir = Directory.CreateTempSubdirectory("bxtv-pe-").FullName;
        try
        {
            var txt = Path.Combine(dir, "a.dll");
            File.WriteAllText(txt, "inte en dll");
            Assert.Null(Pe.Machine(txt));
            Assert.Null(Pe.Machine(Path.Combine(dir, "finns-inte.dll")));
        }
        finally { Directory.Delete(dir, true); }
    }
}

/// <summary>Den egna LGPL-byggnaden: adressen och SHA-256 ur apps/windows/libmpv.json, och zip-arkivet</summary>
public class EgenByggnadTest
{
    const string Sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    [Fact]
    public void Filnamn_blir_en_adress_i_utgavan()
    {
        var b = MpvSource.FromConfig($"{{\"tag\":\"libmpv-0.39.0-20261126\",\"zip\":\"libmpv-0.39.0-20261126-x86_64.zip\",\"sha256\":\"{Sha.ToUpperInvariant()}\"}}");
        Assert.NotNull(b);
        Assert.Equal("https://github.com/BraXhn/braxhn-tv/releases/download/libmpv-0.39.0-20261126/libmpv-0.39.0-20261126-x86_64.zip", b!.Url);
        Assert.Equal(Sha, b.Sha256);
        Assert.True(b.Zip);
        Assert.True(b.Own);
        Assert.Equal(0, b.Size);
    }

    [Fact]
    public void Full_adress_bara_till_en_utgava_i_repot()
    {
        var url = "https://github.com/BraXhn/braxhn-tv/releases/download/libmpv-1/x.zip";
        Assert.Equal(url, MpvSource.FromConfig($"{{\"tag\":\"libmpv-1\",\"zip\":\"{url}\",\"sha256\":\"{Sha}\"}}")!.Url);
        foreach (var bad in new[] { "https://evil.example/x.zip", "https://github.com/annan/repo/releases/download/libmpv-1/x.zip",
                                    "https://github.com/BraXhn/braxhn-tv/releases/download/../../x.zip", "http://github.com/BraXhn/braxhn-tv/releases/download/libmpv-1/x.zip",
                                    "https://github.com/BraXhn/braxhn-tv/releases/download/libmpv-1/x.exe", "../x.zip", "a/b.zip", ".zip" })
            Assert.Null(MpvSource.FromConfig($"{{\"tag\":\"libmpv-1\",\"zip\":\"{bad}\",\"sha256\":\"{Sha}\"}}"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("inte json")]
    [InlineData("{\"tag\":\"v1.4.1\",\"zip\":\"x.zip\",\"sha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}")] // fel tagg
    [InlineData("{\"tag\":\"libmpv-1\",\"zip\":\"x.zip\",\"sha256\":\"abc\"}")]                                                  // ingen riktig SHA-256
    [InlineData("{\"tag\":\"libmpv-1\",\"zip\":\"x.zip\"}")]
    public void Saknas_eller_fel_ger_reserven(string? json) => Assert.Null(MpvSource.FromConfig(json));

    /// <summary>Zip som den egna byggnaden: libmpv-2.dll (låtsad, 11 MB) och licenstexter</summary>
    static string Zip(string dir, ushort machine = 0x8664, bool dll = true)
    {
        var path = Path.Combine(dir, "libmpv.zip");
        using (var z = ZipFile.Open(path, ZipArchiveMode.Create))
        {
            if (dll)
            {
                var b = new byte[11 * 1024 * 1024];
                b[0] = (byte)'M'; b[1] = (byte)'Z';
                BitConverter.GetBytes(0x80).CopyTo(b, 0x3C);
                "PE\0\0"u8.ToArray().CopyTo(b, 0x80);
                BitConverter.GetBytes(machine).CopyTo(b, 0x84);
                using var s = z.CreateEntry("libmpv-2.dll").Open();
                s.Write(b);
            }
            using (var w = new StreamWriter(z.CreateEntry("LICENSE-mpv-LGPL-2.1.txt").Open())) w.Write("LGPL");
            using (var w = new StreamWriter(z.CreateEntry("licenses/ffmpeg.md").Open())) w.Write("FFmpeg LGPL");
            using (var w = new StreamWriter(z.CreateEntry("../utanfor.txt").Open())) w.Write("x");
            z.CreateEntry("libmpv-2.dll.sha256");
        }
        return path;
    }

    static MpvBuild Own(string zip, string? sha = null)
    {
        using var f = File.OpenRead(zip);
        return new MpvBuild("libmpv.zip", "https://x", 0, null, "libmpv-1", "", sha ?? Convert.ToHexString(SHA256.HashData(f)).ToLowerInvariant(), Zip: true, Own: true);
    }

    [Fact]
    public void Zip_kontrolleras_med_sha256_och_packas_upp()
    {
        var dir = Directory.CreateTempSubdirectory("bxtv-zip-").FullName;
        try
        {
            var zip = Zip(dir);
            // Arkivet är litet (nollor packas bra) – storleksgränsen gäller riktiga arkiv; här provas resten
            var e = Assert.Throws<MpvSourceException>(() => MpvSource.CheckArchive(zip, Own(zip)));
            Assert.Contains("storlek", e.Sv);
            var big = Path.Combine(dir, "stor.zip");
            using (var f = File.Create(big)) { f.Write(File.ReadAllBytes(zip)); f.SetLength(MpvSource.MinArchive + 10); }
            MpvSource.CheckArchive(big, Own(big));
            e = Assert.Throws<MpvSourceException>(() => MpvSource.CheckArchive(big, Own(big, sha: Sha)));
            Assert.Contains("SHA-256", e.Sv);
            // Ett 7z med zip-förväntan godtas inte
            Assert.Throws<MpvSourceException>(() => MpvSource.CheckArchive(Path.Combine(AppContext.BaseDirectory, "Filer", "mpv-test.7z"), Own(zip) with { Sha256 = null }));

            var dll = Path.Combine(dir, "libmpv-2.dll");
            MpvSource.ExtractDll(zip, dll, zip: true);
            Assert.Equal("x64", Pe.Machine(dll));
            var lic = Path.Combine(dir, "licens");
            Assert.Equal(3, MpvSource.ExtractLicenses(zip, lic, zip: true));
            Assert.True(File.Exists(Path.Combine(lic, "LICENSE-mpv-LGPL-2.1.txt")));
            Assert.True(File.Exists(Path.Combine(lic, "ffmpeg.md")));
            Assert.False(File.Exists(Path.Combine(dir, "utanfor.txt")), "aldrig utanför mappen");
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void Zip_med_fel_arkitektur_eller_utan_dll()
    {
        var dir = Directory.CreateTempSubdirectory("bxtv-zip-").FullName;
        try
        {
            var dll = Path.Combine(dir, "ut", "libmpv-2.dll");
            Directory.CreateDirectory(Path.GetDirectoryName(dll)!);
            Assert.Throws<MpvSourceException>(() => MpvSource.ExtractDll(Zip(dir, machine: 0x014C), dll, zip: true));
            Assert.False(File.Exists(dll));
            File.Delete(Path.Combine(dir, "libmpv.zip"));
            var e = Assert.Throws<MpvSourceException>(() => MpvSource.ExtractDll(Zip(dir, dll: false), dll, zip: true));
            Assert.Contains("libmpv-2.dll", e.Sv);
        }
        finally { Directory.Delete(dir, true); }
    }
}

/// <summary>Om den inbyggda spelaren: varje plats som provades och varför den inte gick att använda</summary>
public class LibmpvLaddningTest
{
    [Fact]
    public void Fel_arkitektur_laddas_inte_och_sags_tydligt()
    {
        var dir = Directory.CreateTempSubdirectory("bxtv-lib-").FullName;
        try
        {
            var dll = Path.Combine(dir, "libmpv-2.dll");
            MpvSource.ExtractDll(Path.Combine(AppContext.BaseDirectory, "Filer", "mpv-test.7z"), dll);
            // En x64-DLL med bara nollor efter huvudet: rätt arkitektur men går inte att ladda – inget undantag ut
            Assert.Null(Libmpv.Probe(dll, out var a));
            Assert.Equal(Libmpv.ProcessMachine == "x64" ? Libmpv.Outcome.NotLoadable : Libmpv.Outcome.WrongArch, a.Outcome);
            Assert.Null(Libmpv.Probe(Path.Combine(dir, "saknas.dll"), out a));
            Assert.Equal(Libmpv.Outcome.Missing, a.Outcome);
            // 32-bitars: provas inte ens att ladda
            File.WriteAllBytes(dll, PeFile(0x014C));
            Assert.Null(Libmpv.Probe(dll, out a));
            Assert.Equal(Libmpv.Outcome.WrongArch, a.Outcome);
            Assert.Equal("x86", a.Machine);
        }
        finally { Directory.Delete(dir, true); }
    }

    static byte[] PeFile(ushort machine)
    {
        var b = new byte[4096];
        b[0] = (byte)'M'; b[1] = (byte)'Z';
        BitConverter.GetBytes(0x80).CopyTo(b, 0x3C);
        "PE\0\0"u8.ToArray().CopyTo(b, 0x80);
        BitConverter.GetBytes(machine).CopyTo(b, 0x84);
        return b;
    }

    [Fact]
    public void Riktig_libmpv_rapporterar_sin_version()
    {
        var env = Environment.GetEnvironmentVariable("BRAXHN_LIBMPV");
        var path = new[] { env, "/lib/x86_64-linux-gnu/libmpv.so.2", "/usr/lib/x86_64-linux-gnu/libmpv.so.2", "/opt/homebrew/lib/libmpv.dylib" }
            .FirstOrDefault(p => !string.IsNullOrEmpty(p) && File.Exists(p));
        if (path == null) return;
        var lib = Libmpv.Probe(path, out var a);
        Assert.NotNull(lib);
        Assert.Equal(Libmpv.Outcome.Loaded, a.Outcome);
        Assert.StartsWith("mpv ", lib!.MpvVersion());
    }
}

public class LoggTest
{
    [Fact]
    public void Loggen_halls_liten_och_borjar_alltid_pa_en_hel_rad()
    {
        var dir = Directory.CreateTempSubdirectory("bxtv-logg-").FullName;
        var old = Logg.FilePath;
        try
        {
            Logg.FilePath = Path.Combine(dir, "logg.txt");
            for (var i = 0; i < 6000; i++) Logg.Write($"rad {i} " + new string('x', 60));
            var len = new FileInfo(Logg.FilePath).Length;
            Assert.True(len <= Logg.Max, $"{len} byte");
            var text = File.ReadAllText(Logg.FilePath);
            Assert.Matches(@"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d rad \d+ ", text);
            Assert.EndsWith("rad 5999 " + new string('x', 60) + "\n", text);
            Logg.Write("två\nrader");
            Assert.EndsWith("två rader\n", Logg.Tail(100));
            Assert.True(Logg.Tail(500).Length <= 500);
        }
        finally { Logg.FilePath = old; Directory.Delete(dir, true); }
    }
}

/// <summary>"Webbspelaren används eftersom …" – orsaken från webben (native-skip) eller appen</summary>
public class NativeSkipTest
{
    [Fact]
    public void Omkodning_utanfor_hemmet_med_serverns_skal_och_matningen()
    {
        var s = NativeSkip.Describe("mode:transcode", "transcode", ["sänkt kvalitet till 1080p", "bilden kodas som HEVC (libx265)"], true, 8400, sv: true);
        Assert.StartsWith("servern valde omkodning (sänkt kvalitet till 1080p, bilden kodas som HEVC", s);
        Assert.Contains("utanför hemmet", s);
        Assert.Contains("8,4 Mbit/s", s.Replace('.', ','));
        Assert.Equal("the server chose to convert the video – away from home", NativeSkip.Describe("mode:transcode", "transcode", [], true, 0, sv: false));
        Assert.StartsWith("servern packar om", NativeSkip.Describe("mode:remux", "remux", [], false, 0, sv: true));
    }

    [Theory]
    [InlineData("familjefilter", "familjefiltret")]
    [InlineData("trailers", "trailers")]
    [InlineData("off", "avstängd")]
    [InlineData("mpv", "mpv kunde inte laddas")]
    [InlineData("token saknas", "servern svarade inte som väntat")]
    [InlineData("", "servern svarade inte som väntat")]
    public void Ovriga_orsaker(string why, string contains) => Assert.Contains(contains, NativeSkip.Describe(why, "", [], false, 0, sv: true));
}
