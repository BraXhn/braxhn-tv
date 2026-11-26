#!/usr/bin/env bash
# Bygger libmpv-2.dll för Windows x64 som LGPL – korskompilerat på Linux (Ubuntu 24.04) med MinGW-w64.
# Körs av .github/workflows/libmpv.yml men går att köra på Ubuntu 24.04 med samma paket som där (apps/windows/README.md):
#
#   apps/windows/libmpv/bygg.sh <arbetsmapp>
#
# Steg: hämta (kallor.txt, sha256/commit kontrolleras) → bygg beroendena (statiskt) → FFmpeg (utan --enable-gpl
# och --enable-nonfree) → mpv (-Dgpl=false, bara libmpv) → LGPL-kontroll (faller vid GPL) → paketera.
# Färdiga beroenden markeras i <arbetsmapp>/prefix/.klar/ och byggs inte om (flödet cachar prefix/).
#
# Miljö: JOBS (antal parallella jobb, standard nproc), MPV_VERSION + MPV_COMMIT (annan mpv än kallor.txt),
# BYGGDATUM (ÅÅÅÅMMDD i filnamnen, standard i dag).
set -euo pipefail

HAR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROT=$(mkdir -p "${1:?Ange en arbetsmapp: bygg.sh <arbetsmapp>}" && cd "$1" && pwd)
DL=$ROT/kallor          # nedladdade arkiv (och git-arkiv som skapas här)
SRC=$ROT/src            # uppackade källor
PFX=$ROT/prefix         # färdiga statiska bibliotek
UT=$ROT/ut              # resultatet
JOBS=${JOBS:-$(nproc)}
BYGGDATUM=${BYGGDATUM:-$(date -u +%Y%m%d)}
HOST=x86_64-w64-mingw32
export CC=$HOST-gcc-posix CXX=$HOST-g++-posix AR=$HOST-ar RANLIB=$HOST-ranlib STRIP=$HOST-strip
export NM=$HOST-nm WINDRES=$HOST-windres
export PKG_CONFIG_LIBDIR=$PFX/lib/pkgconfig PKG_CONFIG_PATH=
export CFLAGS="-O2 -I$PFX/include" CXXFLAGS="-O2 -I$PFX/include" CPPFLAGS="-I$PFX/include" LDFLAGS="-L$PFX/lib"
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-0}
mkdir -p "$DL" "$SRC" "$PFX/lib/pkgconfig" "$PFX/include" "$PFX/.klar" "$UT"

steg() { echo; echo "::group::$*" 2>/dev/null || true; echo "=== $*"; }
slut() { echo "::endgroup::"; }
fel() { echo "::error::$*"; echo "FEL: $*" >&2; exit 1; }

# --- Källorna ------------------------------------------------------------------------------------------------
declare -A VER LIC TYP URL KTL LFILER UNDER
NAMN=()
while read -r n v l t u k f s; do
  [[ -z "$n" || "$n" == \#* ]] && continue
  NAMN+=("$n"); VER[$n]=$v; LIC[$n]=$l; TYP[$n]=$t; URL[$n]=$u; KTL[$n]=$k; LFILER[$n]=$f; UNDER[$n]=${s:-}
done < "$HAR/kallor.txt"
if [[ -n "${MPV_VERSION:-}" && "${MPV_VERSION#v}" != "${VER[mpv]}" ]]; then
  [[ "${MPV_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || fel "mpv ${MPV_VERSION} finns inte i kallor.txt: ange också dess commit (40 tecken), git ls-remote https://github.com/mpv-player/mpv 'refs/tags/v${MPV_VERSION#v}^{}'"
  VER[mpv]=${MPV_VERSION#v}; KTL[mpv]=$MPV_COMMIT
fi
for n in "${NAMN[@]}"; do
  # Licensen måste gå ihop med LGPL. GPL (men inte LGPL) och "nonfree" stoppar bygget direkt.
  if [[ "${LIC[$n]}" =~ (^|[^L])GPL || "${LIC[$n]}" =~ [Nn]on[Ff]ree ]]; then fel "$n har licensen ${LIC[$n]} – får inte vara med i LGPL-byggnaden"; fi
done

arkiv() { local n=$1; case ${TYP[$n]} in tar) echo "$DL/$(basename "${URL[$n]}")";; git) echo "$DL/$n-${VER[$n]}-${KTL[$n]:0:12}.tar.gz";; esac; }

hamta() {
  local n=$1 a; a=$(arkiv "$n")
  if [[ ${TYP[$n]} == tar ]]; then
    if [[ ! -f "$a" ]] || ! echo "${KTL[$n]}  $a" | sha256sum -c --quiet - 2>/dev/null; then
      curl -fsSL --retry 5 --retry-delay 5 -o "$a.tmp" "${URL[$n]}"
      echo "${KTL[$n]}  $a.tmp" | sha256sum -c --quiet - || fel "sha256 för $n stämmer inte (${URL[$n]})"
      mv "$a.tmp" "$a"
    fi
  else
    [[ -f "$a" ]] && return 0
    local g=$ROT/git/$n
    rm -rf "$g"; mkdir -p "$g"
    git -C "$g" init -q
    git -C "$g" fetch -q --depth 1 "${URL[$n]}" "${KTL[$n]}"
    git -C "$g" -c advice.detachedHead=false checkout -q FETCH_HEAD
    [[ "$(git -C "$g" rev-parse HEAD)" == "${KTL[$n]}" ]] || fel "commit för $n stämmer inte"
    if [[ -n "${UNDER[$n]}" ]]; then
      git -C "$g" remote add origin "${URL[$n]}"
      IFS=, read -ra subs <<< "${UNDER[$n]}"
      git -C "$g" submodule update -q --init --depth 1 -- "${subs[@]}"
      git -C "$g" submodule status -- "${subs[@]}" > "$g/.undermoduler"
    fi
    # Ett arkiv som går att återskapa: samma filer, ordning och tider varje gång
    tar -C "$ROT/git" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --exclude=.git \
      --transform "s,^$n,$n-${VER[$n]}," -cf - "$n" | gzip -n -9 > "$a.tmp"
    mv "$a.tmp" "$a"; rm -rf "$g"
  fi
}

packa_upp() {
  local n=$1 d=$SRC/$1
  rm -rf "$d"; mkdir -p "$d"
  tar -xf "$(arkiv "$n")" -C "$d" --strip-components=1
}

klar() { [[ -f "$PFX/.klar/$1" && "$(cat "$PFX/.klar/$1")" == "${VER[$1]} ${KTL[$1]}" ]]; }
markera() { echo "${VER[$1]} ${KTL[$1]}" > "$PFX/.klar/$1"; }

KORS=$ROT/meson-kors.txt
cat > "$KORS" <<EOF
[binaries]
c = '$CC'
cpp = '$CXX'
ar = '$AR'
strip = '$STRIP'
windres = '$WINDRES'
nm = '$NM'
dlltool = '$HOST-dlltool'
pkg-config = 'pkg-config'
nasm = 'nasm'
[properties]
pkg_config_libdir = '$PFX/lib/pkgconfig'
[built-in options]
c_args = ['-I$PFX/include']
cpp_args = ['-I$PFX/include']
c_link_args = ['-L$PFX/lib']
cpp_link_args = ['-L$PFX/lib']
[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
EOF
CMAKE_KORS=(-G Ninja -DCMAKE_SYSTEM_NAME=Windows -DCMAKE_SYSTEM_PROCESSOR=x86_64 -DCMAKE_C_COMPILER=$CC
  -DCMAKE_CXX_COMPILER=$CXX -DCMAKE_RC_COMPILER=$WINDRES -DCMAKE_FIND_ROOT_PATH=$PFX
  -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY
  -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY -DCMAKE_INSTALL_PREFIX=$PFX -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5)
meson_bygg() { # meson_bygg <namn> [meson-val …]
  local n=$1; shift
  meson setup "$SRC/$n/_b" "$SRC/$n" --cross-file "$KORS" --prefix "$PFX" --libdir lib --buildtype release \
    --default-library static --wrap-mode nodownload "$@"
  meson compile -C "$SRC/$n/_b" -j "$JOBS"
  meson install -C "$SRC/$n/_b" --quiet
}

# --- Beroendena ----------------------------------------------------------------------------------------------
bygg_zlib() {
  make -C "$SRC/zlib" -f win32/Makefile.gcc -j "$JOBS" PREFIX=$HOST- CC=$CC libz.a
  install -m644 "$SRC/zlib/libz.a" "$PFX/lib/"; install -m644 "$SRC/zlib/zlib.h" "$SRC/zlib/zconf.h" "$PFX/include/"
  printf 'prefix=%s\nlibdir=${prefix}/lib\nincludedir=${prefix}/include\nName: zlib\nDescription: zlib\nVersion: %s\nLibs: -L${libdir} -lz\nCflags: -I${includedir}\n' \
    "$PFX" "${VER[zlib]}" > "$PFX/lib/pkgconfig/zlib.pc"
}
bygg_dav1d() { meson_bygg dav1d -Denable_tools=false -Denable_tests=false -Denable_examples=false; }
bygg_freetype() {
  meson_bygg freetype -Dzlib=disabled -Dpng=disabled -Dbrotli=disabled -Dharfbuzz=disabled -Dtests=disabled
}
bygg_fribidi() { meson_bygg fribidi -Ddocs=false -Dbin=false -Dtests=false; }
bygg_harfbuzz() {
  meson_bygg harfbuzz -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dicu=disabled \
    -Dgraphite=disabled -Dchafa=disabled -Dpng=disabled -Dzlib=disabled -Dtests=disabled -Ddocs=disabled \
    -Dintrospection=disabled -Dutilities=disabled -Dbenchmark=disabled -Dgdi=disabled -Ddirectwrite=disabled \
    -Dcoretext=disabled -Draster=disabled -Dvector=disabled -Dgpu=disabled -Dgpu_demo=disabled -Dsubset=disabled
}
bygg_libass() {
  (cd "$SRC/libass" && ./configure --host=$HOST --prefix="$PFX" --disable-shared --enable-static \
    --disable-fontconfig --enable-directwrite --disable-require-system-font-provider --disable-libunibreak --enable-asm \
    && make -j "$JOBS" && make install)
}
bygg_lcms2() {
  (cd "$SRC/lcms2" && ./configure --host=$HOST --prefix="$PFX" --disable-shared --enable-static --without-jpeg \
    --without-tiff --without-zlib && make -C src -j "$JOBS" && make -C src install && make -C include install \
    && install -m644 lcms2.pc "$PFX/lib/pkgconfig/")
}
bygg_lua() {
  make -C "$SRC/lua/src" -j "$JOBS" liblua.a CC="$CC" AR="$AR rcu" RANLIB="$RANLIB" SYSCFLAGS= SYSLIBS= MYCFLAGS=
  install -m644 "$SRC/lua/src/liblua.a" "$PFX/lib/liblua52.a"
  mkdir -p "$PFX/include/lua5.2"
  (cd "$SRC/lua/src" && install -m644 lua.h luaconf.h lualib.h lauxlib.h lua.hpp "$PFX/include/lua5.2/")
  printf 'prefix=%s\nlibdir=${prefix}/lib\nincludedir=${prefix}/include/lua5.2\nName: lua52\nDescription: Lua\nVersion: %s\nLibs: -L${libdir} -llua52\nCflags: -I${includedir}\n' \
    "$PFX" "${VER[lua]}" > "$PFX/lib/pkgconfig/lua52.pc"
}
bygg_shaderc() {
  # shaderc bygger glslang, SPIRV-Tools och SPIRV-Headers i samma träd (versionerna ur shaderc:s DEPS)
  local tp=$SRC/shaderc/third_party
  rm -rf "$tp/glslang" "$tp/spirv-tools" "$tp/spirv-headers"
  cp -a "$SRC/glslang" "$tp/glslang"; cp -a "$SRC/spirv-tools" "$tp/spirv-tools"; cp -a "$SRC/spirv-headers" "$tp/spirv-headers"
  cmake -S "$SRC/shaderc" -B "$SRC/shaderc/_b" "${CMAKE_KORS[@]}" -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON \
    -DSHADERC_SKIP_COPYRIGHT_CHECK=ON -DSHADERC_ENABLE_WERROR_COMPILE=OFF -DSPIRV_SKIP_EXECUTABLES=ON -DSPIRV_SKIP_TESTS=ON \
    -DSPIRV_WERROR=OFF -DENABLE_GLSLANG_BINARIES=OFF -DGLSLANG_TESTS=OFF -DENABLE_SPVREMAPPER=OFF -DENABLE_OPT=ON \
    -DSPIRV_TOOLS_BUILD_STATIC=ON -DSHADERC_ENABLE_SHARED_CRT=OFF
  cmake --build "$SRC/shaderc/_b" -j "$JOBS" --target shaderc_combined
  install -m644 "$SRC/shaderc/_b/libshaderc/libshaderc_combined.a" "$PFX/lib/"
  mkdir -p "$PFX/include/shaderc"; install -m644 "$SRC/shaderc/libshaderc/include/shaderc/"*.h "$PFX/include/shaderc/"
  printf 'prefix=%s\nlibdir=${prefix}/lib\nincludedir=${prefix}/include\nName: shaderc\nDescription: shaderc (statisk)\nVersion: %s\nLibs: -L${libdir} -lshaderc_combined -lstdc++\nCflags: -I${includedir}\n' \
    "$PFX" "${VER[shaderc]}" > "$PFX/lib/pkgconfig/shaderc.pc"
}
bygg_spirv-cross() {
  cmake -S "$SRC/spirv-cross" -B "$SRC/spirv-cross/_b" "${CMAKE_KORS[@]}" -DSPIRV_CROSS_SHARED=OFF -DSPIRV_CROSS_STATIC=ON \
    -DSPIRV_CROSS_CLI=OFF -DSPIRV_CROSS_ENABLE_TESTS=OFF -DSPIRV_CROSS_ENABLE_C_API=ON -DSPIRV_CROSS_ENABLE_GLSL=ON \
    -DSPIRV_CROSS_ENABLE_HLSL=ON -DSPIRV_CROSS_ENABLE_MSL=OFF -DSPIRV_CROSS_ENABLE_CPP=OFF \
    -DSPIRV_CROSS_ENABLE_REFLECT=OFF -DSPIRV_CROSS_ENABLE_UTIL=OFF -DSPIRV_CROSS_FORCE_PIC=ON
  cmake --build "$SRC/spirv-cross/_b" -j "$JOBS"; cmake --install "$SRC/spirv-cross/_b"
  # mpv och libplacebo frågar efter spirv-cross-c-shared; här pekar den på de statiska biblioteken
  local v; v=$(sed -n 's/^Version: *//p' "$PFX/lib/pkgconfig/spirv-cross-c.pc")
  printf 'prefix=%s\nlibdir=${prefix}/lib\nincludedir=${prefix}/include/spirv_cross\nName: spirv-cross-c-shared\nDescription: SPIRV-Cross (statisk)\nVersion: %s\nLibs: -L${libdir} -lspirv-cross-c -lspirv-cross-hlsl -lspirv-cross-glsl -lspirv-cross-core -lstdc++\nCflags: -I${includedir}\n' \
    "$PFX" "$v" > "$PFX/lib/pkgconfig/spirv-cross-c-shared.pc"
}
bygg_libplacebo() {
  meson_bygg libplacebo -Dvulkan=disabled -Dopengl=enabled -Dd3d11=enabled -Dshaderc=enabled -Dglslang=disabled \
    -Dlcms=enabled -Ddovi=enabled -Dlibdovi=disabled -Ddemos=false -Dtests=false -Dunwind=disabled -Dxxhash=disabled
}

# --- FFmpeg (LGPL) -------------------------------------------------------------------------------------------
ffmpeg_configure() {
  # Bara det som behövs, inget som hittas av sig självt (--disable-autodetect). Ingen --enable-gpl, --enable-nonfree
  # eller --enable-version3: FFmpeg blir då LGPL 2.1 eller senare, och configure vägrar alla GPL-bibliotek.
  (cd "$SRC/ffmpeg" && ./configure --prefix="$PFX" --arch=x86_64 --target-os=mingw32 --cross-prefix=$HOST- \
    --cc="$CC" --cxx="$CXX" --enable-cross-compile --pkg-config=pkg-config --pkg-config-flags=--static \
    --enable-static --disable-shared --disable-programs --disable-doc --disable-debug --disable-avdevice \
    --disable-gpl --disable-nonfree --disable-version3 \
    --disable-autodetect --enable-w32threads --enable-zlib --enable-schannel \
    --enable-d3d11va --enable-dxva2 --enable-libdav1d) > "$ROT/ffmpeg-configure.txt" \
    || { tail -30 "$ROT/ffmpeg-configure.txt"; tail -40 "$SRC/ffmpeg/ffbuild/config.log" 2>/dev/null; fel "FFmpeg configure misslyckades"; }
  grep -E '^(install prefix|License|External libraries|Enabled hwaccels)' -A3 "$ROT/ffmpeg-configure.txt" || true
  kontroll_ffmpeg
}
bygg_ffmpeg() {
  ffmpeg_configure
  make -C "$SRC/ffmpeg" -j "$JOBS"
  make -C "$SRC/ffmpeg" install
}

# --- LGPL-kontrollerna ---------------------------------------------------------------------------------------
kontroll_ffmpeg() {
  local h=$SRC/ffmpeg/config.h m=$SRC/ffmpeg/ffbuild/config.mak lic
  lic=$(sed -n 's/^#define FFMPEG_LICENSE "\(.*\)"$/\1/p' "$h")
  echo "LGPL-KONTROLL FFmpeg: licens = \"$lic\""
  grep -q '^License: LGPL version' "$ROT/ffmpeg-configure.txt" || fel "FFmpeg configure säger inte LGPL"
  [[ "$lic" == "LGPL version 2.1 or later" ]] || fel "FFmpeg är inte LGPL: $lic"
  grep -qx '#define CONFIG_GPL 0' "$h" || fel "FFmpeg: CONFIG_GPL är inte 0"
  grep -qx '#define CONFIG_NONFREE 0' "$h" || fel "FFmpeg: CONFIG_NONFREE är inte 0"
  # Bibliotek som FFmpeg själv räknar som GPL eller nonfree (configure: EXTERNAL_LIBRARY_GPL_LIST m.fl.)
  local gpl='AVISYNTH|FREI0R|LIBCDIO|LIBDAVS2|LIBRUBBERBAND|LIBVIDSTAB|LIBX264|LIBX265|LIBXAVS|LIBXAVS2|LIBXVID|POSTPROC|DECKLINK|LIBFDK_AAC|LIBTLS|LIBSMBCLIENT|LIBNPP|CUDA_NVCC'
  if grep -E "^CONFIG_($gpl)=yes" "$m"; then fel "FFmpeg har ett GPL- eller nonfree-bibliotek påslaget"; fi
  echo "LGPL-KONTROLL FFmpeg: externa bibliotek påslagna:"; grep -E '^CONFIG_(LIB[A-Z0-9_]+|ZLIB|SCHANNEL|D3D11VA|DXVA2|W32THREADS)=yes' "$m" | sed 's/^/  /'
}
kontroll_mpv() {
  local b=$SRC/mpv/_b g
  g=$(meson introspect --buildoptions "$b" | python3 -c 'import json,sys; print([o["value"] for o in json.load(sys.stdin) if o["name"]=="gpl"][0])')
  echo "LGPL-KONTROLL mpv: gpl = $g"
  [[ "$g" == "False" ]] || fel "mpv byggs med gpl=$g"
  grep -qx '#define HAVE_GPL 0' "$b/config.h" || fel "mpv: HAVE_GPL är inte 0 i config.h"
}
kontroll_dll() {
  local dll=$1 lic bad s=$ROT/dll-strings.txt
  strings -a "$dll" > "$s"   # en gång till fil: grep -q i en rörledning ger SIGPIPE och fel med pipefail
  # Varje FFmpeg-del bär sin licenstext i filen ("libavcodec license: …"); alla måste vara LGPL
  lic=$(grep -E '^lib(av|sw)[a-z]+ license: ' "$s" | sort -u)
  echo "LGPL-KONTROLL libmpv-2.dll:"; echo "$lic" | sed 's/^/  /'
  [[ $(echo "$lic" | grep -c .) -ge 5 ]] || fel "hittade inte FFmpeg-delarnas licenstexter i $dll"
  if echo "$lic" | grep -v -E ' license: LGPL version 2\.1 or later$'; then fel "en FFmpeg-del i $dll är inte LGPL"; fi
  # mpv:s byggrad (egenskapen mpv-configuration) börjar med -Dgpl=false
  grep -q -E '^(Configuration: )?-Dgpl=false ' "$s" || fel "mpv:s byggrad i $dll saknar -Dgpl=false"
  echo "  mpv-byggrad: $(grep -m1 -E '^-Dgpl=false ' "$s" | cut -c1-120) …"
  # Bara Windows egna DLL-filer får behövas (allt annat är inbyggt)
  echo "  DLL-filer som behövs:"; $HOST-objdump -p "$dll" | sed -n 's/^\s*DLL Name: //p' | sort -u | sed 's/^/    /'
  local win='advapi32|avrt|bcrypt|comctl32|comdlg32|crypt32|d3d11|d3d9|dwmapi|dwrite|dxgi|dxva2|gdi32|imm32|iphlpapi|kernel32|mfplat|msvcrt|ncrypt|ntdll|ole32|oleaut32|opengl32|powrprof|propsys|secur32|setupapi|shcore|shell32|shlwapi|user32|userenv|uxtheme|version|winmm|ws2_32|api-ms-win-[a-z0-9-]+'
  bad=$($HOST-objdump -p "$dll" | sed -n 's/^\s*DLL Name: //p' | grep -v -i -x -E "($win)\.dll" || true)
  [[ -z "$bad" ]] || fel "libmpv-2.dll behöver andra DLL-filer: $bad"
}

# --- mpv -----------------------------------------------------------------------------------------------------
bygg_mpv() {
  local b=$SRC/mpv/_b
  # Alla valfria delar av utom de som räknas upp här (inget kommer med av en slump). -Dgpl=false tar bort mpv:s
  # GPL-filer (se Copyright i mpv:s källkod).
  meson setup "$b" "$SRC/mpv" --cross-file "$KORS" --prefix "$ROT/mpv-inst" --libdir lib --buildtype release \
    --default-library shared --prefer-static --wrap-mode nodownload --auto-features disabled \
    -Dgpl=false -Dlibmpv=true -Dcplayer=false -Dtests=false -Dfuzzers=false -Dbuild-date=false \
    -Dlua=lua52 -Dlcms2=enabled -Dzlib=enabled -Dwin32-threads=enabled -Dwasapi=enabled \
    -Dd3d11=enabled -Dd3d-hwaccel=enabled -Dd3d9-hwaccel=enabled -Dshaderc=enabled -Dspirv-cross=enabled \
    -Dgl=enabled -Dgl-win32=enabled -Dgl-dxinterop=enabled -Dgl-dxinterop-d3d9=enabled -Dplain-gl=enabled \
    -Dvector=enabled -Dmanpage-build=disabled -Dhtml-build=disabled -Dpdf-build=disabled \
    -Dc_link_args="-L$PFX/lib -static" -Dcpp_link_args="-L$PFX/lib -static"
  kontroll_mpv
  meson compile -C "$b" -j "$JOBS"
  meson install -C "$b" --quiet
  $STRIP -s "$ROT/mpv-inst/bin/libmpv-2.dll"
  kontroll_dll "$ROT/mpv-inst/bin/libmpv-2.dll"
}

# --- Kör -----------------------------------------------------------------------------------------------------
steg "Hämtar källorna"
for n in "${NAMN[@]}"; do hamta "$n"; echo "  $n ${VER[$n]} ok"; done
slut

for n in zlib dav1d freetype fribidi harfbuzz libass lcms2 lua spirv-headers spirv-tools glslang shaderc spirv-cross libplacebo ffmpeg; do
  if klar "$n"; then
    echo "$n ${VER[$n]}: redan byggd (cache)"
    # FFmpeg från cachen kontrolleras ändå: configure körs igen och LGPL-kontrollen med den
    if [[ $n == ffmpeg ]]; then steg "Kontrollerar FFmpeg från cachen"; packa_upp ffmpeg; ffmpeg_configure; slut; fi
    continue
  fi
  steg "Bygger $n ${VER[$n]}"
  packa_upp "$n"
  case $n in spirv-headers|spirv-tools|glslang) ;; *) "bygg_$n" ;; esac
  markera "$n"
  slut
done

steg "Bygger mpv ${VER[mpv]} (libmpv, LGPL)"
packa_upp mpv; rm -rf "$ROT/mpv-inst"
bygg_mpv
slut

# --- Paketera ------------------------------------------------------------------------------------------------
steg "Paketerar"
NAMN_UT=libmpv-${VER[mpv]}-$BYGGDATUM
P=$UT/$NAMN_UT; rm -rf "$P"; mkdir -p "$P/licenser" "$P/include/mpv"
cp "$ROT/mpv-inst/bin/libmpv-2.dll" "$P/"
cp "$ROT/mpv-inst/include/mpv/"*.h "$P/include/mpv/"
for n in "${NAMN[@]}"; do
  [[ -d "$SRC/$n" ]] || packa_upp "$n"
  IFS=, read -ra lf <<< "${LFILER[$n]}"
  for f in "${lf[@]}"; do
    [[ -f "$SRC/$n/$f" ]] || fel "licensfilen $f saknas i $n"
    if [[ $n == lua ]]; then sed -n '/^\* Copyright (C) 1994/,/^\*\*\*\*\*\*/p' "$SRC/$n/$f" | sed 's/^\* \{0,1\}//' > "$P/licenser/lua-LICENSE.txt"
    else cp "$SRC/$n/$f" "$P/licenser/$n-$(echo "$f" | tr / _ | sed 's/\.txt$//I;s/\.md$//').txt"; fi
  done
done
# Körtidsbiblioteken från MinGW-w64 (libgcc/libstdc++ med GCC:s undantag, winpthreads) är inbyggda
cp /usr/share/doc/mingw-w64-x86-64-dev/copyright "$P/licenser/mingw-w64-copyright.txt"
cp /usr/share/doc/gcc-mingw-w64-base/copyright "$P/licenser/gcc-mingw-w64-copyright.txt" 2>/dev/null || true
# Licenstexterna som LGPL hänvisar till (LGPL 3 bygger på GPL 3), ur FFmpeg:s källkod
cp "$SRC/ffmpeg/COPYING.LGPLv2.1" "$P/lgpl-2.1.txt"; cp "$SRC/ffmpeg/COPYING.LGPLv3" "$P/lgpl-3.0.txt"
cp "$SRC/ffmpeg/COPYING.GPLv3" "$P/gpl-3.0.txt"
cp "$HAR/../installer/mpv-licens.txt" "$P/mpv-licens.txt"

KF=$P/KALLOR.txt
{
  echo "libmpv-2.dll för Windows x64 – LGPL-byggnad (mpv ${VER[mpv]}), byggd $BYGGDATUM"
  echo "Byggskript: apps/windows/libmpv/bygg.sh i https://github.com/${GITHUB_REPOSITORY:-BraXhn/braxhn-tv}${GITHUB_SHA:+ (commit $GITHUB_SHA)}"
  echo "Kompilator: $($CC --version | sed -n 1p); MinGW-w64 $(dpkg-query -W -f='${Version}' mingw-w64-x86-64-dev 2>/dev/null || echo okänd); meson $(meson --version); $(cmake --version | sed -n 1p)"
  echo
  printf '%-14s %-12s %-18s %s\n' namn version licens "källa och kontroll"
  for n in "${NAMN[@]}"; do
    if [[ ${TYP[$n]} == tar ]]; then k="sha256 ${KTL[$n]}"; else k="commit ${KTL[$n]}"; fi
    printf '%-14s %-12s %-18s %s %s\n' "$n" "${VER[$n]}" "${LIC[$n]}" "${URL[$n]}" "$k"
  done
  echo
  echo "FFmpeg configure: $(grep -m1 '^License:' "$ROT/ffmpeg-configure.txt")"
  echo "  påslaget: $(grep -E '^CONFIG_(LIB[A-Z0-9_]+|ZLIB|SCHANNEL|D3D11VA|DXVA2)=yes' "$SRC/ffmpeg/ffbuild/config.mak" | sed 's/^CONFIG_//;s/=yes//' | grep -v _ | tr '\n' ' ')"
  sed -n 's/^#define FFMPEG_CONFIGURATION "\(.*\)"$/  \1/p' "$SRC/ffmpeg/config.h"
  echo; echo "mpv meson:"; sed -n 's/^#define CONFIGURATION "\(.*\)"$/  \1/p' "$SRC/mpv/_b/config.h"
  echo; echo "sha256 för libmpv-2.dll: $(sha256sum "$P/libmpv-2.dll" | cut -d' ' -f1)"
} > "$KF"
cat "$KF"

ZIP=$UT/$NAMN_UT-win64-lgpl.zip
rm -f "$ZIP"; (cd "$UT" && find "$NAMN_UT" -exec touch -d @$SOURCE_DATE_EPOCH {} + && zip -X -q -r -9 "$ZIP" "$NAMN_UT")

# Källkoden: de oförändrade arkiven, git-arkiven som skapades ovan och byggskripten
K=$UT/$NAMN_UT-kallkod; rm -rf "$K"; mkdir -p "$K/arkiv" "$K/bygg"
for n in "${NAMN[@]}"; do cp "$(arkiv "$n")" "$K/arkiv/"; done
cp "$HAR/"* "$K/bygg/"; cp "$KF" "$K/"
[[ -f "$HAR/../../../.github/workflows/libmpv.yml" ]] && cp "$HAR/../../../.github/workflows/libmpv.yml" "$K/bygg/"
tar -C "$UT" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf "$UT/$NAMN_UT-kallkod.tar" "$NAMN_UT-kallkod"
rm -rf "$K"
(cd "$UT" && sha256sum "$NAMN_UT-win64-lgpl.zip" "$NAMN_UT-kallkod.tar" > "$NAMN_UT-SHA256SUMS.txt" && cat "$NAMN_UT-SHA256SUMS.txt")
echo "zip=$ZIP" > "$UT/resultat.env"
echo "kallkod=$UT/$NAMN_UT-kallkod.tar" >> "$UT/resultat.env"
echo "sums=$UT/$NAMN_UT-SHA256SUMS.txt" >> "$UT/resultat.env"
echo "namn=$NAMN_UT" >> "$UT/resultat.env"
slut
echo "Klart: $ZIP"
