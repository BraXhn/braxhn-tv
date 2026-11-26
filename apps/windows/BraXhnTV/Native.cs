using System.Runtime.InteropServices;

namespace BraXhnTV;

static partial class Native
{
    // Viloläge och skärmsläckare
    public const uint ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x1, ES_DISPLAY_REQUIRED = 0x2;
    [LibraryImport("kernel32.dll")]
    public static partial uint SetThreadExecutionState(uint flags);

    // Mörk titelrad (Windows 10 20H1 och senare: 20, äldre: 19)
    [LibraryImport("dwmapi.dll")]
    public static partial int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    public static void DarkTitleBar(IntPtr hwnd)
    {
        var on = 1;
        if (DwmSetWindowAttribute(hwnd, 20, ref on, sizeof(int)) != 0) DwmSetWindowAttribute(hwnd, 19, ref on, sizeof(int));
    }

    // Fönstermenyn (högerklick på titelraden eller Alt+Mellanslag)
    public const int WM_SYSCOMMAND = 0x0112;
    public const uint MF_STRING = 0x0, MF_SEPARATOR = 0x800, MF_CHECKED = 0x8, MF_UNCHECKED = 0x0, MF_BYCOMMAND = 0x0;
    [LibraryImport("user32.dll")]
    public static partial IntPtr GetSystemMenu(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool revert);
    [LibraryImport("user32.dll", EntryPoint = "AppendMenuW", StringMarshalling = StringMarshalling.Utf16)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool AppendMenu(IntPtr menu, uint flags, nuint id, string? text);
    [LibraryImport("user32.dll")]
    public static partial uint CheckMenuItem(IntPtr menu, uint id, uint check);
    [LibraryImport("user32.dll", EntryPoint = "ModifyMenuW", StringMarshalling = StringMarshalling.Utf16)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool ModifyMenu(IntPtr menu, uint position, uint flags, nuint id, string? text);
}
