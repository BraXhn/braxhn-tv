namespace BraXhnTV;

/// <summary>
/// Skärmens uppdateringsfrekvens efter filmen (hemmabio): 23,976 bilder/s visas bäst på 23,976 Hz (Windows kallar
/// läget "23"), 24 på 24, 25 på 25 eller 50 och så vidare – annars rycker panoreringar.
/// </summary>
public static class RefreshRate
{
    /// <summary>
    /// Bästa frekvensen bland skärmens lägen (samma upplösning), eller null om den nuvarande redan passar eller inget
    /// läge passar. Lägsta multipel först (24 före 48 före 120).
    /// </summary>
    public static int? Pick(double fps, int current, IEnumerable<int> rates)
    {
        if (!(fps >= 10 && fps <= 121)) return null;
        var set = new HashSet<int>(rates.Where(r => r > 0));
        // NTSC-takter (23,976, 29,97, 59,94) heter "23", "29" och "59" i Windows; hela takter sitt eget tal
        var ntsc = Math.Abs(fps - Math.Round(fps)) > 0.01 && Math.Abs(fps * 1.001 - Math.Round(fps * 1.001)) < 0.02;
        for (var k = 1; k <= 5; k++)
        {
            var target = fps * k;
            if (target > 241) break;
            var exact = ntsc ? (int)Math.Floor(target) : (int)Math.Round(target);
            var near = ntsc ? (int)Math.Round(target * 1.001) : exact;
            foreach (var r in new[] { exact, near })
                if (set.Contains(r)) return r == current ? null : r;
            if (current == exact || current == near) return null;
        }
        return null;
    }
}
