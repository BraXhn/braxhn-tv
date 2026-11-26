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
        if (playerBar != null) playerBar.Width = ClientSize.Width;
    }
}
