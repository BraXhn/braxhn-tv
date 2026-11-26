using System.Globalization;
using BraXhnTV;
using Xunit;

/// <summary>Den inbyggda spelarens kontrollrad: tidsformat, klick på tidslinjen, tangentkartan och när raderna syns</summary>
public class PlayerUiTest
{
    [Theory]
    [InlineData(0, "0:00")]
    [InlineData(5.9, "0:05")]
    [InlineData(65, "1:05")]
    [InlineData(754.8, "12:34")]
    [InlineData(3599, "59:59")]
    [InlineData(3723, "1:02:03")]
    [InlineData(-4, "0:00")]
    [InlineData(double.NaN, "0:00")]
    public void Tidsformat_som_webbspelaren(double s, string expected) => Assert.Equal(expected, PlayerUi.TimeText(s));

    [Fact]
    public void Tid_och_langd()
    {
        Assert.Equal("12:34 / 42:10", PlayerUi.TimePair(754, 2530));
        Assert.Equal("42:10 / 42:10", PlayerUi.TimePair(2600, 2530));
        Assert.Equal("0:07", PlayerUi.TimePair(7, 0));
    }

    [Theory]
    [InlineData(18, 0)]          // början av linjen
    [InlineData(10, 0)]          // till vänster om linjen
    [InlineData(518, 1000)]      // mitten: hälften av 2000 s
    [InlineData(1018, 2000)]     // slutet
    [InlineData(1500, 2000)]     // till höger om linjen
    [InlineData(268, 500)]
    public void Klick_pa_tidslinjen_ger_positionen(int x, double expected) => Assert.Equal(expected, PlayerUi.SeekPosition(x, 18, 1000, 2000), 3);

    [Fact]
    public void Tidslinjen_utan_langd_och_tillbaka_till_bildpunkter()
    {
        Assert.Equal(0, PlayerUi.SeekPosition(500, 18, 1000, 0));
        Assert.Equal(0, PlayerUi.SeekPosition(500, 18, 0, 100));
        Assert.Equal(518, PlayerUi.PositionX(1000, 18, 1000, 2000));
        Assert.Equal(1018, PlayerUi.PositionX(9999, 18, 1000, 2000));
        Assert.Equal(18, PlayerUi.PositionX(5, 18, 1000, 0));
        // Fram och tillbaka blir samma punkt
        for (var x = 18; x <= 1018; x += 37) Assert.Equal(x, PlayerUi.PositionX(PlayerUi.SeekPosition(x, 18, 1000, 2530), 18, 1000, 2530));
    }

    [Theory]
    [InlineData(0x20, PlayerAction.TogglePause)]
    [InlineData('K', PlayerAction.TogglePause)]
    [InlineData(0xB3, PlayerAction.TogglePause)]    // medietangenten spela/paus
    [InlineData(0x25, PlayerAction.Back10)]
    [InlineData('J', PlayerAction.Back10)]
    [InlineData(0x27, PlayerAction.Forward10)]
    [InlineData('L', PlayerAction.Forward10)]
    [InlineData(0x26, PlayerAction.VolumeUp)]
    [InlineData(0x28, PlayerAction.VolumeDown)]
    [InlineData('F', PlayerAction.Fullscreen)]
    [InlineData(0x7A, PlayerAction.Fullscreen)]     // F11
    [InlineData(0x1B, PlayerAction.Escape)]
    [InlineData('Q', PlayerAction.Close)]
    [InlineData('M', PlayerAction.Mute)]
    [InlineData('N', PlayerAction.Next)]
    [InlineData(0xB0, PlayerAction.Next)]           // medietangenten nästa
    [InlineData('S', PlayerAction.ToggleSubs)]
    [InlineData('A', PlayerAction.CycleAudio)]
    [InlineData('I', PlayerAction.Stats)]
    [InlineData(0xB2, PlayerAction.Stop)]
    [InlineData('X', PlayerAction.None)]
    [InlineData(0x0D, PlayerAction.None)]           // Enter
    public void Tangentkartan(int vk, PlayerAction expected) => Assert.Equal(expected, PlayerUi.ForKey(vk));

    [Fact]
    public void Ctrl_och_Alt_lamnas_at_Windows()
    {
        Assert.Equal(PlayerAction.None, PlayerUi.ForKey('F', ctrl: true));
        Assert.Equal(PlayerAction.None, PlayerUi.ForKey(0x73, alt: true)); // Alt+F4
        Assert.Equal(PlayerAction.Next, PlayerUi.ForKey('N', shift: true));
    }

    [Fact]
    public void Raderna_tonas_bort_efter_3_s_utan_mus()
    {
        Assert.True(PlayerUi.ShowBars(1, false, false, true, false));
        Assert.False(PlayerUi.ShowBars(3.2, false, false, true, false));
        Assert.True(PlayerUi.ShowBars(10, true, false, true, false), "musen över en rad");
        Assert.True(PlayerUi.ShowBars(10, false, true, true, false), "paus");
        Assert.True(PlayerUi.ShowBars(10, false, false, false, false), "före starten");
        Assert.True(PlayerUi.ShowBars(10, false, false, true, true), "en meny är öppen");
    }

    [Fact]
    public void Volym_och_spar()
    {
        Assert.Equal(100, PlayerUi.Volume(98, 5));
        Assert.Equal(0, PlayerUi.Volume(3, -5));
        Assert.Equal(55, PlayerUi.Volume(50, 5));
        Assert.Equal("Svenska – AC3 5.1", PlayerUi.TrackLabel(null, "swe", "ac3", 6, 2).Replace("Swedish", "Svenska"));
        Assert.Equal("Kommentar (engelska)", PlayerUi.TrackLabel("Kommentar", "eng", null, null, 3).Replace("English", "engelska"));
        Assert.Equal("#4", PlayerUi.TrackLabel(null, null, null, null, 4));
        Assert.Equal("svenska", PlayerUi.LangName("swe", sv: true));
        Assert.Equal("Swedish", PlayerUi.LangName("sv", sv: false));
        Assert.Equal("tlh", PlayerUi.LangName("tlh", sv: true));
        Assert.Equal("1,25×", PlayerUi.Factor(1.25, CultureInfo.GetCultureInfo("sv-SE")));
        Assert.Contains(-1, PlayerUi.SleepMinutes);
    }
}
