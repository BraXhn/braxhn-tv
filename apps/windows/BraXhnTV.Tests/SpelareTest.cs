using System.Collections.Concurrent;
using System.Diagnostics;
using BraXhnTV.Spelare;
using Xunit;

/// <summary>
/// Den inbyggda spelaren mot en riktig libmpv (samma C-API på alla system): spårval via ffmpeg-index, start mitt i,
/// appens tangenter (script-message), slut och stängning. Hoppas över när libmpv eller ffmpeg saknas.
/// </summary>
public class SpelareTest
{
    static string? LibPath()
    {
        var env = Environment.GetEnvironmentVariable("BRAXHN_LIBMPV");
        foreach (var p in new[] { env, "/lib/x86_64-linux-gnu/libmpv.so.2", "/usr/lib/x86_64-linux-gnu/libmpv.so.2", "/opt/homebrew/lib/libmpv.dylib" })
            if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p;
        return null;
    }

    static bool Ffmpeg()
    {
        try { using var p = Process.Start(new ProcessStartInfo("ffmpeg", "-version") { RedirectStandardOutput = true }); p!.WaitForExit(); return p.ExitCode == 0; }
        catch { return false; }
    }

    [Fact]
    public void Spelar_valt_ljudspar_och_undertext_fran_startpositionen_till_slutet()
    {
        var lib = LibPath() is string path ? Libmpv.LoadFrom(path) : null;
        if (lib == null || !Ffmpeg()) return; // finns inte här: provas där libmpv finns
        var dir = Directory.CreateTempSubdirectory("bxtv-mpv-").FullName;
        try
        {
            // 4 s film: bild (0), engelskt ljud (1), svenskt ljud (2), svensk undertext (3)
            File.WriteAllText(Path.Combine(dir, "s.srt"), "1\n00:00:00,500 --> 00:00:03,500\nHej\n");
            var file = Path.Combine(dir, "film.mkv");
            using (var ff = Process.Start(new ProcessStartInfo("ffmpeg", $"-y -loglevel error -f lavfi -i testsrc2=d=4:s=320x240:r=24 -f lavfi -i sine=f=440:d=4 -f lavfi -i sine=f=880:d=4 -i \"{Path.Combine(dir, "s.srt")}\" -map 0 -map 1 -map 2 -map 3 -c:v libx264 -c:a aac -c:s srt -metadata:s:a:0 language=eng -metadata:s:a:1 language=swe -metadata:s:s:0 language=swe \"{file}\"")))
                ff!.WaitForExit();
            Assert.True(File.Exists(file));

            var q = new BlockingCollection<Action>();
            var req = new PlayRequest { Id = 7, Url = file, Title = "Prov", Start = 1, Audio = 2, Sub = "e3", Subs = { new SubTrack { Id = "e3", Index = 3, Lang = "swe" } } };
            var p = new MpvPlayer(lib, 0, q.Add, req);
            var log = new List<string>();
            p.Started += () => log.Add("start");
            p.Ended += () => log.Add("slut");
            p.Failed += (why) => log.Add("fel:" + why);
            p.Command += (c) => log.Add(c);
            p.Gone += () => log.Add("borta");
            p.Start(new PlayerOptions(false, 50, Path.Combine(dir, "conf"), new Dictionary<string, string> { ["vo"] = "null", ["ao"] = "null" }));

            bool Until(string what, int ms)
            {
                var sw = Stopwatch.StartNew();
                while (!log.Contains(what) && sw.ElapsedMilliseconds < ms)
                    if (q.TryTake(out var a, 100)) a();
                return log.Contains(what);
            }
            Assert.True(Until("start", 10000), string.Join(",", log));
            Assert.Equal("2", p.Get("aid"));          // det svenska ljudspåret (ffmpeg-index 2)
            Assert.Equal("1", p.Get("sid"));          // undertexten (ffmpeg-index 3)
            Assert.True(double.Parse(p.Get("time-pos") ?? "0", System.Globalization.CultureInfo.InvariantCulture) >= 0.9, "började vid 1 s");
            Assert.Equal("50.000000", p.Get("volume"));
            // Kontrollradens uppgifter: spåren (menyerna), längden och volymen
            var audio = p.Tracks("audio");
            Assert.Equal(2, audio.Count);
            Assert.Equal("swe", audio.Single(t => t.Selected).Lang);
            Assert.Single(p.Tracks("sub"));
            var sw0 = Stopwatch.StartNew();
            while (p.Duration <= 0 && sw0.ElapsedMilliseconds < 3000) if (q.TryTake(out var a0, 50)) a0();
            Assert.InRange(p.Duration, 3.5, 4.5);
            p.SetVolume(130);
            Assert.Equal("100.000000", p.Get("volume"));
            p.SetVolume(50);
            Assert.Equal("no", p.Get("osc") ?? "no");
            p.Send("script-message", "bx-next");
            Assert.True(Until("bx-next", 3000), string.Join(",", log));
            Assert.True(Until("slut", 10000), string.Join(",", log));
            Assert.True(p.Position >= 2.5, "positionen följde med: " + p.Position);
            p.Stop();
            Assert.True(Until("borta", 5000), string.Join(",", log));
            Assert.DoesNotContain(log, x => x.StartsWith("fel:"));
            Assert.Contains("bx-close", File.ReadAllText(Path.Combine(dir, "conf", "input.conf")));
        }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }

    [Fact]
    public void Fil_som_inte_finns_blir_fel_och_inte_en_krasch()
    {
        var lib = LibPath() is string path ? Libmpv.LoadFrom(path) : null;
        if (lib == null) return;
        var dir = Directory.CreateTempSubdirectory("bxtv-mpv-").FullName;
        try
        {
            var q = new BlockingCollection<Action>();
            var p = new MpvPlayer(lib, 0, q.Add, new PlayRequest { Id = 8, Url = Path.Combine(dir, "finns-inte.mkv") });
            var log = new List<string>();
            p.Failed += (why) => log.Add("fel");
            p.Started += () => log.Add("start");
            p.Gone += () => log.Add("borta");
            p.Start(new PlayerOptions(false, 100, dir, new Dictionary<string, string> { ["vo"] = "null", ["ao"] = "null" }));
            var sw = Stopwatch.StartNew();
            while (!log.Contains("fel") && sw.ElapsedMilliseconds < 10000) if (q.TryTake(out var a, 100)) a();
            Assert.Contains("fel", log);
            Assert.DoesNotContain("start", log);
            p.Stop();
            sw.Restart();
            while (!log.Contains("borta") && sw.ElapsedMilliseconds < 5000) if (q.TryTake(out var a, 100)) a();
            Assert.Contains("borta", log);
        }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }
}
