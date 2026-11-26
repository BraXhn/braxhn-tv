using System.Diagnostics;
using System.Net;

namespace BraXhnTV;

/// <summary>
/// Ny version? Appen frågar GitHub efter den senaste stabila utgåvan (releases/latest) – av sig själv vid start högst
/// en gång per dygn, och när man väljer Sök efter uppdatering … (appens meny och Om BraXhn TV). Hämta och installera
/// laddar ner installationsfilen, kontrollerar den (Logik/Uppdatering.cs), kör den tyst och stänger appen;
/// installationsfilen startar appen igen när den är klar. Inget laddas ner utan att man klickar.
/// </summary>
static class Updater
{
    const string Latest = "https://api.github.com/repos/" + AppInfo.Repo + "/releases/latest";
    static bool busy;
    /// <summary>Den nedladdade installationsfilen (tas bort vid nästa automatiska koll)</summary>
    static string Folder => Path.Combine(AppSettings.Dir, "Uppdatering");

    /// <summary>Den automatiska kollen vid start: tyst om något går fel eller om det inte finns något nytt.</summary>
    public static async Task AutoAsync(MainForm owner, AppSettings cfg)
    {
        if (busy || DateTime.UtcNow - cfg.LastUpdateCheck < TimeSpan.FromHours(24)) return;
        busy = true;
        try
        {
            CleanUp();
            Release? rel;
            try
            {
                rel = await FetchAsync(CancellationToken.None);
                cfg.LastUpdateCheck = DateTime.UtcNow;
                cfg.Save();
            }
            catch (Exception ex) { Logg.Write("uppdatering: kunde inte fråga GitHub: " + ex.Message); return; }
            if (rel is not { HasSetup: true } || Versions.Compare(rel.Version, AppInfo.Version) <= 0 || cfg.SkipVersion == rel.Version) return;
            Logg.Write($"uppdatering: {rel.Version} finns (har {AppInfo.Version})");
            switch (Offer(owner, rel, allowSkip: true))
            {
                case Answer.Install: await InstallAsync(owner, rel); break;
                case Answer.Skip: cfg.SkipVersion = rel.Version; cfg.Save(); break;
            }
        }
        finally { busy = false; }
    }

    /// <summary>Sök efter uppdatering …: visar alltid ett svar – nuvarande och senaste version, eller vad som gick fel.</summary>
    public static async Task ManualAsync(MainForm owner, AppSettings cfg)
    {
        if (busy) return;
        busy = true;
        try
        {
            while (true)
            {
                var res = WithProgress(owner, L.T("Söker efter uppdatering …", "Checking for updates …"), (_, ct) => FetchAsync(ct));
                if (res.Cancelled) return;
                if (res.Error != null)
                {
                    Logg.Write("uppdatering: kunde inte fråga GitHub: " + res.Error.Message);
                    if (Retry(owner, L.T("Det gick inte att söka efter uppdatering", "Could not check for updates"),
                            L.T("Kontrollera att datorn är ansluten till internet. Svarar inte GitHub kan du försöka igen om en stund.",
                                "Check that the computer is connected to the internet. If GitHub isn't responding, try again in a while.")
                            + "\n\n" + ErrorText(res.Error))) continue;
                    return;
                }
                cfg.LastUpdateCheck = DateTime.UtcNow;
                cfg.Save();
                var rel = res.Value;
                if (rel == null || Versions.Compare(rel.Version, AppInfo.Version) <= 0)
                {
                    Info(owner, TaskDialogIcon.Information, L.T($"Du har den senaste versionen ({AppInfo.Version}).", $"You have the latest version ({AppInfo.Version})."),
                        rel == null ? "" : L.T($"Senaste versionen på GitHub: {rel.Version}", $"Latest version on GitHub: {rel.Version}"));
                    return;
                }
                if (!rel.HasSetup)
                {
                    // Utgåvan skapas först; installationsfilen för Windows byggs och läggs dit en stund senare
                    if (Retry(owner, L.T($"BraXhn TV {rel.Version} är på väg", $"BraXhn TV {rel.Version} is on its way"),
                            L.T($"Du har version {AppInfo.Version}. Installationsfilen för Windows är inte klar än – försök igen om en stund.",
                                $"You have version {AppInfo.Version}. The Windows installer isn't ready yet – try again in a while."))) continue;
                    return;
                }
                if (Offer(owner, rel, allowSkip: false) == Answer.Install) await InstallAsync(owner, rel);
                return;
            }
        }
        finally { busy = false; }
    }

    enum Answer { Later, Install, Skip }

    static Answer Offer(Form owner, Release rel, bool allowSkip)
    {
        var install = new TaskDialogButton(L.T("Hämta och installera", "Download and install"));
        var later = new TaskDialogButton(L.T("Inte nu", "Not now"));
        var skip = new TaskDialogButton(L.T("Hoppa över den här versionen", "Skip this version"));
        var mb = Math.Max(1, (rel.SetupSize + 524288) / 1048576);
        var page = new TaskDialogPage
        {
            Caption = AppInfo.Name,
            Icon = TaskDialogIcon.Information,
            Heading = L.T($"BraXhn TV {rel.Version} finns", $"BraXhn TV {rel.Version} is available"),
            Text = L.T($"Du har version {AppInfo.Version}. Senaste versionen är {rel.Version}.\n\nAppen hämtar installationsfilen (ca {mb} MB), installerar den och startar sedan om.",
                       $"You have version {AppInfo.Version}. The latest version is {rel.Version}.\n\nThe app downloads the installer (about {mb} MB), installs it and then restarts."),
            Buttons = { install, later },
            Footnote = rel.PageUrl.Length > 0 ? new TaskDialogFootnote($"<a href=\"{rel.PageUrl}\">{L.T("Vad är nytt?", "What's new?")}</a>") : null,
            EnableLinks = true,
            AllowCancel = true,
        };
        if (allowSkip) page.Buttons.Add(skip);
        page.LinkClicked += (_, e) => AppInfo.OpenExternal(e.LinkHref);
        var answer = TaskDialog.ShowDialog(owner, page);
        return answer == install ? Answer.Install : answer == skip ? Answer.Skip : Answer.Later;
    }

    /// <summary>Hämtar, kontrollerar och startar installationsfilen, och stänger appen.</summary>
    static async Task InstallAsync(MainForm owner, Release rel)
    {
        string file;
        while (true)
        {
            var res = WithProgress(owner, L.T($"Hämtar BraXhn TV {rel.Version} …", $"Downloading BraXhn TV {rel.Version} …"), (page, ct) => DownloadAsync(rel, page, ct));
            if (res.Cancelled) { Logg.Write("uppdatering: nedladdningen avbröts"); return; }
            if (res.Value != null) { file = res.Value; break; }
            Logg.Write("uppdatering: nedladdningen misslyckades: " + res.Error?.Message);
            var why = res.Error is BadFileException bad ? bad.Problem switch
            {
                FileProblem.Size => L.T("Filen blev inte hel (storleken stämmer inte med utgåvans).", "The file is incomplete (the size doesn't match the release)."),
                FileProblem.Sha => L.T("Filens kontrollsumma stämmer inte med utgåvans.", "The file's checksum doesn't match the release."),
                _ => L.T("Filen är inte en installationsfil för Windows.", "The file is not a Windows installer."),
            } + " " + L.T("Den har tagits bort och ingenting har installerats.", "It has been deleted and nothing was installed.")
              : L.T("Kontrollera att datorn är ansluten till internet.", "Check that the computer is connected to the internet.") + "\n\n" + ErrorText(res.Error);
            if (!Retry(owner, L.T("Nedladdningen misslyckades", "The download failed"),
                    why + "\n\n" + L.T("Händer det igen kan du ladda ner installationsfilen från ", "If it happens again, you can download the installer from ") + rel.PageUrl)) return;
        }

        // Spelas en film stoppas den först, så att webben hinner spara var den var (Fortsätt titta)
        if (owner.PlayingFilm)
        {
            var go = new TaskDialogButton(L.T("Fortsätt", "Continue"));
            var page = new TaskDialogPage
            {
                Caption = AppInfo.Name,
                Icon = TaskDialogIcon.Warning,
                Heading = L.T("Filmen stoppas och appen startas om – fortsätta?", "The video stops and the app restarts – continue?"),
                Text = L.T("Du fortsätter där du var när appen har startat igen.", "You can continue where you left off when the app has started again."),
                Buttons = { go, TaskDialogButton.Cancel },
                DefaultButton = go,
                AllowCancel = true,
            };
            if (TaskDialog.ShowDialog(owner, page) != go) { Logg.Write("uppdatering: väntar, en film spelas"); return; }
        }
        await owner.StopPlaybackForUpdateAsync();

        try
        {
            var log = Path.Combine(AppSettings.Dir, "installation.txt");
            Logg.Write($"uppdatering: startar {Path.GetFileName(file)} tyst");
            Process.Start(new ProcessStartInfo(file, Uppdatering.InstallerArguments(log)) { UseShellExecute = true, WorkingDirectory = Folder });
        }
        catch (Exception ex)
        {
            Logg.Write("uppdatering: installationsfilen kunde inte startas: " + ex.Message);
            Info(owner, TaskDialogIcon.Error, L.T("Installationen kunde inte startas", "Could not start the installer"),
                L.T("Filen finns här och kan startas för hand: ", "The file is here and can be started by hand: ") + file + "\n\n" + ex.Message);
            return;
        }
        // Installationsfilen tar över: appen stängs så att filerna kan bytas, och installationsfilen startar den igen
        owner.Close();
    }

    static async Task<Release?> FetchAsync(CancellationToken ct)
    {
        using var http = Http(TimeSpan.FromSeconds(30));
        using var r = await http.GetAsync(Latest, ct);
        if (r.StatusCode == HttpStatusCode.NotFound) return null;   // ingen utgåva alls
        r.EnsureSuccessStatusCode();
        return Versions.FromGitHub(await r.Content.ReadAsStringAsync(ct));
    }

    /// <summary>Laddar ner installationsfilen (och kontrollsumman när utgåvan har en) och kontrollerar den.</summary>
    static async Task<string?> DownloadAsync(Release rel, TaskDialogPage page, CancellationToken ct)
    {
        var name = rel.SetupName!;
        Directory.CreateDirectory(Folder);
        string? sha = null;
        if (rel.ShaUrl != null)
        {
            using var h = Http(TimeSpan.FromSeconds(30));
            sha = Uppdatering.ParseSha(await h.GetStringAsync(rel.ShaUrl, ct), name) ?? throw new BadFileException(FileProblem.Sha);
        }
        var path = Path.Combine(Folder, name);
        var part = path + "." + Guid.NewGuid().ToString("n")[..8] + ".part";
        try
        {
            using var http = Http(TimeSpan.FromMinutes(2));
            using var r = await http.GetAsync(rel.SetupUrl, HttpCompletionOption.ResponseHeadersRead, ct);
            r.EnsureSuccessStatusCode();
            var total = rel.SetupSize;
            await using (var src = await r.Content.ReadAsStreamAsync(ct))
            await using (var dst = File.Create(part))
            {
                var buf = new byte[81920];
                long got = 0;
                var shown = -1;
                int n;
                while ((n = await src.ReadAsync(buf, ct)) > 0)
                {
                    got += n;
                    if (got > total) throw new BadFileException(FileProblem.Size);
                    await dst.WriteAsync(buf.AsMemory(0, n), ct);
                    var pct = (int)(got * 100 / total);
                    if (pct == shown) continue;
                    shown = pct;
                    if (page.ProgressBar is { } bar) { bar.State = TaskDialogProgressBarState.Normal; bar.Value = pct; }
                    page.Text = L.T($"{got / 1048576} av {total / 1048576} MB", $"{got / 1048576} of {total / 1048576} MB");
                }
            }
            page.Text = L.T("Kontrollerar filen …", "Checking the file …");
            var problem = await Task.Run(() => Uppdatering.CheckFile(part, total, sha), ct);
            if (problem != FileProblem.None) throw new BadFileException(problem);
            File.Move(part, path, true);
            return path;
        }
        catch
        {
            try { File.Delete(part); } catch { }
            throw;
        }
    }

    sealed class BadFileException(FileProblem problem) : Exception("Installationsfilen: " + problem)
    {
        public FileProblem Problem { get; } = problem;
    }

    readonly record struct Result<T>(T? Value, Exception? Error, bool Cancelled);

    /// <summary>En ruta med förlopp och Avbryt medan work körs. Stängs av sig själv när work är klar.</summary>
    static Result<T> WithProgress<T>(Form owner, string heading, Func<TaskDialogPage, CancellationToken, Task<T>> work)
    {
        var page = new TaskDialogPage
        {
            Caption = AppInfo.Name,
            Heading = heading,
            Text = L.T("Ett ögonblick …", "One moment …"),
            ProgressBar = new TaskDialogProgressBar(TaskDialogProgressBarState.Marquee),
            Buttons = { TaskDialogButton.Cancel },
            AllowCancel = true,
        };
        using var cts = new CancellationTokenSource();
        T? value = default;
        Exception? error = null;
        var finished = false;     // false = rutan stängdes med Avbryt (eller krysset) innan work var klar
        page.Created += async (_, _) =>
        {
            try { value = await work(page, cts.Token); }
            catch (Exception ex) { error = ex; }
            if (cts.IsCancellationRequested) return;
            finished = true;
            page.BoundDialog?.Close();
        };
        TaskDialog.ShowDialog(owner, page);
        cts.Cancel();
        if (!finished) return new(default, null, true);
        return error == null ? new(value, null, false) : new(default, error, false);
    }

    /// <summary>Ett fel med Försök igen och Stäng. true = Försök igen.</summary>
    static bool Retry(Form owner, string heading, string text)
    {
        var retry = new TaskDialogButton(L.T("Försök igen", "Try again"));
        var page = new TaskDialogPage
        {
            Caption = AppInfo.Name, Icon = TaskDialogIcon.Warning, Heading = heading, Text = text,
            Buttons = { retry, TaskDialogButton.Close }, DefaultButton = retry, AllowCancel = true,
        };
        return TaskDialog.ShowDialog(owner, page) == retry;
    }

    static string ErrorText(Exception? ex) => ex switch
    {
        null => "",
        // HttpClient.Timeout ger TaskCanceledException
        TaskCanceledException => L.T("GitHub svarade inte i tid.", "GitHub didn't respond in time."),
        HttpRequestException { StatusCode: { } s } => L.T($"GitHub svarade {(int)s}.", $"GitHub responded {(int)s}."),
        _ => ex.Message,
    };

    /// <summary>Tar bort installationsfiler från tidigare uppdateringar</summary>
    static void CleanUp()
    {
        try
        {
            if (!Directory.Exists(Folder)) return;
            foreach (var f in Directory.GetFiles(Folder)) try { File.Delete(f); } catch { }
        }
        catch { }
    }

    static HttpClient Http(TimeSpan timeout)
    {
        var http = new HttpClient { Timeout = timeout };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("BraXhnTV-Windows/" + AppInfo.Version);
        http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return http;
    }

    static void Info(Form owner, TaskDialogIcon icon, string heading, string text) =>
        TaskDialog.ShowDialog(owner, new TaskDialogPage { Caption = AppInfo.Name, Icon = icon, Heading = heading, Text = text, Buttons = { TaskDialogButton.OK } });
}
