using Microsoft.Web.WebView2.Core;

namespace BraXhnTV;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        // Provprocessen för libmpv (MpvProbe): ingen fönster, inget annat
        if (args.Length == 2 && args[0] == "--prova-mpv") { Environment.Exit(MpvProbe.Child(args[1])); return; }
        // En app i taget: startas den igen visas fönstret som redan är öppet
        using var mutex = new Mutex(true, @"Local\BraXhnTV-en-instans", out var first);
        using var show = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\BraXhnTV-visa");
        if (!first) { show.Set(); return; }

        ApplicationConfiguration.Initialize();
        if (!WebView2Ready()) return;

        var form = new MainForm(args.Contains("--autostart"));
        new Thread(() =>
        {
            while (show.WaitOne())
                try { form.BeginInvoke(form.ShowFromOutside); } catch { return; }
        }) { IsBackground = true }.Start();
        Application.Run(form);
    }

    /// <summary>WebView2 (Edge) finns i Windows 10 och 11. Saknas den: berätta hur den installeras.</summary>
    static bool WebView2Ready()
    {
        string? error = null;
        try
        {
            if (!string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString())) return true;
        }
        catch (WebView2RuntimeNotFoundException) { }
        catch (Exception e) { error = e.Message; }

        var install = new TaskDialogButton(L.T("Installera WebView2", "Install WebView2"));
        var page = new TaskDialogPage
        {
            Caption = AppInfo.Name,
            Icon = TaskDialogIcon.Error,
            Heading = L.T("Microsoft Edge WebView2 saknas", "Microsoft Edge WebView2 is missing"),
            Text = L.T("BraXhn TV använder WebView2 från Microsoft för att visa servern. Installera den (gratis, från Microsoft) och starta appen igen.",
                       "BraXhn TV uses Microsoft's WebView2 to show the server. Install it (free, from Microsoft) and start the app again.")
                   + (error is null ? "" : "\n\n" + error),
            Buttons = { install, TaskDialogButton.Close },
        };
        if (TaskDialog.ShowDialog(page) == install)
            AppInfo.OpenExternal("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
        return false;
    }
}
