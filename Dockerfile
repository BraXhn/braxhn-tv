FROM node:22-bookworm-slim

# ffmpeg för analys/omkodning, VAAPI-drivrutiner för Intel/AMD-GPU, tini som init
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates mesa-va-drivers vainfo \
    && if [ "$TARGETARCH" = "amd64" ]; then apt-get install -y --no-install-recommends intel-media-va-driver; fi \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
# hls.js (Apache-2.0) för HLS-uppspelning i Chrome/Firefox/Edge
ADD https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js ./web/vendor/hls.min.js
# QR-koder för tvåstegsverifiering (MIT) – serveras lokalt så att CSP kan förbjuda externa skript
ADD https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js ./web/vendor/qrcode.min.js
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh && chmod 644 ./web/vendor/hls.min.js ./web/vendor/qrcode.min.js

ENV PORT=8420 HTTPS_PORT=8443 CONFIG_DIR=/config MEDIA_ROOT=/media TRANSCODE_DIR=/transcode \
    PUID=99 PGID=100 HWACCEL=none NODE_ENV=production
EXPOSE 8420 8443
VOLUME ["/config", "/transcode"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8420)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
