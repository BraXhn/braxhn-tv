using System.Drawing.Drawing2D;

namespace BraXhnTV.Spelare;

/// <summary>
/// Den inbyggda spelarens kontrollrad längst ner, i webbspelarens stil: tidslinje (klicka och dra, tid vid
/// muspekaren), titel och tid till vänster; −10 s, spela/paus, +10 s, nästa avsnitt och stopp i mitten; sovtimer,
/// inställningar, volym och helskärm till höger. Allt ritas här (inga underkontroller), så att raden är lätt och ser
/// likadan ut på alla datorer. Värdena sätts av MainForm.Spelare.cs; klick kommer som händelser.
/// </summary>
sealed class ControlBar : Control
{
    public const int BarHeight = 96;
    const int Pad = 18, TimelineY = 34, ButtonsY = 50, Btn = 40;
    static readonly Color Back = Color.FromArgb(0xF0, 0x14, 0x15, 0x17), Text1 = Color.FromArgb(0xEC, 0xEC, 0xEC), Text2 = Color.FromArgb(0xA8, 0xAA, 0xB0),
        Track = Color.FromArgb(0x4A, 0x4C, 0x52), Buffered = Color.FromArgb(0x7A, 0x7C, 0x84), Accent = Color.FromArgb(0xE5, 0x4B, 0x4B), Hover = Color.FromArgb(0x33, 0x35, 0x3A);
    static readonly string Icons = FontFamily.Families.Any(f => f.Name == "Segoe Fluent Icons") ? "Segoe Fluent Icons" : "Segoe MDL2 Assets";
    readonly Font iconFont = new(Icons, 15f), bigIconFont = new(Icons, 18f), smallFont = new("Segoe UI", 9f), titleFont = new("Segoe UI Semibold", 11f), timeFont = new("Segoe UI", 10f);
    readonly ToolTip tip = new() { InitialDelay = 400, ShowAlways = true };

    // Värden från spelaren
    public string Title { get; set; } = "";
    public double Position { get; set; }
    public double Duration { get; set; }
    public double CachedUntil { get; set; }
    public bool Paused { get; set; }
    public int Volume { get; set; } = 100;
    public bool Muted { get; set; }
    public bool HasNext { get; set; }
    public bool FullScreen { get; set; }
    public string SleepLabel { get; set; } = "";

    /// <summary>Ett klick på en knapp: back10, toggle, fwd10, next, stop, sleep, settings, mute, fullscreen</summary>
    public event Action<string, Point>? Clicked;
    /// <summary>Tidslinjen: position i sekunder; final = musknappen släpptes</summary>
    public event Action<double, bool>? Seek;
    public event Action<int>? VolumeSet;

    sealed record Hit(string Id, Rectangle Rect, string Glyph, string Tip);
    List<Hit> hits = new();
    Rectangle timeline, volume;
    string? hover;
    int hoverX = -1;
    bool draggingTime, draggingVolume;
    double dragPos = -1;

    public ControlBar()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        SetStyle(ControlStyles.Selectable, false);
        Height = BarHeight;
        BackColor = Color.FromArgb(0x14, 0x15, 0x17);
        Cursor = Cursors.Default;
    }

    /// <summary>True medan användaren drar i tidslinjen (positionen från spelaren ska då inte skriva över)</summary>
    public bool Dragging => draggingTime || draggingVolume;

    void Layout2()
    {
        var w = ClientSize.Width;
        timeline = new Rectangle(Pad, TimelineY - 8, Math.Max(10, w - 2 * Pad), 16);
        var list = new List<Hit>();
        // Mitten
        var center = new List<(string id, string glyph, string tip)>
        {
            ("back10", "", L.T("10 sekunder bakåt (←)", "Back 10 seconds (←)")),
            ("toggle", Paused ? "" : "", Paused ? L.T("Spela (mellanslag)", "Play (space)") : L.T("Paus (mellanslag)", "Pause (space)")),
            ("fwd10", "", L.T("10 sekunder framåt (→)", "Forward 10 seconds (→)")),
        };
        if (HasNext) center.Add(("next", "", L.T("Nästa avsnitt (N)", "Next episode (N)")));
        center.Add(("stop", "", L.T("Stoppa och gå tillbaka (Q)", "Stop and go back (Q)")));
        var cx = w / 2 - center.Count * Btn / 2;
        foreach (var (id, glyph, t) in center) { list.Add(new Hit(id, new Rectangle(cx, ButtonsY, Btn, Btn), glyph, t)); cx += Btn; }
        // Höger: helskärm, volym, inställningar, sovtimer (från höger)
        var rx = w - Pad - Btn;
        list.Add(new Hit("fullscreen", new Rectangle(rx, ButtonsY, Btn, Btn), FullScreen ? "" : "", FullScreen ? L.T("Lämna helskärm (F)", "Exit full screen (F)") : L.T("Helskärm (F)", "Full screen (F)")));
        rx -= 100;
        volume = new Rectangle(rx + 8, ButtonsY + Btn / 2 - 8, 84, 16);
        rx -= Btn;
        list.Add(new Hit("mute", new Rectangle(rx, ButtonsY, Btn, Btn), Muted || Volume == 0 ? "" : "", Muted ? L.T("Slå på ljudet (M)", "Unmute (M)") : L.T("Ljud av (M)", "Mute (M)")));
        rx -= Btn;
        list.Add(new Hit("settings", new Rectangle(rx, ButtonsY, Btn, Btn), "", L.T("Ljud, undertexter och hastighet", "Audio, subtitles and speed")));
        var sleepW = SleepLabel.Length > 0 ? Btn + TextRenderer.MeasureText(SleepLabel, smallFont).Width : Btn;
        rx -= sleepW;
        list.Add(new Hit("sleep", new Rectangle(rx, ButtonsY, sleepW, Btn), "", L.T("Sovtimer", "Sleep timer")));
        hits = list;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Layout2();
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(BackColor);
        // Tidslinjen: spår, buffrat, spelat, knopp
        var pos = draggingTime && dragPos >= 0 ? dragPos : Position;
        var y = timeline.Y + timeline.Height / 2;
        var hot = hover == "timeline" || draggingTime;
        var th = hot ? 6 : 4;
        using (var b = new SolidBrush(Track)) g.FillRectangle(b, timeline.X, y - th / 2, timeline.Width, th);
        if (CachedUntil > pos && Duration > 0)
        {
            var x0 = PlayerUi.PositionX(pos, timeline.X, timeline.Width, Duration);
            var x1 = PlayerUi.PositionX(CachedUntil, timeline.X, timeline.Width, Duration);
            using var b = new SolidBrush(Buffered); g.FillRectangle(b, x0, y - th / 2, x1 - x0, th);
        }
        var px = PlayerUi.PositionX(pos, timeline.X, timeline.Width, Duration);
        using (var b = new SolidBrush(Accent))
        {
            g.FillRectangle(b, timeline.X, y - th / 2, px - timeline.X, th);
            var r = hot ? 8 : 6;
            g.FillEllipse(b, px - r, y - r, 2 * r, 2 * r);
        }
        // Tid vid muspekaren (bubbla ovanför linjen)
        if ((hover == "timeline" || draggingTime) && Duration > 0)
        {
            var at = draggingTime ? pos : PlayerUi.SeekPosition(hoverX, timeline.X, timeline.Width, Duration);
            var text = PlayerUi.TimeText(at);
            var sz = TextRenderer.MeasureText(text, smallFont);
            var bx = Math.Clamp(PlayerUi.PositionX(at, timeline.X, timeline.Width, Duration) - sz.Width / 2 - 6, 2, Width - sz.Width - 14);
            var bubble = new Rectangle(bx, 2, sz.Width + 12, 20);
            using (var b = new SolidBrush(Hover)) using (var path = Round(bubble, 5)) g.FillPath(b, path);
            TextRenderer.DrawText(g, text, smallFont, bubble, Text1, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
        // Vänster: titel och tid
        var leftW = Math.Max(60, hits.Min(h => h.Rect.X) - Pad - 12);
        var center0 = hits.Where(h => h.Id is "back10").Select(h => h.Rect.X).FirstOrDefault(Width);
        leftW = Math.Min(leftW, center0 - Pad - 12);
        if (leftW > 40)
        {
            TextRenderer.DrawText(g, Title, titleFont, new Rectangle(Pad, ButtonsY - 2, leftW, 24), Text1, TextFormatFlags.EndEllipsis | TextFormatFlags.Left | TextFormatFlags.NoPrefix);
            TextRenderer.DrawText(g, PlayerUi.TimePair(pos, Duration), timeFont, new Rectangle(Pad, ButtonsY + 20, leftW, 22), Text2, TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
        }
        // Knapparna
        foreach (var h in hits)
        {
            if (h.Id == hover) using (var b = new SolidBrush(Hover)) using (var path = Round(h.Rect, 8)) g.FillPath(b, path);
            var glyphRect = h.Id == "sleep" && SleepLabel.Length > 0 ? new Rectangle(h.Rect.X, h.Rect.Y, Btn, Btn) : h.Rect;
            TextRenderer.DrawText(g, h.Glyph, h.Id == "toggle" ? bigIconFont : iconFont, glyphRect, Text1, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
            if (h.Id is "back10" or "fwd10")
                TextRenderer.DrawText(g, "10", smallFont, new Rectangle(h.Rect.X, h.Rect.Bottom - 15, h.Rect.Width, 14), Text2, TextFormatFlags.HorizontalCenter);
            if (h.Id == "sleep" && SleepLabel.Length > 0)
                TextRenderer.DrawText(g, SleepLabel, smallFont, new Rectangle(h.Rect.X + Btn - 6, h.Rect.Y, h.Rect.Width - Btn + 6, Btn), Accent, TextFormatFlags.VerticalCenter | TextFormatFlags.Left);
        }
        // Volym
        var vy = volume.Y + volume.Height / 2;
        var vol = Muted ? 0 : Volume;
        using (var b = new SolidBrush(Track)) g.FillRectangle(b, volume.X, vy - 2, volume.Width, 4);
        using (var b = new SolidBrush(Text1))
        {
            var vx = volume.X + (int)(volume.Width * vol / 100.0);
            g.FillRectangle(b, volume.X, vy - 2, vx - volume.X, 4);
            g.FillEllipse(b, vx - 6, vy - 6, 12, 12);
        }
    }

    static GraphicsPath Round(Rectangle r, int radius)
    {
        var p = new GraphicsPath();
        var d = radius * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    string? HitAt(Point p)
    {
        if (Rectangle.Inflate(timeline, 0, 6).Contains(p)) return "timeline";
        if (Rectangle.Inflate(volume, 4, 10).Contains(p)) return "volume";
        return hits.FirstOrDefault(h => h.Rect.Contains(p))?.Id;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (draggingTime) { dragPos = PlayerUi.SeekPosition(e.X, timeline.X, timeline.Width, Duration); Seek?.Invoke(dragPos, false); Invalidate(); return; }
        if (draggingVolume) { SetVolumeAt(e.X); return; }
        var h = HitAt(e.Location);
        if (h != hover)
        {
            hover = h;
            var hit = hits.FirstOrDefault(x => x.Id == h);
            if (hit != null) tip.Show(hit.Tip, this, hit.Rect.X, hit.Rect.Y - 26, 2500); else tip.Hide(this);
        }
        hoverX = e.X;
        Invalidate();
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (Dragging) return;
        hover = null;
        tip.Hide(this);
        Invalidate();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        var h = HitAt(e.Location);
        if (h == "timeline" && Duration > 0)
        {
            draggingTime = true;
            Capture = true;
            dragPos = PlayerUi.SeekPosition(e.X, timeline.X, timeline.Width, Duration);
            Seek?.Invoke(dragPos, false);
            Invalidate();
        }
        else if (h == "volume") { draggingVolume = true; Capture = true; SetVolumeAt(e.X); }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (draggingTime)
        {
            draggingTime = false;
            Capture = false;
            Seek?.Invoke(PlayerUi.SeekPosition(e.X, timeline.X, timeline.Width, Duration), true);
            Position = dragPos;
            dragPos = -1;
            Invalidate();
            return;
        }
        if (draggingVolume) { draggingVolume = false; Capture = false; return; }
        if (e.Button != MouseButtons.Left) return;
        var h = HitAt(e.Location);
        var hit = hits.FirstOrDefault(x => x.Id == h);
        if (hit != null) Clicked?.Invoke(hit.Id, PointToScreen(new Point(hit.Rect.X, hit.Rect.Y)));
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        VolumeSet?.Invoke(PlayerUi.Volume(Muted ? 0 : Volume, e.Delta > 0 ? 5 : -5));
    }

    void SetVolumeAt(int x)
    {
        var v = (int)Math.Round(Math.Clamp((x - volume.X) / (double)volume.Width, 0, 1) * 100);
        Volume = v;
        VolumeSet?.Invoke(v);
        Invalidate();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { tip.Dispose(); iconFont.Dispose(); bigIconFont.Dispose(); smallFont.Dispose(); titleFont.Dispose(); timeFont.Dispose(); }
        base.Dispose(disposing);
    }
}

/// <summary>
/// Ett nästan genomskinligt fönster över bilden som tar emot musen (mpv:s fönster körs i en egen tråd och skickar
/// inte musen vidare till appen): klick = spela/paus, dubbelklick = helskärm, hjulet = volym, högerklick = meny.
/// Det aktiveras aldrig, så tangenterna stannar hos appens fönster.
/// </summary>
sealed class MouseLayer : Form
{
    public event Action? Click1, DoubleClick1, RightClick, Moved;
    public event Action<int>? Wheel;
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
    protected override void OnMouseMove(MouseEventArgs e) { base.OnMouseMove(e); ShowCursor(); Moved?.Invoke(); }

    /// <summary>Muspekaren göms över bilden (i helskärm, när raderna tonats bort) och visas igen när musen rör sig</summary>
    public void HideCursor() { if (!cursorHidden && Visible) { Cursor.Hide(); cursorHidden = true; } }
    public void ShowCursor() { if (cursorHidden) { Cursor.Show(); cursorHidden = false; } }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { ShowCursor(); clickTimer.Dispose(); }
        base.Dispose(disposing);
    }
}
