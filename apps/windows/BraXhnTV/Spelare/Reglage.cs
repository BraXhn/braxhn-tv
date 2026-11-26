using System.Drawing.Drawing2D;

namespace BraXhnTV.Spelare;

/// <summary>Kortet med nästa avsnitt: titel, sekunder kvar (−1 = ingen nedräkning) och nedräkningens längd</summary>
sealed record NextCard(string Title, int SecondsLeft, int Total, bool Auto);

/// <summary>
/// Den inbyggda spelarens reglage, ritade som mjuka tonade gradienter över bilden (i stil med Plex spelare, i appens
/// egna färger): överst tillbakapil, titel och inställningar; nederst tidslinjen över hela bredden, tiden, knapparna
/// i mitten och ljud/undertexter, volym och helskärm till höger. I hörnet nere till höger "Hoppa över intro" eller
/// kortet med nästa avsnitt, och i mitten en paus-ikon som tonar bort. Varje del är ett lagerfönster (LayerWindow)
/// över bilden; MainForm.Spelare.cs sätter värdena och tar emot klicken. Logiken (när raderna visas, tider, intro,
/// nedräkning) finns i Logik/Spelarrad.cs och Logik/PlayerUi.cs.
/// </summary>
sealed class PlayerChrome : IDisposable
{
    // Appens färger (som webbappen och menyerna)
    static readonly Color Text1 = Color.FromArgb(0xF2, 0xF2, 0xF2), Text2 = Color.FromArgb(0xC4, 0xC6, 0xCC),
        Accent = Color.FromArgb(0xE5, 0x4B, 0x4B), Card = Color.FromArgb(0xEB, 0x14, 0x15, 0x17), HoverBg = Color.FromArgb(0x40, 0xFF, 0xFF, 0xFF);
    static readonly string IconFamily = FontFamily.Families.Any(f => f.Name == "Segoe Fluent Icons") ? "Segoe Fluent Icons" : "Segoe MDL2 Assets";
    const string GlyphSettings = "", GlyphVolume = "", GlyphMute = "", GlyphFull = "", GlyphWindow = "", GlyphTimer = "", GlyphNext = "";

    // ---------- värden från spelaren ----------
    public string Title = "", Subtitle = "";
    public double Position, Duration, CachedUntil, Speed = 1;
    public bool Paused, Muted, HasNext, FullScreen, ShowEndTime;
    public int Volume = 100;
    public string SleepLabel = "";
    public IReadOnlyList<(double Start, string Title)> Chapters = [];
    /// <summary>"Hoppa över intro" (null = ingen knapp)</summary>
    public string? SkipText;
    public NextCard? Next;
    /// <summary>Förhandsbilden för en tidpunkt: arket och var i det (null = ingen, eller inte hämtad än)</summary>
    public Func<double, (Image Sheet, Rectangle Src)?>? Preview;

    // ---------- händelser ----------
    /// <summary>En knapp: back, settings, sleep, back10, toggle, fwd30, next, tracks, mute, fullscreen, timemode, skip, nextnow, nextcancel</summary>
    public event Action<string, Point>? Clicked;
    /// <summary>Tidslinjen: position i sekunder; final = musknappen släpptes</summary>
    public event Action<double, bool>? Seek;
    public event Action<int>? VolumeSet;
    /// <summary>Klick, dubbelklick, hjul och högerklick på raderna utanför knapparna – som på bilden</summary>
    public event Action? VideoClick, VideoDoubleClick, VideoRightClick;
    public event Action<int>? VideoWheel;
    /// <summary>Musen rörde sig över raderna (skärmpunkt)</summary>
    public event Action<Point>? Moved;

    readonly LayerWindow top = new(), bottom = new(), corner = new(), center = new(clickThrough: true);
    readonly Form owner;
    readonly ToolTip tip = new() { InitialDelay = 500, ShowAlways = true };
    readonly System.Windows.Forms.Timer fade = new() { Interval = 15 }, flashTimer = new() { Interval = 20 },
        clickTimer = new() { Interval = SystemInformation.DoubleClickTime }, soon = new() { Interval = 16 };
    Rectangle video;           // spelarens yta på skärmen
    double s = 1;              // skala (Spelarrad.Scale)
    bool shown, visible;
    double fadeLevel;          // 0–1
    DateTime fadeStart; double fadeFrom, fadeTo, fadeMs;
    DateTime flashStart; bool flashPaused;
    Fonts? fonts;

    sealed record Hit(string Id, Rectangle Rect, string Tip);
    List<Hit> topHits = new(), bottomHits = new(), cornerHits = new();
    Rectangle timeline, volumeBar;
    string? hoverTop, hoverBottom, hoverCorner;
    int hoverX = -1;
    bool draggingTime, draggingVolume, volumeOpen;
    double dragPos = -1;

    public PlayerChrome(Form owner)
    {
        this.owner = owner;
        Wire(top, () => topHits, h => hoverTop = h, () => hoverTop);
        Wire(bottom, () => bottomHits, h => hoverBottom = h, () => hoverBottom);
        Wire(corner, () => cornerHits, h => hoverCorner = h, () => hoverCorner);
        bottom.MouseDown += OnBottomDown;
        bottom.MouseMove += OnBottomDrag;
        bottom.MouseUp += OnBottomUp;
        fade.Tick += (_, _) => FadeStep();
        flashTimer.Tick += (_, _) => FlashStep();
        clickTimer.Tick += (_, _) => { clickTimer.Stop(); VideoClick?.Invoke(); };
        soon.Tick += (_, _) => { soon.Stop(); Render(); };
    }

    /// <summary>Ritar om inom en bildruta – musrörelser kommer tätare än det behövs</summary>
    void RenderSoon() { if (!soon.Enabled) soon.Start(); }

    /// <summary>True medan användaren drar i tidslinjen eller volymen</summary>
    public bool Dragging => draggingTime || draggingVolume;
    /// <summary>Musen är över en knapp eller tidslinjen (då ligger raderna kvar)</summary>
    public bool PointerOnControl => shown && (hoverTop != null || hoverBottom != null);
    public bool Shown => shown;

    // ---------- mus ----------
    void Wire(LayerWindow w, Func<List<Hit>> hits, Action<string?> setHover, Func<string?> getHover)
    {
        w.MouseMove += (_, e) =>
        {
            Moved?.Invoke(w.PointToScreen(e.Location));
            if (Dragging) return;
            if (w == bottom) hoverX = e.X;
            var h = HitAt(w, hits(), e.Location);
            if (h != getHover())
            {
                setHover(h);
                var hit = hits().FirstOrDefault(x => x.Id == h);
                // Överst visas förklaringen under knappen (ovanför är skärmens kant i helskärm), annars ovanför
                if (hit != null && hit.Tip.Length > 0) tip.Show(hit.Tip, w, hit.Rect.X, w == top ? hit.Rect.Bottom + S(6) : hit.Rect.Y - S(30), 2500); else tip.Hide(w);
                RenderSoon();
            }
            else if (w == bottom && h == "timeline") RenderSoon();
        };
        w.MouseLeave += (_, _) => { if (Dragging) return; setHover(null); tip.Hide(w); Render(); };
        w.MouseDown += (_, e) =>
        {
            if (e.Button == MouseButtons.Right) { VideoRightClick?.Invoke(); return; }
            if (e.Button != MouseButtons.Left || HitAt(w, hits(), e.Location) != null) return;
            // Utanför knapparna: som ett klick på bilden (ett enkelklick väntar på dubbelklicket)
            if (e.Clicks >= 2) { clickTimer.Stop(); VideoDoubleClick?.Invoke(); }
            else clickTimer.Start();
        };
        w.MouseUp += (_, e) =>
        {
            if (e.Button != MouseButtons.Left || w == bottom && Dragging) return;
            var id = HitAt(w, hits(), e.Location);
            if (id is null or "timeline" or "volume") return;
            var hit = hits().First(x => x.Id == id);
            Clicked?.Invoke(id, w.PointToScreen(new Point(hit.Rect.X, hit.Rect.Y)));
        };
        w.MouseWheel += (_, e) => VideoWheel?.Invoke(e.Delta);
    }

    string? HitAt(LayerWindow w, List<Hit> hits, Point p)
    {
        if (w == bottom)
        {
            if (Rectangle.Inflate(timeline, 0, (int)(10 * s)).Contains(p)) return "timeline";
            if (volumeOpen && Rectangle.Inflate(volumeBar, (int)(6 * s), (int)(12 * s)).Contains(p)) return "volume";
        }
        return hits.FirstOrDefault(h => h.Rect.Contains(p))?.Id;
    }

    void OnBottomDown(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        var h = HitAt(bottom, bottomHits, e.Location);
        if (h == "timeline" && Duration > 0)
        {
            draggingTime = true;
            bottom.Capture = true;
            dragPos = PlayerUi.SeekPosition(e.X, timeline.X, timeline.Width, Duration);
            Seek?.Invoke(dragPos, false);
            Render();
        }
        else if (h == "volume") { draggingVolume = true; bottom.Capture = true; SetVolumeAt(e.X); }
    }

    void OnBottomDrag(object? sender, MouseEventArgs e)
    {
        if (draggingTime) { dragPos = PlayerUi.SeekPosition(e.X, timeline.X, timeline.Width, Duration); hoverX = e.X; Seek?.Invoke(dragPos, false); RenderSoon(); }
        else if (draggingVolume) SetVolumeAt(e.X);
    }

    void OnBottomUp(object? sender, MouseEventArgs e)
    {
        if (draggingTime)
        {
            draggingTime = false;
            bottom.Capture = false;
            var at = PlayerUi.SeekPosition(e.X, timeline.X, timeline.Width, Duration);
            Seek?.Invoke(at, true);
            Position = at;
            dragPos = -1;
            hoverBottom = HitAt(bottom, bottomHits, e.Location);
            Render();
        }
        else if (draggingVolume) { draggingVolume = false; bottom.Capture = false; Render(); }
    }

    void SetVolumeAt(int x)
    {
        Volume = (int)Math.Round(Math.Clamp((x - volumeBar.X) / (double)Math.Max(1, volumeBar.Width), 0, 1) * 100);
        Muted = false;
        VolumeSet?.Invoke(Volume);
        Render();
    }

    // ---------- placering, visa och dölj ----------

    /// <summary>Spelarens yta på skärmen och skalan. Fönstren följer med (helskärm, flyttat fönster).</summary>
    public void Layout(Rectangle screenRect, double scale)
    {
        if (Math.Abs(scale - s) > 0.001 || fonts == null) { s = scale; fonts?.Dispose(); fonts = new Fonts(s); }
        video = screenRect;
        Render();
    }

    /// <summary>Raderna in (snabbt) eller ut (långsammare toning)</summary>
    public void SetShown(bool show)
    {
        if (show == shown && (fade.Enabled || fadeLevel == (show ? 1 : 0))) return;
        shown = show;
        if (!show) { volumeOpen = false; tip.Hide(top); tip.Hide(bottom); hoverTop = hoverBottom = null; }
        fadeFrom = fadeLevel; fadeTo = show ? 1 : 0; fadeMs = show ? 150 : 400; fadeStart = DateTime.UtcNow;
        if (show && visible) { EnsureShown(top); EnsureShown(bottom); }
        Render();
        fade.Start();
        FadeStep();
    }

    void FadeStep()
    {
        var t = fadeMs <= 0 ? 1 : Math.Clamp((DateTime.UtcNow - fadeStart).TotalMilliseconds / fadeMs, 0, 1);
        var eased = 1 - (1 - t) * (1 - t);
        fadeLevel = fadeFrom + (fadeTo - fadeFrom) * eased;
        var a = (byte)Math.Round(255 * fadeLevel);
        top.SetAlpha(a); bottom.SetAlpha(a);
        if (t >= 1)
        {
            fade.Stop();
            if (fadeLevel <= 0) { top.Hide(); bottom.Hide(); }
            Render(); // hörnet flyttas ner när raderna är borta
        }
    }

    /// <summary>Visar reglagen (när spelaren startar) eller döljer allt (när den stängs)</summary>
    public void SetVisible(bool on)
    {
        visible = on;
        if (!on)
        {
            fade.Stop(); flashTimer.Stop(); clickTimer.Stop(); soon.Stop();
            foreach (var w in new[] { top, bottom, corner, center }) { tip.Hide(w); if (!w.IsDisposed) w.Hide(); }
            draggingTime = draggingVolume = false;
            hoverTop = hoverBottom = hoverCorner = null;
            return;
        }
        shown = true; fadeLevel = 1;
        top.SetAlpha(255); bottom.SetAlpha(255);
        Render();
        EnsureShown(top); EnsureShown(bottom);
    }

    void EnsureShown(LayerWindow w)
    {
        if (w.IsDisposed || w.Visible || !visible) return;
        w.Show(owner);
        Raise();
    }

    /// <summary>
    /// Lägger reglagen överst (över muslagret) i rätt ordning. Bara när appen är aktiv: annars kunde de hamna över
    /// ett annat programs fönster.
    /// </summary>
    public void Raise()
    {
        if (Form.ActiveForm != owner) return;
        foreach (var w in new[] { top, bottom, corner, center }) if (w.Visible) w.Raise();
    }

    /// <summary>Stor paus- eller spela-ikon i mitten som tonar bort</summary>
    public void Flash(bool paused)
    {
        if (!visible || video.Width <= 0) return;
        flashPaused = paused;
        flashStart = DateTime.UtcNow;
        var d = (int)(112 * s);
        using (var g = center.Begin(new Size(d, d)))
        {
            using (var b = new SolidBrush(Color.FromArgb(0x99, 0, 0, 0))) g.FillEllipse(b, 0, 0, d - 1, d - 1);
            var r = new RectangleF(d * 0.3f, d * 0.3f, d * 0.4f, d * 0.4f);
            if (paused) PauseIcon(g, r, Text1); else PlayIcon(g, r, Text1);
        }
        center.SetAlpha(230);
        center.Present(new Point(video.X + (video.Width - d) / 2, video.Y + (video.Height - d) / 2));
        if (!center.Visible) { center.Show(owner); Raise(); }
        flashTimer.Start();
    }

    void FlashStep()
    {
        var ms = (DateTime.UtcNow - flashStart).TotalMilliseconds;
        // Syns en stund och tonar sedan bort (paus lite längre, så att läget märks)
        var hold = flashPaused ? 450 : 250; const double out1 = 450;
        if (ms < hold) return;
        var t = Math.Clamp((ms - hold) / out1, 0, 1);
        center.SetAlpha((byte)Math.Round(230 * (1 - t)));
        if (t >= 1) { flashTimer.Stop(); center.Hide(); }
    }

    // ---------- ritning ----------

    /// <summary>Ritar om det som syns (anropas när värdena ändrats, högst några gånger i sekunden)</summary>
    public void Render()
    {
        if (!visible || video.Width <= 0 || video.Height <= 0 || fonts == null) return;
        if (top.Visible || shown) RenderTop();
        if (bottom.Visible || shown) RenderBottom();
        RenderCorner();
    }

    int S(double v) => (int)Math.Round(v * s);

    void RenderTop()
    {
        var f = fonts!;
        var w = video.Width; var h = Math.Min(S(132), video.Height / 3);
        var hits = new List<Hit>();
        using (var g = top.Begin(new Size(w, h)))
        {
            // Mjuk tonad gradient uppifrån (ingen balk): mörkast längst upp, borta vid underkanten
            Gradient(g, new Rectangle(0, 0, w, h), top: true, 0.72f);
            var pad = S(22); var btn = S(48);
            var back = new Rectangle(pad - S(8), S(18), btn, btn);
            hits.Add(new Hit("back", back, L.T("Tillbaka (Q)", "Back (Q)")));
            HoverCircle(g, back, hoverTop == "back");
            BackArrow(g, back);
            // Höger: inställningar och sovtimern
            var x = w - pad - btn + S(8);
            var settings = new Rectangle(x, S(18), btn, btn);
            hits.Add(new Hit("settings", settings, L.T("Inställningar: undertextstorlek och -tid, hastighet, sovtimer", "Settings: subtitle size and timing, speed, sleep timer")));
            HoverCircle(g, settings, hoverTop == "settings");
            Glyph(g, GlyphSettings, f.Icon, settings, Text1);
            var right = settings.X - S(6);
            if (SleepLabel.Length > 0)
            {
                var tw = (int)Math.Ceiling(g.MeasureString(SleepLabel, f.Small).Width);
                var sleep = new Rectangle(right - tw - S(40), S(22), tw + S(40), S(40));
                hits.Add(new Hit("sleep", sleep, L.T("Sovtimer", "Sleep timer")));
                if (hoverTop == "sleep") using (var b = new SolidBrush(HoverBg)) using (var p = Round(sleep, sleep.Height / 2)) g.FillPath(b, p);
                Glyph(g, GlyphTimer, f.SmallIcon, new Rectangle(sleep.X + S(6), sleep.Y, S(28), sleep.Height), Accent);
                TextAt(g, SleepLabel, f.Small, new RectangleF(sleep.X + S(34), sleep.Y, tw + S(4), sleep.Height), Accent, StringAlignment.Near);
                right = sleep.X - S(6);
            }
            // Titeln: serien/filmen, och avsnittet under
            var tx = back.Right + S(10);
            var tw2 = Math.Max(0, right - tx - S(10));
            if (Subtitle.Length > 0)
            {
                TextAt(g, Title, f.Title, new RectangleF(tx, S(17), tw2, S(30)), Text1, StringAlignment.Near, shadow: true);
                TextAt(g, Subtitle, f.Sub, new RectangleF(tx, S(46), tw2, S(24)), Text2, StringAlignment.Near, shadow: true);
            }
            else TextAt(g, Title, f.Title, new RectangleF(tx, S(18), tw2, btn), Text1, StringAlignment.Near, shadow: true);
        }
        topHits = hits;
        top.Present(video.Location);
    }

    // Nederst, uppifrån: plats för förhandsbilden, tidslinjen, tiderna och knapparna
    int BottomContent => S(18 + 64 + 6 + 22 + 14);

    void RenderBottom()
    {
        var f = fonts!;
        var w = video.Width;
        var h = Math.Min(video.Height, BottomContent + S(190));
        var hits = new List<Hit>();
        var pad = S(32);
        var btnY = h - S(18) - S(64);
        var timesY = btnY - S(6) - S(22);
        var tlY = timesY - S(8);
        timeline = new Rectangle(pad, tlY - S(5), Math.Max(10, w - 2 * pad), S(10));
        using (var g = bottom.Begin(new Size(w, h)))
        {
            Gradient(g, new Rectangle(0, h - Math.Min(h, BottomContent + S(110)), w, Math.Min(h, BottomContent + S(110))), top: false, 0.85f);

            // Tidslinjen: tunn i vila, tjockare med musen över; buffrat ljusare; tydlig punkt för positionen
            var pos = draggingTime && dragPos >= 0 ? dragPos : Position;
            var hot = hoverBottom == "timeline" || draggingTime;
            var th = hot ? S(8) : Math.Max(3, S(4));
            var ty = tlY - th / 2f;
            using (var b = new SolidBrush(Color.FromArgb(0x55, 0xFF, 0xFF, 0xFF))) using (var p = RoundF(new RectangleF(timeline.X, ty, timeline.Width, th), th / 2f)) g.FillPath(b, p);
            if (CachedUntil > pos && Duration > 0)
            {
                var x0 = PlayerUi.PositionX(pos, timeline.X, timeline.Width, Duration);
                var x1 = PlayerUi.PositionX(CachedUntil, timeline.X, timeline.Width, Duration);
                using var b = new SolidBrush(Color.FromArgb(0x99, 0xFF, 0xFF, 0xFF));
                g.FillRectangle(b, x0, ty, Math.Max(0, x1 - x0), th);
            }
            var px = PlayerUi.PositionX(pos, timeline.X, timeline.Width, Duration);
            using (var b = new SolidBrush(Accent))
            {
                if (px > timeline.X) using (var p = RoundF(new RectangleF(timeline.X, ty, px - timeline.X, th), th / 2f)) g.FillPath(b, p);
                var r = hot ? S(10) : S(7);
                using (var sh = new SolidBrush(Color.FromArgb(0x60, 0, 0, 0))) g.FillEllipse(sh, px - r - 1, tlY - r, 2 * r + 2, 2 * r + 2);
                g.FillEllipse(b, px - r, tlY - r, 2 * r, 2 * r);
                using var ring = new Pen(Color.FromArgb(0xF0, 0xFF, 0xFF, 0xFF), Math.Max(1.5f, S(2)));
                if (hot) g.DrawEllipse(ring, px - r, tlY - r, 2 * r, 2 * r);
            }

            // Tiderna: förfluten till vänster, tid kvar eller sluttid till höger (klick växlar)
            TextAt(g, PlayerUi.TimeText(Math.Min(pos, Duration > 0 ? Duration : pos)), f.Time, new RectangleF(pad, timesY, S(160), S(22)), Text1, StringAlignment.Near, shadow: true);
            var rightText = ShowEndTime ? Spelarrad.EndsAt(pos, Duration, Speed, DateTime.Now, L.Sv) : Spelarrad.Remaining(pos, Duration);
            if (rightText.Length > 0)
            {
                var rw = (int)Math.Ceiling(g.MeasureString(rightText, f.Time).Width) + S(8);
                var rr = new Rectangle(w - pad - rw, timesY - S(2), rw, S(26));
                hits.Add(new Hit("timemode", rr, ShowEndTime ? L.T("Visa tid kvar", "Show time left") : L.T("Visa när filmen slutar", "Show when it ends")));
                if (hoverBottom == "timemode") using (var b = new SolidBrush(HoverBg)) using (var p = Round(rr, S(6))) g.FillPath(b, p);
                TextAt(g, rightText, f.Time, rr, Text1, StringAlignment.Far, shadow: true);
            }

            // Knapparna i mitten: −10 s, spela/paus (stor), +30 s, nästa avsnitt
            var big = S(64); var mid = S(52); var gap = S(30);
            var cx = w / 2;
            var play = new Rectangle(cx - big / 2, btnY, big, big);
            var back10 = new Rectangle(play.X - gap - mid, btnY + (big - mid) / 2, mid, mid);
            var fwd30 = new Rectangle(play.Right + gap, back10.Y, mid, mid);
            hits.Add(new Hit("back10", back10, L.T("10 sekunder bakåt (←)", "Back 10 seconds (←)")));
            hits.Add(new Hit("toggle", play, Paused ? L.T("Spela (mellanslag)", "Play (space)") : L.T("Paus (mellanslag)", "Pause (space)")));
            hits.Add(new Hit("fwd30", fwd30, L.T("30 sekunder framåt", "Forward 30 seconds")));
            HoverCircle(g, back10, hoverBottom == "back10");
            SkipIcon(g, back10, back: true, "10");
            using (var b = new SolidBrush(hoverBottom == "toggle" ? Color.FromArgb(0x55, 0xFF, 0xFF, 0xFF) : Color.FromArgb(0x30, 0xFF, 0xFF, 0xFF))) g.FillEllipse(b, play);
            var ir = new RectangleF(play.X + big * 0.3f, play.Y + big * 0.3f, big * 0.4f, big * 0.4f);
            if (Paused) PlayIcon(g, ir, Text1); else PauseIcon(g, ir, Text1);
            HoverCircle(g, fwd30, hoverBottom == "fwd30");
            SkipIcon(g, fwd30, back: false, "30");
            if (HasNext)
            {
                var next = new Rectangle(fwd30.Right + gap, back10.Y, mid, mid);
                hits.Add(new Hit("next", next, L.T("Nästa avsnitt (N)", "Next episode (N)")));
                HoverCircle(g, next, hoverBottom == "next");
                Glyph(g, GlyphNext, f.Icon, next, Text1);
            }

            // Höger: ljud och undertexter, volym (reglaget fälls ut till vänster om högtalaren), helskärm. Platsen för
            // reglaget är alltid reserverad, så att knapparna inte flyttar sig under muspekaren när det fälls ut.
            var btn = S(48);
            var by = btnY + (big - btn) / 2;
            var full = new Rectangle(w - pad - btn + S(8), by, btn, btn);
            hits.Add(new Hit("fullscreen", full, FullScreen ? L.T("Lämna helskärm (F)", "Exit full screen (F)") : L.T("Helskärm (F)", "Full screen (F)")));
            HoverCircle(g, full, hoverBottom == "fullscreen");
            Glyph(g, FullScreen ? GlyphWindow : GlyphFull, f.Icon, full, Text1);
            volumeOpen = hoverBottom is "mute" or "volume" || draggingVolume;
            var sliderW = S(110);
            var mute = new Rectangle(full.X - S(4) - btn, by, btn, btn);
            volumeBar = new Rectangle(mute.X - sliderW + S(8), by + btn / 2 - S(3), sliderW - S(14), S(6));
            hits.Add(new Hit("mute", mute, Muted ? L.T("Slå på ljudet (M)", "Unmute (M)") : L.T("Ljud av (M) · volym ↑/↓", "Mute (M) · volume ↑/↓")));
            if (volumeOpen) hits.Add(new Hit("volume", Rectangle.Inflate(volumeBar, S(6), S(12)), ""));
            HoverCircle(g, mute, hoverBottom == "mute");
            Glyph(g, Muted || Volume == 0 ? GlyphMute : GlyphVolume, f.Icon, mute, Text1);
            if (volumeOpen)
            {
                var vol = Muted ? 0 : Volume;
                var vy = volumeBar.Y + volumeBar.Height / 2f;
                using (var b = new SolidBrush(Color.FromArgb(0x55, 0xFF, 0xFF, 0xFF))) using (var p = RoundF(volumeBar, volumeBar.Height / 2f)) g.FillPath(b, p);
                var vx = volumeBar.X + volumeBar.Width * vol / 100f;
                using (var b = new SolidBrush(Text1))
                {
                    if (vx > volumeBar.X) using (var p = RoundF(new RectangleF(volumeBar.X, volumeBar.Y, vx - volumeBar.X, volumeBar.Height), volumeBar.Height / 2f)) g.FillPath(b, p);
                    var r = S(7);
                    g.FillEllipse(b, vx - r, vy - r, 2 * r, 2 * r);
                }
            }
            var tracks = new Rectangle(mute.X - sliderW - S(4) - btn, by, btn, btn);
            hits.Add(new Hit("tracks", tracks, L.T("Ljud och undertexter (C)", "Audio and subtitles (C)")));
            HoverCircle(g, tracks, hoverBottom == "tracks");
            SubtitleIcon(g, tracks);

            // Tid (och kapitel) vid muspekaren, med förhandsbilden ovanför när servern har sådana
            if (hot && Duration > 0)
            {
                var at = draggingTime ? pos : PlayerUi.SeekPosition(hoverX, timeline.X, timeline.Width, Duration);
                var ch = Chapters.LastOrDefault(c => c.Start <= at).Title;
                var label = PlayerUi.TimeText(at) + (string.IsNullOrWhiteSpace(ch) ? "" : " · " + ch);
                var lw = (int)Math.Ceiling(g.MeasureString(label, f.Small).Width) + S(16);
                var prev = Preview?.Invoke(at);
                var pw = prev != null ? S(224) : 0;
                var ph = prev is { } pv ? (int)Math.Round(pw * pv.Src.Height / (double)Math.Max(1, pv.Src.Width)) : 0;
                var bw = Math.Max(lw, pw + S(6));
                var bh = (prev != null ? ph + S(6) : 0) + S(26);
                var ax = PlayerUi.PositionX(at, timeline.X, timeline.Width, Duration);
                var bx = Math.Clamp(ax - bw / 2, S(4), w - bw - S(4));
                var bubble = new Rectangle(bx, tlY - S(16) - bh, bw, bh);
                using (var b = new SolidBrush(Card)) using (var p = Round(bubble, S(6))) g.FillPath(b, p);
                if (prev is { } pr)
                {
                    var dst = new Rectangle(bubble.X + (bw - pw) / 2, bubble.Y + S(3), pw, ph);
                    g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    g.DrawImage(pr.Sheet, dst, pr.Src, GraphicsUnit.Pixel);
                }
                TextAt(g, label, f.Small, new RectangleF(bubble.X, bubble.Bottom - S(26), bubble.Width, S(26)), Text1, StringAlignment.Center);
            }
        }
        bottomHits = hits;
        bottom.Present(new Point(video.X, video.Bottom - h));
    }

    /// <summary>Hörnet nere till höger: "Hoppa över intro" eller kortet med nästa avsnitt. Syns även när raderna är borta.</summary>
    void RenderCorner()
    {
        var f = fonts!;
        var hits = new List<Hit>();
        if (SkipText == null && Next == null)
        {
            cornerHits = hits; hoverCorner = null;
            if (corner.Visible) { tip.Hide(corner); corner.Hide(); }
            return;
        }
        Size size;
        using (var mg = Graphics.FromHwnd(IntPtr.Zero))
            size = Next != null ? new Size(S(440), S(150)) : new Size((int)Math.Ceiling(mg.MeasureString(SkipText!, f.Button).Width) + S(48), S(52));
        var pad = S(32);
        var lift = shown || fadeLevel > 0 ? BottomContent + S(26) : S(40);
        var at = new Point(video.Right - pad - size.Width, video.Bottom - lift - size.Height);
        using (var g = corner.Begin(size))
        {
            if (Next is { } n)
            {
                var card = new Rectangle(0, 0, size.Width - 1, size.Height - 1);
                using (var b = new SolidBrush(Card)) using (var p = Round(card, S(10))) g.FillPath(b, p);
                var head = n.Auto && n.SecondsLeft >= 0
                    ? L.T($"Nästa avsnitt om {n.SecondsLeft} s", $"Next episode in {n.SecondsLeft} s")
                    : L.T("Nästa avsnitt", "Next episode");
                TextAt(g, head, f.Small, new RectangleF(S(20), S(14), size.Width - S(40), S(22)), Text2, StringAlignment.Near);
                TextAt(g, n.Title.Length > 0 ? n.Title : L.T("Nästa avsnitt", "Next episode"), f.CardTitle, new RectangleF(S(20), S(38), size.Width - S(40), S(30)), Text1, StringAlignment.Near);
                var bh = S(44);
                var now = new Rectangle(S(20), size.Height - S(20) - bh, S(196), bh);
                var cancel = new Rectangle(now.Right + S(12), now.Y, S(140), bh);
                hits.Add(new Hit("nextnow", now, L.T("Spela nästa avsnitt nu (Enter)", "Play the next episode now (Enter)")));
                hits.Add(new Hit("nextcancel", cancel, L.T("Fortsätt titta på eftertexterna (Esc)", "Keep watching the credits (Esc)")));
                using (var b = new SolidBrush(hoverCorner == "nextnow" ? Color.FromArgb(0xF0, 0x5F, 0x5F) : Accent)) using (var p = Round(now, S(8))) g.FillPath(b, p);
                PlayIcon(g, new RectangleF(now.X + S(18), now.Y + bh * 0.32f, bh * 0.36f, bh * 0.36f), Color.White);
                TextAt(g, L.T("Spela nu", "Play now"), f.Button, new RectangleF(now.X + S(30), now.Y, now.Width - S(30), now.Height), Color.White, StringAlignment.Center);
                using (var b = new SolidBrush(hoverCorner == "nextcancel" ? Color.FromArgb(0x55, 0xFF, 0xFF, 0xFF) : Color.FromArgb(0x26, 0xFF, 0xFF, 0xFF))) using (var p = Round(cancel, S(8))) g.FillPath(b, p);
                TextAt(g, L.T("Avbryt", "Cancel"), f.Button, cancel, Text1, StringAlignment.Center);
                // Nedräkningen som en linje längst ner på kortet
                if (n.Auto && n.Total > 0 && n.SecondsLeft >= 0)
                {
                    var frac = Math.Clamp(n.SecondsLeft / (double)n.Total, 0, 1);
                    using var b = new SolidBrush(Accent);
                    g.FillRectangle(b, S(10), size.Height - S(4), (float)((size.Width - S(20)) * frac), S(3));
                }
            }
            else
            {
                var r = new Rectangle(0, 0, size.Width - 1, size.Height - 1);
                hits.Add(new Hit("skip", r, L.T("Eller tryck Enter", "Or press Enter")));
                var hot = hoverCorner == "skip";
                using (var b = new SolidBrush(hot ? Color.FromArgb(0xF2, 0xF2, 0xF2) : Color.FromArgb(0xA6, 0x10, 0x10, 0x12))) using (var p = Round(r, S(8))) g.FillPath(b, p);
                using (var pen = new Pen(Color.FromArgb(0xD0, 0xFF, 0xFF, 0xFF), Math.Max(1.5f, S(1.5)))) using (var p = Round(Rectangle.Inflate(r, -1, -1), S(8))) g.DrawPath(pen, p);
                TextAt(g, SkipText!, f.Button, r, hot ? Color.FromArgb(0x14, 0x15, 0x17) : Text1, StringAlignment.Center);
            }
        }
        cornerHits = hits;
        corner.Present(at);
        if (!corner.Visible) { corner.Show(owner); Raise(); }
    }

    // ---------- små ritverktyg ----------

    /// <summary>Gradient från svart (alfa max) till genomskinligt, mjukt avtagande (ingen kant)</summary>
    static void Gradient(Graphics g, Rectangle r, bool top, float max)
    {
        if (r.Height <= 0 || r.Width <= 0) return;
        using var b = new LinearGradientBrush(new Rectangle(r.X, r.Y - 1, r.Width, r.Height + 2), Color.Black, Color.Black, LinearGradientMode.Vertical);
        var a = (int)(255 * max);
        Color A(double f) => Color.FromArgb((int)Math.Round(a * f), 0, 0, 0);
        // Uppifrån och ner: överst mörkt för den övre raden, nederst mörkt för den nedre
        var stops = new[] { 0f, 0.25f, 0.5f, 0.75f, 1f };
        var fall = new[] { 1.0, 0.78, 0.45, 0.16, 0.0 };
        b.InterpolationColors = new ColorBlend
        {
            Positions = stops,
            Colors = (top ? fall : Enumerable.Reverse(fall)).Select(A).ToArray(),
        };
        g.FillRectangle(b, r);
    }

    void HoverCircle(Graphics g, Rectangle r, bool hot)
    {
        if (!hot) return;
        using var b = new SolidBrush(HoverBg);
        g.FillEllipse(b, r);
    }

    static void TextAt(Graphics g, string text, Font font, RectangleF r, Color c, StringAlignment align, bool shadow = false)
    {
        using var sf = new StringFormat(StringFormatFlags.NoWrap) { Alignment = align, LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter };
        if (shadow)
        {
            using var sb = new SolidBrush(Color.FromArgb(0x80, 0, 0, 0));
            var o = Math.Max(1f, font.Size / 14f);
            g.DrawString(text, font, sb, new RectangleF(r.X + o, r.Y + o, r.Width, r.Height), sf);
        }
        using var b = new SolidBrush(c);
        g.DrawString(text, font, b, r, sf);
    }

    static void Glyph(Graphics g, string glyph, Font font, Rectangle r, Color c)
    {
        using var sf = new StringFormat(StringFormatFlags.NoWrap | StringFormatFlags.NoClip) { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        using var sb = new SolidBrush(Color.FromArgb(0x70, 0, 0, 0));
        g.DrawString(glyph, font, sb, new RectangleF(r.X + 1, r.Y + 2, r.Width, r.Height), sf);
        using var b = new SolidBrush(c);
        g.DrawString(glyph, font, b, r, sf);
    }

    static void PlayIcon(Graphics g, RectangleF r, Color c)
    {
        using var b = new SolidBrush(c);
        var x0 = r.X + r.Width * 0.12f;
        g.FillPolygon(b, new[] { new PointF(x0, r.Y), new PointF(r.Right + r.Width * 0.08f, r.Y + r.Height / 2), new PointF(x0, r.Bottom) });
    }

    static void PauseIcon(Graphics g, RectangleF r, Color c)
    {
        using var b = new SolidBrush(c);
        var bw = r.Width * 0.32f;
        using (var p = RoundF(new RectangleF(r.X + r.Width * 0.06f, r.Y, bw, r.Height), bw * 0.2f)) g.FillPath(b, p);
        using (var p = RoundF(new RectangleF(r.Right - r.Width * 0.06f - bw, r.Y, bw, r.Height), bw * 0.2f)) g.FillPath(b, p);
    }

    /// <summary>Cirkelpil med sekunder i (bakåt moturs, framåt medurs)</summary>
    void SkipIcon(Graphics g, Rectangle r, bool back, string secs)
    {
        var d = r.Width * 0.58f;
        var c = new RectangleF(r.X + (r.Width - d) / 2, r.Y + (r.Height - d) / 2, d, d);
        using var pen = new Pen(Text1, Math.Max(1.6f, S(2.2))) { StartCap = LineCap.Round, EndCap = LineCap.Round };
        // Bågen lämnar en öppning upptill där pilspetsen sitter
        g.DrawArc(pen, c, back ? -60 : -120, back ? 300 : -300);
        var tipX = back ? c.X + c.Width * 0.25f : c.Right - c.Width * 0.25f;
        var tipY = c.Y + c.Height * 0.067f;
        var a = d * 0.22f;
        using (var b = new SolidBrush(Text1))
            g.FillPolygon(b, back
                ? new[] { new PointF(tipX - a, tipY), new PointF(tipX + a * 0.35f, tipY - a * 0.8f), new PointF(tipX + a * 0.35f, tipY + a * 0.8f) }
                : new[] { new PointF(tipX + a, tipY), new PointF(tipX - a * 0.35f, tipY - a * 0.8f), new PointF(tipX - a * 0.35f, tipY + a * 0.8f) });
        TextAt(g, secs, fonts!.Tiny, new RectangleF(c.X - S(4), c.Y + S(1), c.Width + S(8), c.Height), Text1, StringAlignment.Center);
    }

    /// <summary>Tillbakapil: ← (en linje med en vinkel)</summary>
    void BackArrow(Graphics g, Rectangle r)
    {
        using var pen = new Pen(Text1, Math.Max(2f, S(2.6))) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        var cx = r.X + r.Width / 2f; var cy = r.Y + r.Height / 2f; var a = r.Width * 0.22f;
        g.DrawLine(pen, cx - a, cy, cx + a, cy);
        g.DrawLines(pen, new[] { new PointF(cx - a * 0.1f, cy - a * 0.85f), new PointF(cx - a, cy), new PointF(cx - a * 0.1f, cy + a * 0.85f) });
    }

    /// <summary>Undertexter och ljud: en pratbubbla med två textrader</summary>
    void SubtitleIcon(Graphics g, Rectangle r)
    {
        var w = r.Width * 0.5f; var h = r.Height * 0.38f;
        var box = new RectangleF(r.X + (r.Width - w) / 2, r.Y + (r.Height - h) / 2 - S(1), w, h);
        using var pen = new Pen(Text1, Math.Max(1.6f, S(2.2))) { LineJoin = LineJoin.Round, StartCap = LineCap.Round, EndCap = LineCap.Round };
        using (var p = RoundF(box, h * 0.22f)) g.DrawPath(pen, p);
        var l = box.X + w * 0.2f; var y1 = box.Y + h * 0.4f; var y2 = box.Y + h * 0.68f;
        g.DrawLine(pen, l, y1, box.Right - w * 0.2f, y1);
        g.DrawLine(pen, l, y2, box.Right - w * 0.42f, y2);
    }

    static GraphicsPath Round(Rectangle r, int radius) => RoundF(r, radius);

    static GraphicsPath RoundF(RectangleF r, float radius)
    {
        var p = new GraphicsPath();
        var d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
        if (d <= 0.5f) { p.AddRectangle(r); return p; }
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    /// <summary>Typsnitten i bildpunkter efter skalan, så att raderna är lika stora på en tv som på en skärm</summary>
    sealed class Fonts : IDisposable
    {
        public readonly Font Title, Sub, Time, Small, Tiny, Button, CardTitle, Icon, SmallIcon;
        public Fonts(double s)
        {
            float P(double v) => (float)(v * s);
            Title = new Font("Segoe UI Semibold", P(21), GraphicsUnit.Pixel);
            Sub = new Font("Segoe UI", P(16), GraphicsUnit.Pixel);
            Time = new Font("Segoe UI", P(15), GraphicsUnit.Pixel);
            Small = new Font("Segoe UI", P(14), GraphicsUnit.Pixel);
            Tiny = new Font("Segoe UI Semibold", P(10.5), GraphicsUnit.Pixel);
            Button = new Font("Segoe UI Semibold", P(17), GraphicsUnit.Pixel);
            CardTitle = new Font("Segoe UI Semibold", P(19), GraphicsUnit.Pixel);
            Icon = new Font(IconFamily, P(21), GraphicsUnit.Pixel);
            SmallIcon = new Font(IconFamily, P(15), GraphicsUnit.Pixel);
        }
        public void Dispose() { foreach (var f in new[] { Title, Sub, Time, Small, Tiny, Button, CardTitle, Icon, SmallIcon }) f.Dispose(); }
    }

    public void Dispose()
    {
        fade.Dispose(); flashTimer.Dispose(); clickTimer.Dispose(); soon.Dispose(); tip.Dispose();
        foreach (var w in new[] { top, bottom, corner, center }) w.Dispose();
        fonts?.Dispose();
    }
}

/// <summary>
/// Ett nästan genomskinligt fönster över hela bilden som tar emot musen (mpv:s fönster körs i en egen tråd och
/// skickar inte musen vidare till appen): klick = spela/paus, dubbelklick = helskärm, hjulet = volym, högerklick =
/// meny. Raderna (PlayerChrome) ligger över det. Det aktiveras aldrig, så tangenterna stannar hos appens fönster.
/// Musrörelser skickas vidare med skärmpunkten; MainForm avgör om de räknas (Spelarrad.MouseWakes).
/// </summary>
sealed class MouseLayer : Form
{
    public event Action? Click1, DoubleClick1, RightClick;
    public event Action<int>? Wheel;
    public event Action<Point>? Moved;
    readonly System.Windows.Forms.Timer clickTimer = new() { Interval = SystemInformation.DoubleClickTime };
    bool cursorHidden;

    public MouseLayer()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.Black;
        Opacity = 0.01; // syns inte, men tar emot musen (ett helt genomskinligt fönster gör inte det)
        // Ett enkelklick väntar på dubbelklicket, så att dubbelklick (helskärm) inte också pausar
        clickTimer.Tick += (_, _) => { clickTimer.Stop(); Click1?.Invoke(); };
    }

    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x08000000 /* WS_EX_NOACTIVATE */ | 0x00000080 /* WS_EX_TOOLWINDOW */;
            return cp;
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x0021 /* WM_MOUSEACTIVATE */) { m.Result = 3 /* MA_NOACTIVATE */; return; }
        base.WndProc(ref m);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button == MouseButtons.Right) { RightClick?.Invoke(); return; }
        if (e.Button != MouseButtons.Left) return;
        if (e.Clicks >= 2) { clickTimer.Stop(); DoubleClick1?.Invoke(); }
        else clickTimer.Start();
    }

    protected override void OnMouseWheel(MouseEventArgs e) { base.OnMouseWheel(e); Wheel?.Invoke(e.Delta); }
    protected override void OnMouseMove(MouseEventArgs e) { base.OnMouseMove(e); Moved?.Invoke(PointToScreen(e.Location)); }

    /// <summary>Muspekaren göms över bilden när raderna tonats bort och visas igen när musen rör sig</summary>
    public void HideCursor() { if (!cursorHidden && Visible) { Cursor.Hide(); cursorHidden = true; } }
    public void ShowCursor() { if (cursorHidden) { Cursor.Show(); cursorHidden = false; } }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { ShowCursor(); clickTimer.Dispose(); }
        base.Dispose(disposing);
    }
}
