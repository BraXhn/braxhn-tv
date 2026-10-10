#!/bin/sh
set -e
PUID="${PUID:-99}"; PGID="${PGID:-100}"
mkdir -p "$CONFIG_DIR" "$TRANSCODE_DIR"
chown -R "$PUID:$PGID" "$CONFIG_DIR" "$TRANSCODE_DIR" 2>/dev/null || true

# Ge åtkomst till GPU-enheter (/dev/dri) för hårdvaruomkodning
GROUPS_ARG="--clear-groups"
EXTRA=""
for dev in /dev/dri/renderD* /dev/dri/card* /dev/nvidia0; do
  [ -e "$dev" ] || continue
  gid=$(stat -c %g "$dev")
  case ",$EXTRA," in *",$gid,"*) ;; *) EXTRA="${EXTRA:+$EXTRA,}$gid";; esac
done
[ -n "$EXTRA" ] && GROUPS_ARG="--groups $EXTRA"

echo "BraXhn TV startar som $PUID:$PGID (hwaccel: ${HWACCEL:-none})"
if [ "$(id -u)" = "0" ]; then
  exec setpriv --reuid="$PUID" --regid="$PGID" $GROUPS_ARG -- "$@"
fi
exec "$@"
