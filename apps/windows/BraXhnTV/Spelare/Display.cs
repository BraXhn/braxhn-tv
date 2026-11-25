using System.Runtime.InteropServices;

namespace BraXhnTV.Spelare;

/// <summary>Byter skärmens uppdateringsfrekvens efter filmen och tillbaka (valfritt, för hemmabion)</summary>
static class Display
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
        public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }
    const int ENUM_CURRENT_SETTINGS = -1, DM_DISPLAYFREQUENCY = 0x400000, CDS_FULLSCREEN = 0x4, DISP_CHANGE_SUCCESSFUL = 0;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool EnumDisplaySettingsW(string device, int mode, ref DEVMODE dm);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int ChangeDisplaySettingsExW(string device, ref DEVMODE dm, IntPtr hwnd, int flags, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int ChangeDisplaySettingsExW(string device, IntPtr dm, IntPtr hwnd, int flags, IntPtr param);

    static string? changed; // skärmen vars läge appen har bytt

    /// <summary>Byter till den frekvens som passar filmen. Gör ingenting om inget läge passar.</summary>
    public static void Match(Screen screen, double fps)
    {
        try
        {
            var dev = screen.DeviceName;
            var cur = New();
            if (!EnumDisplaySettingsW(dev, ENUM_CURRENT_SETTINGS, ref cur)) return;
            var rates = new List<int>();
            var m = New();
            for (var i = 0; EnumDisplaySettingsW(dev, i, ref m); i++, m = New())
                if (m.dmPelsWidth == cur.dmPelsWidth && m.dmPelsHeight == cur.dmPelsHeight && m.dmBitsPerPel == cur.dmBitsPerPel)
                    rates.Add(m.dmDisplayFrequency);
            var pick = RefreshRate.Pick(fps, cur.dmDisplayFrequency, rates);
            if (pick is not int hz) return;
            var want = cur;
            want.dmDisplayFrequency = hz;
            want.dmFields = DM_DISPLAYFREQUENCY;
            // CDS_FULLSCREEN: tillfälligt – Windows går tillbaka om appen stängs
            if (ChangeDisplaySettingsExW(dev, ref want, IntPtr.Zero, CDS_FULLSCREEN, IntPtr.Zero) == DISP_CHANGE_SUCCESSFUL) changed = dev;
        }
        catch { }
    }

    /// <summary>Tillbaka till skärmens vanliga läge</summary>
    public static void Restore()
    {
        if (changed == null) return;
        try { ChangeDisplaySettingsExW(changed, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero); } catch { }
        changed = null;
    }

    static DEVMODE New() => new() { dmDeviceName = "", dmFormName = "", dmSize = (short)Marshal.SizeOf<DEVMODE>() };
}
