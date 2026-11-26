using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;
using BraXhnTV.Spelare;

namespace BraXhnTV;

/// <summary>
/// Huvudfönstret: serverns webbapp i WebView2. Varje server har en egen användardatamapp (inloggning och kakor),
/// så webbvyn skapas om när man byter server. Välj server, Lägg till server och felsidan är lokala sidor
/// (Sidor/start.html) som pratar med appen via postMessage.
/// </summary>
sealed partial class MainForm : Form
{
    public static readonly Color Bg = Color.FromArgb(0x1b, 0x1c, 0x1f);
    readonly AppSettings cfg = AppSettings.Load();
    readonly bool autostart;
    WebView2? web;
    string webKey = "-";          // vilken användardatamapp webbvyn har ("" = appens egen, annars serverns id)
    ServerEntry? current;         // servern som är öppen (null när en lokal sida visas utan server)
    string lastUrl = "";          // senaste adressen hos servern (för Försök igen)
    bool fullScreen;
    FormWindowState preFullState;
    Rectangle preFullBounds;
    string awake = "none";

    // Fönstermenyn
    const uint MenuServers = 0x1000, MenuAdd = 0x1010, MenuAutostart = 0x1020, MenuUpdates = 0x1030, MenuAbout = 0x1040, MenuReload = 0x1050;

    public MainForm(bool autostart)
    {
        this.autostart = autostart;
        // Utan AVX2 provas libmpv i en egen process först (en x86_64-v3-byggnad skulle annars krascha appen)
        if (!System.Runtime.Intrinsics.X86.Avx2.IsSupported) Libmpv.Precheck = MpvProbe.Run;
        Logg.Write($"start: {AppInfo.Name} {AppInfo.Version}, Windows {Environment.OSVersion.Version}, {System.Runtime.InteropServices.RuntimeInformation.OSArchitecture}, AVX2 {(System.Runtime.Intrinsics.X86.Avx2.IsSupported ? "ja" : "nej")}");
        Text = AppInfo.Name;
        BackColor = Bg;
        MinimumSize = new Size(480, 320);
        StartPosition = FormStartPosition.Manual;
        KeyPreview = true;
        try { Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath ?? Application.ExecutablePath); } catch { }
        RestorePlacement();
        cfg.CleanUp();
    }

    // ---------- start ----------
    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        if (autostart) WindowState = FormWindowState.Minimized;
        if (cfg.Servers.Count == 1) await OpenServer(cfg.Servers[0]);
        else if (cfg.Servers.Count == 0) await ShowLocal("add");
        else await ShowLocal("pick");
        await Task.Delay(3000);
        await Updater.CheckAsync(this, cfg, manual: false);
    }

    public void ShowFromOutside()
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        Activate();
    }

    /// <summary>Webbvyn för en användardatamapp. Finns den redan används den, annars skapas en ny.</summary>
    async Task<CoreWebView2?> EnsureWeb(string key)
    {
        if (web?.CoreWebView2 != null && webKey == key) return web.CoreWebView2;
        if (web != null)
        {
            Controls.Remove(web);
            web.Dispose();
            web = null;
            SetAwake("none");
        }
        webKey = key;
        var folder = key == "" ? Path.Combine(AppSettings.Dir, "App") : AppSettings.ServerDir(key);
        try
        {
            Directory.CreateDirectory(folder);
            // HardwareMediaKeyHandling: medietangenter och Windows medieruta (SMTC) från webbens Media Session
            var opts = new CoreWebView2EnvironmentOptions("--enable-features=HardwareMediaKeyHandling,MediaSessionService");
            var env = await CoreWebView2Environment.CreateAsync(null, folder, opts);
            var w = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Bg };
            Controls.Add(w);
            w.BringToFront();
            await w.EnsureCoreWebView2Async(env);
            web = w;
            Setup(w.CoreWebView2);
            return w.CoreWebView2;
        }
        catch (Exception ex)
        {
            webKey = "-";
            TaskDialog.ShowDialog(this, new TaskDialogPage
            {
                Caption = AppInfo.Name, Icon = TaskDialogIcon.Error,
                Heading = L.T("Det gick inte att starta webbvyn", "Could not start the web view"),
                Text = L.T("Starta om appen. Hjälper inte det: installera om BraXhn TV.", "Restart the app. If that doesn't help, reinstall BraXhn TV.") + "\n\n" + ex.Message,
            });
            return null;
        }
    }

    void Setup(CoreWebView2 core)
    {
        var s = core.Settings;
        s.UserAgent = s.UserAgent + " BraXhnTV-Windows/" + AppInfo.Version;
        s.IsStatusBarEnabled = false;
        s.IsGeneralAutofillEnabled = true;
        s.IsPasswordAutosaveEnabled = true;
        // Utvecklarverktygen (Granska) bara för felsökning: "DevTools": true i installningar.json eller BRAXHN_DEVTOOLS=1
        s.AreDevToolsEnabled = cfg.DevTools || Environment.GetEnvironmentVariable("BRAXHN_DEVTOOLS") == "1";
        // Högerklick: webbappens egna menyer som förut; annars appens meny i stället för webbläsarens (se OnContextMenu)
        core.ContextMenuRequested += OnContextMenu;
        _ = core.AddScriptToExecuteOnDocumentCreatedAsync(Inject.Script);
        core.WebMessageReceived += OnMessage;
        core.NavigationStarting += OnNavigationStarting;
        core.NavigationCompleted += OnNavigationCompleted;
        core.NewWindowRequested += OnNewWindow;
        core.DownloadStarting += OnDownload;
        core.ContainsFullScreenElementChanged += (_, _) => SetFullScreen(core.ContainsFullScreenElement);
        core.DocumentTitleChanged += (_, _) =>
            Text = string.IsNullOrWhiteSpace(core.DocumentTitle) || core.DocumentTitle == "about:blank" ? AppInfo.Name : core.DocumentTitle;
        core.ProcessFailed += (_, e) =>
        {
            if (e.ProcessFailedKind is CoreWebView2ProcessFailedKind.BrowserProcessExited or CoreWebView2ProcessFailedKind.RenderProcessExited)
                BeginInvoke(async () => { webKey = "-"; if (current != null) await OpenServer(current); else await ShowLocal("pick"); });
        };
    }

    // ---------- servrar ----------
    async Task OpenServer(ServerEntry sv, string? url = null)
    {
        current = sv;
        cfg.LastServer = sv.Id;
        cfg.Save();
        var core = await EnsureWeb(sv.Id);
        core?.Navigate(url ?? sv.Url);
    }

    /// <summary>Visar en lokal sida: add (Lägg till server), pick (Välj server) eller error (servern svarar inte)</summary>
    async Task ShowLocal(string mode, string? label = null)
    {
        var core = await EnsureWeb(webKey is "-" ? (current?.Id ?? "") : webKey);
        if (core == null) return;
        var data = new JsonObject
        {
            ["lang"] = L.Sv ? "sv" : "en",
            ["mode"] = mode,
            ["def"] = cfg.Servers.Count == 0 ? Address.Label(Address.Default) : "",
            ["label"] = label ?? "",
            ["version"] = AppInfo.Version,
            ["logo"] = "data:image/png;base64," + Convert.ToBase64String(Resource("logo.png")),
            ["servers"] = new JsonArray(cfg.Servers.Select(s => (JsonNode)new JsonObject
            {
                ["id"] = s.Id, ["label"] = Address.Label(s.Url), ["current"] = s.Id == current?.Id,
            }).ToArray()),
        };
        var html = System.Text.Encoding.UTF8.GetString(Resource("start.html"))
            .Replace("/*DATA*/{}", data.ToJsonString().Replace("</", "<\\/"));
        Text = AppInfo.Name;
        core.NavigateToString(html);
    }

    static byte[] Resource(string name)
    {
        using var s = typeof(MainForm).Assembly.GetManifestResourceStream(name)!;
        using var m = new MemoryStream();
        s.CopyTo(m);
        return m.ToArray();
    }

    async Task AddServer(string input, bool force)
    {
        var url = Address.Normalize(input);
        if (url == "") { AddError("Adressen ser inte rätt ut. Skriv till exempel tv.braxhn.net.", "The address doesn't look right. Enter for example tv.braxhn.net.", false); return; }
        var old = cfg.Servers.FirstOrDefault(s => s.Url.Equals(url, StringComparison.OrdinalIgnoreCase));
        if (old != null) { await OpenServer(old); return; }
        if (!force)
        {
            var (ok, msgSv, msgEn) = await Check(url);
            if (!ok) { AddError(msgSv, msgEn, true); return; }
        }
        var sv = new ServerEntry { Id = DateTime.UtcNow.Ticks.ToString("x") + Random.Shared.Next(0x1000, 0xffff).ToString("x"), Url = url };
        cfg.Servers.Add(sv);
        await OpenServer(sv);
    }

    void AddError(string sv, string en, bool canForce) =>
        web?.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new { t = "addError", sv, en, canForce }));

    /// <summary>Är det en BraXhn TV-server? (/api/status svarar med name)</summary>
    static async Task<(bool, string, string)> Check(string url)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            http.DefaultRequestHeaders.UserAgent.ParseAdd("BraXhnTV-Windows/" + AppInfo.Version);
            using var r = await http.GetAsync(url + "/api/status");
            var body = await r.Content.ReadAsStringAsync();
            if (r.IsSuccessStatusCode && body.Contains("BraXhn TV")) return (true, "", "");
            return (false, $"Svaret från {Address.Label(url)} kommer inte från en BraXhn TV-server. Kontrollera adressen.",
                           $"The reply from {Address.Label(url)} doesn't come from a BraXhn TV server. Check the address.");
        }
        catch
        {
            return (false, $"Hittar ingen server på {Address.Label(url)}. Kontrollera adressen och att datorn är ansluten till internet.",
                           $"No server found at {Address.Label(url)}. Check the address and that the computer is connected to the internet.");
        }
    }

    async Task RemoveServer(string id)
    {
        var sv = cfg.Servers.FirstOrDefault(s => s.Id == id);
        if (sv == null) return;
        cfg.Servers.Remove(sv);
        if (cfg.LastServer == id) cfg.LastServer = null;
        cfg.Save();
        if (current?.Id == id) current = null;
        // Webbvyn för servern stängs innan dess mapp tas bort (det som inte går att ta bort nu tas bort vid nästa start)
        if (webKey == id) await EnsureWeb("");
        try { Directory.Delete(AppSettings.ServerDir(id), true); } catch { }
        await ShowLocal(cfg.Servers.Count == 0 ? "add" : "pick");
    }

    // ---------- meddelanden från sidorna ----------
    async void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonNode? m;
        try { m = JsonNode.Parse(e.WebMessageAsJson); } catch { return; }
        var t = m?["t"]?.GetValue<string>() ?? "";
        var local = !e.Source.StartsWith("http", StringComparison.OrdinalIgnoreCase);
        // Från alla sidor: uppspelning och tangenter
        switch (t)
        {
            case "media": webAwake = m?["s"]?.GetValue<string>() ?? "none"; UpdateAwake(); return;
            case "f11": ToggleFullScreen(); return;
            case "esc": if (fullScreen && web?.CoreWebView2?.ContainsFullScreenElement != true) SetFullScreen(false); return;
        }
        // Den inbyggda spelaren (från serverns sidor, se MainForm.Spelare.cs)
        if (t.StartsWith("native-", StringComparison.Ordinal)) { if (!local) OnNativeMessage(t, m); return; }
        // Bara från appens egna sidor: serverlistan
        if (!local) return;
        switch (t)
        {
            case "add": await AddServer(m?["url"]?.GetValue<string>() ?? "", m?["force"]?.GetValue<bool>() == true); break;
            case "open":
                var sv = cfg.Servers.FirstOrDefault(s => s.Id == m?["id"]?.GetValue<string>());
                if (sv != null) await OpenServer(sv);
                break;
            case "remove": await RemoveServer(m?["id"]?.GetValue<string>() ?? ""); break;
            case "pick": await ShowLocal(cfg.Servers.Count == 0 ? "add" : "pick"); break;
            case "retry": if (current != null) await OpenServer(current, Address.SameOrigin(lastUrl, current.Url) ? lastUrl : null); break;
        }
    }

    // ---------- navigering, länkar och nedladdningar ----------
    void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        var uri = e.Uri;
        if (!uri.StartsWith("http", StringComparison.OrdinalIgnoreCase))
        {
            // Lokala sidor (about:blank, data:) får visas; mailto och liknande går till Windows
            if (uri.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase)) { e.Cancel = true; AppInfo.OpenExternal(uri); }
            return;
        }
        // En länk till en annan webbplats som användaren klickar på öppnas i webbläsaren. Omdirigeringar (till exempel
        // enkel inloggning hos en annan leverantör) stannar i appen.
        if (current != null && !Address.SameOrigin(uri, current.Url) && e.IsUserInitiated && !e.IsRedirected)
        {
            e.Cancel = true;
            AppInfo.OpenExternal(uri);
            return;
        }
        if (current != null && Address.SameOrigin(uri, current.Url)) lastUrl = uri;
    }

    async void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        // Serverns sida laddades: är servern ny nog för den inbyggda spelaren? (MainForm.Spelare.cs)
        if (e.IsSuccess && current != null && web?.CoreWebView2 != null && Address.SameOrigin(web.CoreWebView2.Source, current.Url)) { await CheckServerAsync(current); return; }
        if (e.IsSuccess || current == null) return;
        // Servern nås inte: visa felsidan. (Fel som servern själv svarar med, t.ex. 404, visar webbappen.)
        if (e.WebErrorStatus is CoreWebView2WebErrorStatus.CannotConnect or CoreWebView2WebErrorStatus.HostNameNotResolved
            or CoreWebView2WebErrorStatus.Timeout or CoreWebView2WebErrorStatus.ServerUnreachable or CoreWebView2WebErrorStatus.Disconnected
            or CoreWebView2WebErrorStatus.ConnectionAborted or CoreWebView2WebErrorStatus.ConnectionReset)
            await ShowLocal("error", Address.Label(current.Url));
    }

    void OnNewWindow(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        // Sidor hos samma server öppnas i fönstret, allt annat i standardwebbläsaren
        if (current != null && Address.SameOrigin(e.Uri, current.Url)) web?.CoreWebView2?.Navigate(e.Uri);
        else AppInfo.OpenExternal(e.Uri);
    }

    void OnDownload(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        // Fråga var filen ska sparas (Hämtade filer föreslås). Dialogen visas efter händelsen, inte i den.
        var deferral = e.GetDeferral();
        BeginInvoke(() =>
        {
            try
            {
                using var dlg = new SaveFileDialog
                {
                    Title = L.T("Spara fil", "Save file"),
                    FileName = Path.GetFileName(e.ResultFilePath),
                    InitialDirectory = Path.GetDirectoryName(e.ResultFilePath),
                    Filter = L.T("Alla filer", "All files") + " (*.*)|*.*",
                    OverwritePrompt = true,
                };
                if (dlg.ShowDialog(this) == DialogResult.OK) e.ResultFilePath = dlg.FileName;
                else e.Cancel = true;
            }
            finally { deferral.Complete(); }
        });
    }

    // ---------- helskärm ----------
    void ToggleFullScreen()
    {
        if (web?.CoreWebView2?.ContainsFullScreenElement == true) _ = web.CoreWebView2.ExecuteScriptAsync("document.exitFullscreen()");
        else SetFullScreen(!fullScreen);
    }

    void SetFullScreen(bool on)
    {
        if (on == fullScreen) return;
        fullScreen = on;
        if (on)
        {
            preFullState = WindowState;
            preFullBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            FormBorderStyle = FormBorderStyle.None;
            if (WindowState == FormWindowState.Maximized) WindowState = FormWindowState.Normal;
            WindowState = FormWindowState.Maximized;
        }
        else
        {
            WindowState = FormWindowState.Normal;
            FormBorderStyle = FormBorderStyle.Sizable;
            Bounds = preFullBounds;
            if (preFullState == FormWindowState.Maximized) WindowState = FormWindowState.Maximized;
        }
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (keyData == Keys.F11) { ToggleFullScreen(); return true; }
        if (keyData == Keys.Escape && fullScreen && web?.CoreWebView2?.ContainsFullScreenElement != true) { SetFullScreen(false); return true; }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    // ---------- viloläge ----------
    /// <summary>Video: skärmen och datorn hålls vakna. Ljud: datorn hålls vaken men skärmen får släckas.</summary>
    void SetAwake(string s)
    {
        if (s == awake) return;
        awake = s;
        Native.SetThreadExecutionState(Native.ES_CONTINUOUS | s switch
        {
            "video" => Native.ES_SYSTEM_REQUIRED | Native.ES_DISPLAY_REQUIRED,
            "audio" => Native.ES_SYSTEM_REQUIRED,
            _ => 0u,
        });
    }

    // ---------- fönstret ----------
    void RestorePlacement()
    {
        var b = cfg.Window is { Length: 4 } w ? new Rectangle(w[0], w[1], w[2], w[3]) : Rectangle.Empty;
        if (b.Width >= 400 && b.Height >= 300 && Screen.AllScreens.Any(s => Rectangle.Intersect(s.WorkingArea, b) is { Width: >= 100, Height: >= 60 }))
            Bounds = b;
        else
        {
            var wa = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
            var size = new Size(Math.Min(1280, wa.Width * 9 / 10), Math.Min(800, wa.Height * 9 / 10));
            Bounds = new Rectangle(wa.X + (wa.Width - size.Width) / 2, wa.Y + (wa.Height - size.Height) / 2, size.Width, size.Height);
        }
        if (cfg.Maximized) WindowState = FormWindowState.Maximized;
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        var r = fullScreen ? preFullBounds : WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        cfg.Maximized = fullScreen ? preFullState == FormWindowState.Maximized : WindowState == FormWindowState.Maximized;
        if (r.Width > 0 && r.Height > 0) cfg.Window = [r.X, r.Y, r.Width, r.Height];
        cfg.Save();
        // Den inbyggda spelaren: webben får veta var filmen var (Fortsätt titta), mpv stängs och sedan fönstret
        // (mpv ritar i fönstret – det får inte försvinna under den). Efter högst 3 s stängs det ändå.
        if (player != null && !closingAfterPlayer)
        {
            closingAfterPlayer = true;
            var p = player;
            p.Gone += () => BeginInvoke(Close);
            ClosePlayer();
            _ = Task.Delay(3000).ContinueWith(_ => { try { BeginInvoke(Close); } catch { } });
            e.Cancel = true;
            return;
        }
        Display.Restore();
        SetAwake("none");
        base.OnFormClosing(e);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Native.DarkTitleBar(Handle);
        var menu = Native.GetSystemMenu(Handle, false);
        Native.AppendMenu(menu, Native.MF_SEPARATOR, 0, null);
        Native.AppendMenu(menu, Native.MF_STRING, MenuServers, L.T("Byt server …", "Change server …"));
        Native.AppendMenu(menu, Native.MF_STRING, MenuAdd, L.T("Lägg till server …", "Add server …"));
        Native.AppendMenu(menu, Native.MF_STRING, MenuReload, L.T("Ladda om", "Reload"));
        Native.AppendMenu(menu, Native.MF_SEPARATOR, 0, null);
        Native.AppendMenu(menu, Native.MF_STRING | (Autostart ? Native.MF_CHECKED : 0), MenuAutostart, L.T("Starta med Windows", "Start with Windows"));
        Native.AppendMenu(menu, Native.MF_STRING, MenuUpdates, L.T("Sök efter uppdateringar …", "Check for updates …"));
        Native.AppendMenu(menu, Native.MF_STRING, MenuAbout, L.T("Om BraXhn TV", "About BraXhn TV"));
        AddPlayerMenu(menu);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == Native.WM_SYSCOMMAND && RunMenu((uint)(m.WParam.ToInt64() & 0xFFF0))) return;
        base.WndProc(ref m);
    }

    /// <summary>Ett val i appens meny (fönstermenyn eller högerklicksmenyn). false = inte appens.</summary>
    bool RunMenu(uint id)
    {
        if (PlayerMenu(id)) return true;
        switch (id)
        {
            case MenuServers: _ = ShowLocal(cfg.Servers.Count == 0 ? "add" : "pick"); return true;
            case MenuAdd: _ = ShowLocal("add"); return true;
            case MenuReload: web?.CoreWebView2?.Reload(); return true;
            case MenuAutostart:
                Autostart = !Autostart;
                Native.CheckMenuItem(Native.GetSystemMenu(Handle, false), MenuAutostart, Native.MF_BYCOMMAND | (Autostart ? Native.MF_CHECKED : Native.MF_UNCHECKED));
                return true;
            case MenuUpdates: _ = Updater.CheckAsync(this, cfg, manual: true); return true;
            case MenuAbout: About(); return true;
        }
        return false;
    }

    // ---------- högerklick ----------
    // Text som går att redigera eller är markerad: bara klipp ut/kopiera/klistra in och liknande ur webbläsarens meny.
    // Annars (och aldrig Granska, Spara som, Skriv ut …): appens meny, så att den finns där man letar.
    static readonly HashSet<string> TextItems = ["cut", "copy", "paste", "pasteAndMatchStyle", "selectAll", "undo", "redo", "emoji", "copyLinkLocation", "copyImage", "spellCheck"];

    void OnContextMenu(object? sender, CoreWebView2ContextMenuRequestedEventArgs e)
    {
        var items = e.MenuItems;
        for (var i = items.Count - 1; i >= 0; i--)
        {
            var it = items[i];
            var spelling = it.Name.StartsWith("spell", StringComparison.OrdinalIgnoreCase) || it.Name.Contains("Suggestion", StringComparison.OrdinalIgnoreCase);
            if (it.Kind != CoreWebView2ContextMenuItemKind.Separator && !TextItems.Contains(it.Name) && !spelling) items.RemoveAt(i);
        }
        // Avgränsare först, sist eller dubbelt tas bort
        for (var i = items.Count - 1; i >= 0; i--)
            if (items[i].Kind == CoreWebView2ContextMenuItemKind.Separator && (i == 0 || i == items.Count - 1 || items[i - 1].Kind == CoreWebView2ContextMenuItemKind.Separator)) items.RemoveAt(i);
        if (items.Count > 0) return;
        var env = web?.CoreWebView2?.Environment;
        if (env == null) { e.Handled = true; return; }
        void Add(uint id, string label, bool? check = null)
        {
            var item = env.CreateContextMenuItem(label, null, check == null ? CoreWebView2ContextMenuItemKind.Command : CoreWebView2ContextMenuItemKind.CheckBox);
            if (check != null) item.IsChecked = check.Value;
            item.CustomItemSelected += (_, _) => BeginInvoke(() => RunMenu(id));
            items.Add(item);
        }
        void Sep() => items.Add(env.CreateContextMenuItem("", null, CoreWebView2ContextMenuItemKind.Separator));
        Add(MenuReload, L.T("Ladda om", "Reload"));
        Add(MenuServers, L.T("Byt server …", "Change server …"));
        Add(MenuAdd, L.T("Lägg till server …", "Add server …"));
        Sep();
        AddPlayerItems(Add);
        Sep();
        Add(MenuAutostart, L.T("Starta med Windows", "Start with Windows"), Autostart);
        Add(MenuUpdates, L.T("Sök efter uppdateringar …", "Check for updates …"));
        Add(MenuAbout, L.T("Om BraXhn TV", "About BraXhn TV"));
    }

    void About()
    {
        TaskDialog.ShowDialog(this, new TaskDialogPage
        {
            Caption = AppInfo.Name,
            Heading = $"{AppInfo.Name} {AppInfo.Version}",
            Text = L.T("Windows-appen för BraXhn TV. Inställningar och inloggningar sparas i ", "The Windows app for BraXhn TV. Settings and sign-ins are stored in ")
                   + AppSettings.Dir + (web?.CoreWebView2 != null ? "\n\nWebView2 " + web.CoreWebView2.Environment.BrowserVersionString : ""),
            Buttons = { TaskDialogButton.OK },
        });
    }

    // ---------- start med Windows ----------
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    static bool Autostart
    {
        get
        {
            using var k = Registry.CurrentUser.OpenSubKey(RunKey);
            return k?.GetValue("BraXhnTV") != null;
        }
        set
        {
            using var k = Registry.CurrentUser.CreateSubKey(RunKey);
            if (value) k.SetValue("BraXhnTV", $"\"{Environment.ProcessPath}\" --autostart");
            else k.DeleteValue("BraXhnTV", false);
        }
    }
}
