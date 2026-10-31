#!/usr/bin/env python3
"""Pack a synth's browser build into one self-contained HTML file.

    pack.py --wasm build/x.wasm --synth-dir examples/basic --out build/web/basic.html

The page inlines the shell (web/shell), the AudioWorklet code, the WebAssembly
module (base64) and the synth's ui/layout.json and ui/custom.js, so it runs
from a double-click (file://), GitHub Pages, or anywhere else, with no server.
"""
import argparse
import base64
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHELL = os.path.join(HERE, "shell")

# Page scripts, concatenated in this order into one module script.
PAGE_JS = ["wasi.js", "model.js", "audio.js", "host.js", "controls.js", "panels.js",
           "modulation.js", "presets.js", "keyboard.js", "midi.js", "clock.js", "app.js"]


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def safe(text):
    """Make text safe to place inside a <script> element."""
    return re.sub(r"</(script)", r"<\\/\1", text, flags=re.IGNORECASE)


# The page is kept pure ASCII: some web views (WebKitGTK serving the plugin's
# page) ignore the declared charset and would garble anything else.
def ascii_js(text):
    """Escape non-ASCII as \\uXXXX (valid in JS strings, regexes, templates and comments)."""
    def esc(m):
        b = m.group(0).encode("utf-16-be")
        return "".join("\\u%04x" % int.from_bytes(b[i:i + 2], "big") for i in range(0, len(b), 2))
    return re.sub(r"[^\x00-\x7f]", esc, text)


def ascii_css(text):
    return re.sub(r"[^\x00-\x7f]", lambda m: "\\%06x" % ord(m.group(0)), text)


def ascii_html(text):
    return re.sub(r"[^\x00-\x7f]", lambda m: "&#x%x;" % ord(m.group(0)), text)


def custom_js(path):
    """ui/custom.js exports register(sk); wrap it so no module loading is needed."""
    if not os.path.exists(path):
        return "null"
    src = read(path)
    src = re.sub(r"^\s*export\s+(?=(async\s+)?function|const|let|class)", "", src, flags=re.MULTILINE)
    return "(function () {\n%s\nreturn typeof register === 'function' ? register : null;\n})()" % src


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wasm", required=True)
    ap.add_argument("--synth-dir", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    synth = json.loads(read(os.path.join(a.synth_dir, "synth.json")))
    layout_path = os.path.join(a.synth_dir, "ui", "layout.json")
    layout = json.loads(read(layout_path)) if os.path.exists(layout_path) else None
    with open(a.wasm, "rb") as f:
        wasm = base64.b64encode(f.read()).decode("ascii")

    js = "\n".join("// ---- %s\n%s" % (n, read(os.path.join(SHELL, "js", n))) for n in PAGE_JS)
    worklet = read(os.path.join(SHELL, "js", "wasi.js")) + "\n" + read(os.path.join(SHELL, "worklet.js"))
    data = {"wasm": wasm, "layout": layout}

    page = read(os.path.join(SHELL, "template.html"))
    for key, value in {
        "TITLE": ascii_html(synth.get("name", synth.get("id", "synth"))),
        "STYLE": ascii_css(read(os.path.join(SHELL, "style.css"))),
        "DATA": safe(json.dumps(data)),
        "WORKLET": safe(ascii_js(worklet)),
        "CUSTOM": safe(ascii_js(custom_js(os.path.join(a.synth_dir, "ui", "custom.js")))),
        "SCRIPT": safe(ascii_js(js)),
    }.items():
        marker = "{{%s}}" % key
        if marker not in page:
            sys.exit("template.html is missing " + marker)
        page = page.replace(marker, value)

    if not page.isascii():
        sys.exit("pack.py: the page still has non-ASCII characters (template.html?)")
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(page)
    print("wrote %s (%d KB)" % (a.out, os.path.getsize(a.out) // 1024))


if __name__ == "__main__":
    main()
