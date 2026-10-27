// Ikoner (SVG) för spelarens kontroller
const svg = (d, vb = '0 0 24 24') => `<svg viewBox="${vb}" width="22" height="22" fill="currentColor" aria-hidden="true">${d}</svg>`;
export const ICON = {
  play: svg('<path d="M8 5v14l11-7z"/>'), pause: svg('<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'),
  prev: svg('<path d="M6 6h2v12H6zM9.5 12l8.5 6V6z"/>'), next: svg('<path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/>'),
  stop: svg('<path d="M6 6h12v12H6z"/>'),
  fwd10: svg('<path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16.5" font-size="7" text-anchor="middle" font-family="sans-serif" font-weight="700">10</text>'),
  // Spela på en annan enhet (som Cast-ikonen: skärm med vågor i hörnet)
  remote: svg('<path d="M3 5h18v14h-7v-2h5V7H5v3H3zm0 7a9 9 0 0 1 9 9h-2a7 7 0 0 0-7-7zm0 4a5 5 0 0 1 5 5H6a3 3 0 0 0-3-3zm0 3.5A1.5 1.5 0 0 1 4.5 21H3z"/>'),
  back10: svg('<path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="16.5" font-size="7" text-anchor="middle" font-family="sans-serif" font-weight="700">10</text>'),
  fwd30: svg('<path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16.5" font-size="7" text-anchor="middle" font-family="sans-serif" font-weight="700">30</text>'),
  gear: svg('<path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.4-2.9a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/>'),
  list: svg('<path d="M4 6h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zM4 16h2v2H4zm4 0h12v2H8z"/>'),
  vol: svg('<path d="M4 9v6h4l5 4V5L8 9zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/>'),
  mute: svg('<path d="M4 9v6h4l5 4V5L8 9zm16.6 3L23 9.6 21.6 8.2 19.2 10.6 16.8 8.2 15.4 9.6l2.4 2.4-2.4 2.4 1.4 1.4 2.4-2.4 2.4 2.4 1.4-1.4z"/>'),
  full: svg('<path d="M5 5h5v2H7v3H5zm9 0h5v5h-2V7h-3zM5 14h2v3h3v2H5zm12 0h2v5h-5v-2h3z"/>'),
  mini: svg('<path d="M3 5h18v14H3zm2 2v10h14V7zm6 4h7v5h-7z"/>'),
  expand: svg('<path d="M4 4h7v2H7.4l4.3 4.3-1.4 1.4L6 7.4V11H4zm16 16h-7v-2h3.6l-4.3-4.3 1.4-1.4 4.3 4.3V13h2z"/>'),
};
// Ikoner för sidomenyn (Hem och biblioteken). Storleken sätts i CSS.
const rail = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
export const RAIL_ICON = {
  home: rail('<path d="M12 3 3 10v11h6v-6h6v6h6V10z"/>'),
  movie: rail('<path d="M4 4h2l2 3h3L9 4h3l2 3h3l-2-3h5v16H4zm2 5v9h12V9z"/>'),
  show: rail('<path d="M3 6h18v12H3zm2 2v8h14V8zm4 12h6v2H9zM8.6 2.6 12 5l3.4-2.4 1.1 1.6L12 7.4 7.5 4.2z"/>'),
  kids: rail('<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zM8.5 9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM7.5 14a4.8 4.8 0 0 0 9 0z"/>'),
  music: rail('<path d="M9 3v11.3A3.5 3.5 0 1 0 11 17.5V8h6V3z"/>'),
  audiobook: rail('<path d="M5 3h11a3 3 0 0 1 3 3v15H8a3 3 0 0 1-3-3zm2 2v13a1 1 0 0 0 1 1h9V6a1 1 0 0 0-1-1zm2 2h6v2H9z"/>'),
  podcast: rail('<path d="M12 2a7 7 0 0 1 4.5 12.4l-1.3-1.5a5 5 0 1 0-6.4 0l-1.3 1.5A7 7 0 0 1 12 2zm0 4a3 3 0 0 1 1.5 5.6V22h-3V11.6A3 3 0 0 1 12 6z"/>'),
  live: rail('<path d="M3 7h18v13H3zm2 2v9h14V9zM7.4 2.6 12 5.5l4.6-2.9 1 1.7L13.9 7h-3.8L6.4 4.3z"/><circle cx="12" cy="13.5" r="2.5"/>'),
  photo: rail('<path d="M3 5h18v14H3zm2 2v8.6l4-4.1 3 3 4.5-5.5L19 12.5V7zm4.5 1a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z"/>'),
  streaming: rail('<path d="M3 5h18v11H3zm2 2v7h14V7zm5 1.5 4.5 2.5-4.5 2.5zM7 18h10v2H7z"/>'),
};
