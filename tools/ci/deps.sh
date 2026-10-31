#!/usr/bin/env bash
# Installs build dependencies on a CI runner.
#   tools/ci/deps.sh native   Ninja (Linux)
#   tools/ci/deps.sh web      clang 18 + wasm32 sysroot (Linux)
#   tools/ci/deps.sh plugin   JUCE's Linux deps / Ninja on macOS / WebView2 SDK on Windows
# On Windows, `plugin` writes WEBVIEW2_DIR to $GITHUB_ENV for tools/ci/plugin.sh.
set -euo pipefail
kind="${1:?native, web or plugin}"
os="${RUNNER_OS:-$(uname -s)}"

case "$kind:$os" in
  native:Linux)
    sudo apt-get update -q && sudo apt-get install -y -q ninja-build ;;
  web:Linux)
    sudo apt-get update -q
    sudo apt-get install -y -q ninja-build clang-18 lld-18 wasi-libc libc++-18-dev-wasm32 libclang-rt-18-dev-wasm32 ;;
  plugin:Linux)
    sudo apt-get update -q
    sudo apt-get install -y -q ninja-build xvfb libasound2-dev libjack-jackd2-dev ladspa-sdk libcurl4-openssl-dev \
      libfreetype-dev libfontconfig1-dev libx11-dev libxcomposite-dev libxcursor-dev libxext-dev libxinerama-dev \
      libxrandr-dev libxrender-dev libxi-dev libwebkit2gtk-4.1-dev libegl-dev libglu1-mesa-dev mesa-common-dev ;;
  plugin:macOS)
    brew install ninja ;;
  plugin:Windows)
    dir="${RUNNER_TEMP:-/tmp}/nuget"
    nuget install Microsoft.Web.WebView2 -OutputDirectory "$dir" -NonInteractive
    [ -n "${GITHUB_ENV:-}" ] && echo "WEBVIEW2_DIR=$dir" >> "$GITHUB_ENV" ;;
  *)
    echo "deps.sh: nothing to install for $kind on $os" ;;
esac
