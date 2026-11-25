namespace BraXhnTV;

/// <summary>Skript som körs i serverns sidor: berättar för appen om något spelas och fångar F11/Esc.</summary>
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
  addEventListener('keydown', (e) => {
    if (e.key === 'F11') { e.preventDefault(); wv.postMessage({ t: 'f11' }); }
    else if (e.key === 'Escape' && !document.fullscreenElement) wv.postMessage({ t: 'esc' });
  }, true);
})();
""";
}
