using BraXhnTV;
using Xunit;

public class AdressTest
{
    [Theory]
    [InlineData("tv.braxhn.net", "https://tv.braxhn.net")]
    [InlineData("  tv.braxhn.net/  ", "https://tv.braxhn.net")]
    [InlineData("https://TV.braxhn.net/", "https://tv.braxhn.net")]
    [InlineData("192.168.1.10", "http://192.168.1.10:8420")]
    [InlineData("192.168.1.10:9000", "http://192.168.1.10:9000")]
    [InlineData("nas", "http://nas:8420")]
    [InlineData("nas.local", "http://nas.local:8420")]
    [InlineData("server.lan/tv", "http://server.lan:8420/tv")]
    [InlineData("http://192.168.1.10:8420", "http://192.168.1.10:8420")]
    [InlineData("https://tv.braxhn.net:443", "https://tv.braxhn.net")]
    [InlineData("", "")]
    [InlineData("tv braxhn", "")]
    [InlineData("ftp://tv.braxhn.net", "")]
    public void Normaliserar_som_Expo_appen(string input, string expected) => Assert.Equal(expected, Address.Normalize(input));

    [Fact]
    public void Namnet_utan_protokoll_och_standardport()
    {
        Assert.Equal("tv.braxhn.net", Address.Label("https://tv.braxhn.net"));
        Assert.Equal("192.168.1.10", Address.Label("http://192.168.1.10:8420"));
    }

    [Fact]
    public void Samma_ursprung()
    {
        Assert.True(Address.SameOrigin("https://tv.braxhn.net/#/item/4", "https://tv.braxhn.net"));
        Assert.False(Address.SameOrigin("https://www.imdb.com/title/tt1", "https://tv.braxhn.net"));
        Assert.False(Address.SameOrigin("http://tv.braxhn.net/", "https://tv.braxhn.net"));
        Assert.False(Address.SameOrigin("http://192.168.1.10:8421/", "http://192.168.1.10:8420"));
    }

    [Fact]
    public void Bara_webb_och_epost_oppnas_utanfor_appen()
    {
        Assert.True(Address.External("https://www.themoviedb.org/movie/1"));
        Assert.True(Address.External("mailto:a@b.se"));
        Assert.False(Address.External("file:///C:/Windows/System32/cmd.exe"));
        Assert.False(Address.External("ms-settings:"));
    }
}

public class VersionTest
{
    [Theory]
    [InlineData("1.4.0", "1.4.1", -1)]
    [InlineData("1.10.0", "1.9.9", 1)]
    [InlineData("v1.4.0", "1.4.0", 0)]
    [InlineData("1.5.0-beta.3", "1.5.0", -1)]
    [InlineData("1.5.0-beta.10", "1.5.0-beta.9", 1)]
    [InlineData("1.5.0-beta.3", "1.4.9", 1)]
    [InlineData("1.4.0+abc", "1.4.0", 0)]
    public void Jamfor(string a, string b, int sign) => Assert.Equal(sign, Math.Sign(Versions.Compare(a, b)));

    const string Release = """
    { "tag_name": "v1.5.0", "html_url": "https://github.com/BraXhn/braxhn-tv/releases/tag/v1.5.0", "draft": false, "prerelease": false,
      "assets": [
        { "name": "notes.txt", "browser_download_url": "https://github.com/BraXhn/braxhn-tv/releases/download/v1.5.0/notes.txt" },
        { "name": "BraXhnTV-Setup-1.5.0.exe", "size": 5000000, "browser_download_url": "https://github.com/BraXhn/braxhn-tv/releases/download/v1.5.0/BraXhnTV-Setup-1.5.0.exe" } ] }
    """;

    [Fact]
    public void Hittar_installationsfilen()
    {
        var r = Versions.FromGitHub(Release)!;
        Assert.Equal("1.5.0", r.Version);
        Assert.Equal("BraXhnTV-Setup-1.5.0.exe", r.SetupName);
        Assert.EndsWith("/BraXhnTV-Setup-1.5.0.exe", r.SetupUrl);
    }

    [Fact]
    public void Utan_windowsfil_ingen_uppdatering()
    {
        Assert.False(Versions.FromGitHub("""{ "tag_name": "v1.5.0", "assets": [] }""")!.HasSetup);
        Assert.Null(Versions.FromGitHub(Release.Replace("\"prerelease\": false", "\"prerelease\": true")));
        // Filen måste komma från GitHub
        Assert.False(Versions.FromGitHub(Release.Replace("https://github.com/BraXhn/braxhn-tv/releases/download/v1.5.0/BraXhnTV", "https://example.com/BraXhnTV"))!.HasSetup);
    }
}

public class FrekvensTest
{
    static readonly int[] Tv = [23, 24, 25, 29, 30, 50, 59, 60];

    [Theory]
    [InlineData(23.976, 60, 23)]
    [InlineData(24.0, 60, 24)]
    [InlineData(25.0, 60, 25)]
    [InlineData(29.97, 60, 29)]
    [InlineData(50.0, 60, 50)]
    [InlineData(59.94, 60, 59)]
    [InlineData(23.976, 23, null)]
    public void Tv_med_alla_lagen(double fps, int current, int? expected) => Assert.Equal(expected, RefreshRate.Pick(fps, current, Tv));

    [Fact]
    public void Datorskarm_utan_24_hz()
    {
        // 120 Hz är redan en multipel av 24: inget byte
        Assert.Null(RefreshRate.Pick(24.0, 120, [60, 120]));
        // 23,976 utan 23-läge: 24 är närmast
        Assert.Equal(24, RefreshRate.Pick(23.976, 60, [24, 60]));
        // 25 bilder/s på en skärm med bara 60: inget passar
        Assert.Null(RefreshRate.Pick(25.0, 60, [60]));
        Assert.Equal(50, RefreshRate.Pick(25.0, 60, [50, 60]));
        Assert.Null(RefreshRate.Pick(0, 60, Tv));
        Assert.Null(RefreshRate.Pick(double.NaN, 60, Tv));
    }
}
