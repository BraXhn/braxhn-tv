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
    bool NativeReady() => cfg.UseBuiltInPlayer && Libmpv.Load(out _) != null;

    void PostNative(object msg)
    {
        try { web?.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(msg)); } catch { }
    }

    void OnNativeMessage(string t, JsonNode? m)
    {
        switch (t)
        {
            case "native-check":
                PostNative(new { t = "native-ready", ok = NativeReady() });
                break;
            case "native-play":
                PlayNative(m);
                break;
            case "native-stop":
                if (player != null && player.Request.Id == (m?["id"]?.GetValue<long>() ?? -1)) ClosePlayer();
                break;
        }
    }

    void PlayNative(JsonNode? m)
    {
        PlayRequest req;
        try { req = ParseRequest(m); }
        catch { PostNative(new { t = "native-failed", id = m?["id"]?.GetValue<long>() ?? 0 }); return; }
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
                PostNative(new { t = "native-failed", id = req.Id, pos = playerStarted ? p.Position : req.Start, error = why });
                ClosePlayer(notify: false);
            };
            p.Ended += () => { if (player == p) PostNative(new { t = "native-ended", id = req.Id, pos = p.Position }); };
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

    // ---------- raden överst: Tillbaka, titeln och Nästa avsnitt (visas när musen rör sig) ----------
    void EnsureBar(PlayRequest req)
    {
        if (playerBar == null)
        {
            playerBar = new Panel { Height = 52, BackColor = Color.FromArgb(0x14, 0x15, 0x17), Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right, Padding = new Padding(10, 8, 10, 8) };
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
            barTimer = new System.Windows.Forms.Timer { Interval = 300 };
            barTimer.Tick += (_, _) => BarTick();
        }
        playerBar.Bounds = new Rectangle(0, 0, ClientSize.Width, playerBar.Height);
        barTitle!.Text = req.Title;
        nextButton!.Visible = req.NextId != null;
        playerBar.Visible = true;
        playerBar.BringToFront();
        mouseMoved = DateTime.UtcNow;
        lastMouse = Cursor.Position;
        barTimer!.Start();
    }

    static Button BarButton(string text) => new()
    {
        Text = text, AutoSize = true, FlatStyle = FlatStyle.Flat, ForeColor = Color.White, BackColor = Color.FromArgb(0x2e, 0x2f, 0x33),
        Font = new Font("Segoe UI Semibold", 10.5f), Padding = new Padding(10, 2, 10, 2), Cursor = Cursors.Hand,
        FlatAppearance = { BorderColor = Color.FromArgb(0x38, 0x39, 0x3e), MouseOverBackColor = Color.FromArgb(0x3a, 0x3b, 0x40) },
    };

    void BarTick()
    {
        if (playerBar == null || player == null) return;
        var pos = Cursor.Position;
        if (pos != lastMouse) { lastMouse = pos; mouseMoved = DateTime.UtcNow; }
        var over = playerBar.Visible && playerBar.RectangleToScreen(playerBar.ClientRectangle).Contains(pos);
        var show = over || (DateTime.UtcNow - mouseMoved).TotalSeconds < 3 || !playerStarted || player.Paused;
        if (show != playerBar.Visible) { playerBar.Visible = show; if (show) playerBar.BringToFront(); }
        playerBar.Width = ClientSize.Width;
    }

    void RemoveBar()
    {
        barTimer?.Stop();
        if (playerBar != null) playerBar.Visible = false;
    }

    // ---------- viloläge: webbsidan och spelaren var för sig ----------
    string webAwake = "none";
    void UpdateAwake() => SetAwake(player != null && playerStarted && !player.Paused ? "video" : webAwake);

    // ---------- inställningar i fönstermenyn ----------
    const uint MenuPlayer = 0x1100, MenuPassthrough = 0x1110, MenuRefresh = 0x1120, MenuMpvInfo = 0x1130;

    void AddPlayerMenu(IntPtr menu)
    {
        Native.AppendMenu(menu, Native.MF_SEPARATOR, 0, null);
        Native.AppendMenu(menu, Native.MF_STRING | (cfg.UseBuiltInPlayer ? Native.MF_CHECKED : 0), MenuPlayer, L.T("Använd den inbyggda spelaren", "Use the built-in player"));
        Native.AppendMenu(menu, Native.MF_STRING | (cfg.Passthrough ? Native.MF_CHECKED : 0), MenuPassthrough, L.T("Ljud orört till förstärkaren (AC3, DTS, TrueHD)", "Send audio untouched to the receiver (AC3, DTS, TrueHD)"));
        Native.AppendMenu(menu, Native.MF_STRING | (cfg.MatchRefresh ? Native.MF_CHECKED : 0), MenuRefresh, L.T("Byt skärmens uppdateringsfrekvens efter filmen", "Match the display refresh rate to the video"));
        Native.AppendMenu(menu, Native.MF_STRING, MenuMpvInfo, L.T("Om den inbyggda spelaren …", "About the built-in player …"));
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
        }
        return false;
    }

    void MpvInfo()
    {
        var lib = Libmpv.Load(out var err);
        var folder = Path.Combine(AppSettings.Dir, "mpv");
        var open = new TaskDialogButton(L.T("Öppna mappen", "Open the folder"));
        var page = new TaskDialogPage
        {
            Caption = AppInfo.Name,
            Heading = lib != null ? L.T("Den inbyggda spelaren (mpv) finns", "The built-in player (mpv) is available") : L.T("Den inbyggda spelaren (mpv) saknas", "The built-in player (mpv) is missing"),
            Text = (lib != null
                    ? L.T("Filmer som servern kan skicka orörda spelas i mpv. Annars används webbspelaren.\n\nFil: ", "Videos the server can send untouched play in mpv. Otherwise the web player is used.\n\nFile: ") + lib.Path
                    : L.T("Webbspelaren används. Lägg libmpv-2.dll i mappen nedan och starta om appen, så används mpv (se README för apps/windows).",
                          "The web player is used. Put libmpv-2.dll in the folder below and restart the app to use mpv (see the apps/windows README).") + "\n\n" + folder + (err != null ? "\n\n" + err : ""))
                   + L.T("\n\nmpv är fri programvara (LGPL/GPL), https://mpv.io. Licenstexterna finns i appens mapp.", "\n\nmpv is free software (LGPL/GPL), https://mpv.io. The licence texts are in the app's folder."),
            Buttons = { open, TaskDialogButton.OK },
        };
        if (TaskDialog.ShowDialog(this, page) == open)
        {
            try { Directory.CreateDirectory(folder); System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(folder) { UseShellExecute = true }); } catch { }
        }
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (playerBar != null) playerBar.Width = ClientSize.Width;
    }
}
