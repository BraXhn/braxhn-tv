# Debian 13 (trixie): Debians ffmpeg 7.1 för både amd64 och arm64. Valt framför jellyfin-ffmpeg 7 eftersom paketen
# kommer från Debians signerade arkiv (apt kontrollerar InRelease mot debian-archive-keyring i basimagen och varje
# paket mot SHA-256 i Release) och får säkerhetsuppdateringar med imagen – inget eget paketförråd, ingen egen
# nyckel och ingen nedladdning utanför apt. Bygget innehåller HEVC/AV1-kodarna (NVENC, VA-API, QSV, x265, SVT-AV1),
# HEIF-avkodning, libplacebo (Vulkan) och tonemap_opencl. Det jellyfin-ffmpeg har utöver det (tonemap_cuda) sonderas
# vid start och används om någon kör en egen ffmpeg med det. Se BRAIN.md (ffmpeg-version) och README.
FROM node:24-trixie-slim

# ffmpeg för analys/omkodning, VA-API-drivrutiner för Intel/AMD, Vulkan (Mesa) för tonmappning med libplacebo,
# tini som init. amd64: Intels mediadrivrutin och oneVPL-körmiljön för Quick Sync (QSV).
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates mesa-va-drivers mesa-vulkan-drivers vainfo \
    && if [ "$TARGETARCH" = "amd64" ]; then apt-get install -y --no-install-recommends intel-media-va-driver libmfx-gen1.2; fi \
    && rm -rf /var/lib/apt/lists/* \
    && ffmpeg -hide_banner -version | head -1 | grep -q '^ffmpeg version 7\.' \
    && ffmpeg -hide_banner -encoders | grep -Eq ' libx265 ' && ffmpeg -hide_banner -filters | grep -Eq ' libplacebo '

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
COPY docker/entrypoint.sh /entrypoint.sh
# hls.js och qrcode-generator ligger i web/vendor (se VENDOR.md) – inga nedladdningar vid bygget
RUN chmod 755 /entrypoint.sh && node server/verify.js --manifest && chmod 444 integrity.json

ENV PORT=8420 HTTPS_PORT=8443 CONFIG_DIR=/config MEDIA_ROOT=/media TRANSCODE_DIR=/transcode \
    PUID=99 PGID=100 HWACCEL=none NODE_ENV=production UV_THREADPOOL_SIZE=16 TZ=Europe/Stockholm
EXPOSE 8420 8443
VOLUME ["/config", "/transcode"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8420)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
