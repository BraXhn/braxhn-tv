using System.Text.Json;
using BraXhnTV.Spelare;

namespace BraXhnTV;

/// <summary>
/// Hämtar den inbyggda spelaren (libmpv-2.dll) efter ett klick: BraXhn TV:s egen LGPL-byggnad (zip med SHA-256 ur
/// libmpv.json), eller som reserv mpv-projektets Windows-bygge från SourceForge (MpvSource). Kontrollerat (storlek,
/// kontrollsumma, arkivtyp, att DLL:en finns, är för x64 och går att ladda) och sparat i
/// %LOCALAPPDATA%\BraXhnTV\mpv. Används direkt utan omstart, utom när en äldre version redan är laddad – då byts den
/// vid nästa start. Inget hämtas utan att användaren klickar Hämta. Går något fel spelar webbspelaren som förut.
/// </summary>
static class MpvSetup
{
    public const string LicenseUrl = "https://github.com/mpv-player/mpv/blob/master/Copyright";
    public const string BuildsUrl = "https://github.com/shinchiro/mpv-winbuild-cmake";
    public const string OwnReleasesPage = "https://github.com/" + AppInfo.Repo + "/releases";
    static bool busy;

    /// <summary>Uppgifter om den hämtade filen (mpv\kalla.json): vilket arkiv och när</summary>
    public sealed record Source(string Name, string Url, string Date, DateTime Fetched, string? Version);
    static string SourceFile => Path.Combine(Libmpv.Folder, "kalla.json");

    public static Source? Installed()
    {
        try { return File.Exists(SourceFile) ? JsonSerializer.Deserialize<Source>(File.ReadAllText(SourceFile)) : null; }
        catch { return null; }
    }

    /// <summary>
    /// Frågar om mpv ska hämtas (eller uppdateras) och gör det. true = den inbyggda spelaren kan användas nu.
    /// firstTime: frågan kommer av sig själv första gången en film kunde ha spelats i den inbyggda spelaren.
    /// </summary>
    public static bool Offer(Form owner, bool update, bool firstTime = false)
    {
        if (busy) return false;
        busy = true;
        try
        {
            var get = new TaskDialogButton(update ? L.T("Uppdatera", "Update") : L.T("Hämta", "Download"));
            var later = new TaskDialogButton(L.T("Inte nu", "Not now"));
            var page = new TaskDialogPage
            {
                Caption = AppInfo.Name,
                Icon = TaskDialogIcon.Information,
                Heading = update
                    ? L.T("Uppdatera den inbyggda spelaren (mpv, ca 30 MB)?", "Update the built-in player (mpv, about 30 MB)?")
                    : L.T("Hämta den inbyggda spelaren (mpv, ca 30 MB)?", "Download the built-in player (mpv, about 30 MB)?"),
                Text = (firstTime
                        ? L.T("Med den spelar appen filmer i originalkvalitet – 4K HDR, DTS, TrueHD och bildundertexter – utan att servern behöver koda om. Den här filmen spelas i webbspelaren.\n\n",
                              "With it the app plays videos in original quality – 4K HDR, DTS, TrueHD and image subtitles – without the server converting them. This video plays in the web player.\n\n")
                        : L.T("Med den spelar appen filmer i originalkvalitet – 4K HDR, DTS, TrueHD och bildundertexter – utan att servern behöver koda om.\n\n",
                              "With it the app plays videos in original quality – 4K HDR, DTS, TrueHD and image subtitles – without the server converting them.\n\n"))
                       + (OwnBuild() != null
                          ? L.T("Den hämtas från BraXhn TV:s utgåvor på GitHub (mpv byggd med LGPL-inställningar) och har en egen licens (LGPL).",
                                "It is downloaded from BraXhn TV's releases on GitHub (mpv built with LGPL settings) and has its own licence (LGPL).")
                          : L.T("Den hämtas från mpv-projektets Windows-byggen (SourceForge) och har en egen licens (LGPL/GPL).",
                                "It is downloaded from the mpv project's Windows builds (SourceForge) and has its own licence (LGPL/GPL).")),
                Footnote = new TaskDialogFootnote($"<a href=\"{LicenseUrl}\">{L.T("mpv:s licens", "mpv licence")}</a> · <a href=\"{(OwnBuild() != null ? OwnReleasesPage : BuildsUrl)}\">{L.T("Om byggena", "About the builds")}</a>"),
                EnableLinks = true,
                Buttons = { get, later },
            };
            page.LinkClicked += (_, e) => AppInfo.OpenExternal(e.LinkHref);
            if (TaskDialog.ShowDialog(owner, page) != get) { Logg.Write("mpv: hämtningen erbjöds – Inte nu"); return false; }
            return Download(owner);
        }
        finally { busy = false; }
    }

    /// <summary>Den egna byggnaden ur apps/windows/libmpv.json (inbyggd i appen), eller null</summary>
    static MpvBuild? OwnBuild()
    {
        try
        {
            using var st = typeof(MpvSetup).Assembly.GetManifestResourceStream("libmpv.json");
            return st == null ? null : MpvSource.FromConfig(new StreamReader(st).ReadToEnd());
        }
        catch { return null; }
    }

    static HttpClient Http()
    {
        var http = new HttpClient { Timeout = TimeSpan.FromMinutes(15) };
        // Ett eget namn (inte en webbläsares): SourceForge skickar då direkt vidare till filen i stället för en sida.
        // GitHub skickar vidare till sin fillagring; HttpClient följer omdirigeringar (bara https → https).
        http.DefaultRequestHeaders.UserAgent.ParseAdd("BraXhnTV-Windows/" + AppInfo.Version);
        return http;
    }

    enum Step { List, Download, Check, Unpack, Install }

    static bool Download(Form owner)
    {
        var bar = new TaskDialogProgressBar(TaskDialogProgressBarState.Marquee);
        var page = new TaskDialogPage
        {
            Caption = AppInfo.Name,
            Heading = L.T("Hämtar den inbyggda spelaren …", "Downloading the built-in player …"),
            Text = L.T("Letar efter den senaste versionen …", "Looking for the latest version …"),
            ProgressBar = bar,
            Buttons = { TaskDialogButton.Cancel },
        };
        using var cts = new CancellationTokenSource();
        Exception? error = null;
        var step = Step.List;
        MpvBuild? build = null;
        string? version = null;
        var restart = false;
        var ok = false;
        // Hämtar och kontrollerar ett arkiv och packar upp libmpv-2.dll (till dll). Licenstexterna följer med.
        async Task<MpvBuild> Fetch(HttpClient http, MpvBuild b)
        {
            var archive = Path.Combine(Libmpv.Folder, "hamtning.arkiv");
            var dll = Path.Combine(Libmpv.Folder, Libmpv.FileName + ".hamtad");
            Logg.Write($"mpv: hämtar {b.Url} ({(b.Size > 0 ? b.Size + " byte" : "okänd storlek")})");
            step = Step.Download;
            page.Text = b.Name;
            using (var r = await http.GetAsync(b.Url, HttpCompletionOption.ResponseHeadersRead, cts.Token))
            {
                r.EnsureSuccessStatusCode();
                if (r.Content.Headers.ContentType?.MediaType is "text/html")
                    throw new MpvSourceException("Servern svarade med en webbsida i stället för filen. Försök igen senare.", "The server answered with a web page instead of the file. Please try again later.");
                var total = b.Size > 0 ? b.Size : r.Content.Headers.ContentLength ?? 0;
                await using var src = await r.Content.ReadAsStreamAsync(cts.Token);
                await using var dst = File.Create(archive);
                var buf = new byte[81920];
                long got = 0;
                int n;
                if (total > 0) bar.State = TaskDialogProgressBarState.Normal;
                while ((n = await src.ReadAsync(buf, cts.Token)) > 0)
                {
                    if (got + n > MpvSource.MaxArchive) throw new MpvSourceException("Filen är större än väntat.", "The file is larger than expected.");
                    await dst.WriteAsync(buf.AsMemory(0, n), cts.Token);
                    got += n;
                    if (total > 0) bar.Value = (int)Math.Min(100, got * 100 / total);
                }
            }
            step = Step.Check;
            bar.State = TaskDialogProgressBarState.Marquee;
            page.Text = L.T("Kontrollerar och packar upp …", "Checking and unpacking …");
            await Task.Run(() =>
            {
                MpvSource.CheckArchive(archive, b);
                step = Step.Unpack;
                MpvSource.ExtractDll(archive, dll, Libmpv.ProcessMachine, b.Zip);
                try { MpvSource.ExtractLicenses(archive, Path.Combine(Libmpv.Folder, "licens"), b.Zip); } catch { /* licenstexterna finns också på nätet */ }
            }, cts.Token);
            return b;
        }

        page.Created += async (_, _) =>
        {
            Directory.CreateDirectory(Libmpv.Folder);
            var archive = Path.Combine(Libmpv.Folder, "hamtning.arkiv");
            var dll = Path.Combine(Libmpv.Folder, Libmpv.FileName + ".hamtad");
            try
            {
                using var http = Http();
                // Först den egna LGPL-byggnaden (libmpv.json i appen); går den inte att nå: mpv-projektets byggen
                var own = OwnBuild();
                if (own != null)
                {
                    try { build = await Fetch(http, own); }
                    catch (HttpRequestException ex) { Logg.Write($"mpv: den egna byggnaden gick inte att hämta ({ex.StatusCode?.ToString() ?? ex.Message}) – provar mpv-projektets byggen"); }
                }
                else Logg.Write("mpv: libmpv.json saknas i appen – använder mpv-projektets byggen");
                if (build == null)
                {
                    step = Step.List;
                    page.Text = L.T("Letar efter den senaste versionen …", "Looking for the latest version …");
                    Logg.Write("mpv: läser listan " + MpvSource.Rss);
                    var sf = MpvSource.Pick(await http.GetStringAsync(MpvSource.Rss, cts.Token))
                        ?? throw new MpvSourceException("Hittade ingen passande fil i mpv-projektets lista. Försök igen senare.", "Found no suitable file in the mpv project's list. Please try again later.");
                    build = await Fetch(http, sf);
                }
                step = Step.Install;
                var target = Path.Combine(Libmpv.Folder, Libmpv.FileName);
                if (Libmpv.IsLoaded)
                {
                    // Den gamla filen används just nu och kan inte bytas: den nya läggs bredvid och byts in vid nästa start
                    File.Move(dll, Libmpv.Pending, true);
                    restart = true;
                    ok = true;
                    Logg.Write("mpv: ny version sparad, byts in vid nästa start");
                }
                else
                {
                    // Ingen mpv är laddad (saknas eller gick inte att använda): den nya filen läggs på plats och provas där –
                    // laddas den och svarar mpv med sin version? Annars tas den bort igen.
                    File.Move(dll, target, true);
                    var lib = Libmpv.Load(out var loadError);
                    version = lib == null ? null : await Task.Run(lib.MpvVersion);
                    if (lib == null || version == null)
                    {
                        if (lib == null) try { File.Delete(target); } catch { }
                        throw new MpvSourceException("Den hämtade filen gick inte att starta på den här datorn.", "The downloaded file could not be started on this computer.", loadError);
                    }
                    ok = true;
                    Logg.Write($"mpv: installerad {version} från {build.Name}");
                }
                File.WriteAllText(SourceFile, JsonSerializer.Serialize(new Source(build.Name, build.Url, build.Date, DateTime.UtcNow, version)));
            }
            catch (Exception ex)
            {
                error = ex;
                Logg.Write($"mpv: hämtningen misslyckades i steget {step}: {(ex is MpvSourceException m ? m.En + (m.Detail != null ? " – " + m.Detail : "") : ex.GetType().Name + ": " + ex.Message)}");
            }
            finally
            {
                try { File.Delete(archive); } catch { }
                try { File.Delete(dll); } catch { }
            }
            page.BoundDialog?.Close();
        };
        TaskDialog.ShowDialog(owner, page);
        cts.Cancel();

        if (ok)
        {
            TaskDialog.ShowDialog(owner, new TaskDialogPage
            {
                Caption = AppInfo.Name, Icon = TaskDialogIcon.ShieldSuccessGreenBar,
                Heading = restart ? L.T("Den nya versionen är hämtad", "The new version has been downloaded") : L.T("Den inbyggda spelaren är klar", "The built-in player is ready"),
                Text = restart
                    ? L.T("Den används när du startar om appen.", "It is used when you restart the app.")
                    : L.T("Nästa film du spelar öppnas i den inbyggda spelaren.", "The next video you play opens in the built-in player.") + (version != null ? "\n\n" + version : ""),
                Buttons = { TaskDialogButton.OK },
            });
            return !restart;
        }
        if (error is OperationCanceledException && cts.IsCancellationRequested) { Logg.Write("mpv: hämtningen avbröts"); return false; }
        if (error != null)
        {
            var (sv, en) = error switch
            {
                MpvSourceException m => (m.Sv, m.En),
                HttpRequestException or TaskCanceledException => ("Det gick inte att hämta filen. Kontrollera att datorn är ansluten till internet och försök igen senare.",
                                                                  "Could not download the file. Check that the computer is connected to the internet and try again later."),
                IOException or UnauthorizedAccessException => ("Det gick inte att spara filen i " + Libmpv.Folder + ".", "Could not save the file in " + Libmpv.Folder + "."),
                _ => ("Något gick fel.", "Something went wrong."),
            };
            var detail = error is MpvSourceException { Detail: not null } md ? md.Detail : error is MpvSourceException ? null : error.Message;
            TaskDialog.ShowDialog(owner, new TaskDialogPage
            {
                Caption = AppInfo.Name, Icon = TaskDialogIcon.Warning,
                Heading = L.T("Den inbyggda spelaren kunde inte hämtas", "The built-in player could not be downloaded"),
                Text = L.T(sv, en) + L.T(" Webbspelaren används som vanligt.", " The web player is used as usual.") + (detail != null ? "\n\n" + detail : ""),
                Buttons = { TaskDialogButton.OK },
            });
        }
        return false;
    }
}
