#!/usr/bin/env python3
"""Start a new synth repo from synthkit/template.

    python3 synthkit/tools/new-synth.py <dir> --name "Glass Rain" [options]

<dir> is an empty folder or a freshly cloned empty repo. The script copies the
template, fills in the synth's identity, and adds synthkit as a git submodule
pinned to the commit this script came from. Then:

    cd <dir> && cmake -S . -B build && cmake --build build && ./build/<target>_render --check .

Options (sensible defaults are derived from --name):
  --id ID              permanent synth id (letters, digits, - and _)      default: from name
  --target NAME        CMake/target name (lowercase, letters/digits/_)    default: from id
  --plugin-code CODE   permanent 4-char plugin code, e.g. Glra            default: from name
  --vendor NAME        shown in DAWs                                      default: 10d6
  --vendor-code CODE   permanent 4-char vendor code (one uppercase+)      default: Tend
  --accent "#rrggbb"   UI accent colour                                   default: #2457d6
  --synthkit-url URL   submodule URL                                      default: this checkout's origin
  --link-synthkit PATH symlink synthkit/ to PATH instead of adding a submodule (for testing the template)

Identifiers that end up in DAW projects (id, plugin and vendor codes, the
macOS bundle id) can't change once the synth is released, so the script
checks them now.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys

KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(KIT, "template")


def die(msg):
    sys.exit("new-synth: " + msg)


def git(*args, cwd=None, check=True):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and r.returncode != 0:
        die("git %s failed: %s" % (" ".join(args), r.stderr.strip()))
    return r.stdout.strip()


def words(name):
    return re.findall(r"[A-Za-z0-9]+", name)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dir")
    ap.add_argument("--name", required=True)
    ap.add_argument("--id")
    ap.add_argument("--target")
    ap.add_argument("--plugin-code")
    ap.add_argument("--vendor", default="10d6")
    ap.add_argument("--vendor-code", default="Tend")
    ap.add_argument("--accent", default="#2457d6")
    ap.add_argument("--synthkit-url")
    ap.add_argument("--link-synthkit")
    a = ap.parse_args()

    w = words(a.name)
    if not w:
        die("--name needs at least one letter or digit")
    sid = a.id or "-".join(x.lower() for x in w)
    target = a.target or re.sub(r"[^a-z0-9_]", "_", sid.lower())
    joined = "".join(w)
    code = a.plugin_code or (joined[0].upper() + (joined[1:] + "xxx")[:3].lower())
    cls = "".join(x[:1].upper() + x[1:] for x in w)
    if not cls[0].isalpha():
        cls = "Synth" + cls

    # Permanent identifiers: check them before anything is written.
    if not re.fullmatch(r"[A-Za-z0-9_-]+", sid):
        die("--id may only use letters, digits, - and _ (got %r)" % sid)
    if not re.fullmatch(r"[a-z][a-z0-9_]*", target):
        die("--target must be lowercase letters, digits and _, starting with a letter (got %r)" % target)
    for label, c in (("--plugin-code", code), ("--vendor-code", a.vendor_code)):
        if len(c) != 4 or not c.isascii() or not c.isalnum():
            die("%s must be exactly 4 ASCII letters or digits (got %r)" % (label, c))
    if not any(ch.isupper() for ch in a.vendor_code):
        die("--vendor-code needs at least one uppercase letter (got %r)" % a.vendor_code)
    if not re.fullmatch(r"[A-Z][a-z0-9]{3}", code):
        die("--plugin-code should be one uppercase letter then three lowercase letters or digits, "
            "which GarageBand needs (got %r)" % code)
    if code == "Skba":
        die("--plugin-code Skba belongs to synthkit's example synth")
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", a.accent):
        die("--accent must look like #2457d6")

    dest = os.path.abspath(a.dir)
    os.makedirs(dest, exist_ok=True)
    leftovers = [f for f in os.listdir(dest) if f not in (".git",)]
    if leftovers:
        die("%s isn't empty (%s)" % (dest, ", ".join(sorted(leftovers)[:5])))

    subs = {"{{NAME}}": a.name, "{{ID}}": sid, "{{TARGET}}": target, "{{CLASS}}": cls,
            "{{PLUGIN_CODE}}": code, "{{VENDOR}}": a.vendor, "{{VENDOR_CODE}}": a.vendor_code,
            "{{ACCENT}}": a.accent}
    for root, _dirs, files in os.walk(TEMPLATE):
        rel = os.path.relpath(root, TEMPLATE)
        os.makedirs(os.path.join(dest, rel), exist_ok=True)
        for f in files:
            src = os.path.join(root, f)
            with open(src, encoding="utf-8") as fh:
                text = fh.read()
            for k, v in subs.items():
                text = text.replace(k, v)
            left = re.findall(r"\{\{[A-Z_]+\}\}", text)
            if left:
                die("template file %s has unknown placeholders %s" % (os.path.join(rel, f), left))
            with open(os.path.join(dest, rel, f), "w", encoding="utf-8") as fh:
                fh.write(text)

    if not os.path.isdir(os.path.join(dest, ".git")):
        git("init", "-q", "-b", "main", cwd=dest)

    if a.link_synthkit:
        os.symlink(os.path.abspath(a.link_synthkit), os.path.join(dest, "synthkit"))
        pinned = "(linked to %s)" % os.path.abspath(a.link_synthkit)
    else:
        url = a.synthkit_url or git("remote", "get-url", "origin", cwd=KIT)
        commit = git("rev-parse", "HEAD", cwd=KIT)
        if git("status", "--porcelain", "--untracked-files=no", cwd=KIT):
            print("new-synth: note: synthkit has uncommitted changes; the submodule pins %s without them" % commit[:10])
        # Clone from this checkout (fast, works offline), then point it at the real URL.
        git("-c", "protocol.file.allow=always", "submodule", "add", "-q", KIT, "synthkit", cwd=dest)
        git("config", "-f", ".gitmodules", "submodule.synthkit.url", url, cwd=dest)
        git("submodule", "sync", "-q", cwd=dest)
        sub = os.path.join(dest, "synthkit")
        git("remote", "set-url", "origin", url, cwd=sub)
        git("checkout", "-q", commit, cwd=sub)
        git("add", ".gitmodules", "synthkit", cwd=dest)
        pinned = "%s @ %s" % (url, commit[:10])

    git("add", "-A", cwd=dest)

    for f in ("CMakeLists.txt",):
        if not os.path.exists(os.path.join(dest, f)):
            die("template copy is missing " + f)
    print("Created %s in %s" % (a.name, dest))
    print("  id %s, target %s, plugin code %s, vendor %s (%s)" % (sid, target, code, a.vendor, a.vendor_code))
    print("  synthkit %s" % pinned)
    print("Next: cd %s && cmake -S . -B build && cmake --build build && ./build/%s_render --check ." % (a.dir, target))


if __name__ == "__main__":
    main()
