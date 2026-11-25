namespace BraXhnTV;

/// <summary>
/// Ny version? Vid start högst en gång per dygn (och när man väljer Sök efter uppdateringar) frågar appen GitHub
/// efter den senaste utgåvan med en installationsfil för Windows. Inget laddas ner eller installeras utan att man
/// klickar på det.
/// </summary>
static class Updater
{
    const string Latest = "https://api.github.com/repos/" + AppInfo.Repo + "/releases/latest";
    static bool busy;

    public static async Task CheckAsync(Form owner, AppSettings cfg, bool manual)
    {
        if (busy) return;
        if (!manual && DateTime.UtcNow - cfg.LastUpdateCheck < TimeSpan.FromHours(24)) return;
        busy = true;
        try
        {
            Release? rel;
            try
            {
                using var http = Http();
                rel = Versions.FromGitHub(await http.GetStringAsync(Latest));
                cfg.LastUpdateCheck = DateTime.UtcNow;
                cfg.Save();
            }
            catch (Exception ex)
            {
                if (manual) Info(owner, TaskDialogIcon.Warning, L.T("Det gick inte att söka efter uppdateringar", "Could not check for updates"),
                    L.T("Kontrollera att datorn är ansluten till internet och försök igen senare.", "Check that the computer is connected to the internet and try again later.") + "\n\n" + ex.Message);
                return;
            }
            if (rel == null || Versions.Compare(rel.Version, AppInfo.Version) <= 0)
            {
                if (manual) Info(owner, TaskDialogIcon.Information, L.T("Du har den senaste versionen", "You have the latest version"), $"{AppInfo.Name} {AppInfo.Version}");
                return;
            }
            if (!manual && cfg.SkipVersion == rel.Version) return;

            var install = new TaskDialogButton(L.T("Ladda ner och installera", "Download and install"));
            var later = new TaskDialogButton(L.T("Inte nu", "Not now"));
            var skip = new TaskDialogButton(L.T("Hoppa över den här versionen", "Skip this version"));
            var page = new TaskDialogPage
            {
                Caption = AppInfo.Name,
                Icon = TaskDialogIcon.Information,
                Heading = L.T($"BraXhn TV {rel.Version} finns", $"BraXhn TV {rel.Version} is available"),
                Text = L.T($"Du har version {AppInfo.Version}. Installationen öppnas och appen stängs medan den installeras.",
                           $"You have version {AppInfo.Version}. The installer opens and the app closes while it installs."),
                Buttons = { install, later },
                Footnote = rel.PageUrl.Length > 0 ? new TaskDialogFootnote($"<a href=\"{rel.PageUrl}\">{L.T("Vad är nytt?", "What's new?")}</a>") : null,
                EnableLinks = true,
            };
            if (!manual) page.Buttons.Add(skip);
            page.LinkClicked += (_, e) => AppInfo.OpenExternal(e.LinkHref);
            var answer = TaskDialog.ShowDialog(owner, page);
            if (answer == skip) { cfg.SkipVersion = rel.Version; cfg.Save(); return; }
            if (answer != install) return;

            var file = Download(owner, rel);
            if (file == null) return;
            try
            {
                // Installationen tar över; appen stängs så att filen kan bytas
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(file) { UseShellExecute = true });
                owner.Close();
            }
            catch (Exception ex)
            {
                Info(owner, TaskDialogIcon.Error, L.T("Installationen kunde inte startas", "Could not start the installer"),
                    L.T("Filen finns här och kan startas för hand: ", "The file is here and can be started by hand: ") + file + "\n\n" + ex.Message);
            }
        }
        finally { busy = false; }
    }

    static HttpClient Http()
    {
        var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("BraXhnTV-Windows/" + AppInfo.Version);
        http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return http;
    }

    /// <summary>Laddar ner installationsfilen med en förloppsruta. null = avbrutet eller misslyckat.</summary>
    static string? Download(Form owner, Release rel)
    {
        var bar = new TaskDialogProgressBar(TaskDialogProgressBarState.Marquee);
        var page = new TaskDialogPage
        {
            Caption = AppInfo.Name,
            Heading = L.T($"Laddar ner BraXhn TV {rel.Version} …", $"Downloading BraXhn TV {rel.Version} …"),
            ProgressBar = bar,
            Buttons = { TaskDialogButton.Cancel },
        };
        using var cts = new CancellationTokenSource();
        string? done = null;
        Exception? error = null;
        page.Created += async (_, _) =>
        {
            var path = Path.Combine(Path.GetTempPath(), rel.SetupName);
            try
            {
                using var http = Http();
                using var r = await http.GetAsync(rel.SetupUrl, HttpCompletionOption.ResponseHeadersRead, cts.Token);
                r.EnsureSuccessStatusCode();
                var total = r.Content.Headers.ContentLength ?? 0;
                await using (var src = await r.Content.ReadAsStreamAsync(cts.Token))
                await using (var dst = File.Create(path))
                {
                    var buf = new byte[81920];
                    long got = 0;
                    int n;
                    while ((n = await src.ReadAsync(buf, cts.Token)) > 0)
                    {
                        await dst.WriteAsync(buf.AsMemory(0, n), cts.Token);
                        got += n;
                        if (total > 0) { bar.State = TaskDialogProgressBarState.Normal; bar.Value = (int)(got * 100 / total); }
                    }
                }
                done = path;
            }
            catch (Exception ex)
            {
                error = ex;
                try { File.Delete(path); } catch { }
            }
            page.BoundDialog?.Close();
        };
        TaskDialog.ShowDialog(owner, page);
        cts.Cancel();
        if (done == null && error != null && error is not OperationCanceledException)
        {
            Info(owner, TaskDialogIcon.Error, L.T("Nedladdningen misslyckades", "The download failed"),
                L.T("Försök igen senare, eller ladda ner installationsfilen från ", "Try again later, or download the installer from ") + rel.PageUrl + "\n\n" + error.Message);
        }
        return done;
    }

    static void Info(Form owner, TaskDialogIcon icon, string heading, string text) =>
        TaskDialog.ShowDialog(owner, new TaskDialogPage { Caption = AppInfo.Name, Icon = icon, Heading = heading, Text = text, Buttons = { TaskDialogButton.OK } });
}
