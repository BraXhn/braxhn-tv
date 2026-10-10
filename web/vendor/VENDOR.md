# Inbäddade tredjepartsfiler

Filerna ligger i repot (i stället för att hämtas vid bygget) så att innehållet är spårbart i git och inte kan bytas ut av en tredje part.

| Fil | Källa | Version | Licens | SHA-256 |
|---|---|---|---|---|
| `hls.min.js` | github.com/video-dev/hls.js – release.zip (`dist/hls.min.js`) | 1.5.20 | Apache-2.0 | `d016c1230496ee59f3f5b01c16cce4cc01b5a1d3d357adec200c908b131ebe49` |
| `qrcode.min.js` | github.com/kazuhikoarase/qrcode-generator – tagg `js1.4.4` (`js/qrcode.js`) | 1.4.4 | MIT (`LICENSE-qrcode-generator.txt`) | `18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780` |

CI kontrollerar checksummorna (`npm run verify`).
