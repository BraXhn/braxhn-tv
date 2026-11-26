using System.Diagnostics;
using BraXhnTV.Spelare;

namespace BraXhnTV;

/// <summary>
/// Provar libmpv-2.dll i en egen process (BraXhnTV.exe --prova-mpv &lt;fil&gt;) innan appen laddar den. Används när
/// processorn saknar AVX2: varianten x86_64-v3 (som README:n förut föreslog) avslutar då processen med "otillåten
/// instruktion" (0xC000001D) – i en egen process blir det ett tydligt besked i stället för en krasch.
/// </summary>
static class MpvProbe
{
    const int IllegalInstruction = unchecked((int)0xC000001D);

    /// <summary>I provprocessen: ladda filen, starta en tom mpv och skriv versionen. 0 = gick bra.</summary>
    public static int Child(string path)
    {
        var lib = Libmpv.Probe(path, out var a);
        if (lib == null) { Console.Error.Write(a.Outcome + ": " + a.Detail); return 2; }
        var v = lib.MpvVersion();
        Console.Out.Write(v ?? "");
        return v != null ? 0 : 3;
    }

    /// <summary>I appen: kör provprocessen och tolka svaret (null = filen går att använda)</summary>
    public static (Libmpv.Outcome, string?)? Run(string path)
    {
        try
        {
            var psi = new ProcessStartInfo(Environment.ProcessPath ?? Application.ExecutablePath) { UseShellExecute = false, RedirectStandardError = true, RedirectStandardOutput = true, CreateNoWindow = true };
            psi.ArgumentList.Add("--prova-mpv");
            psi.ArgumentList.Add(path);
            using var p = Process.Start(psi)!;
            var err = p.StandardError.ReadToEndAsync();
            var outp = p.StandardOutput.ReadToEndAsync();
            if (!p.WaitForExit(20000)) { try { p.Kill(); } catch { } Logg.Write("mpv-prov: svarade inte inom 20 s"); return (Libmpv.Outcome.NotLoadable, "provet svarade inte"); }
            Logg.Write($"mpv-prov: {path} → {p.ExitCode:X8} {outp.Result}{err.Result}");
            return p.ExitCode switch
            {
                0 => null,
                IllegalInstruction => (Libmpv.Outcome.NeedsNewerCpu, "0xC000001D"),
                _ => (Libmpv.Outcome.NotLoadable, err.Result.Length > 0 ? err.Result : $"0x{p.ExitCode:X8}"),
            };
        }
        catch (Exception e)
        {
            // Går provet inte att köra: ladda som förut hellre än att aldrig använda mpv
            Logg.Write("mpv-prov: kunde inte köras – " + e.Message);
            return null;
        }
    }
}
