#!/bin/bash
# Bygger BraXhn TV-imagen lokalt på Unraid och installerar Unraid-mallen.
# Kör från mappen där du packat upp BraXhn TV:  bash install.sh
set -e
cd "$(dirname "$0")"
IMAGE="${IMAGE:-braxhn-tv:local}"
TPL_DIR=/boot/config/plugins/dockerMan/templates-user

echo "==> Bygger $IMAGE (tar några minuter första gången)…"
docker build -t "$IMAGE" .

if [ -d "$TPL_DIR" ]; then
  sed "s#ghcr.io/braxhn/braxhn-tv:latest#$IMAGE#" braxhn-tv.xml > "$TPL_DIR/my-braxhn-tv.xml"
  mkdir -p /mnt/user/appdata/braxhn-tv
  echo "==> Mall installerad: $TPL_DIR/my-braxhn-tv.xml"
  echo
  echo "Klart! Gå till Docker-fliken -> Add Container -> välj mallen 'braxhn-tv',"
  echo "kontrollera sökvägen till Media och klicka Apply."
else
  echo "Hittade inte $TPL_DIR – är detta en Unraid-server?"
  echo "Imagen är byggd. Starta med:  docker compose up -d"
fi
