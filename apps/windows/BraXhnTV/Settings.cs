using System.Text.Json;

namespace BraXhnTV;

public sealed class ServerEntry
{
    public string Id { get; set; } = "";
    public string Url { get; set; } = "";
}

/// <summary>
/// Appens inställningar i %LOCALAPPDATA%\BraXhnTV\installningar.json. Inloggningarna sparar WebView2 själv, i en
/// egen mapp per server (Servrar\&lt;id&gt;), så att två servrar aldrig delar kakor.
/// </summary>
public sealed class AppSettings
{
    public List<ServerEntry> Servers { get; set; } = new();
    public string? LastServer { get; set; }
    /// <summary>Fönstrets läge och storlek (x, y, bredd, höjd) när det inte är maximerat</summary>
    public int[]? Window { get; set; }
    public bool Maximized { get; set; }
    public DateTime LastUpdateCheck { get; set; }
    /// <summary>Versionen som användaren valt att hoppa över</summary>
    public string? SkipVersion { get; set; }

    public static string Dir { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BraXhnTV");
    static string FilePath => Path.Combine(Dir, "installningar.json");
    public static string ServerDir(string id) => Path.Combine(Dir, "Servrar", id);
    static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public static AppSettings Load()
    {
        try
        {
            if (File.Exists(FilePath))
            {
                var s = JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath), Json) ?? new();
                s.Servers.RemoveAll(x => string.IsNullOrEmpty(x.Id) || string.IsNullOrEmpty(x.Url) || x.Id.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0);
                return s;
            }
        }
        catch { /* trasig fil: börja om med tomma inställningar */ }
        return new();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Dir);
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(this, Json));
            File.Move(tmp, FilePath, true);
        }
        catch { /* går det inte att spara nu blir det nästa gång */ }
    }

    /// <summary>Tar bort mappar för servrar som inte längre finns i listan (kunde inte raderas medan de användes)</summary>
    public void CleanUp()
    {
        try
        {
            var root = Path.Combine(Dir, "Servrar");
            if (!Directory.Exists(root)) return;
            foreach (var d in Directory.GetDirectories(root))
                if (!Servers.Any(s => s.Id == Path.GetFileName(d)))
                    try { Directory.Delete(d, true); } catch { }
        }
        catch { }
    }
}
