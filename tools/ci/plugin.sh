#!/usr/bin/env bash
# Builds, checks and packages one synth's plugins on a CI runner (Windows,
# macOS or Linux). Used by synthkit's CI and by every synth repo's CI.
#
#   tools/ci/plugin.sh <cmake source dir> <target> <synth dir> <page dir> [out.zip]
#
#   cmake source dir  the project to configure (a synth repo's root, or synthkit's)
#   target            the name given to synthkit_add_synth (e.g. basic)
#   synth dir         the folder with synth.json
#   page dir          the folder with <target>.html (from the web build)
#   out.zip           default plugin.zip
#
# EXTRA_CMAKE_ARGS adds configure options (e.g. -DFETCHCONTENT_SOURCE_DIR_JUCE=…).
#
# Builds VST3 + Standalone (+ AU on macOS, universal binaries), signs macOS
# bundles ad hoc, runs <target>_plugin_check and pluginval (strictness 10;
# plus auval on macOS), and zips the plugins with INSTALL.md.
set -euo pipefail
# Say where it failed, as a GitHub annotation (visible without the full log).
trap 'echo "::error title=plugin.sh::failed at line $LINENO: $BASH_COMMAND"' ERR
src="${1:?cmake source dir}"; target="${2:?target}"; synth="${3:?synth dir}"; page="${4:?page dir}"
out="${5:-plugin.zip}"
kit="$(cd "$(dirname "$0")/../.." && pwd)"
os="${RUNNER_OS:-$(uname -s)}"; [ "$os" = Darwin ] && os=macOS
page="$(cd "$page" && pwd)"
build="${BUILD_DIR:-build-plugin}"
PLUGINVAL_VERSION="${PLUGINVAL_VERSION:-v1.0.4}"

PY="$(command -v python3 || command -v python)"
json() { "$PY" -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$synth/synth.json" "$1"; }
product="$(json name)"; plugin_code="$(json pluginCode)"; vendor_code="$(json vendorCode)"

echo "::group::Configure"
args=(${EXTRA_CMAKE_ARGS:-} -DCMAKE_BUILD_TYPE=Release -DSYNTHKIT_PLUGIN=ON -DSYNTHKIT_BUILD_TESTS=OFF -DSYNTHKIT_WEB_UI_DIR="$page")
case "$os" in
  Windows) args+=(-DJUCE_WEBVIEW2_PACKAGE_LOCATION="${WEBVIEW2_DIR:?run tools/ci/deps.sh plugin first}") ;;
  macOS)   args+=(-G Ninja "-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64" -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0) ;;
  *)       args+=(-G Ninja) ;;
esac
cmake -S "$src" -B "$build" "${args[@]}"
echo "::endgroup::"

echo "::group::Build"
targets=("${target}_plugin_VST3" "${target}_plugin_Standalone" "${target}_plugin_check")
[ "$os" = macOS ] && targets+=("${target}_plugin_AU")
cmake --build "$build" --config Release --parallel --target "${targets[@]}"
echo "::endgroup::"

art="$(find "$build" -type d -path "*${target}_plugin_artefacts/Release" | head -1)"
check="$(find "$build" -path "*${target}_plugin_check_artefacts/Release/*" -type f \( -name "${target}_plugin_check" -o -name "${target}_plugin_check.exe" \) | head -1)"
vst3="$art/VST3/$product.vst3"
[ -d "$vst3" ] || { echo "plugin.sh: $vst3 not found"; exit 1; }

if [ "$os" = macOS ]; then
  for b in "$vst3" "$art/AU/$product.component" "$art/Standalone/$product.app"; do codesign --force --deep --sign - "$b"; done
fi

# Linux has no display on CI: run GUI-capable tools under Xvfb. (A function,
# not an array: macOS's bash 3.2 treats an empty array as unset under set -u.)
run() { if [ "$os" = Linux ]; then xvfb-run -a "$@"; else "$@"; fi; }

echo "::group::Plays like the engine, loaded the way a DAW loads it"
run "$check" "$vst3"
echo "::endgroup::"

echo "::group::pluginval"
pv="$(mktemp -d)"
case "$os" in
  Windows) zip=pluginval_Windows.zip; bin="$pv/pluginval.exe" ;;
  macOS)   zip=pluginval_macOS.zip;   bin="$pv/pluginval.app/Contents/MacOS/pluginval" ;;
  *)       zip=pluginval_Linux.zip;   bin="$pv/pluginval" ;;
esac
curl -sSL -o "$pv/pv.zip" "https://github.com/Tracktion/pluginval/releases/download/$PLUGINVAL_VERSION/$zip"
(cd "$pv" && unzip -q pv.zip)
run "$bin" --strictness-level 10 --validate-in-process --timeout-ms 300000 "$vst3"
if [ "$os" = macOS ]; then
  mkdir -p ~/Library/Audio/Plug-Ins/Components
  cp -R "$art/AU/$product.component" ~/Library/Audio/Plug-Ins/Components/
  killall -9 AudioComponentRegistrar 2>/dev/null || true
  auval -a > /dev/null
  auval -strict -v aumu "$plugin_code" "$vendor_code"
  "$bin" --strictness-level 10 --validate-in-process --timeout-ms 300000 ~/Library/Audio/Plug-Ins/Components/"$product.component"
fi
echo "::endgroup::"

echo "::group::Package"
stage="$(mktemp -d)"; dest="$stage/$product"
mkdir -p "$dest"
cp -R "$vst3" "$dest/"
[ -d "$art/AU" ] && cp -R "$art/AU/$product.component" "$dest/"
cp -R "$art/Standalone/"* "$dest/"
cp "$kit/plugin/INSTALL.md" "$dest/INSTALL.md"
out_abs="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"
rm -f "$out_abs"
if [ "$os" = Windows ]; then (cd "$stage" && 7z a -tzip -bd "$out_abs" "$product" > /dev/null)
else (cd "$stage" && zip -qry "$out_abs" "$product"); fi
echo "wrote $out"
echo "::endgroup::"
