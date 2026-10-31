#!/usr/bin/env python3
"""Pack a synth's browser build into one self-contained HTML file.

    pack.py --wasm build/x.wasm --synth-dir examples/basic --out build/web/basic.html

The page inlines the shell (web/shell), the AudioWorklet code, the WebAssembly
module (base64) and the synth's ui/ folder (layout.json, custom.js, style.css,
and for a synth with its own page, page.html, page.js and page/*.js), so it
runs from a double-click (file://), GitHub Pages, or anywhere else, with no
server.
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


# ---- a synth's own page: ui/page.js and the modules it imports ----------------
#
# The page's modules are joined into one scope (no bundler, no module loading,
# so the page still works from file://): `export` is dropped, and an import of
# a name from another page module becomes a reference to that module's
# top-level declaration. So top-level names must be unique across the page's
# modules, imports must be relative (./x.js), and `import * as`, default
# exports and import.meta aren't supported. Renamed imports (`a as b`) become
# `const b = a;`.

IMPORT_RE = re.compile(r"""^\s*import\s+(?:([\s\S]*?)\s+from\s+)?["']([^"']+)["']\s*;?[ \t]*$""", re.MULTILINE)
DECL_RE = re.compile(r"^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)", re.MULTILINE)


class PageError(Exception):
    pass


def page_bundle(ui_dir):
    entry = os.path.join(ui_dir, "page.js")
    if not os.path.exists(entry):
        return "null"
    root = os.path.abspath(ui_dir)
    mods = {}      # path -> (deps, transformed source)
    order = []

    def load(path, chain):
        path = os.path.abspath(path)
        if path in mods:
            return
        if not path.startswith(root + os.sep):
            raise PageError("%s imports %s, which is outside ui/" % (chain[-1], path))
        if not os.path.exists(path):
            raise PageError("%s imports %s, which doesn't exist" % (os.path.relpath(chain[-1], root), os.path.relpath(path, root)))
        src = read(path)
        rel = os.path.relpath(path, root)
        if "import.meta" in src:
            raise PageError("%s: import.meta isn't supported in page modules" % rel)
        if re.search(r"^\s*export\s+default\b", src, re.MULTILINE):
            raise PageError("%s: use named exports (export function ...), not export default" % rel)
        deps, aliases = [], []

        def imp(m):
            what, spec = m.group(1), m.group(2)
            if not spec.startswith("."):
                raise PageError("%s: import from %r: page modules can only import other page modules (./x.js)" % (rel, spec))
            deps.append(os.path.normpath(os.path.join(os.path.dirname(path), spec)))
            if what:
                what = what.strip()
                if what.startswith("*"):
                    raise PageError("%s: 'import * as' isn't supported in page modules; import the names" % rel)
                if not what.startswith("{"):
                    raise PageError("%s: default imports aren't supported in page modules; use named imports" % rel)
                for part in what.strip("{} \n").split(","):
                    part = part.strip()
                    if not part:
                        continue
                    mm = re.match(r"^([\w$]+)\s+as\s+([\w$]+)$", part)
                    if mm:
                        aliases.append("const %s = %s;" % (mm.group(2), mm.group(1)))
            return ""

        body = IMPORT_RE.sub(imp, src)
        # export { a, b as c }
        def exp_list(m):
            out = []
            for part in m.group(1).split(","):
                mm = re.match(r"^\s*([\w$]+)\s+as\s+([\w$]+)\s*$", part)
                if mm:
                    out.append("const %s = %s;" % (mm.group(2), mm.group(1)))
            return "\n".join(out)
        body = re.sub(r"^\s*export\s*\{([^}]*)\}\s*;?", exp_list, body, flags=re.MULTILINE)
        body = re.sub(r"^(\s*)export\s+(?=(async\s+)?function|const|let|var|class)", r"\1", body, flags=re.MULTILINE)
        mods[path] = (deps, "\n".join(aliases) + ("\n" if aliases else "") + body)
        for d in deps:
            load(d, chain + [path])
        order.append(path)   # dependencies first (cycles: whichever came first)

    load(entry, [entry])
    seen = {}
    for path in order:
        for name in DECL_RE.findall(mods[path][1]):
            if name in seen and seen[name] != path:
                raise PageError("'%s' is declared at the top of both %s and %s; page modules share one scope, so rename one"
                                % (name, os.path.relpath(seen[name], root), os.path.relpath(path, root)))
            seen[name] = path
    parts = ["// ---- ui/%s\n%s" % (os.path.relpath(p, root), mods[p][1]) for p in order]
    return ("(function () {\n\"use strict\";\n%s\nreturn typeof mount === 'function' ? mount : null;\n})()" % "\n".join(parts))


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
    ui = os.path.join(a.synth_dir, "ui")
    try:
        page = page_bundle(ui)
    except PageError as e:
        sys.exit("pack.py: " + str(e))
    page_html = read(os.path.join(ui, "page.html")) if os.path.exists(os.path.join(ui, "page.html")) else ""
    synth_css = read(os.path.join(ui, "style.css")) if os.path.exists(os.path.join(ui, "style.css")) else ""
    worklet = read(os.path.join(SHELL, "js", "wasi.js")) + "\n" + read(os.path.join(SHELL, "worklet.js"))
    data = {"wasm": wasm, "layout": layout}

    html = read(os.path.join(SHELL, "template.html"))
    for key, value in {
        "TITLE": ascii_html(synth.get("name", synth.get("id", "synth"))),
        "STYLE": ascii_css(read(os.path.join(SHELL, "style.css")) + ("\n/* ---- ui/style.css */\n" + synth_css if synth_css else "")),
        "PAGE_HTML": ascii_html(page_html),
        "PAGE": safe(ascii_js(page)),
        "DATA": safe(json.dumps(data)),
        "WORKLET": safe(ascii_js(worklet)),
        "CUSTOM": safe(ascii_js(custom_js(os.path.join(a.synth_dir, "ui", "custom.js")))),
        "SCRIPT": safe(ascii_js(js)),
    }.items():
        marker = "{{%s}}" % key
        if marker not in html:
            sys.exit("template.html is missing " + marker)
        html = html.replace(marker, value)
    page = html

    if not page.isascii():
        sys.exit("pack.py: the page still has non-ASCII characters (template.html?)")
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(page)
    print("wrote %s (%d KB)" % (a.out, os.path.getsize(a.out) // 1024))


if __name__ == "__main__":
    main()
