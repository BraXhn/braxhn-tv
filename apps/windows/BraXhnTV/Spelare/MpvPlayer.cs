using System.Globalization;
using System.Runtime.InteropServices;

namespace BraXhnTV.Spelare;

/// <summary>Det webben skickar när den inbyggda spelaren ska spela (web/js/player/nativeplan.js nativePlan)</summary>
sealed class PlayRequest
{
    public long Id;
    public string Url = "", Title = "", Sub = "";
    public double Start, Duration;
    public int? Audio;                       // ffmpeg-index för ljudspåret
    public List<SubTrack> Subs = new();
    public long? NextId;
    /// <summary>Kontots "spela nästa avsnitt automatiskt"</summary>
    public bool AutoNext;
    /// <summary>Kapitlen (start i sekunder, titel) – visas vid muspekaren på tidslinjen</summary>
    public List<(double Start, string Title)> Chapters = new();
}
sealed class SubTrack { public string Id = "", Label = "", Lang = ""; public int? Index; public string? Url; }

/// <summary>Inställningarna för hemmabion</summary>
sealed record PlayerOptions(bool Passthrough, int Volume, string ConfigDir, IReadOnlyDictionary<string, string>? Extra = null);

/// <summary>
/// En uppspelning i mpv, ritad i en panel i appens fönster (wid). Händelserna kommer på UI-tråden. Alla fel blir
/// Failed – appen kraschar inte och webbspelaren tar över.
/// </summary>
unsafe sealed class MpvPlayer
{
    readonly Libmpv mpv;
    readonly long wid;
    readonly Action<Action> ui;
    IntPtr h;
    Thread? loop;
    volatile bool stopping;
    volatile bool started;
    public PlayRequest Request { get; }
    public double Position { get; private set; }
    public bool Paused { get; private set; }
    public double Fps { get; private set; }
    public int Volume { get; private set; } = -1;

    public event Action? Started;
    public event Action<string>? Failed;     // orsaken; före eller efter starten
    public event Action? Ended;              // filmen tog slut
    public event Action<string>? Command;    // bx-close, bx-esc, bx-fullscreen, bx-next
    public event Action? PauseChanged;
    public event Action? Gone;               // mpv är helt stängd (panelen får tas bort)

    const ulong PropTime = 1, PropPause = 2, PropVolume = 3, PropDuration = 4, PropMute = 5, PropCache = 6;
    public double Duration { get; private set; }
    public bool Muted { get; private set; }
    /// <summary>Hur långt filen är buffrad (sekunder i filen), 0 = okänt</summary>
    public double CachedUntil { get; private set; }

    /// <summary>wid: fönstret mpv ritar i (0 = inget, i testerna). ui: kör en händelse på UI-tråden.</summary>
    public MpvPlayer(Libmpv mpv, long wid, Action<Action> ui, PlayRequest req)
    {
        this.mpv = mpv; this.wid = wid; this.ui = ui; Request = req;
    }

    void Ui(Action a) { try { ui(a); } catch { } }

    public void Start(PlayerOptions o)
    {
        h = mpv.Create();
        if (h == IntPtr.Zero) throw new InvalidOperationException("mpv_create misslyckades");
        // Före initialize: fönstret. Reglagen, musen och tangenterna sköter appen själv (Spelare/Reglage.cs,
        // PlayerUi.ForKey) – mpv:s egna (OSC, standardtangenter, mus i fönstret) är avstängda, så att
        // inget dubbleras och raden ser ut som resten av appen. input.conf finns kvar för script-message (bx-…).
        if (wid != 0) Opt("wid", wid.ToString(CultureInfo.InvariantCulture));
        Opt("config", "no");
        Opt("terminal", "no");
        Opt("input-default-bindings", "no");
        Opt("input-vo-keyboard", "no");
        Opt("input-cursor", "no");
        Opt("input-conf", InputConf(o.ConfigDir));
        Opt("osc", "no");
        Opt("load-scripts", "no");
        Opt("ytdl", "no");
        Opt("idle", "yes");
        Opt("keep-open", "no");
        Opt("force-window", "yes");
        Opt("cursor-autohide", "no");
        Opt("osd-bar", "yes");
        Opt("force-media-title", Request.Title);
        // Bilden: hårdvaruavkodning när den är säker, libplacebo; HDR till skärmen när Windows HDR är på, annars tonmappning
        Opt("hwdec", "auto-safe");
        Opt("vo", "gpu-next");
        Opt("target-colorspace-hint", "yes");
        // Nätet: en stor buffert, så att hemmets uppladdning hinner med vid toppar i bithastigheten
        Opt("cache", "yes");
        Opt("demuxer-max-bytes", "300MiB");
        Opt("demuxer-max-back-bytes", "100MiB");
        Opt("network-timeout", "30");
        // Ljudet: orört till förstärkaren (bitström) när det är valt – kräver exklusivt läge för TrueHD och DTS-HD
        if (o.Passthrough)
        {
            Opt("audio-spdif", "ac3,eac3,dts,dts-hd,truehd");
            Opt("audio-exclusive", "yes");
        }
        Opt("volume", Math.Clamp(o.Volume, 0, 100).ToString(CultureInfo.InvariantCulture));
        Opt("volume-max", "100");
        Opt("media-controls", "yes");   // Windows medieruta (finns i nyare mpv; ignoreras annars)
        Opt("slang", "");
        Opt("sid", "no");
        if (Request.Start > 0) Opt("start", Request.Start.ToString("0.###", CultureInfo.InvariantCulture));
        foreach (var (k, v) in o.Extra ?? new Dictionary<string, string>()) Opt(k, v);

        var err = mpv.Initialize(h);
        if (err < 0) throw new InvalidOperationException("mpv_initialize: " + mpv.Error(err));
        mpv.Observe(h, PropTime, "time-pos", Libmpv.FmtDouble);
        mpv.Observe(h, PropPause, "pause", Libmpv.FmtFlag);
        mpv.Observe(h, PropVolume, "volume", Libmpv.FmtDouble);
        mpv.Observe(h, PropDuration, "duration", Libmpv.FmtDouble);
        mpv.Observe(h, PropMute, "mute", Libmpv.FmtFlag);
        mpv.Observe(h, PropCache, "demuxer-cache-time", Libmpv.FmtDouble);
        loop = new Thread(EventLoop) { IsBackground = true, Name = "mpv" };
        loop.Start();
        err = mpv.Command(h, "loadfile", Request.Url, "replace");
        if (err < 0) throw new InvalidOperationException("loadfile: " + mpv.Error(err));
    }

    void Opt(string name, string value) => mpv.SetOption(h, name, value); // okända val (äldre mpv) ignoreras

    /// <summary>Tangenterna: Esc, q, f/dubbelklick och N går till appen (helskärm, stäng, nästa avsnitt)</summary>
    static string InputConf(string dir)
    {
        Directory.CreateDirectory(dir);
        var path = System.IO.Path.Combine(dir, "input.conf");
        const string conf = """
            # BraXhn TV: de här tangenterna sköter appen. Övriga är mpv:s vanliga (mellanslag, pilar, 9/0 = volym, # = ljudspår, j = undertext).
            ESC script-message bx-esc
            q script-message bx-close
            Q script-message bx-close
            f script-message bx-fullscreen
            F11 script-message bx-fullscreen
            MBTN_LEFT_DBL script-message bx-fullscreen
            N script-message bx-next
            """;
        try { if (!File.Exists(path) || File.ReadAllText(path) != conf) File.WriteAllText(path, conf); } catch { }
        return path;
    }

    /// <summary>Läser en egenskap (tester och felsökning)</summary>
    public string? Get(string name) => h == IntPtr.Zero || stopping ? null : mpv.GetString(h, name);
    /// <summary>Skickar ett kommando till mpv</summary>
    public void Send(params string[] args) { if (h != IntPtr.Zero && !stopping) mpv.Command(h, args); }

    public void TogglePause() { if (h != IntPtr.Zero && !stopping) mpv.Command(h, "cycle", "pause"); }
    /// <summary>Sätter en egenskap (aid, sid, volume, speed, sub-scale …)</summary>
    public void Set(string name, string value) { if (h != IntPtr.Zero && !stopping) mpv.SetProperty(h, name, value); }
    static string N(double d) => d.ToString("0.###", CultureInfo.InvariantCulture);
    /// <summary>Spolar till en position. exact = på bildrutan (när man släpper tidslinjen), annars närmaste nyckelbild.</summary>
    public void SeekTo(double sec, bool exact = true) => Send("seek", N(Math.Max(0, sec)), exact ? "absolute+exact" : "absolute+keyframes");
    public void SeekBy(double sec) => Send("seek", N(sec), "relative");
    public void SetVolume(int v) => Set("volume", Math.Clamp(v, 0, 100).ToString(CultureInfo.InvariantCulture));
    /// <summary>En kort text i bilden (mpv:s OSD), t.ex. volymen efter scrollhjulet</summary>
    public void ShowText(string text, int ms = 1200) => Send("show-text", text, ms.ToString(CultureInfo.InvariantCulture));

    /// <summary>Ett spår i filen (ljud eller undertext) för menyerna</summary>
    public sealed record Track(int Id, string Type, string? Title, string? Lang, string? Codec, int? Channels, bool Selected, bool External);

    /// <summary>Spåren i filen av en sort ("audio" eller "sub")</summary>
    public List<Track> Tracks(string type)
    {
        var list = new List<Track>();
        if (h == IntPtr.Zero || stopping) return list;
        var count = int.TryParse(mpv.GetString(h, "track-list/count"), out var n) ? n : 0;
        for (var i = 0; i < count; i++)
        {
            string? G(string k) => mpv.GetString(h, $"track-list/{i}/{k}");
            if (G("type") != type || !int.TryParse(G("id"), out var id)) continue;
            list.Add(new Track(id, type, G("title"), G("lang"), G("codec"), int.TryParse(G("demux-channel-count"), out var ch) ? ch : null, G("selected") == "yes", G("external") == "yes"));
        }
        return list;
    }

    /// <summary>Stänger mpv. Gone kommer när allt är stängt.</summary>
    public void Stop()
    {
        if (stopping) return;
        stopping = true;
        if (h == IntPtr.Zero) { Ui(() => Gone?.Invoke()); return; }
        try { mpv.Command(h, "quit"); mpv.Wakeup(h); } catch { }
        if (loop == null) { try { mpv.TerminateDestroy(h); } catch { } h = IntPtr.Zero; Ui(() => Gone?.Invoke()); }
    }

    void EventLoop()
    {
        try
        {
            while (true)
            {
                var e = mpv.Wait(h, 1);
                if (e == null) continue;
                if (e->Id == Libmpv.EvShutdown) break;
                if (e->Id == 0) { if (stopping) { mpv.Command(h, "quit"); } continue; }
                Handle(e);
            }
        }
        catch (Exception ex) { var msg = ex.Message; Ui(() => Failed?.Invoke(msg)); }
        // mpv stängs här, i spelarens egen tråd (inte UI-tråden: mpv:s fönster kan vänta på den)
        try { mpv.TerminateDestroy(h); } catch { }
        h = IntPtr.Zero;
        Ui(() => Gone?.Invoke());
    }

    void Handle(Libmpv.Event* e)
    {
        switch (e->Id)
        {
            case Libmpv.EvFileLoaded:
                SelectTracks();
                Fps = mpv.GetDouble(h, "container-fps") ?? 0;
                break;
            case Libmpv.EvPlaybackRestart:
                if (!started && !stopping) { started = true; Ui(() => Started?.Invoke()); }
                break;
            case Libmpv.EvEndFile:
            {
                var ef = (Libmpv.EventEndFile*)e->Data;
                if (stopping || ef == null) break;
                if (ef->Reason == Libmpv.EndEof) Ui(() => Ended?.Invoke());
                else if (ef->Reason == Libmpv.EndError) { var why = mpv.Error(ef->Error); Ui(() => Failed?.Invoke(why)); }
                break;
            }
            case Libmpv.EvClientMessage:
            {
                var m = (Libmpv.EventClientMessage*)e->Data;
                if (m == null || m->NumArgs < 1) break;
                var arg = Libmpv.Str(Marshal.ReadIntPtr(m->Args));
                if (arg != null && arg.StartsWith("bx-", StringComparison.Ordinal)) Ui(() => Command?.Invoke(arg));
                break;
            }
            case Libmpv.EvPropertyChange:
            {
                var p = (Libmpv.EventProperty*)e->Data;
                if (p == null || p->Data == IntPtr.Zero) break;
                if (e->ReplyUserdata == PropTime && p->Format == Libmpv.FmtDouble) Position = *(double*)p->Data;
                else if (e->ReplyUserdata == PropVolume && p->Format == Libmpv.FmtDouble) Volume = (int)Math.Round(*(double*)p->Data);
                else if (e->ReplyUserdata == PropDuration && p->Format == Libmpv.FmtDouble) Duration = *(double*)p->Data;
                else if (e->ReplyUserdata == PropMute && p->Format == Libmpv.FmtFlag) Muted = *(int*)p->Data != 0;
                else if (e->ReplyUserdata == PropCache && p->Format == Libmpv.FmtDouble) CachedUntil = *(double*)p->Data;
                else if (e->ReplyUserdata == PropPause && p->Format == Libmpv.FmtFlag)
                {
                    var paused = *(int*)p->Data != 0;
                    if (paused != Paused) { Paused = paused; Ui(() => PauseChanged?.Invoke()); }
                }
                break;
            }
        }
    }

    /// <summary>Ljudspåret och undertexten som webben valde (kontots språkval), hittade med ffmpeg-index i filen</summary>
    void SelectTracks()
    {
        var count = int.TryParse(mpv.GetString(h, "track-list/count"), out var n) ? n : 0;
        int? Find(string type, int ffIndex)
        {
            for (var i = 0; i < count; i++)
                if (mpv.GetString(h, $"track-list/{i}/type") == type && mpv.GetString(h, $"track-list/{i}/ff-index") == ffIndex.ToString(CultureInfo.InvariantCulture)
                    && int.TryParse(mpv.GetString(h, $"track-list/{i}/id"), out var id)) return id;
            return null;
        }
        if (Request.Audio is int a && Find("audio", a) is int aid) mpv.SetProperty(h, "aid", aid.ToString(CultureInfo.InvariantCulture));
        // Undertexter från filer bredvid filmen och nedladdade: läggs till från servern (WebVTT). Den valda visas.
        foreach (var s in Request.Subs.Where(s => s.Url != null))
            mpv.Command(h, "sub-add", s.Url!, s.Id == Request.Sub ? "select" : "auto", s.Label, s.Lang);
        var sel = Request.Subs.FirstOrDefault(s => s.Id == Request.Sub);
        if (sel?.Index is int si && Find("sub", si) is int sid) mpv.SetProperty(h, "sid", sid.ToString(CultureInfo.InvariantCulture));
        else if (sel == null) mpv.SetProperty(h, "sid", "no");
    }
}
