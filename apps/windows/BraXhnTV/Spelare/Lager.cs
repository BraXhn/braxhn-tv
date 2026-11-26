using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace BraXhnTV.Spelare;

/// <summary>
/// Ett fönster över bilden med genomskinlighet per bildpunkt (Windows "layered window", UpdateLayeredWindow).
/// Så kan spelarraden vara en mjuk tonad gradient över filmen – en vanlig WinForms-kontroll kan inte vara
/// genomskinlig över mpv:s fönster, som ritas av grafikkortet i en egen tråd. Bildpunkter med alfa 0 släpper igenom
/// musen till muslagret under. Fönstret aktiveras aldrig, så tangenterna stannar hos appens fönster.
/// Innehållet ritas med GDI+ direkt i en DIB (förmultiplicerad alfa, som UpdateLayeredWindow vill ha).
/// </summary>
class LayerWindow : Form
{
    readonly bool clickThrough;
    Surface? surface;
    byte alpha = 255;

    /// <param name="clickThrough">musen går rakt igenom (t.ex. paus-ikonen i mitten)</param>
    public LayerWindow(bool clickThrough = false)
    {
        this.clickThrough = clickThrough;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Cursor = Cursors.Default;
    }

    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | (clickThrough ? WS_EX_TRANSPARENT : 0);
            return cp;
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x0021 /* WM_MOUSEACTIVATE */) { m.Result = 3 /* MA_NOACTIVATE */; return; }
        base.WndProc(ref m);
    }

    // Ett lagerfönster har inget WM_PAINT-innehåll; bakgrunden ska inte ritas av WinForms
    protected override void OnPaintBackground(PaintEventArgs e) { }

    /// <summary>Börjar rita: en tom (helt genomskinlig) yta i storleken size. Avsluta med Present.</summary>
    public Graphics Begin(Size size)
    {
        size = new Size(Math.Max(1, size.Width), Math.Max(1, size.Height));
        if (surface == null || surface.Size != size) { surface?.Dispose(); surface = new Surface(size); }
        var g = Graphics.FromImage(surface.Bitmap);
        g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
        g.Clear(Color.Transparent);
        g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceOver;
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
        // ClearType går inte på genomskinlig bakgrund (GDI skriver alfa 0): gråskalig kantutjämning
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        return g;
    }

    /// <summary>Visar det som ritats sedan Begin, med fönstrets övre vänstra hörn på skärmpunkten at</summary>
    public unsafe void Present(Point at)
    {
        if (surface == null || !IsHandleCreated || IsDisposed) return;
        var dst = new POINT { X = at.X, Y = at.Y };
        var size = new SIZE { W = surface.Size.Width, H = surface.Size.Height };
        var src = new POINT();
        var blend = Blend(alpha);
        UpdateLayeredWindow(Handle, IntPtr.Zero, &dst, &size, surface.Dc, &src, 0, &blend, ULW_ALPHA);
    }

    /// <summary>Hela fönstrets genomskinlighet (0–255) utan att rita om – för toningen in och ut</summary>
    public unsafe void SetAlpha(byte a)
    {
        alpha = a;
        if (surface == null || !IsHandleCreated || IsDisposed) return;
        var blend = Blend(a);
        UpdateLayeredWindow(Handle, IntPtr.Zero, null, null, IntPtr.Zero, null, 0, &blend, ULW_ALPHA);
    }

    public byte Alpha => alpha;

    /// <summary>Lägger fönstret överst bland appens fönster utan att aktivera det</summary>
    public void Raise()
    {
        if (IsHandleCreated && !IsDisposed) SetWindowPos(Handle, IntPtr.Zero /* HWND_TOP */, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    }

    static BLENDFUNCTION Blend(byte a) => new() { BlendOp = 0 /* AC_SRC_OVER */, BlendFlags = 0, SourceConstantAlpha = a, AlphaFormat = 1 /* AC_SRC_ALPHA */ };

    protected override void Dispose(bool disposing)
    {
        if (disposing) { surface?.Dispose(); surface = null; }
        base.Dispose(disposing);
    }

    /// <summary>En DIB-yta (32 bitar, uppifrån och ner) som GDI+ ritar direkt i</summary>
    sealed class Surface : IDisposable
    {
        public readonly Size Size;
        public readonly IntPtr Dc;
        public readonly Bitmap Bitmap;
        readonly IntPtr bmp, old;

        public Surface(Size size)
        {
            Size = size;
            Dc = CreateCompatibleDC(IntPtr.Zero);
            var bi = new BITMAPINFOHEADER { Size = Marshal.SizeOf<BITMAPINFOHEADER>(), Width = size.Width, Height = -size.Height, Planes = 1, BitCount = 32 };
            bmp = CreateDIBSection(Dc, ref bi, 0, out var bits, IntPtr.Zero, 0);
            if (bmp == IntPtr.Zero) { DeleteDC(Dc); throw new OutOfMemoryException("CreateDIBSection"); }
            old = SelectObject(Dc, bmp);
            Bitmap = new Bitmap(size.Width, size.Height, size.Width * 4, PixelFormat.Format32bppPArgb, bits);
        }

        public void Dispose()
        {
            Bitmap.Dispose();
            SelectObject(Dc, old);
            DeleteObject(bmp);
            DeleteDC(Dc);
        }
    }

    // ---------- Windows ----------
    const int WS_EX_LAYERED = 0x00080000, WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOOLWINDOW = 0x00000080, WS_EX_TRANSPARENT = 0x00000020;
    const int ULW_ALPHA = 2;
    const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_NOOWNERZORDER = 0x200;

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int W, H; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFOHEADER
    {
        public int Size, Width, Height;
        public short Planes, BitCount;
        public int Compression, SizeImage, XPelsPerMeter, YPelsPerMeter, ClrUsed, ClrImportant;
    }

    [DllImport("user32.dll")]
    static extern unsafe bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, POINT* pptDst, SIZE* psize, IntPtr hdcSrc, POINT* pptSrc, int crKey, BLENDFUNCTION* pblend, int flags);
    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFOHEADER bi, uint usage, out IntPtr bits, IntPtr section, uint offset);
}

/// <summary>Var musen är: vilket fönster som ligger överst under pekaren hör det till appen?</summary>
static class WindowAt
{
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    const uint GA_ROOTOWNER = 3;

    /// <summary>True om fönstret överst vid skärmpunkten p är owner eller ett av dess fönster (spelarens lager, mpv)</summary>
    public static bool BelongsTo(IntPtr owner, Point p)
    {
        try
        {
            var h = WindowFromPoint(new POINT { X = p.X, Y = p.Y });
            return h != IntPtr.Zero && (h == owner || GetAncestor(h, GA_ROOTOWNER) == owner);
        }
        catch { return false; }
    }
}
