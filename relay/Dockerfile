# BraXhn Relay – fjärråtkomst till BraXhn TV utan portöppning. Körs på en server som nås från internet (t.ex. en VPS),
# helst bakom Caddy för HTTPS (se docker-compose.yml och README.md).
# Bara Node och tre filer: inga npm-beroenden, ingen ffmpeg. Byggs med relay/ som kontext.
FROM node:24-alpine

WORKDIR /app
COPY package.json server.js admin.html admin.js ./
# Datamappen (parade servrar och deras hemligheter) ägs av node – en namngiven volym ärver ägaren
RUN mkdir -p /data && chown node:node /data && chmod 700 /data

ENV RELAY_PORT=8080 RELAY_DATA_DIR=/data NODE_ENV=production
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8080)+'/_relay/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
