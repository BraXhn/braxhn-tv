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
        { "name": "BraXhnTV-Setup-1.5.0.exe", "browser_download_url": "https://github.com/BraXhn/braxhn-tv/releases/download/v1.5.0/BraXhnTV-Setup-1.5.0.exe" } ] }
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
        Assert.Null(Versions.FromGitHub("""{ "tag_name": "v1.5.0", "assets": [] }"""));
        Assert.Null(Versions.FromGitHub(Release.Replace("\"prerelease\": false", "\"prerelease\": true")));
        // Filen måste komma från GitHub
        Assert.Null(Versions.FromGitHub(Release.Replace("https://github.com/BraXhn/braxhn-tv/releases/download/v1.5.0/BraXhnTV", "https://example.com/BraXhnTV")));
    }
}
