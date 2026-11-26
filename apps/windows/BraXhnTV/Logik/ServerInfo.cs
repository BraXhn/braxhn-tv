using System.Text.Json;
using System.Text.RegularExpressions;

namespace BraXhnTV;

/// <summary>
/// Serverns version (GET /api/status, öppen utan inloggning). Webbappen kommer från servern, och kroken som lämnar
/// över filmer till den inbyggda spelaren (web/js/player/native.js) finns först i 1.4.1. Med en äldre server frågar
/// webben aldrig appen – då spelar webbspelaren allt, hur mpv än är installerad.
/// </summary>
public static class ServerInfo
{
    /// <summary>Den första serverversionen vars webbapp lämnar över till den inbyggda spelaren</summary>
    public const string MinNative = "1.4.1";

    /// <summary>Versionen i svaret från /api/status, eller null om svaret inte kommer från en BraXhn TV-server</summary>
    public static string? VersionFromStatus(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object) return null;
            if (!r.TryGetProperty("name", out var n) || n.ValueKind != JsonValueKind.String || n.GetString() != "BraXhn TV") return null;
            if (!r.TryGetProperty("version", out var v) || v.ValueKind != JsonValueKind.String) return null;
            var s = v.GetString() ?? "";
            return Regex.IsMatch(s, @"^\d+\.\d+\.\d+([\-+][0-9A-Za-z.\-+]*)?$") ? s : null;
        }
        catch (JsonException) { return null; }
    }

    /// <summary>Är servern för gammal för den inbyggda spelaren? Okänd version (null) räknas inte som för gammal.</summary>
    public static bool TooOldForNative(string? version) => version != null && Versions.Compare(version, MinNative) < 0;
}
