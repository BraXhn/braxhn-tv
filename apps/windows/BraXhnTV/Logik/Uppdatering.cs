using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace BraXhnTV;

/// <summary>Vad som är fel med en nedladdad installationsfil</summary>
public enum FileProblem { None, Missing, Size, Sha, NotExe }

/// <summary>
/// Hämta och installera en ny version (dialogerna finns i Updater.cs): kontrollen av den nedladdade filen och hur
/// installationsfilen startas.
/// </summary>
public static class Uppdatering
{
    /// <summary>
    /// Inno Setup utan frågor: /SILENT visar bara förloppet, /CLOSEAPPLICATIONS stänger appen om den fortfarande är
    /// öppen, /NORESTART startar aldrig om datorn och /STARTAPP får installationsfilen att starta appen igen efteråt
    /// (se [Run] i installer/BraXhnTV.iss). /LOG skriver vad installationen gjorde, för felsökning.
    /// </summary>
    public static string InstallerArguments(string logPath)
    {
        if (logPath.Contains('"')) throw new ArgumentException("Sökvägen får inte innehålla citattecken", nameof(logPath));
        return $"/SILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /STARTAPP \"/LOG={logPath}\"";
    }

    /// <summary>
    /// Kontrollsumman ur en .sha256-fil ("&lt;hex&gt;  BraXhnTV-Setup-1.4.3.exe" som sha256sum skriver, eller bara
    /// summan). null om filen inte går att läsa eller gäller en annan fil.
    /// </summary>
    public static string? ParseSha(string text, string setupName)
    {
        var m = Regex.Match(text.TrimStart('﻿').Trim(), @"^([0-9A-Fa-f]{64})(?:\s+\*?(\S+))?\s*$", RegexOptions.Multiline);
        if (!m.Success) return null;
        if (m.Groups[2].Success && m.Groups[2].Value != setupName) return null;
        return m.Groups[1].Value.ToLowerInvariant();
    }

    /// <summary>
    /// Är filen den som GitHub säger? Storleken ska stämma, kontrollsumman (när utgåvan har en) och filen ska vara ett
    /// Windows-program (PE-huvud).
    /// </summary>
    public static FileProblem CheckFile(string path, long size, string? sha256)
    {
        var fi = new FileInfo(path);
        if (!fi.Exists) return FileProblem.Missing;
        if (fi.Length != size) return FileProblem.Size;
        if (Pe.Machine(path) == null) return FileProblem.NotExe;
        if (sha256 != null)
        {
            using var f = File.OpenRead(path);
            if (!Convert.ToHexString(SHA256.HashData(f)).Equals(sha256, StringComparison.OrdinalIgnoreCase)) return FileProblem.Sha;
        }
        return FileProblem.None;
    }
}
