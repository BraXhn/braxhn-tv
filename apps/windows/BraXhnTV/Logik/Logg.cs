using System.Text;

namespace BraXhnTV;

/// <summary>
/// Appens loggfil, %LOCALAPPDATA%\BraXhnTV\logg.txt: vad den inbyggda spelaren och serverkontrollen gjorde, så att
/// ägaren kan skicka den med en felrapport. Högst <see cref="Max"/> byte – blir den större sparas bara den senare
/// halvan. Aldrig adresser med token (strömlänkarna loggas inte).
/// </summary>
public static class Logg
{
    public const long Max = 256 * 1024;
    static readonly object Gate = new();
    public static string FilePath { get; set; } = Path.Combine(AppSettings.Dir, "logg.txt");

    public static void Write(string text)
    {
        var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {text.Replace('\r', ' ').Replace('\n', ' ')}\n";
        lock (Gate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
                var fi = new FileInfo(FilePath);
                if (fi.Exists && fi.Length + line.Length > Max) Shrink();
                File.AppendAllText(FilePath, line, Encoding.UTF8);
            }
            catch { /* loggen får aldrig stoppa appen */ }
        }
    }

    /// <summary>Behåller den senare halvan av filen, från en hel rad</summary>
    static void Shrink()
    {
        var bytes = File.ReadAllBytes(FilePath);
        var start = (int)Math.Max(0, bytes.Length - Max / 2);
        if (start > 0) { var nl = Array.IndexOf(bytes, (byte)'\n', start); start = nl < 0 ? bytes.Length : nl + 1; }
        var tmp = FilePath + ".tmp";
        File.WriteAllBytes(tmp, bytes[start..]);
        File.Move(tmp, FilePath, true);
    }

    /// <summary>Slutet av loggen (för "Kopiera felsökningsinformation")</summary>
    public static string Tail(int maxChars = 6000)
    {
        lock (Gate)
        {
            try
            {
                if (!File.Exists(FilePath)) return "";
                var s = File.ReadAllText(FilePath, Encoding.UTF8);
                if (s.Length <= maxChars) return s;
                var cut = s.IndexOf('\n', s.Length - maxChars);
                return cut < 0 ? s[^maxChars..] : s[(cut + 1)..];
            }
            catch { return ""; }
        }
    }
}
