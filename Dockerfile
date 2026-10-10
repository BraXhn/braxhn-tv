FROM node:25-bookworm-slim

# ffmpeg för analys/omkodning, VAAPI-drivrutiner för Intel/AMD-GPU, tini som init
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates mesa-va-drivers vainfo \
    && if [ "$TARGETARCH" = "amd64" ]; then apt-get install -y --no-install-recommends intel-media-va-driver; fi \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
COPY docker/entrypoint.sh /entrypoint.sh
# hls.js och qrcode-generator ligger i web/vendor (se VENDOR.md) – inga nedladdningar vid bygget
RUN chmod 755 /entrypoint.sh && node server/verify.js --manifest && chmod 444 integrity.json

ENV PORT=8420 HTTPS_PORT=8443 CONFIG_DIR=/config MEDIA_ROOT=/media TRANSCODE_DIR=/transcode \
    PUID=99 PGID=100 HWACCEL=none NODE_ENV=production
EXPOSE 8420 8443
VOLUME ["/config", "/transcode"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8420)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
