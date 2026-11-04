# Debian 13 (trixie): Debians ffmpeg 7.1 för både amd64 och arm64. Valt framför jellyfin-ffmpeg 7 eftersom paketen
# kommer från Debians signerade arkiv (apt kontrollerar InRelease mot debian-archive-keyring i basimagen och varje
# paket mot SHA-256 i Release) och får säkerhetsuppdateringar med imagen – inget eget paketförråd, ingen egen
# nyckel och ingen nedladdning utanför apt. Bygget innehåller HEVC/AV1-kodarna (NVENC, VA-API, QSV, x265, SVT-AV1),
# HEIF-avkodning, libplacebo (Vulkan) och tonemap_opencl. Det jellyfin-ffmpeg har utöver det (tonemap_cuda) sonderas
# vid start och används om någon kör en egen ffmpeg med det. Se docs/arkitektur.md (ffmpeg-version) och README.
FROM node:24-trixie-slim

# ffmpeg för analys/omkodning, VA-API-drivrutiner för Intel/AMD, Vulkan (Mesa) för tonmappning med libplacebo,
# tini som init. amd64: Intels mediadrivrutin och oneVPL-körmiljön för Quick Sync (QSV).
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates mesa-va-drivers mesa-vulkan-drivers vainfo \
    && if [ "$TARGETARCH" = "amd64" ]; then apt-get install -y --no-install-recommends intel-media-va-driver libmfx-gen1.2; fi \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx \
       /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
    && ffmpeg -hide_banner -version | head -1 | grep -q '^ffmpeg version 7\.' \
    && ffmpeg -hide_banner -encoders | grep -Eq ' libx265 ' && ffmpeg -hide_banner -filters | grep -Eq ' libplacebo '

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
COPY docker/entrypoint.sh /entrypoint.sh
# hls.js och qrcode-generator ligger i web/vendor (se VENDOR.md) – inga nedladdningar vid bygget
RUN chmod 755 /entrypoint.sh && node server/verify.js --manifest && chmod 444 integrity.json

# Versionen sätts av bygget (docker-publish.yml); lokalt bygge: "dev". OCI-etiketterna visas av Docker/Unraid och
# ghcr.io; net.unraid.* ger ikon och WebUI-länk även när containern startas utan mallen.
ARG VERSION=dev
ARG REVISION=
LABEL org.opencontainers.image.title="BraXhn TV" \
      org.opencontainers.image.description="Fri, självhostad mediaserver för filmer, serier, musik, ljudböcker, poddar och live-TV" \
      org.opencontainers.image.source="https://github.com/BraXhn/braxhn-tv" \
      org.opencontainers.image.url="https://github.com/BraXhn/braxhn-tv" \
      org.opencontainers.image.documentation="https://github.com/BraXhn/braxhn-tv#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="BraXhn" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION" \
      net.unraid.docker.icon="https://raw.githubusercontent.com/BraXhn/braxhn-tv/main/unraid/braxhn-tv.png" \
      net.unraid.docker.webui="http://[IP]:[PORT:8420]/"

ENV PORT=8420 HTTPS_PORT=8443 CONFIG_DIR=/config MEDIA_ROOT=/media TRANSCODE_DIR=/transcode \
    PUID=99 PGID=100 UMASK=002 HWACCEL=none NODE_ENV=production UV_THREADPOOL_SIZE=16 TZ=Europe/Stockholm
EXPOSE 8420 8443
VOLUME ["/config", "/transcode"]
# start-period: en stor databas kan behöva migreras (och säkerhetskopieras) vid första starten efter en uppdatering
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8420)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Avstängning (Unraid: docker stop väntar 10 s): tini -g skickar SIGTERM till hela processgruppen – servern och dess
# ffmpeg-processer (som avslutar sina filer snyggt på SIGTERM). Servern skriver klart inspelningar och stänger databasen.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
