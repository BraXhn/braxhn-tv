#!/bin/sh
# Start av containern: rättigheter enligt Unraids konvention (PUID=99 nobody, PGID=100 users, UMASK=002), rätt ägare
# på /config och inspelningarna, åtkomst till grafikkortet och sedan servern som PUID:PGID – aldrig som root i onödan.
#
# Tre lägen (beslutet görs först, utan att något ändras, och kan provas med BRAXHN_ENTRYPOINT_DRYRUN=1 –
# test/distribution.test.js):
#   drop – containern startade som root (Unraids standard): ägare rättas och servern körs som PUID:PGID
#   root – PUID=0: servern körs som root (fungerar, men rekommenderas inte)
#   user – containern startades redan som en vanlig användare (docker run --user / user: i compose): PUID/PGID kan
#          inte användas och ägare kan inte ändras – bara kontroller och råd
set -e
log() { echo "[start] $*"; }
num() { case "$1" in ''|*[!0-9]*) return 1;; esac; return 0; }

ME=$(id -u)
DRYRUN="${BRAXHN_ENTRYPOINT_DRYRUN:-0}"
# Bara i provläget: låtsas vara en annan användare (testet körs inte som root)
[ "$DRYRUN" = 1 ] && [ -n "${BRAXHN_TEST_UID:-}" ] && ME="$BRAXHN_TEST_UID"

PUID="${PUID:-99}"; PGID="${PGID:-100}"; UMASK="${UMASK:-002}"
num "$PUID" || { log "VARNING: PUID=\"$PUID\" är inte ett tal – använder 99 (nobody)."; PUID=99; }
num "$PGID" || { log "VARNING: PGID=\"$PGID\" är inte ett tal – använder 100 (users)."; PGID=100; }
case "$UMASK" in
  [0-7][0-7][0-7]|0[0-7][0-7][0-7]) ;;
  *) log "VARNING: UMASK=\"$UMASK\" är ogiltig (tre siffror 0–7, t.ex. 002 eller 022) – använder 002."; UMASK=002;;
esac

if [ "$ME" = 0 ]; then
  if [ "$PUID" = 0 ]; then
    MODE=root
    log "VARNING: PUID=0 – servern körs som root. Det fungerar, men sätt hellre PUID=99 och PGID=100 (Unraids standard)."
  else MODE=drop; fi
else
  MODE=user
  [ "$PUID" = "$ME" ] || log "OBS: containern startades som användare $ME (--user) – PUID=$PUID används inte. Ta bort --user för att använda PUID/PGID."
fi

if [ "$DRYRUN" = 1 ]; then
  echo "beslut: läge=$MODE puid=$PUID pgid=$PGID umask=$UMASK"
  exit 0
fi

umask "$UMASK"
CONFIG_DIR="${CONFIG_DIR:-/config}"; TRANSCODE_DIR="${TRANSCODE_DIR:-/transcode}"; MEDIA_ROOT="${MEDIA_ROOT:-/media}"
mkdir -p "$CONFIG_DIR" "$TRANSCODE_DIR" 2>/dev/null || true

GROUPS_ARG="--clear-groups"
if [ "$MODE" = drop ]; then
  # Bara filer med fel ägare (chown -R på hela /config tar minuter med många bilder på /mnt/user)
  find "$CONFIG_DIR" "$TRANSCODE_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown "$PUID:$PGID" {} + 2>/dev/null || true
  # Inspelningar, extern säkerhetskopia och startcachen (bara översta mappen – kan innehålla mycket)
  for d in /recordings /backup /prestart; do [ -d "$d" ] && chown "$PUID:$PGID" "$d" 2>/dev/null || true; done

  # Åtkomst till GPU-enheter (/dev/dri, NVIDIA) för hårdvaruomkodning: enheternas grupper läggs till
  EXTRA=""
  for dev in /dev/dri/renderD* /dev/dri/card* /dev/nvidia0; do
    [ -e "$dev" ] || continue
    gid=$(stat -c %g "$dev")
    case ",$EXTRA," in *",$gid,"*) ;; *) EXTRA="${EXTRA:+$EXTRA,}$gid";; esac
  done
  [ -n "$EXTRA" ] && GROUPS_ARG="--groups $EXTRA"
fi

# Kör ett kommando som den användare servern körs som
as_app() {
  if [ "$MODE" = drop ]; then setpriv --reuid="$PUID" --regid="$PGID" $GROUPS_ARG -- "$@"; else "$@"; fi
}
WHO="$PUID:$PGID"; [ "$MODE" = user ] && WHO="$(id -u):$(id -g)"
writable() { as_app sh -c 't="$1/.braxhn-skrivtest.$$"; : > "$t" && rm -f "$t"' sh "$1" 2>/dev/null; }

# Behörighetskontroller med konkreta råd. /config måste gå att skriva i – annars kan servern inte starta.
if ! writable "$CONFIG_DIR"; then
  log "FEL: servern ($WHO) kan inte skriva i $CONFIG_DIR."
  if [ "$MODE" = user ]; then
    log "  Containern startades med --user $(id -u). Ge den användaren skrivrätt till mappen, eller ta bort --user och använd PUID/PGID."
  else
    log "  Rätta ägaren i Unraids terminal (byt sökväg om din appdata ligger någon annanstans):"
    log "    chown -R $PUID:$PGID /mnt/user/appdata/braxhn-tv && chmod -R u+rwX,g+rwX /mnt/user/appdata/braxhn-tv"
    log "  Ligger mappen på en NFS/SMB-resurs med root_squash kan containern inte ändra ägare – välj en lokal mapp."
  fi
  exit 1
fi
writable "$TRANSCODE_DIR" || log "VARNING: $TRANSCODE_DIR går inte att skriva i ($WHO) – omkodning fungerar inte. Kontrollera mappen för Omkodningscache."
if [ -d /recordings ] && ! writable /recordings; then
  log "VARNING: /recordings går inte att skriva i ($WHO) – inspelningar misslyckas. Kör t.ex.: chown $PUID:$PGID /mnt/user/media/Inspelningar"
fi
if [ -d "$MEDIA_ROOT" ] && ! as_app test -r "$MEDIA_ROOT" -a -x "$MEDIA_ROOT" 2>/dev/null; then
  log "VARNING: $MEDIA_ROOT går inte att läsa ($WHO). Mediamappar på Unraid ska normalt ägas av nobody:users (99:100) – kör Tools → New Permissions på resursen eller ändra PUID/PGID."
fi
if [ "$MODE" = user ]; then
  for dev in /dev/dri/renderD*; do
    [ -e "$dev" ] || continue
    [ -r "$dev" ] && [ -w "$dev" ] || log "VARNING: ingen åtkomst till $dev (grupp $(stat -c %g "$dev")) med --user – lägg till --group-add $(stat -c %g "$dev") eller ta bort --user."
  done
fi

log "BraXhn TV startar som $WHO (läge $MODE, umask $UMASK, hwaccel ${HWACCEL:-none})"
if [ "$MODE" = drop ]; then
  exec setpriv --reuid="$PUID" --regid="$PGID" $GROUPS_ARG -- "$@"
fi
exec "$@"
