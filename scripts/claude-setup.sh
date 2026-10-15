#!/bin/bash
# Körs när en Claude Code-session startar: ser till att ffmpeg finns (krävs av testerna).
# Lokalt på din dator gör skriptet ingenting om ffmpeg redan är installerat.
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then exit 0; fi
if command -v apt-get >/dev/null 2>&1; then
  SUDO=""; [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo -n"
  ($SUDO apt-get update -qq && $SUDO apt-get install -y -qq ffmpeg) >/dev/null 2>&1 \
    && echo "ffmpeg installerat" || echo "Kunde inte installera ffmpeg – installera det för att köra testerna"
elif command -v brew >/dev/null 2>&1; then
  echo "ffmpeg saknas – kör: brew install ffmpeg"
else
  echo "ffmpeg saknas – installera det för att köra testerna"
fi
exit 0
