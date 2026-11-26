using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using BraXhnTV.Spelare;

namespace BraXhnTV;

/// <summary>
/// Den inbyggda spelaren (mpv): webben frågar (native-check), skickar filmen (native-play) och sköter servern –
/// appen spelar i en panel ovanpå webbvyn och berättar om framsteg, slut och stängning. Går något fel med mpv
/// svarar appen native-failed och webbspelaren tar över.
/// </summary>
sealed partial class MainForm
{
    MpvPlayer? player;
    Panel? playerPanel;
    Panel? playerBar;
    Button? nextButton;
    Label? barTitle;
    System.Windows.Forms.Timer? progressTimer, barTimer;
    Point lastMouse;
    DateTime mouseMoved;
    bool playerStarted;
    bool closingAfterPlayer;

    /// <summary>Finns libmpv, och är den inbyggda spelaren på?</summary>
    bool NativeReady()
    {
        if (!cfg.UseBuiltInPlayer) { Skipped("off", "", [], false, 0); return false; }
        var ok = Libmpv.Load(out var err) != null;
        if (!ok) Skipped("mpv", "", err != null ? [err] : [], false, 0);
        return ok;
    }

    void PostNative(object msg)
    {
        try { web?.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(msg)); } catch { }
    }

    void OnNativeMessage(string t, JsonNode? m)
    {
        switch (t)
        {
            case "native-check":
                var ready = NativeReady();
                PostNative(new { t = "native-ready", ok = ready });
                // Första gången en film kunde ha spelats i den inbyggda spelaren men mpv saknas: fråga en gång om den ska
                // hämtas (filmen spelas i webbspelaren under tiden). Följer mpv med installationen frågar appen aldrig.
                if (!ready && cfg.UseBuiltInPlayer && !cfg.MpvOffered && !Libmpv.Bundled)
                {
                    cfg.MpvOffered = true;
                    cfg.Save();
                    BeginInvoke(() => { MpvSetup.Offer(this, update: false, firstTime: true); UpdateMpvMenu(); });
                }
                break;
            case "native-play":
                lastSkip = null;
                PlayNative(m);
                break;
            case "native-skip":
                var reasons = (m?["reasons"] as JsonArray)?.Select(x => x is JsonValue v && v.TryGetValue<string>(out var r) ? r : "").Where(x => x.Length > 0).Take(6).ToList() ?? [];
                Skipped(Str(m, "why") ?? "", Str(m, "mode") ?? "", reasons, m?["remote"] is JsonValue rv && rv.TryGetValue<bool>(out var rb) && rb,
                    m?["bw"] is JsonValue bv && bv.TryGetValue<int>(out var bi) ? bi : 0);
                break;
            case "native-stop":
                if (player != null && player.Request.Id == (m?["id"]?.GetValue<long>() ?? -1)) ClosePlayer();
                break;
        }
    }

    static string? Str(JsonNode? m, string key) => m?[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    // ---------- varför webbspelaren används (visas en gång per orsak och körning, och i Om den inbyggda spelaren) ----------
    string? lastSkip;
    readonly HashSet<string> skipNoted = new();

    void Skipped(string why, string mode, IReadOnlyList<string> reasons, bool remote, int bw)
    {
        var text = NativeSkip.Describe(why, mode, reasons, remote, bw, L.Sv);
        lastSkip = text;
        Logg.Write("webbspelaren används: " + NativeSkip.Describe(why, mode, reasons, remote, bw, true));
        var key = why.StartsWith("mode:", StringComparison.Ordinal) ? "mode" : why;
        if (why == "off" || !skipNoted.Add(key)) return;
        var hint = why == "mpv" && !Libmpv.Bundled ? L.T(" Högerklicka för appens meny → Hämta den inbyggda spelaren.", " Right-click for the app menu → Download the built-in player.") : "";
        try { web?.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new { t = "app-note", text = L.T("Webbspelaren används eftersom ", "The web player is used because ") + text + "." + hint, ms = 12000 })); } catch { }
    }

    void PlayNative(JsonNode? m)
    {
        PlayRequest req;
        try { req = ParseRequest(m); }
        catch { Logg.Write("native-play: konstigt meddelande"); PostNative(new { t = "native-failed", id = m?["id"]?.GetValue<long>() ?? 0 }); return; }
        Logg.Write($"native-play: titel {req.Id}, start {req.Start:0}");
        // Bara strömmar från servern som är öppen (länken innehåller en token som bara gäller den här titeln)
        if (current == null || !Address.SameOrigin(req.Url, current.Url) || req.Subs.Any(s => s.Url != null && !Address.SameOrigin(s.Url, current.Url)))
        {
            PostNative(new { t = "native-failed", id = req.Id });
            return;
        }
        if (player != null)
        {
            // En annan titel (nästa avsnitt): den förra stängs utan att sidan ritas om
            var old = player;
            PostNative(new { t = "native-closed", id = old.Request.Id, pos = old.Position, replaced = true });
            DisposePlayer(keepPanel: true);
        }
        var lib = Libmpv.Load(out var err);
        if (lib == null) { PostNative(new { t = "native-failed", id = req.Id, error = err }); return; }
        try
        {
            EnsurePlayerPanel(req);
            var panel = playerPanel!;
            var p = player = new MpvPlayer(lib, panel.Handle.ToInt64(), (a) => { if (!IsDisposed) BeginInvoke(a); }, req);
            playerStarted = false;
            p.Started += () =>
            {
                if (player != p) return;
                playerStarted = true;
                PostNative(new { t = "native-started", id = req.Id });
                if (cfg.MatchRefresh && p.Fps > 0) Display.Match(Screen.FromControl(this), p.Fps);
                UpdateAwake();
            };
            p.Failed += (why) =>
            {
                if (player != p) return;
                Logg.Write($"mpv: titel {req.Id} kunde inte spelas – {why}");
                PostNative(new { t = "native-failed", id = req.Id, pos = playerStarted ? p.Position : req.Start, error = why });
                ClosePlayer(notify: false);
            };
            p.Ended += () =>
            {
                if (player != p) return;
                // Sovtimern "när avsnittet är slut": tillbaka till sidan i stället för nästa avsnitt
                if (sleepAfter) { sleepAfter = false; Logg.Write("sovtimern: titeln slut"); ClosePlayer(); return; }
                PostNative(new { t = "native-ended", id = req.Id, pos = p.Position });
            };
            p.PauseChanged += () => { if (player == p) { SendProgress(); UpdateAwake(); } };
            p.Command += (c) =>
            {
                if (player != p) return;
                switch (c)
                {
                    case "bx-close": ClosePlayer(); break;
                    case "bx-esc": if (fullScreen) SetFullScreen(false); else ClosePlayer(); break;
                    case "bx-fullscreen": SetFullScreen(!fullScreen); break;
                    case "bx-next": Next(); break;
                }
            };
            p.Start(new PlayerOptions(cfg.Passthrough, cfg.Volume, Path.Combine(AppSettings.Dir, "mpv")));
            progressTimer ??= new System.Windows.Forms.Timer { Interval = 10000 };
            progressTimer.Tick -= OnProgressTick;
            progressTimer.Tick += OnProgressTick;
            progressTimer.Start();
        }
        catch (Exception ex)
        {
            Logg.Write($"mpv: kunde inte starta titel {req.Id} – {ex.Message}");
            PostNative(new { t = "native-failed", id = req.Id, error = ex.Message });
            DisposePlayer(keepPanel: false);
        }
    }

    static PlayRequest ParseRequest(JsonNode? m)
    {
        var r = new PlayRequest
        {
            Id = m!["id"]!.GetValue<long>(),
            Url = m["url"]!.GetValue<string>(),
            Title = m["title"]?.GetValue<string>() ?? "",
            Start = m["start"]?.GetValue<double>() ?? 0,
            Duration = m["duration"]?.GetValue<double>() ?? 0,
            Audio = m["audio"] is JsonValue a && a.TryGetValue<int>(out var ai) ? ai : null,
            Sub = m["sub"]?.GetValue<string>() ?? "",
            NextId = m["nextId"] is JsonValue n && n.TryGetValue<long>(out var ni) ? ni : null,
        };
        if (m["subs"] is JsonArray subs)
            foreach (var s in subs.OfType<JsonObject>())
                r.Subs.Add(new SubTrack
                {
                    Id = s["id"]?.GetValue<string>() ?? "", Label = s["label"]?.GetValue<string>() ?? "", Lang = s["lang"]?.GetValue<string>() ?? "",
                    Index = s["index"] is JsonValue iv && iv.TryGetValue<int>(out var ii) ? ii : null, Url = s["url"]?.GetValue<string>(),
                });
        return r;
    }

    void OnProgressTick(object? sender, EventArgs e) { if (player != null && playerStarted && !player.Paused) SendProgress(); }

    void SendProgress()
    {
        if (player == null || !playerStarted) return;
        PostNative(new { t = "native-progress", id = player.Request.Id, pos = player.Position, paused = player.Paused });
    }

    void Next()
    {
        if (player?.Request.NextId == null) return;
        PostNative(new { t = "native-next", id = player.Request.Id, pos = player.Position });
    }

    /// <summary>Stänger spelaren (Tillbaka, q, Esc). notify: webben får veta var filmen var.</summary>
    void ClosePlayer(bool notify = true)
    {
        if (player == null) return;
        if (notify && playerStarted) PostNative(new { t = "native-closed", id = player.Request.Id, pos = player.Position });
        else if (notify) PostNative(new { t = "native-closed", id = player.Request.Id, pos = player.Request.Start });
        DisposePlayer(keepPanel: false);
    }

    void DisposePlayer(bool keepPanel)
    {
        var p = player;
        player = null;
        playerStarted = false;
        progressTimer?.Stop();
        if (p != null)
        {
            if (p.Volume >= 0) { cfg.Volume = p.Volume; cfg.Save(); }
            var panel = playerPanel;
            if (!keepPanel)
            {
                // Panelen tas bort först när mpv stängt sitt fönster i den
                playerPanel = null;
                p.Gone += () => { panel?.Dispose(); };
                if (panel != null) panel.Visible = false;
                RemoveBar();
                Display.Restore();
                if (fullScreen && web?.CoreWebView2?.ContainsFullScreenElement != true) SetFullScreen(false);
                web?.Focus();
            }
            else
            {
                // Ny panel för nästa titel; den gamla tas bort när mpv stängt
                playerPanel = null;
                p.Gone += () => { panel?.Dispose(); };
            }
            try { p.Stop(); } catch { panel?.Dispose(); }
        }
        UpdateAwake();
    }

    void EnsurePlayerPanel(PlayRequest req)
    {
        if (playerPanel == null || playerPanel.IsDisposed)
        {
            playerPanel = new Panel { Dock = DockStyle.Fill, BackColor = Color.Black };
            Controls.Add(playerPanel);
        }
        playerPanel.Visible = true;
        playerPanel.BringToFront();
        EnsureBar(req);
        playerPanel.Focus();
    }

    // ---------- reglagen: raden överst (Tillbaka, titeln, Nästa avsnitt), kontrollraden nederst och musen över bilden ----------
    ControlBar? controls;
    MouseLayer? mouseLayer;
    ContextMenuStrip? openMenu;
    bool barsShown = true;
    DateTime? sleepAt;
    bool sleepAfter;
    int lastSid = -1;

    void EnsureBar(PlayRequest req)
    {
        if (playerBar == null)
        {
            playerBar = new Panel { Height = 52, BackColor = Color.FromArgb(0x14, 0x15, 0x17), Padding = new Padding(10, 8, 10, 8) };
            var back = BarButton(L.T("← Tillbaka", "← Back"));
            back.Dock = DockStyle.Left;
            back.Click += (_, _) => ClosePlayer();
            nextButton = BarButton(L.T("Nästa avsnitt ⏭", "Next episode ⏭"));
            nextButton.Dock = DockStyle.Right;
            nextButton.Click += (_, _) => Next();
            barTitle = new Label { Dock = DockStyle.Fill, ForeColor = Color.FromArgb(0xec, 0xec, 0xec), TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(14, 0, 0, 0), AutoEllipsis = true, Font = new Font("Segoe UI", 11f) };
            playerBar.Controls.Add(barTitle);
            playerBar.Controls.Add(back);
            playerBar.Controls.Add(nextButton);
            Controls.Add(playerBar);
            barTimer = new System.Windows.Forms.Timer { Interval = 200 };
            barTimer.Tick += (_, _) => BarTick();
        }
        if (controls == null)
        {
            controls = new ControlBar();
            controls.Clicked += OnControlClick;
            controls.Seek += (s, final) => player?.SeekTo(s, exact: final);
            controls.VolumeSet += (v) => { player?.SetVolume(v); if (player?.Muted == true) player.Set("mute", "no"); };
            Controls.Add(controls);
        }
        if (mouseLayer == null || mouseLayer.IsDisposed)
        {
            mouseLayer = new MouseLayer();
            mouseLayer.Click1 += () => DoAction(PlayerAction.TogglePause);
            mouseLayer.DoubleClick1 += () => DoAction(PlayerAction.Fullscreen);
            mouseLayer.Wheel += (d) => DoAction(d > 0 ? PlayerAction.VolumeUp : PlayerAction.VolumeDown);
            mouseLayer.RightClick += () => ShowMenu(VideoMenu(), Cursor.Position);
            mouseLayer.Moved += () => mouseMoved = DateTime.UtcNow;
        }
        barTitle!.Text = req.Title;
        nextButton!.Visible = req.NextId != null;
        controls.Title = req.Title;
        controls.HasNext = req.NextId != null;
        controls.Position = req.Start;
        controls.Duration = req.Duration;
        sleepAfter = false; // sovtimern "när avsnittet är slut" gäller en titel; en tid gäller över nästa avsnitt
        mouseMoved = DateTime.UtcNow;
        lastMouse = Cursor.Position;
        SetBars(true);
        if (!mouseLayer.Visible) mouseLayer.Show(this);
        LayoutPlayer();
        barTimer!.Start();
    }

    /// <summary>Raderna och muslagret efter fönstrets storlek; muslagret täcker bara bilden mellan raderna</summary>
    void LayoutPlayer()
    {
        if (playerBar == null || controls == null) return;
        var w = ClientSize.Width; var h = ClientSize.Height;
        playerBar.Bounds = new Rectangle(0, 0, w, playerBar.Height);
        controls.Bounds = new Rectangle(0, h - ControlBar.BarHeight, w, ControlBar.BarHeight);
        if (mouseLayer is { IsDisposed: false } && player != null && WindowState != FormWindowState.Minimized)
        {
            var top = barsShown ? playerBar.Height : 0;
            var bottom = barsShown ? h - ControlBar.BarHeight : h;
            var r = RectangleToScreen(new Rectangle(0, top, w, Math.Max(1, bottom - top)));
            mouseLayer.Bounds = r;
        }
    }

    void SetBars(bool show)
    {
        barsShown = show;
        if (playerBar != null) { playerBar.Visible = show; if (show) playerBar.BringToFront(); }
        if (controls != null) { controls.Visible = show; if (show) controls.BringToFront(); }
        if (show) mouseLayer?.ShowCursor();
        else if (fullScreen) mouseLayer?.HideCursor();
        LayoutPlayer();
    }

    static Button BarButton(string text) => new()
    {
        Text = text, AutoSize = true, FlatStyle = FlatStyle.Flat, ForeColor = Color.White, BackColor = Color.FromArgb(0x2e, 0x2f, 0x33),
        Font = new Font("Segoe UI Semibold", 10.5f), Padding = new Padding(10, 2, 10, 2), Cursor = Cursors.Hand,
        FlatAppearance = { BorderColor = Color.FromArgb(0x38, 0x39, 0x3e), MouseOverBackColor = Color.FromArgb(0x3a, 0x3b, 0x40) },
    };

    void BarTick()
    {
        if (playerBar == null || controls == null || player == null) return;
        var p = player;
        var pos = Cursor.Position;
        if (pos != lastMouse) { lastMouse = pos; mouseMoved = DateTime.UtcNow; }
        bool Over(Control c) => c.Visible && c.RectangleToScreen(c.ClientRectangle).Contains(pos);
        var show = PlayerUi.ShowBars((DateTime.UtcNow - mouseMoved).TotalSeconds, Over(playerBar) || Over(controls) || controls.Dragging, p.Paused, playerStarted, openMenu?.Visible == true);
        if (show != barsShown) SetBars(show);
        // Värdena i kontrollraden
        if (!controls.Dragging) controls.Position = p.Position;
        if (p.Duration > 0) controls.Duration = p.Duration;
        controls.CachedUntil = p.CachedUntil;
        controls.Paused = p.Paused;
        if (p.Volume >= 0) controls.Volume = p.Volume;
        controls.Muted = p.Muted;
        controls.FullScreen = fullScreen;
        controls.SleepLabel = sleepAfter ? L.T("efter avsnittet", "after this one") : sleepAt is DateTime at ? $"{Math.Max(1, (int)Math.Ceiling((at - DateTime.Now).TotalMinutes))} min" : "";
        if (barsShown) controls.Invalidate();
        // Sovtimern: pausar när tiden är ute
        if (sleepAt is DateTime t && DateTime.Now >= t)
        {
            sleepAt = null;
            if (!p.Paused) p.TogglePause();
            p.ShowText(L.T("Sovtimern pausade filmen", "The sleep timer paused the video"), 4000);
            Logg.Write("sovtimern pausade");
        }
        // Tangenterna ska till appen: har mpv:s fönster tagit fokus läggs det tillbaka på panelen
        if (ActiveForm == this && openMenu?.Visible != true)
        {
            var f = Native.GetFocus();
            if (f != IntPtr.Zero && FromHandle(f) == null) playerPanel?.Focus();
        }
    }

    void RemoveBar()
    {
        barTimer?.Stop();
        if (playerBar != null) playerBar.Visible = false;
        if (controls != null) controls.Visible = false;
        openMenu?.Close();
        if (mouseLayer is { IsDisposed: false }) { mouseLayer.ShowCursor(); mouseLayer.Hide(); }
    }

    /// <summary>Tangenterna medan den inbyggda spelaren visas (MainForm.ProcessCmdKey)</summary>
    bool PlayerKey(Keys keyData)
    {
        if (player == null) return false;
        var a = PlayerUi.ForKey((int)(keyData & Keys.KeyCode), keyData.HasFlag(Keys.Shift), keyData.HasFlag(Keys.Control), keyData.HasFlag(Keys.Alt));
        if (a == PlayerAction.None) return false;
        mouseMoved = DateTime.UtcNow - TimeSpan.FromSeconds(a is PlayerAction.TogglePause or PlayerAction.Back10 or PlayerAction.Forward10 ? 0 : 10);
        DoAction(a);
        return true;
    }

    void DoAction(PlayerAction a)
    {
        var p = player;
        if (p == null) return;
        switch (a)
        {
            case PlayerAction.TogglePause: p.TogglePause(); break;
            case PlayerAction.Back10: p.SeekBy(-10); break;
            case PlayerAction.Forward10: p.SeekBy(10); break;
            case PlayerAction.VolumeUp or PlayerAction.VolumeDown:
            {
                var v = PlayerUi.Volume(p.Muted ? 0 : Math.Max(0, p.Volume), a == PlayerAction.VolumeUp ? 5 : -5);
                p.SetVolume(v);
                if (p.Muted) p.Set("mute", "no");
                p.ShowText(L.T($"Volym {v} %", $"Volume {v}%"));
                break;
            }
            case PlayerAction.Mute: p.Send("cycle", "mute"); p.ShowText(p.Muted ? L.T("Ljud på", "Sound on") : L.T("Ljud av", "Muted")); break;
            case PlayerAction.Fullscreen: SetFullScreen(!fullScreen); break;
            case PlayerAction.Escape: if (fullScreen) SetFullScreen(false); else ClosePlayer(); break;
            case PlayerAction.Close or PlayerAction.Stop: ClosePlayer(); break;
            case PlayerAction.Next: Next(); break;
            case PlayerAction.CycleAudio: p.Send("cycle", "audio"); p.Send("show-text", "${track-list/${current-tracks/audio/id}/lang:}  ${current-tracks/audio/title:}", "2000"); break;
            case PlayerAction.ToggleSubs:
            {
                var subs = p.Tracks("sub");
                var sel = subs.FirstOrDefault(s => s.Selected);
                if (sel != null) { lastSid = sel.Id; p.Set("sid", "no"); p.ShowText(L.T("Undertexter av", "Subtitles off")); }
                else if (subs.Count > 0)
                {
                    var t = subs.FirstOrDefault(s => s.Id == lastSid) ?? subs[0];
                    p.Set("sid", t.Id.ToString(CultureInfo.InvariantCulture));
                    p.ShowText(L.T("Undertext: ", "Subtitles: ") + PlayerUi.TrackLabel(t.Title, t.Lang, null, null, t.Id));
                }
                else p.ShowText(L.T("Inga undertexter", "No subtitles"));
                break;
            }
            case PlayerAction.Stats: p.Send("script-binding", "stats/display-stats-toggle"); break;
        }
        BarTick();
    }

    void OnControlClick(string id, Point at)
    {
        switch (id)
        {
            case "back10": DoAction(PlayerAction.Back10); break;
            case "fwd10": DoAction(PlayerAction.Forward10); break;
            case "toggle": DoAction(PlayerAction.TogglePause); break;
            case "next": Next(); break;
            case "stop": ClosePlayer(); break;
            case "mute": DoAction(PlayerAction.Mute); break;
            case "fullscreen": SetFullScreen(!fullScreen); break;
            case "settings": ShowMenu(SettingsMenu(), at, above: true); break;
            case "sleep": ShowMenu(SleepMenu(), at, above: true); break;
        }
    }

    // ---------- menyerna (mörka, som resten av spelaren) ----------
    void ShowMenu(ContextMenuStrip m, Point at, bool above = false)
    {
        openMenu?.Close();
        openMenu = m;
        m.Closed += (_, _) => { BeginInvoke(() => { m.Dispose(); if (openMenu == m) openMenu = null; }); };
        if (above) m.Show(at, ToolStripDropDownDirection.AboveRight);
        else m.Show(at);
    }

    static ContextMenuStrip DarkMenu() => new()
    {
        Renderer = new ToolStripProfessionalRenderer(new DarkColors()) { RoundedEdges = false },
        ForeColor = Color.FromArgb(0xEC, 0xEC, 0xEC), BackColor = Color.FromArgb(0x1E, 0x1F, 0x22), ShowImageMargin = false, ShowCheckMargin = true,
        Font = new Font("Segoe UI", 10f),
    };

    static ToolStripMenuItem Item(string text, Action? click = null, bool check = false, bool enabled = true)
    {
        var i = new ToolStripMenuItem(text) { Checked = check, Enabled = enabled, ForeColor = Color.FromArgb(0xEC, 0xEC, 0xEC) };
        if (click != null) i.Click += (_, _) => click();
        return i;
    }

    static void Dark(ToolStripMenuItem parent)
    {
        if (parent.DropDown is ToolStripDropDownMenu d) { d.ShowImageMargin = false; d.ShowCheckMargin = true; d.BackColor = Color.FromArgb(0x1E, 0x1F, 0x22); d.ForeColor = Color.FromArgb(0xEC, 0xEC, 0xEC); d.Renderer = new ToolStripProfessionalRenderer(new DarkColors()); }
    }

    ToolStripMenuItem AudioItems()
    {
        var root = Item(L.T("Ljudspår", "Audio track"));
        foreach (var t in player?.Tracks("audio") ?? [])
        {
            var id = t.Id;
            root.DropDownItems.Add(Item(PlayerUi.TrackLabel(t.Title, t.Lang, t.Codec, t.Channels, t.Id), () => player?.Set("aid", id.ToString(CultureInfo.InvariantCulture)), t.Selected));
        }
        if (root.DropDownItems.Count == 0) root.Enabled = false;
        Dark(root);
        return root;
    }

    ToolStripMenuItem SubItems()
    {
        var root = Item(L.T("Undertexter", "Subtitles"));
        var subs = player?.Tracks("sub") ?? [];
        root.DropDownItems.Add(Item(L.T("Av", "Off"), () => player?.Set("sid", "no"), !subs.Any(s => s.Selected)));
        foreach (var t in subs)
        {
            var id = t.Id;
            root.DropDownItems.Add(Item(PlayerUi.TrackLabel(t.Title, t.Lang, null, null, t.Id), () => { lastSid = id; player?.Set("sid", id.ToString(CultureInfo.InvariantCulture)); }, t.Selected));
        }
        Dark(root);
        return root;
    }

    ContextMenuStrip SettingsMenu()
    {
        var m = DarkMenu();
        m.Items.Add(AudioItems());
        m.Items.Add(SubItems());
        var p = player;
        double D(string name, double def) => double.TryParse(p?.Get(name), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : def;
        var size = Item(L.T("Undertextstorlek", "Subtitle size"));
        var scale = D("sub-scale", 1);
        foreach (var f in PlayerUi.SubScales) { var v = f; size.DropDownItems.Add(Item(PlayerUi.Factor(f, CultureInfo.CurrentCulture), () => player?.Set("sub-scale", v.ToString(CultureInfo.InvariantCulture)), Math.Abs(scale - f) < 0.01)); }
        Dark(size);
        m.Items.Add(size);
        var delay = D("sub-delay", 0);
        var sync = Item(L.T($"Undertextens tid ({delay:+0.0;−0.0;0} s)", $"Subtitle timing ({delay:+0.0;−0.0;0} s)"));
        sync.DropDownItems.Add(Item(L.T("Tidigare (−0,1 s)", "Earlier (−0.1 s)"), () => { player?.Send("add", "sub-delay", "-0.1"); player?.Send("show-text", "${sub-delay}"); }));
        sync.DropDownItems.Add(Item(L.T("Senare (+0,1 s)", "Later (+0.1 s)"), () => { player?.Send("add", "sub-delay", "0.1"); player?.Send("show-text", "${sub-delay}"); }));
        sync.DropDownItems.Add(Item(L.T("Återställ", "Reset"), () => player?.Set("sub-delay", "0"), enabled: delay != 0));
        Dark(sync);
        m.Items.Add(sync);
        var speedNow = D("speed", 1);
        var speed = Item(L.T("Hastighet", "Speed"));
        foreach (var f in PlayerUi.Speeds) { var v = f; speed.DropDownItems.Add(Item(PlayerUi.Factor(f, CultureInfo.CurrentCulture), () => player?.Set("speed", v.ToString(CultureInfo.InvariantCulture)), Math.Abs(speedNow - f) < 0.01)); }
        Dark(speed);
        m.Items.Add(speed);
        return m;
    }

    ContextMenuStrip SleepMenu()
    {
        var m = DarkMenu();
        foreach (var min in PlayerUi.SleepMinutes)
        {
            var v = min;
            var text = v == 0 ? L.T("Av", "Off") : v < 0 ? L.T("När avsnittet eller filmen är slut", "When this episode or film ends") : $"{v} min";
            var on = v == 0 ? sleepAt == null && !sleepAfter : v < 0 ? sleepAfter : false;
            m.Items.Add(Item(text, () =>
            {
                sleepAt = v > 0 ? DateTime.Now.AddMinutes(v) : null;
                sleepAfter = v < 0;
                Logg.Write("sovtimer: " + (v == 0 ? "av" : v < 0 ? "efter titeln" : v + " min"));
            }, on));
        }
        return m;
    }

    /// <summary>Högerklick på bilden: spår, spelarens val och vägen tillbaka till webbspelaren</summary>
    ContextMenuStrip VideoMenu()
    {
        var m = DarkMenu();
        m.Items.Add(Item(player?.Paused == true ? L.T("Spela", "Play") : L.T("Paus", "Pause"), () => DoAction(PlayerAction.TogglePause)));
        m.Items.Add(AudioItems());
        m.Items.Add(SubItems());
        m.Items.Add(new ToolStripSeparator());
        m.Items.Add(Item(L.T("Ljud orört till förstärkaren (från nästa film)", "Send audio untouched to the receiver (from the next video)"), () => PlayerMenu(MenuPassthrough), cfg.Passthrough));
        m.Items.Add(Item(L.T("Byt skärmens uppdateringsfrekvens efter filmen", "Match the display refresh rate to the video"), () => PlayerMenu(MenuRefresh), cfg.MatchRefresh));
        m.Items.Add(Item(L.T("Använd den inbyggda spelaren", "Use the built-in player"), () => PlayerMenu(MenuPlayer), cfg.UseBuiltInPlayer));
        m.Items.Add(Item(L.T("Om den inbyggda spelaren …", "About the built-in player …"), MpvInfo));
        m.Items.Add(new ToolStripSeparator());
        m.Items.Add(Item(L.T("Spela den här filmen i webbspelaren", "Play this video in the web player"), ToWebPlayer));
        m.Items.Add(Item(L.T("Tillbaka (Q)", "Back (Q)"), () => ClosePlayer()));
        return m;
    }

    /// <summary>Webbspelaren tar över där filmen är (webben: native-failed med user, utan felmeddelande)</summary>
    void ToWebPlayer()
    {
        var p = player;
        if (p == null) return;
        Logg.Write($"titel {p.Request.Id}: tillbaka till webbspelaren på {p.Position:0} s");
        PostNative(new { t = "native-failed", id = p.Request.Id, pos = playerStarted ? p.Position : p.Request.Start, user = true });
        ClosePlayer(notify: false);
    }

    sealed class DarkColors : ProfessionalColorTable
    {
        static readonly Color Bg = Color.FromArgb(0x1E, 0x1F, 0x22), Sel = Color.FromArgb(0x33, 0x35, 0x3A), Line = Color.FromArgb(0x38, 0x39, 0x3E);
        public override Color ToolStripDropDownBackground => Bg;
        public override Color ImageMarginGradientBegin => Bg;
        public override Color ImageMarginGradientMiddle => Bg;
        public override Color ImageMarginGradientEnd => Bg;
        public override Color MenuBorder => Line;
        public override Color MenuItemBorder => Sel;
        public override Color MenuItemSelected => Sel;
        public override Color MenuItemSelectedGradientBegin => Sel;
        public override Color MenuItemSelectedGradientEnd => Sel;
        public override Color SeparatorDark => Line;
        public override Color SeparatorLight => Bg;
        public override Color CheckBackground => Sel;
        public override Color CheckSelectedBackground => Sel;
        public override Color CheckPressedBackground => Sel;
    }

    // ---------- viloläge: webbsidan och spelaren var för sig ----------
    string webAwake = "none";
    void UpdateAwake() => SetAwake(player != null && playerStarted && !player.Paused ? "video" : webAwake);

    // ---------- inställningar i fönstermenyn ----------
    const uint MenuPlayer = 0x1100, MenuPassthrough = 0x1110, MenuRefresh = 0x1120, MenuMpvInfo = 0x1130, MenuMpvGet = 0x1140;

    /// <summary>"Hämta …" när ingen mpv finns i appens mapp, annars "Uppdatera …"</summary>
    static string MpvGetLabel() => File.Exists(Path.Combine(Libmpv.Folder, Libmpv.FileName))
        ? L.T("Uppdatera den inbyggda spelaren …", "Update the built-in player …")
        : L.T("Hämta den inbyggda spelaren (mpv) …", "Download the built-in player (mpv) …");

    void UpdateMpvMenu()
    {
        if (Libmpv.Bundled || !IsHandleCreated) return;
        Native.ModifyMenu(Native.GetSystemMenu(Handle, false), MenuMpvGet, Native.MF_BYCOMMAND | Native.MF_STRING, MenuMpvGet, MpvGetLabel());
    }

    void AddPlayerMenu(IntPtr menu)
    {
        Native.AppendMenu(menu, Native.MF_SEPARATOR, 0, null);
        Native.AppendMenu(menu, Native.MF_STRING | (cfg.UseBuiltInPlayer ? Native.MF_CHECKED : 0), MenuPlayer, L.T("Använd den inbyggda spelaren", "Use the built-in player"));
        Native.AppendMenu(menu, Native.MF_STRING | (cfg.Passthrough ? Native.MF_CHECKED : 0), MenuPassthrough, L.T("Ljud orört till förstärkaren (AC3, DTS, TrueHD)", "Send audio untouched to the receiver (AC3, DTS, TrueHD)"));
        Native.AppendMenu(menu, Native.MF_STRING | (cfg.MatchRefresh ? Native.MF_CHECKED : 0), MenuRefresh, L.T("Byt skärmens uppdateringsfrekvens efter filmen", "Match the display refresh rate to the video"));
        // Följer mpv med installationen (bredvid BraXhnTV.exe) uppdateras den med appen – då ingen hämtning
        if (!Libmpv.Bundled) Native.AppendMenu(menu, Native.MF_STRING, MenuMpvGet, MpvGetLabel());
        Native.AppendMenu(menu, Native.MF_STRING, MenuMpvInfo, L.T("Om den inbyggda spelaren …", "About the built-in player …"));
    }

    /// <summary>Spelarens val i högerklicksmenyn (samma som i fönstermenyn)</summary>
    void AddPlayerItems(Action<uint, string, bool?> add)
    {
        add(MenuPlayer, L.T("Använd den inbyggda spelaren", "Use the built-in player"), cfg.UseBuiltInPlayer);
        add(MenuPassthrough, L.T("Ljud orört till förstärkaren (AC3, DTS, TrueHD)", "Send audio untouched to the receiver (AC3, DTS, TrueHD)"), cfg.Passthrough);
        add(MenuRefresh, L.T("Byt skärmens uppdateringsfrekvens efter filmen", "Match the display refresh rate to the video"), cfg.MatchRefresh);
        if (!Libmpv.Bundled) add(MenuMpvGet, MpvGetLabel(), null);
        add(MenuMpvInfo, L.T("Om den inbyggda spelaren …", "About the built-in player …"), null);
    }

    void GetMpv()
    {
        var update = File.Exists(Path.Combine(Libmpv.Folder, Libmpv.FileName));
        MpvSetup.Offer(this, update);
        UpdateMpvMenu();
    }

    bool PlayerMenu(uint id)
    {
        var menu = Native.GetSystemMenu(Handle, false);
        void Check(uint item, bool on) => Native.CheckMenuItem(menu, item, Native.MF_BYCOMMAND | (on ? Native.MF_CHECKED : Native.MF_UNCHECKED));
        switch (id)
        {
            case MenuPlayer: cfg.UseBuiltInPlayer = !cfg.UseBuiltInPlayer; cfg.Save(); Check(MenuPlayer, cfg.UseBuiltInPlayer); return true;
            case MenuPassthrough: cfg.Passthrough = !cfg.Passthrough; cfg.Save(); Check(MenuPassthrough, cfg.Passthrough); return true;
            case MenuRefresh: cfg.MatchRefresh = !cfg.MatchRefresh; cfg.Save(); Check(MenuRefresh, cfg.MatchRefresh); return true;
            case MenuMpvInfo: MpvInfo(); return true;
            case MenuMpvGet: BeginInvoke(GetMpv); return true;
        }
        return false;
    }

    // ---------- serverns version: den inbyggda spelaren kräver 1.4.1 eller senare på servern ----------
    readonly Dictionary<string, string?> serverVersions = new();
    DateTime serverChecked;

    /// <summary>Fönstret aktiveras: har servern uppdaterats medan appen var öppen? (högst var 30:e minut)</summary>
    protected override void OnActivated(EventArgs e)
    {
        base.OnActivated(e);
        if (current == null || DateTime.UtcNow - serverChecked < TimeSpan.FromMinutes(30) || !serverVersions.ContainsKey(current.Id)) return;
        serverVersions.Remove(current.Id);
        _ = CheckServerAsync(current);
    }

    static string OldServerText(string version) => L.T(
        $"Den inbyggda spelaren kräver BraXhn TV {ServerInfo.MinNative} eller senare på servern – uppdatera servern (den har {version}). Till dess spelar webbspelaren allt.",
        $"The built-in player requires BraXhn TV {ServerInfo.MinNative} or later on the server – update the server (it has {version}). Until then the web player plays everything.");

    /// <summary>Frågar servern om dess version (en gång per server och körning) och säger till en gång om den är för gammal</summary>
    async Task CheckServerAsync(ServerEntry sv)
    {
        if (serverVersions.ContainsKey(sv.Id)) return;
        serverVersions[sv.Id] = null;
        string? v;
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            http.DefaultRequestHeaders.UserAgent.ParseAdd("BraXhnTV-Windows/" + AppInfo.Version);
            v = ServerInfo.VersionFromStatus(await http.GetStringAsync(sv.Url + "/api/status"));
        }
        catch (Exception ex)
        {
            serverVersions.Remove(sv.Id); // nästa sidladdning försöker igen
            Logg.Write($"server {Address.Label(sv.Url)}: versionen gick inte att läsa – {ex.GetType().Name}");
            return;
        }
        serverVersions[sv.Id] = v;
        serverChecked = DateTime.UtcNow;
        // Servern har bytt version sedan förra gången: sidan kan vara den gamla (ur tjänstearbetarens cache om servern
        // svarade långsamt, eller öppen sedan före uppdateringen). Ladda om en gång, så att webbappen – och kroken till
        // den inbyggda spelaren – är serverns nya. Spelas något just nu: bara ett meddelande.
        if (v != null)
        {
            cfg.ServerSeen.TryGetValue(sv.Id, out var seen);
            if (seen != v) { cfg.ServerSeen[sv.Id] = v; cfg.Save(); }
            if (seen != null && seen != v && current?.Id == sv.Id)
            {
                Logg.Write($"server {Address.Label(sv.Url)}: ny version {seen} → {v}");
                if (player == null && webAwake == "none") { web?.CoreWebView2?.Reload(); return; }
                try { web?.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new { t = "app-note", text = L.T($"Servern har uppdaterats till {v}. Högerklicka och välj Ladda om när filmen är slut.", $"The server has been updated to {v}. Right-click and choose Reload when the video ends."), ms = 15000 })); } catch { }
            }
        }
        var old = ServerInfo.TooOldForNative(v);
        Logg.Write($"server {Address.Label(sv.Url)}: version {v ?? "okänd"}{(old ? $" – för gammal för den inbyggda spelaren (kräver {ServerInfo.MinNative})" : "")}");
        if (!old || !cfg.UseBuiltInPlayer || current?.Id != sv.Id) return;
        var key = sv.Url + "|" + v;
        if (cfg.ServerNotes.Contains(key)) return;
        cfg.ServerNotes.Add(key);
        cfg.Save();
        try { web?.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new { t = "app-note", text = OldServerText(v!), ms = 20000 })); } catch { }
    }

    /// <summary>Om den inbyggda spelaren: vad som provades, vad som fungerar och vad man ska göra</summary>
    string MpvReport(out string heading, out Libmpv? lib)
    {
        lib = Libmpv.Load(out var err);
        var sb = new System.Text.StringBuilder();
        string? sver = null;
        var hasServer = current != null && serverVersions.TryGetValue(current.Id, out sver);
        var oldServer = hasServer && ServerInfo.TooOldForNative(sver);
        var version = lib != null ? (mpvVersion ??= SafeVersion(lib)) : null;
        heading = !cfg.UseBuiltInPlayer ? L.T("Den inbyggda spelaren är avstängd", "The built-in player is turned off")
            : oldServer ? L.T("Servern behöver uppdateras", "The server needs an update")
            : lib != null ? L.T("Den inbyggda spelaren (mpv) är klar", "The built-in player (mpv) is ready")
            : Libmpv.LastAttempts.All(a => a.Outcome == Libmpv.Outcome.Missing) ? L.T("Den inbyggda spelaren (mpv) är inte hämtad", "The built-in player (mpv) has not been downloaded")
            : L.T("Den inbyggda spelaren (mpv) gick inte att starta", "The built-in player (mpv) could not be started");

        if (oldServer) sb.AppendLine(OldServerText(sver!)).AppendLine();
        else if (lib == null && cfg.UseBuiltInPlayer)
            sb.AppendLine(Libmpv.Bundled
                ? L.T("Webbspelaren används. mpv följer med appen men gick inte att starta – installera om BraXhn TV.", "The web player is used. mpv comes with the app but could not be started – reinstall BraXhn TV.")
                : L.T("Webbspelaren används. Klicka Hämta för att hämta mpv (ca 30 MB) – appen väljer rätt fil och använder den direkt.",
                      "The web player is used. Click Download to get mpv (about 30 MB) – the app picks the right file and uses it right away.")).AppendLine();

        if (lastSkip != null) sb.AppendLine(L.T("Senaste filmen: webbspelaren användes eftersom ", "Last video: the web player was used because ") + lastSkip + ".").AppendLine();
        sb.AppendLine(L.T("Servern: ", "Server: ") + (current == null ? "–" : Address.Label(current.Url) + ", " +
            (sver == null ? L.T("versionen okänd", "version unknown") : $"{L.T("version", "version")} {sver} " +
                (oldServer ? L.T($"(kräver {ServerInfo.MinNative})", $"(needs {ServerInfo.MinNative})") : "✓"))));
        sb.AppendLine("mpv: " + (version ?? (lib != null ? L.T("laddad", "loaded") : L.T("saknas", "missing"))));
        if (lib != null) sb.AppendLine(L.T("Fil: ", "File: ") + lib.Path);
        var src = MpvSetup.Installed();
        if (src != null) sb.AppendLine(L.T("Hämtad: ", "Downloaded: ") + $"{src.Name} ({src.Fetched.ToLocalTime():yyyy-MM-dd})");
        if (File.Exists(Libmpv.Pending)) sb.AppendLine(L.T("En nyare version används när appen startas om.", "A newer version is used when the app restarts."));
        sb.AppendLine().AppendLine(L.T("Platser som provades:", "Places that were tried:"));
        foreach (var a in Libmpv.LastAttempts)
        {
            sb.Append("• ").Append(a.Path).Append(" – ").AppendLine(a.Outcome switch
            {
                Libmpv.Outcome.Missing => L.T("finns inte", "not found"),
                Libmpv.Outcome.Loaded => L.T("hittad och laddad", "found and loaded"),
                Libmpv.Outcome.WrongArch => L.T($"fel sorts fil ({a.Machine}, datorn behöver {Libmpv.ProcessMachine}) – ta bort den och klicka Hämta",
                                                $"wrong kind of file ({a.Machine}, this computer needs {Libmpv.ProcessMachine}) – delete it and click Download"),
                Libmpv.Outcome.TooOld => L.T($"för gammal ({a.Detail}) – klicka Uppdatera", $"too old ({a.Detail}) – click Update"),
                Libmpv.Outcome.NeedsNewerCpu => L.T("kräver en processor med AVX2 (troligen varianten x86_64-v3) – ta bort den och klicka Hämta, så tar appen varianten som fungerar på alla datorer",
                                                    "needs a processor with AVX2 (probably the x86_64-v3 variant) – delete it and click Download; the app picks the variant that works on all computers"),
                _ => L.T("hittad men gick inte att ladda: ", "found but could not be loaded: ") + a.Detail,
            });
        }
        if (Libmpv.LastAttempts.Any(a => a.Outcome is Libmpv.Outcome.NotLoadable or Libmpv.Outcome.NeedsNewerCpu) && !System.Runtime.Intrinsics.X86.Avx2.IsSupported)
            sb.AppendLine(L.T("Processorn saknar AVX2, så varianten x86_64-v3 fungerar inte här. Klicka Hämta – appen tar varianten som fungerar på alla datorer.",
                              "The processor lacks AVX2, so the x86_64-v3 variant does not work here. Click Download – the app picks the variant that works on all computers."));
        sb.AppendLine().AppendLine(L.T(
            "När spelas filmen i mpv? När servern kan skicka originalfilen orörd. Utanför hemmet (via den publika adressen, även hemifrån) med kvalitet Auto gäller det när uppkopplingen rymmer filen med 10 % marginal eller inte hann mätas, och filen ryms inom upplösningstaket utanför hemmet. Familjefilter, vald lägre kvalitet, trailers före filmen och Titta tillsammans spelas i webbspelaren.",
            "When does a video play in mpv? When the server can send the original file untouched. Away from home (through the public address, even from home) with Auto quality, that is when the connection fits the file with a 10% margin or could not be measured, and the file is within the away-from-home resolution cap. Family filter, a lower chosen quality, trailers before the film and Watch together use the web player."));
        sb.AppendLine().Append(L.T("Logg: ", "Log: ")).AppendLine(Logg.FilePath);
        sb.Append(L.T("mpv är fri programvara (LGPL/GPL), https://mpv.io.", "mpv is free software (LGPL/GPL), https://mpv.io."));
        if (err != null && lib == null) Logg.Write("om den inbyggda spelaren: " + err);
        return sb.ToString();
    }

    static string? mpvVersion;
    static string? SafeVersion(Libmpv lib) { try { return lib.MpvVersion(); } catch { return null; } }

    void MpvInfo()
    {
        var text = MpvReport(out var heading, out var lib);
        var get = new TaskDialogButton(File.Exists(Path.Combine(Libmpv.Folder, Libmpv.FileName)) ? L.T("Uppdatera …", "Update …") : L.T("Hämta …", "Download …"));
        var open = new TaskDialogButton(L.T("Öppna mappen", "Open the folder"));
        var copy = new TaskDialogButton(L.T("Kopiera felsökningsinformation", "Copy troubleshooting info")) { AllowCloseDialog = false };
        copy.Click += (_, _) =>
        {
            try
            {
                Clipboard.SetText($"{AppInfo.Name} {AppInfo.Version} (Windows {Environment.OSVersion.Version}, {System.Runtime.InteropServices.RuntimeInformation.OSArchitecture}, AVX2 {(System.Runtime.Intrinsics.X86.Avx2.IsSupported ? "ja" : "nej")})\n\n{heading}\n{text}\n\n--- {Logg.FilePath} ---\n{Logg.Tail()}");
                copy.Text = L.T("Kopierat – klistra in i Feedback", "Copied – paste it into Feedback");
            }
            catch { }
        };
        var page = new TaskDialogPage
        {
            Caption = AppInfo.Name,
            Icon = lib != null && cfg.UseBuiltInPlayer ? TaskDialogIcon.Information : TaskDialogIcon.Warning,
            Heading = heading,
            Text = text,
            Buttons = { open, copy, TaskDialogButton.Close },
        };
        if (!Libmpv.Bundled) page.Buttons.Insert(0, get);
        var answer = TaskDialog.ShowDialog(this, page);
        if (answer == get) BeginInvoke(GetMpv);
        else if (answer == open)
        {
            try { Directory.CreateDirectory(Libmpv.Folder); System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Libmpv.Folder) { UseShellExecute = true }); } catch { }
        }
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        LayoutPlayer();
    }

    protected override void OnMove(EventArgs e)
    {
        base.OnMove(e);
        LayoutPlayer();
    }
}
