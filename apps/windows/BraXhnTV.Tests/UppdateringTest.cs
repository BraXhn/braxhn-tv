using System.Security.Cryptography;
using BraXhnTV;
using Xunit;

/// <summary>Sök efter uppdatering, Hämta och installera (ärende #5): versioner, utgåvans filer, kontrollen och installationen</summary>
public class UppdateringTest
{
    [Theory]
    [InlineData("1.4.2", "1.4.10", -1)]
    [InlineData("1.4.10", "1.4.9", 1)]
    [InlineData("v1.4.2", "1.4.2", 0)]
    [InlineData("V1.4.3", "v1.4.2", 1)]
    [InlineData("1.4.2-beta.1", "1.4.2", -1)]
    [InlineData("1.4.2", "1.4.2-beta.7", 1)]
    [InlineData("1.4.2-beta.2", "1.4.2-beta.10", -1)]
    [InlineData("1.4.2-beta", "1.4.2-beta.1", -1)]
    public void Versionsjamforelse(string a, string b, int sign) => Assert.Equal(sign, Math.Sign(Versions.Compare(a, b)));

    static string Json(string tag = "v1.4.10", bool prerelease = false, string assets = "") => $$"""
    { "tag_name": "{{tag}}", "html_url": "https://github.com/BraXhn/braxhn-tv/releases/tag/{{tag}}", "draft": false, "prerelease": {{(prerelease ? "true" : "false")}},
      "assets": [ {{assets}} ] }
    """;

    static string Asset(string name, long size = 1234, string? url = null) =>
        $$"""{ "name": "{{name}}", "size": {{size}}, "browser_download_url": "{{url ?? "https://github.com/BraXhn/braxhn-tv/releases/download/v1.4.10/" + name}}" }""";

    [Fact]
    public void Valjer_installationsfilen_for_utgavans_version()
    {
        var json = Json(assets: string.Join(",",
            Asset("BraXhnTV-Setup-1.4.9.exe", 1),                 // en gammal fil som ligger kvar i utgåvan
            Asset("braxhn-tv-1.4.10.tar.gz", 2),
            Asset("BraXhnTV-Setup-1.4.10.exe", 98765432),
            Asset("BraXhnTV-Setup-1.4.10.exe.sha256", 90)));
        var r = Versions.FromGitHub(json)!;
        Assert.Equal("1.4.10", r.Version);
        Assert.Equal("BraXhnTV-Setup-1.4.10.exe", r.SetupName);
        Assert.Equal("https://github.com/BraXhn/braxhn-tv/releases/download/v1.4.10/BraXhnTV-Setup-1.4.10.exe", r.SetupUrl);
        Assert.Equal(98765432, r.SetupSize);
        Assert.Equal("https://github.com/BraXhn/braxhn-tv/releases/download/v1.4.10/BraXhnTV-Setup-1.4.10.exe.sha256", r.ShaUrl);
        Assert.True(r.HasSetup);
    }

    [Fact]
    public void Utan_sha_fil_ingen_sha_adress()
    {
        var r = Versions.FromGitHub(Json(assets: Asset("BraXhnTV-Setup-1.4.10.exe")))!;
        Assert.True(r.HasSetup);
        Assert.Null(r.ShaUrl);
    }

    [Fact]
    public void Ny_version_utan_windowsfil_an()
    {
        // Utgåvan finns men installationsfilen byggs fortfarande: versionen syns, men inget att installera
        var r = Versions.FromGitHub(Json(assets: Asset("BraXhnTV-Setup-1.4.9.exe")))!;
        Assert.Equal("1.4.10", r.Version);
        Assert.False(r.HasSetup);
        Assert.False(Versions.FromGitHub(Json(assets: Asset("BraXhnTV-Setup-1.4.10.exe", size: 0)))!.HasSetup);
        Assert.False(Versions.FromGitHub(Json(assets: Asset("BraXhnTV-Setup-1.4.10.exe", url: "https://example.com/BraXhnTV-Setup-1.4.10.exe")))!.HasSetup);
        Assert.False(Versions.FromGitHub(Json(assets: Asset("BraXhnTV-Setup-1.4.10.exe", url: "http://github.com/BraXhn/braxhn-tv/releases/download/v1.4.10/BraXhnTV-Setup-1.4.10.exe")))!.HasSetup);
    }

    [Theory]
    [InlineData("libmpv-0.42.0-20261126", false)]
    [InlineData("v1.5.0-beta.3", false)]
    [InlineData("1.4.10", false)]
    [InlineData("v1.4", false)]
    [InlineData("v1.4.10.1", false)]
    [InlineData("v1.4.10", true)]
    public void Bara_taggar_v_semver_utan_forhandsversion(string tag, bool ok)
    {
        var json = Json(tag, assets: Asset($"BraXhnTV-Setup-{tag.TrimStart('v')}.exe"));
        Assert.Equal(ok, Versions.FromGitHub(json) != null);
    }

    [Fact]
    public void Forhandsutgava_och_utkast_erbjuds_aldrig()
    {
        Assert.Null(Versions.FromGitHub(Json(prerelease: true, assets: Asset("BraXhnTV-Setup-1.4.10.exe"))));
        Assert.Null(Versions.FromGitHub(Json(assets: Asset("BraXhnTV-Setup-1.4.10.exe")).Replace("\"draft\": false", "\"draft\": true")));
        Assert.Null(Versions.FromGitHub("[]"));
    }

    [Theory]
    [InlineData("3f786850e387550fdab836ed7e6dc881de23001b3f786850e387550fdab836ed  BraXhnTV-Setup-1.4.10.exe\n", "3f786850e387550fdab836ed7e6dc881de23001b3f786850e387550fdab836ed")]
    [InlineData("3F786850E387550FDAB836ED7E6DC881DE23001B3F786850E387550FDAB836ED *BraXhnTV-Setup-1.4.10.exe", "3f786850e387550fdab836ed7e6dc881de23001b3f786850e387550fdab836ed")]
    [InlineData("\uFEFF3f786850e387550fdab836ed7e6dc881de23001b3f786850e387550fdab836ed\r\n", "3f786850e387550fdab836ed7e6dc881de23001b3f786850e387550fdab836ed")]
    [InlineData("3f786850e387550fdab836ed7e6dc881de23001b3f786850e387550fdab836ed  BraXhnTV-Setup-1.4.9.exe", null)]
    [InlineData("inte en kontrollsumma", null)]
    [InlineData("", null)]
    public void Laser_sha_filen(string text, string? hex) => Assert.Equal(hex, Uppdatering.ParseSha(text, "BraXhnTV-Setup-1.4.10.exe"));

    static string FakeExe(int size = 4096)
    {
        // Ett minimalt PE-huvud: "MZ", pekaren på 0x3C och "PE\0\0" + maskin (x86, som Inno Setups installationsfil)
        var b = new byte[size];
        b[0] = (byte)'M'; b[1] = (byte)'Z';
        BitConverter.GetBytes(0x80).CopyTo(b, 0x3C);
        b[0x80] = (byte)'P'; b[0x81] = (byte)'E';
        BitConverter.GetBytes((ushort)0x014C).CopyTo(b, 0x84);
        var path = Path.Combine(Path.GetTempPath(), "braxhn-uppd-" + Guid.NewGuid().ToString("n") + ".exe");
        File.WriteAllBytes(path, b);
        return path;
    }

    [Fact]
    public void Kontrollerar_storlek_sha_och_exe()
    {
        var f = FakeExe();
        try
        {
            var sha = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(f))).ToLowerInvariant();
            Assert.Equal(FileProblem.None, Uppdatering.CheckFile(f, 4096, null));
            Assert.Equal(FileProblem.None, Uppdatering.CheckFile(f, 4096, sha));
            Assert.Equal(FileProblem.None, Uppdatering.CheckFile(f, 4096, sha.ToUpperInvariant()));
            Assert.Equal(FileProblem.Size, Uppdatering.CheckFile(f, 4097, sha));
            Assert.Equal(FileProblem.Sha, Uppdatering.CheckFile(f, 4096, new string('0', 64)));
            Assert.Equal(FileProblem.Missing, Uppdatering.CheckFile(f + ".finns-inte", 4096, null));
            // Rätt storlek men inte ett program (t.ex. en felsida från en proxy)
            File.WriteAllBytes(f, new byte[4096]);
            Assert.Equal(FileProblem.NotExe, Uppdatering.CheckFile(f, 4096, null));
        }
        finally { File.Delete(f); }
    }

    [Fact]
    public void Argument_till_installationsfilen()
    {
        var a = Uppdatering.InstallerArguments(@"C:\Users\Anna Berg\AppData\Local\BraXhnTV\installation.txt");
        Assert.Equal(@"/SILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /STARTAPP ""/LOG=C:\Users\Anna Berg\AppData\Local\BraXhnTV\installation.txt""", a);
        // Aldrig /VERYSILENT (då syns inget alls) och aldrig ett omstartsval för datorn
        Assert.DoesNotContain("VERYSILENT", a);
        Assert.Throws<ArgumentException>(() => Uppdatering.InstallerArguments("C:\\a\"b.txt"));
    }

    [Fact]
    public void Installationsfilen_startar_appen_efter_tyst_installation()
    {
        // BraXhnTV.iss: [Run]-posten för det vanliga läget hoppas över tyst, så det måste finnas en post för /STARTAPP
        var iss = File.ReadAllText(Path.Combine(Root(), "installer", "BraXhnTV.iss"));
        Assert.Matches(@"(?m)^Filename: ""\{app\}\\BraXhnTV\.exe"";.*Flags: nowait skipifnotsilent; Check: StartAfterUpdate\s*$", iss);
        Assert.Contains("'/STARTAPP'", iss);
    }

    static string Root()
    {
        var d = AppContext.BaseDirectory;
        while (d != null && !File.Exists(Path.Combine(d, "installer", "BraXhnTV.iss"))) d = Path.GetDirectoryName(d);
        return d ?? throw new InvalidOperationException("Hittar inte apps/windows");
    }
}
