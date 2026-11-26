using System.Drawing;
using BraXhnTV;
using Xunit;

/// <summary>
/// Spelarraden i den inbyggda spelaren (Logik/Spelarrad.cs): när musen får visa raderna, tid kvar och sluttid,
/// titeln överst, hoppa över intro, nästa avsnitt-nedräkningen, förhandsbilderna och serverns svar.
/// </summary>
public class SpelarradTest
{
    // Spelarens yta på skärmen: fönstret står på x 100–1380, y 50–770
    static readonly Rectangle Yta = new(100, 50, 1280, 720);

    [Fact]
    public void Musen_utanfor_fonstret_visar_inget()
    {
        // Felet i 1.4.2: varje ändring av Cursor.Position räknades, var musen än var på skärmen
        Assert.False(Spelarrad.MouseWakes(Yta, new Point(1600, 400), appActive: true, cursorOverApp: false, new Size(40, 0)));
        Assert.False(Spelarrad.MouseWakes(Yta, new Point(50, 400), appActive: true, cursorOverApp: false, new Size(-30, 12)));
        Assert.False(Spelarrad.MouseWakes(Yta, new Point(700, 20), appActive: false, cursorOverApp: false, new Size(0, 25)), "ovanför fönstret");
        // Kanten räknas som utanför (Rectangle.Contains: höger och nederkant ingår inte)
        Assert.False(Spelarrad.MouseWakes(Yta, new Point(1380, 400), true, true, new Size(20, 0)));
    }

    [Fact]
    public void Musen_over_bilden_visar_raderna()
    {
        Assert.True(Spelarrad.MouseWakes(Yta, new Point(700, 400), appActive: true, cursorOverApp: true, new Size(10, 0)));
        Assert.True(Spelarrad.MouseWakes(Yta, new Point(100, 50), true, true, new Size(0, -6)), "övre vänstra hörnet ingår");
        // Fönstret är inte aktivt men pekaren är över det (t.ex. filmen på en annan skärm): en tydlig rörelse räcker
        Assert.True(Spelarrad.MouseWakes(Yta, new Point(700, 400), appActive: false, cursorOverApp: true, new Size(12, 5)));
    }

    [Fact]
    public void Ett_annat_fonster_over_bilden_visar_inget()
    {
        // Pekaren är inom spelarens yta, men ett annat fönster (t.ex. ett som alltid ligger överst) ligger där
        Assert.False(Spelarrad.MouseWakes(Yta, new Point(700, 400), appActive: true, cursorOverApp: false, new Size(30, 30)));
        Assert.False(Spelarrad.MouseWakes(Yta, new Point(700, 400), appActive: false, cursorOverApp: false, new Size(30, 30)));
    }

    [Theory]
    [InlineData(0, 0, true, false)]      // Windows skickar musrörelse utan rörelse (fönster som visas under pekaren)
    [InlineData(1, 0, true, false)]
    [InlineData(2, 2, true, false)]      // √8 ≈ 2,8 bildpunkter
    [InlineData(3, 2, true, false)]      // √13 ≈ 3,6
    [InlineData(4, 0, true, true)]
    [InlineData(-3, 3, true, true)]      // √18 ≈ 4,2
    [InlineData(5, 0, false, false)]     // i bakgrunden krävs dubbelt så lång rörelse
    [InlineData(8, 0, false, true)]
    public void Sma_skakningar_raknas_inte(int dx, int dy, bool active, bool expected) =>
        Assert.Equal(expected, Spelarrad.MouseWakes(Yta, new Point(700, 400), active, cursorOverApp: true, new Size(dx, dy)));

    [Fact]
    public void Skakningsgransen_foljer_skarmens_skala()
    {
        // 200 % (4K-tv): gränsen är 8 bildpunkter
        Assert.False(Spelarrad.MouseWakes(Yta, new Point(700, 400), true, true, new Size(6, 0), Spelarrad.JitterFor(2.0)));
        Assert.True(Spelarrad.MouseWakes(Yta, new Point(700, 400), true, true, new Size(8, 0), Spelarrad.JitterFor(2.0)));
        Assert.Equal(4, Spelarrad.JitterFor(1.0));
        Assert.Equal(6, Spelarrad.JitterFor(1.5));
        Assert.False(Spelarrad.MouseWakes(Rectangle.Empty, new Point(0, 0), true, true, new Size(50, 50)), "ingen yta");
    }

    [Theory]
    [InlineData(96, 1080, 1.0)]
    [InlineData(144, 1080, 1.5)]
    [InlineData(96, 2160, 2.0)]          // 4K-tv i helskärm med 100 %: lika stort som på en 1080p-tv
    [InlineData(192, 2160, 2.0)]
    [InlineData(96, 600, 1.0)]           // litet fönster: aldrig mindre än 100 %
    [InlineData(288, 2160, 3.0)]
    [InlineData(96, 4320, 2.0)]          // högst 200 % av fönstrets storlek
    public void Skalan_foljer_DPI_och_storleken(int dpi, int height, double expected) => Assert.Equal(expected, Spelarrad.Scale(dpi, height), 3);

    [Theory]
    [InlineData(754, 2530, "−29:36")]
    [InlineData(0, 3723, "−1:02:03")]
    [InlineData(3000, 2530, "−0:00")]
    [InlineData(10, 0, "")]
    public void Tid_kvar(double pos, double dur, string expected) => Assert.Equal(expected, Spelarrad.Remaining(pos, dur));

    [Fact]
    public void Sluttid()
    {
        var now = new DateTime(2026, 11, 26, 21, 50, 10);
        Assert.Equal("slutar 22:41", Spelarrad.EndsAt(754, 3800, 1, now, sv: true));     // 50:46 kvar
        Assert.Equal("ends 10:41 PM", Spelarrad.EndsAt(754, 3800, 1, now, sv: false));
        // Hastigheten räknas in: 2× halverar tiden kvar
        Assert.Equal("slutar 22:16", Spelarrad.EndsAt(754, 3800, 2, now, sv: true));
        // Över midnatt
        Assert.Equal("slutar 00:10", Spelarrad.EndsAt(0, 8400, 1, new DateTime(2026, 11, 26, 21, 50, 0), sv: true));
        Assert.Equal("", Spelarrad.EndsAt(5, 0, 1, now, true));
        Assert.Equal("slutar 21:50", Spelarrad.EndsAt(99, 50, 1, now, true));
    }

    [Theory]
    [InlineData("Breaking Bad · S01E03 · …And the Bag's in the River", "Breaking Bad", "S1 · E3 · …And the Bag's in the River")]
    [InlineData("Bron · S02E10", "Bron", "S2 · E10")]
    [InlineData("Arrival · 2016", "Arrival", "2016")]
    [InlineData("Hemvideo", "Hemvideo", "")]
    [InlineData("", "", "")]
    [InlineData("Serie · S00E01 · Special", "Serie", "S0 · E1 · Special")]
    public void Titeln_overst(string title, string main, string sub)
    {
        var (m, s) = Spelarrad.SplitTitle(title);
        Assert.Equal(main, m);
        Assert.Equal(sub, s);
    }

    static readonly Spelarrad.Extras Avsnitt = new(Intro: new(30, 95), Recap: new(0, 28), Credits: 2400, Trickplay: true);

    [Theory]
    [InlineData(-1, Spelarrad.SkipKind.None)]
    [InlineData(0, Spelarrad.SkipKind.Recap)]
    [InlineData(26.9, Spelarrad.SkipKind.Recap)]
    [InlineData(27, Spelarrad.SkipKind.None)]          // sista sekunden: ingen knapp (som webbspelaren)
    [InlineData(29.9, Spelarrad.SkipKind.None)]
    [InlineData(30, Spelarrad.SkipKind.Intro)]
    [InlineData(93.9, Spelarrad.SkipKind.Intro)]
    [InlineData(94, Spelarrad.SkipKind.None)]
    [InlineData(2450, Spelarrad.SkipKind.None)]        // eftertexterna: kortet med nästa avsnitt i stället
    public void Hoppa_over_intro_och_sammanfattning(double pos, Spelarrad.SkipKind expected) => Assert.Equal(expected, Spelarrad.SkipAt(Avsnitt, pos).Kind);

    [Fact]
    public void Hoppa_over_till_slutet_av_introt()
    {
        Assert.Equal(95, Spelarrad.SkipAt(Avsnitt, 40).To);
        Assert.Equal(28, Spelarrad.SkipAt(Avsnitt, 5).To);
        // Överlappar de går sammanfattningen före
        var both = new Spelarrad.Extras(new(10, 60), new(0, 30), null, false);
        Assert.Equal(Spelarrad.SkipKind.Recap, Spelarrad.SkipAt(both, 15).Kind);
        Assert.Equal(Spelarrad.SkipKind.None, Spelarrad.SkipAt(Spelarrad.Extras.None, 15).Kind);
        Assert.Equal(Spelarrad.SkipKind.None, Spelarrad.SkipAt(Avsnitt, double.NaN).Kind);
    }

    [Fact]
    public void Nasta_avsnitt_nar_eftertexterna_borjar()
    {
        // Eftertexter vid 2400 s av 2530, nedräkning 8 s, automatiskt nästa avsnitt på
        Assert.False(Spelarrad.NextUpAt(2399, 2530, 2400, hasNext: true, autoNext: true, countdown: 8, dismissed: false).Show);
        var n = Spelarrad.NextUpAt(2400, 2530, 2400, true, true, 8, false);
        Assert.True(n.Show); Assert.True(n.Auto); Assert.Equal(8, n.SecondsLeft); Assert.False(n.PlayNow);
        Assert.Equal(3, Spelarrad.NextUpAt(2405.2, 2530, 2400, true, true, 8, false).SecondsLeft);
        var now = Spelarrad.NextUpAt(2408, 2530, 2400, true, true, 8, false);
        Assert.True(now.PlayNow); Assert.Equal(0, now.SecondsLeft);
        // Avbryt: inget kort och inget byte
        Assert.False(Spelarrad.NextUpAt(2405, 2530, 2400, true, true, 8, dismissed: true).Show);
        // Inget nästa avsnitt (film)
        Assert.False(Spelarrad.NextUpAt(2450, 2530, 2400, hasNext: false, true, 8, false).Show);
    }

    [Fact]
    public void Nasta_avsnitt_utan_automatik_raknar_inte_ner()
    {
        var n = Spelarrad.NextUpAt(2450, 2530, 2400, hasNext: true, autoNext: false, countdown: 8, dismissed: false);
        Assert.True(n.Show); Assert.False(n.Auto); Assert.False(n.PlayNow); Assert.Equal(-1, n.SecondsLeft);
    }

    [Fact]
    public void Nasta_avsnitt_utan_eftertexter_de_sista_30_sekunderna()
    {
        Assert.False(Spelarrad.NextUpAt(2499, 2530, null, true, true, 8, false).Show);
        var n = Spelarrad.NextUpAt(2500, 2530, null, true, true, 8, false);
        Assert.True(n.Show); Assert.Equal(30, n.SecondsLeft);
        // Utan eftertexter byter appen inte själv: filmen tar slut och webben startar nästa avsnitt (som förut)
        Assert.False(Spelarrad.NextUpAt(2529.5, 2530, null, true, true, 8, false).PlayNow);
        Assert.Equal(1, Spelarrad.NextUpAt(2529.5, 2530, null, true, true, 8, false).SecondsLeft);
        // Eftertexter som börjar för sent (eller efter slutet) räknas inte – då gäller de sista 30 s
        Assert.True(Spelarrad.NextUpAt(2510, 2530, 2600, true, true, 8, false).Show);
        // Nedräkningen slutar senast när filmen tar slut
        Assert.Equal(4, Spelarrad.NextUpAt(2526, 2530, 2520, true, true, 20, false).SecondsLeft);
        // Okänd längd: inget kort
        Assert.False(Spelarrad.NextUpAt(100, 0, null, true, true, 8, false).Show);
    }

    [Fact]
    public void Nedrakningen_0_sekunder_byter_direkt()
    {
        Assert.True(Spelarrad.NextUpAt(2400, 2530, 2400, true, true, 0, false).PlayNow);
    }

    [Fact]
    public void Forhandsbilderna_ur_sprite_arken()
    {
        var tp = new Spelarrad.Trick(Interval: 10, W: 240, H: 136, Cols: 10, Rows: 10, Count: 253, First: 1);
        Assert.Equal((1, 0, 0), Spelarrad.TrickTile(tp, 0));
        Assert.Equal((1, 240, 0), Spelarrad.TrickTile(tp, 19.9));
        Assert.Equal((1, 2160, 136), Spelarrad.TrickTile(tp, 195));      // bild 19: rad 1, kolumn 9
        Assert.Equal((2, 0, 0), Spelarrad.TrickTile(tp, 1000));          // bild 100: nästa ark
        Assert.Equal((3, 480, 680), Spelarrad.TrickTile(tp, 99999));     // efter slutet: sista bilden (252)
        Assert.Equal((1, 0, 0), Spelarrad.TrickTile(tp, -5));
    }

    [Fact]
    public void Serverns_svar_for_titeln()
    {
        var e = Spelarrad.ExtrasFromItem("""{"id":7,"kind":"episode","intro":{"start":31.5,"end":92},"credits":2400.25,"recap":null,"trickplay":true}""");
        Assert.Equal(new Spelarrad.Span(31.5, 92), e.Intro);
        Assert.Null(e.Recap);
        Assert.Equal(2400.25, e.Credits);
        Assert.True(e.Trickplay);
        var none = Spelarrad.ExtrasFromItem("""{"id":8,"kind":"movie","intro":null,"credits":null}""");
        Assert.Equal(Spelarrad.Extras.None, none);
        Assert.Equal(Spelarrad.Extras.None, Spelarrad.ExtrasFromItem("inte json"));
        Assert.Equal(Spelarrad.Extras.None, Spelarrad.ExtrasFromItem("""{"intro":{"start":50,"end":20}}"""));
    }

    [Fact]
    public void Kontots_val_for_nasta_avsnitt_och_overhoppning()
    {
        var p = Spelarrad.PrefsFrom("""{"skipIntro":true,"skipRecap":false,"skipCredits":true,"autoNext":false,"nextCountdown":15}""");
        Assert.True(p.SkipIntro); Assert.False(p.SkipRecap); Assert.False(p.AutoNext); Assert.Equal(15, p.Countdown);
        var d = Spelarrad.PrefsFrom("{}");
        Assert.False(d.SkipIntro); Assert.True(d.AutoNext); Assert.Equal(8, d.Countdown);
        Assert.Equal(60, Spelarrad.PrefsFrom("""{"nextCountdown":600}""").Countdown);
        Assert.Equal(0, Spelarrad.PrefsFrom("""{"nextCountdown":-3}""").Countdown);
        Assert.Equal(8, Spelarrad.PrefsFrom("trasigt").Countdown);
    }

    [Fact]
    public void Nasta_avsnittets_namn()
    {
        Assert.Equal("S1 · E4 · Cancer Man", Spelarrad.NextTitle("""{"kind":"episode","season":1,"episode":4,"title":"Cancer Man","showTitle":"Breaking Bad"}"""));
        Assert.Equal("S2 · E1", Spelarrad.NextTitle("""{"kind":"episode","season":2,"episode":1,"title":""}"""));
        Assert.Equal("", Spelarrad.NextTitle("{"));
    }

    [Fact]
    public void Forhandsbildernas_beskrivning()
    {
        var t = Spelarrad.TrickFrom("""{"interval":10,"w":240,"h":100,"cols":10,"rows":10,"count":42,"sheets":1,"first":1}""");
        Assert.Equal(new Spelarrad.Trick(10, 240, 100, 10, 10, 42, 1), t);
        Assert.Null(Spelarrad.TrickFrom("""{"interval":0,"w":240,"h":100,"cols":10,"rows":10,"count":42}"""));
        Assert.Null(Spelarrad.TrickFrom("x"));
        Assert.Equal(1, Spelarrad.TrickFrom("""{"interval":10,"w":240,"h":100,"cols":10,"rows":10,"count":4}""")!.First);
    }
}
