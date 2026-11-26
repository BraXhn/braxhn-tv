namespace BraXhnTV;

/// <summary>
/// Skript som körs i serverns sidor: berättar för appen om något spelas, fångar F11/Esc och visar appens korta
/// meddelanden (app-note, t.ex. att servern behöver uppdateras för den inbyggda spelaren) nere i sidan.
/// </summary>
static class Inject
{
    public const string Script = """
(() => {
  if (window.top !== window || !window.chrome || !window.chrome.webview) return;
  const wv = window.chrome.webview;
  // Ljud- och videoelement, även de som inte ligger i sidan (new Audio())
  const seen = new Set();
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { seen.add(this); setTimeout(check, 0); return play.apply(this, arguments); };
  let last = '';
  function check() {
    let s = 'none';
    for (const m of [...seen, ...document.querySelectorAll('video,audio')]) {
      if (m.paused || m.ended) { if (!m.isConnected) seen.delete(m); continue; }
      if (m.tagName === 'VIDEO' && m.isConnected) { s = 'video'; break; }
      s = 'audio';
    }
    if (s !== last) { last = s; wv.postMessage({ t: 'media', s }); }
  }
  for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied']) document.addEventListener(ev, () => setTimeout(check, 0), true);
  setInterval(check, 10000);
  addEventListener('pagehide', () => wv.postMessage({ t: 'media', s: 'none' }));
  // Ett diskret meddelande från appen: försvinner av sig självt eller vid klick
  wv.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.t !== 'app-note' || typeof m.text !== 'string') return;
    const show = () => {
      const d = document.createElement('div');
      d.setAttribute('role', 'status');
      d.textContent = m.text;
      d.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(560px,92vw);z-index:2147483647;' +
        'background:#2e2f33;color:#ececec;border:1px solid #44464c;border-radius:10px;padding:12px 16px;font:14px/1.45 "Segoe UI",system-ui,sans-serif;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.45);cursor:pointer';
      d.onclick = () => d.remove();
      document.body.append(d);
      setTimeout(() => d.remove(), +m.ms || 15000);
    };
    if (document.body) show(); else addEventListener('DOMContentLoaded', show, { once: true });
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'F11') { e.preventDefault(); wv.postMessage({ t: 'f11' }); }
    else if (e.key === 'Escape' && !document.fullscreenElement) wv.postMessage({ t: 'esc' });
  }, true);
})();
""";
}
