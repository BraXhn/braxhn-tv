using System.Runtime.InteropServices;
using System.Text;

namespace BraXhnTV.Spelare;

/// <summary>
/// libmpv-2.dll (mpv:s C-API, client.h) laddad dynamiskt. Saknas filen eller är den för gammal blir Load null och
/// webbspelaren används. DLL:en byts mot en annan version genom att filen ersätts (LGPL).
/// </summary>
unsafe sealed class Libmpv
{
    public const string FileName = "libmpv-2.dll";
    // Händelser och format ur client.h
    public const int EvShutdown = 1, EvStartFile = 6, EvEndFile = 7, EvFileLoaded = 8, EvClientMessage = 16, EvPlaybackRestart = 21, EvPropertyChange = 22;
    public const int FmtNone = 0, FmtString = 1, FmtFlag = 3, FmtInt64 = 4, FmtDouble = 5;
    public const int EndEof = 0, EndStop = 2, EndQuit = 3, EndError = 4;

    [StructLayout(LayoutKind.Sequential)] public struct Event { public int Id; public int Error; public ulong ReplyUserdata; public IntPtr Data; }
    [StructLayout(LayoutKind.Sequential)] public struct EventProperty { public IntPtr Name; public int Format; public IntPtr Data; }
    [StructLayout(LayoutKind.Sequential)] public struct EventEndFile { public int Reason; public int Error; }
    [StructLayout(LayoutKind.Sequential)] public struct EventClientMessage { public int NumArgs; public IntPtr Args; }

    public string Path { get; private init; } = "";
    delegate* unmanaged[Cdecl]<uint> apiVersion;
    delegate* unmanaged[Cdecl]<IntPtr> create;
    delegate* unmanaged[Cdecl]<IntPtr, int> initialize;
    delegate* unmanaged[Cdecl]<IntPtr, byte*, byte*, int> setOptionString;
    delegate* unmanaged[Cdecl]<IntPtr, byte*, byte*, int> setPropertyString;
    delegate* unmanaged[Cdecl]<IntPtr, byte*, byte*> getPropertyString;
    delegate* unmanaged[Cdecl]<IntPtr, byte*, int, void*, int> getProperty;
    delegate* unmanaged[Cdecl]<IntPtr, byte**, int> command;
    delegate* unmanaged[Cdecl]<IntPtr, ulong, byte*, int, int> observeProperty;
    delegate* unmanaged[Cdecl]<IntPtr, double, Event*> waitEvent;
    delegate* unmanaged[Cdecl]<IntPtr, void> wakeup;
    delegate* unmanaged[Cdecl]<IntPtr, void> terminateDestroy;
    delegate* unmanaged[Cdecl]<void*, void> free;
    delegate* unmanaged[Cdecl]<int, byte*> errorString;

    /// <summary>Platserna där appen letar: bredvid BraXhnTV.exe (installationen) och %LOCALAPPDATA%\BraXhnTV\mpv</summary>
    public static string[] Candidates() =>
    [
        System.IO.Path.Combine(AppContext.BaseDirectory, FileName),
        System.IO.Path.Combine(AppSettings.Dir, "mpv", FileName),
    ];

    static Libmpv? loaded;
    static string? loadError;

    /// <summary>Laddar en bestämd fil (testerna). null om den inte går att använda.</summary>
    public static Libmpv? LoadFrom(string path)
    {
        if (!NativeLibrary.TryLoad(path, out var h)) return null;
        var m = new Libmpv { Path = path };
        m.Bind(h);
        return (m.apiVersion() >> 16) >= 2 ? m : null;
    }

    /// <summary>Laddar libmpv en gång. null = finns inte eller går inte att använda (orsaken i error).</summary>
    public static Libmpv? Load(out string? error)
    {
        if (loaded != null || loadError != null) { error = loadError; return loaded; }
        foreach (var p in Candidates())
        {
            if (!File.Exists(p)) continue;
            try
            {
                if (!NativeLibrary.TryLoad(p, out var h)) { loadError = "Kunde inte läsa " + p; continue; }
                var m = new Libmpv { Path = p };
                m.Bind(h);
                // libmpv-2 = API-version 2.x
                if ((m.apiVersion() >> 16) < 2) { loadError = "För gammal libmpv: " + p; continue; }
                loaded = m;
                loadError = null;
                break;
            }
            catch (Exception e) { loadError = e.Message; }
        }
        loadError ??= loaded == null ? "libmpv-2.dll saknas" : null;
        error = loadError;
        return loaded;
    }

    void Bind(IntPtr h)
    {
        IntPtr F(string name) => NativeLibrary.GetExport(h, name);
        apiVersion = (delegate* unmanaged[Cdecl]<uint>)F("mpv_client_api_version");
        create = (delegate* unmanaged[Cdecl]<IntPtr>)F("mpv_create");
        initialize = (delegate* unmanaged[Cdecl]<IntPtr, int>)F("mpv_initialize");
        setOptionString = (delegate* unmanaged[Cdecl]<IntPtr, byte*, byte*, int>)F("mpv_set_option_string");
        setPropertyString = (delegate* unmanaged[Cdecl]<IntPtr, byte*, byte*, int>)F("mpv_set_property_string");
        getPropertyString = (delegate* unmanaged[Cdecl]<IntPtr, byte*, byte*>)F("mpv_get_property_string");
        getProperty = (delegate* unmanaged[Cdecl]<IntPtr, byte*, int, void*, int>)F("mpv_get_property");
        command = (delegate* unmanaged[Cdecl]<IntPtr, byte**, int>)F("mpv_command");
        observeProperty = (delegate* unmanaged[Cdecl]<IntPtr, ulong, byte*, int, int>)F("mpv_observe_property");
        waitEvent = (delegate* unmanaged[Cdecl]<IntPtr, double, Event*>)F("mpv_wait_event");
        wakeup = (delegate* unmanaged[Cdecl]<IntPtr, void>)F("mpv_wakeup");
        terminateDestroy = (delegate* unmanaged[Cdecl]<IntPtr, void>)F("mpv_terminate_destroy");
        free = (delegate* unmanaged[Cdecl]<void*, void>)F("mpv_free");
        errorString = (delegate* unmanaged[Cdecl]<int, byte*>)F("mpv_error_string");
    }

    static byte[] U8(string s) => Encoding.UTF8.GetBytes(s + "\0");
    public static string? Str(IntPtr p) => p == IntPtr.Zero ? null : Marshal.PtrToStringUTF8(p);

    public IntPtr Create() => create();
    public int Initialize(IntPtr h) => initialize(h);
    public string Error(int code) => Str((IntPtr)errorString(code)) ?? code.ToString();

    public int SetOption(IntPtr h, string name, string value)
    {
        fixed (byte* n = U8(name), v = U8(value)) return setOptionString(h, n, v);
    }

    public int SetProperty(IntPtr h, string name, string value)
    {
        fixed (byte* n = U8(name), v = U8(value)) return setPropertyString(h, n, v);
    }

    public string? GetString(IntPtr h, string name)
    {
        fixed (byte* n = U8(name))
        {
            var r = getPropertyString(h, n);
            if (r == null) return null;
            var s = Str((IntPtr)r);
            free(r);
            return s;
        }
    }

    public double? GetDouble(IntPtr h, string name)
    {
        double d;
        fixed (byte* n = U8(name)) return getProperty(h, n, FmtDouble, &d) >= 0 ? d : null;
    }

    public int Command(IntPtr h, params string[] args)
    {
        var bufs = args.Select(U8).ToArray();
        var handles = bufs.Select(b => GCHandle.Alloc(b, GCHandleType.Pinned)).ToArray();
        try
        {
            var ptrs = stackalloc byte*[args.Length + 1];
            for (var i = 0; i < args.Length; i++) ptrs[i] = (byte*)handles[i].AddrOfPinnedObject();
            ptrs[args.Length] = null;
            return command(h, ptrs);
        }
        finally { foreach (var g in handles) g.Free(); }
    }

    public int Observe(IntPtr h, ulong id, string name, int format)
    {
        fixed (byte* n = U8(name)) return observeProperty(h, id, n, format);
    }

    public Event* Wait(IntPtr h, double timeout) => waitEvent(h, timeout);
    public void Wakeup(IntPtr h) => wakeup(h);
    public void TerminateDestroy(IntPtr h) => terminateDestroy(h);
}
