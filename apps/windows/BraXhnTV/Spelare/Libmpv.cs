using System.Runtime.InteropServices;
using System.Text;

namespace BraXhnTV.Spelare;

/// <summary>
/// libmpv-2.dll (mpv:s C-API, client.h) laddad dynamiskt. Saknas filen, är den för fel processor eller för gammal blir Load null och
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
        System.IO.Path.Combine(Folder, FileName),
    ];

    /// <summary>%LOCALAPPDATA%\BraXhnTV\mpv – dit appen hämtar mpv</summary>
    public static string Folder => System.IO.Path.Combine(AppSettings.Dir, "mpv");
    /// <summary>Följer libmpv med installationen (bredvid BraXhnTV.exe)? Då hämtar appen den aldrig själv.</summary>
    public static bool Bundled => File.Exists(System.IO.Path.Combine(AppContext.BaseDirectory, FileName));
    /// <summary>En nyare version som hämtades medan den gamla var laddad; byts in vid nästa start</summary>
    public static string Pending => System.IO.Path.Combine(Folder, FileName + ".ny");

    /// <summary>Utfallet för en plats: Missing (ingen fil), WrongArch, NeedsNewerCpu (t.ex. x86_64-v3 utan AVX2), NotLoadable, TooOld, Loaded</summary>
    public enum Outcome { Missing, WrongArch, NeedsNewerCpu, NotLoadable, TooOld, Loaded }

    /// <summary>
    /// Provning i en egen process innan filen laddas i appen (sätts av appen när processorn saknar AVX2): en
    /// x86_64-v3-byggnad kraschar då med "otillåten instruktion" – det får inte ta med sig hela appen.
    /// Svar: null = gick bra, annars utfallet och felet.
    /// </summary>
    public static Func<string, (Outcome outcome, string? detail)?>? Precheck { get; set; }
    static readonly Dictionary<string, (Outcome outcome, string? detail)?> prechecked = new();
    public sealed record Attempt(string Path, Outcome Outcome, string? Machine, string? Detail);

    static readonly object Gate = new();
    static Libmpv? loaded;
    static IReadOnlyList<Attempt> attempts = [];
    /// <summary>Vad senaste laddningen provade, plats för plats (Om den inbyggda spelaren)</summary>
    public static IReadOnlyList<Attempt> LastAttempts { get { lock (Gate) return attempts; } }
    public static bool IsLoaded { get { lock (Gate) return loaded != null; } }
    /// <summary>Processorns arkitektur som DLL:en måste vara byggd för (appen är x64, även på ARM-datorer)</summary>
    public static string ProcessMachine => RuntimeInformation.ProcessArchitecture switch { Architecture.X86 => "x86", Architecture.Arm64 => "arm64", _ => "x64" };

    /// <summary>Laddar en bestämd fil (testerna och kontrollen efter nedladdning). null om den inte går att använda.</summary>
    public static Libmpv? LoadFrom(string path) => Probe(path, out _);

    /// <summary>Provar en fil: laddas den, och annars varför inte</summary>
    public static Libmpv? Probe(string path, out Attempt attempt)
    {
        if (!File.Exists(path)) { attempt = new(path, Outcome.Missing, null, null); return null; }
        // En Windows-DLL för fel processor (t.ex. 32-bitarsvarianten i686) går inte att ladda – säg det tydligt
        var machine = Pe.Machine(path);
        if (machine != null && machine != ProcessMachine) { attempt = new(path, Outcome.WrongArch, machine, null); return null; }
        if (Precheck != null)
        {
            var fi = new FileInfo(path);
            var key = $"{path}|{fi.Length}|{fi.LastWriteTimeUtc.Ticks}";
            if (!prechecked.TryGetValue(key, out var r)) prechecked[key] = r = Precheck(path);
            if (r is { } bad) { attempt = new(path, bad.outcome, machine, bad.detail); return null; }
        }
        IntPtr h;
        try { h = NativeLibrary.Load(path); }
        catch (Exception e) { attempt = new(path, Outcome.NotLoadable, machine, e.Message); return null; }
        try
        {
            var m = new Libmpv { Path = path };
            m.Bind(h);
            var api = m.apiVersion();
            // libmpv-2 = API-version 2.x
            if ((api >> 16) < 2) { attempt = new(path, Outcome.TooOld, machine, $"API {api >> 16}.{api & 0xffff}"); return null; }
            attempt = new(path, Outcome.Loaded, machine, null);
            return m;
        }
        catch (Exception e) { attempt = new(path, Outcome.NotLoadable, machine, e.Message); return null; }
    }

    /// <summary>
    /// Laddar libmpv. null = finns inte eller går inte att använda (orsaken i error, alla försök i LastAttempts).
    /// Bara en lyckad laddning sparas: läggs filen dit (eller hämtas den) medan appen kör används den nästa gång,
    /// utan omstart.
    /// </summary>
    public static Libmpv? Load(out string? error)
    {
        lock (Gate)
        {
            if (loaded != null) { error = null; return loaded; }
            ApplyPending();
            var list = new List<Attempt>();
            foreach (var p in Candidates())
            {
                var m = Probe(p, out var a);
                list.Add(a);
                if (m != null) { loaded = m; break; }
            }
            attempts = list;
            var bad = list.LastOrDefault(x => x.Outcome != Outcome.Missing && x.Outcome != Outcome.Loaded);
            error = loaded != null ? null
                : bad == null ? FileName + " saknas"
                : bad.Outcome == Outcome.WrongArch ? $"{bad.Path}: fel arkitektur ({bad.Machine}, behöver {ProcessMachine})"
                : bad.Outcome == Outcome.TooOld ? $"{bad.Path}: för gammal libmpv ({bad.Detail})"
                : bad.Outcome == Outcome.NeedsNewerCpu ? $"{bad.Path}: kräver en nyare processor (AVX2 – troligen varianten x86_64-v3)"
                : $"{bad.Path}: {bad.Detail}";
            return loaded;
        }
    }

    /// <summary>En version som hämtades medan den förra var laddad byts in innan något laddas</summary>
    static void ApplyPending()
    {
        try { if (File.Exists(Pending)) File.Move(Pending, System.IO.Path.Combine(Folder, FileName), true); }
        catch { /* filen används: nästa gång */ }
    }

    /// <summary>mpv:s version ("mpv v0.39.0-…"), eller null. Startar och stänger en tom mpv.</summary>
    public string? MpvVersion()
    {
        var h = create();
        if (h == IntPtr.Zero) return null;
        try
        {
            SetOption(h, "vo", "null");
            SetOption(h, "ao", "null");
            return initialize(h) < 0 ? null : GetString(h, "mpv-version");
        }
        finally { terminateDestroy(h); }
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
