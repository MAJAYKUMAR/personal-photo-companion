#!/usr/bin/env python3
"""Verify the packaged Personal Photo Companion artifacts.

Checks (stdlib only, no third-party packages):
  - Windows NSIS installer exists, is a PE executable of sane size, and the
    win-unpacked directory holds the current app files (hash-compared
    against the repo sources) with no app.asar (loose files by design).
  - macOS zip (built on Linux; DMG needs macOS) contains a valid .app
    bundle: Info.plist with the right bundle id/version, a Mach-O
    executable bit, and the current app files (hash-compared).
  - Linux AppImage, when present, is an ELF executable of sane size.
  - Source hygiene: no network APIs in the app's JavaScript sources.

Usage:
    python3 tests/check_build.py [--dist DIR]

On a Windows runner (sys.platform == "win32"), the macOS zip check is
reported as a warning, not a failure: a Windows-only workflow cannot
build a Mac zip, so failing the whole run for its absence would make
every Windows run fail for a platform it never builds. On other
platforms the Mac check stays a failure, as before.

Exit code 0 only when every FAIL-level check passes. WARN-level items are
reported but do not fail the run (e.g. a missing optional Linux AppImage).

Run the packaging scripts first: npm run package:win, package:mac-zip,
package:linux (package:mac for DMG needs macOS).
"""

import argparse
import hashlib
import json
import os
import plistlib
import shutil
import stat
import sys
import tempfile
import zipfile

APP_ID = "com.example.personal-photo-companion"
APP_VERSION = "1.0.0"
# Files that must exist inside the packaged app, relative to resources/app
# (Windows/Linux) or Contents/Resources/app (macOS).
REQUIRED_APP_FILES = [
    "main.js",
    "core.js",
    "preload.js",
    "package.json",
    "renderer/index.html",
    "renderer/renderer.js",
    "renderer/styles.css",
    "assets/avatar.png",
]
# electron-builder rewrites package.json when packaging (it strips
# devDependencies, scripts, and build config), so the packaged copy is
# intentionally different from the repo copy: check presence, not hash.
HASH_COMPARE_EXCLUDE = {"package.json"}
# JavaScript sources scanned for forbidden network usage.
JS_SOURCES = [
    "main.js",
    "core.js",
    "preload.js",
    "renderer/renderer.js",
]
FORBIDDEN_TOKENS = [
    "require('http')",
    'require("http")',
    "require('https')",
    'require("https")',
    "require('net')",
    'require("net")',
    "electron.net",
    "net.request",
    "fetch(",
    "axios",
    "XMLHttpRequest",
]

failures = []
warnings = []


def check(name, ok, detail=""):
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f": {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def warn(name, detail=""):
    print(f"[WARN] {name}" + (f": {detail}" if detail else ""))
    warnings.append(name)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_app_files(label, app_root, repo_root):
    """Check required files exist in a packaged app dir and match sources."""
    for rel in REQUIRED_APP_FILES:
        packaged = os.path.join(app_root, rel)
        source = os.path.join(repo_root, rel)
        if not os.path.isfile(packaged):
            check(f"{label}: file present {rel}", False, "missing")
            continue
        check(f"{label}: file present {rel}", True)
        if os.path.isfile(source):
            if rel in HASH_COMPARE_EXCLUDE:
                continue
            same = sha256_of(packaged) == sha256_of(source)
            check(f"{label}: matches repo source {rel}", same,
                  "" if same else "packaged copy differs from repo")
    asar = os.path.join(app_root, "..", "app.asar")
    check(f"{label}: loose files, no app.asar", not os.path.exists(asar),
          "app.asar found but asar:false is configured" if os.path.exists(asar) else "")


def verify_windows(dist_dir, repo_root):
    exes = sorted(
        f for f in os.listdir(dist_dir)
        if f.lower().endswith(".exe") and os.path.isfile(os.path.join(dist_dir, f))
    )
    if not exes:
        check("win: NSIS installer exists", False, "no .exe in dist/ (run package:win)")
        # Fall through: the unpacked folder is still checked below, so a
        # partial Windows build gets verified for what it did produce.
    else:
        exe = max(exes, key=lambda f: os.path.getsize(os.path.join(dist_dir, f)))
        exe_path = os.path.join(dist_dir, exe)
        size = os.path.getsize(exe_path)
        check("win: NSIS installer exists", True, f"{exe} ({size} bytes)")
        check("win: installer sane size (>10 MB)", size > 10 * 1024 * 1024, f"{size} bytes")
        with open(exe_path, "rb") as f:
            magic = f.read(2)
        check("win: installer is a PE executable (MZ header)", magic == b"MZ",
              f"header={magic!r}")
        with open(exe_path, "rb") as f:
            head = f.read(1024 * 1024)
        if b"Personal Photo Companion" in head:
            check("win: installer embeds product name", True)
        else:
            warn("win: installer embeds product name",
                 "name not found in first 1 MB (may be compressed; non-fatal)")

    unpacked = os.path.join(dist_dir, "win-unpacked")
    if not os.path.isdir(unpacked):
        check("win: win-unpacked dir exists", False,
              "run package:win-dir or check electron-builder output")
        return
    check("win: win-unpacked dir exists", True)
    exe_names = [f for f in os.listdir(unpacked) if f.lower().endswith(".exe")]
    check("win: unpacked app executable exists", len(exe_names) > 0,
          ", ".join(exe_names) if exe_names else "no .exe found")
    verify_app_files("win-unpacked", os.path.join(unpacked, "resources", "app"), repo_root)


def verify_mac(dist_dir, repo_root):
    zips = sorted(
        f for f in os.listdir(dist_dir)
        if f.lower().endswith(".zip") and os.path.isfile(os.path.join(dist_dir, f))
    )
    if not zips:
        check("mac: zip package exists", False, "no .zip in dist/ (run package:mac-zip)")
        return
    zpath = os.path.join(dist_dir, zips[0])
    size = os.path.getsize(zpath)
    check("mac: zip package exists", True, f"{zips[0]} ({size} bytes)")
    check("mac: zip sane size (>10 MB)", size > 10 * 1024 * 1024, f"{size} bytes")
    tmp = tempfile.mkdtemp(prefix="pcc-mac-check-")
    try:
        with zipfile.ZipFile(zpath) as zf:
            names = zf.namelist()
            apps = sorted({n.split("/")[0] for n in names if n.endswith(".app/Contents/Info.plist")})
            check("mac: .app bundle with Info.plist in zip", len(apps) == 1,
                  ", ".join(apps) if apps else "no Info.plist found")
            if not apps:
                return
            app_prefix = apps[0] + "/"
            plist_name = app_prefix + "Contents/Info.plist"
            with zf.open(plist_name) as pf:
                plist = plistlib.load(pf)
            check("mac: Info.plist bundle id", plist.get("CFBundleIdentifier") == APP_ID,
                  str(plist.get("CFBundleIdentifier")))
            check("mac: Info.plist version", plist.get("CFBundleShortVersionString") == APP_VERSION,
                  str(plist.get("CFBundleShortVersionString")))
            exe_name = plist.get("CFBundleExecutable", "")
            exe_entry = app_prefix + "Contents/MacOS/" + exe_name
            check("mac: bundle executable entry exists", exe_entry in names, exe_entry)
            if exe_entry in names:
                mode = zf.getinfo(exe_entry).external_attr >> 16
                check("mac: bundle executable has +x bit", bool(mode & stat.S_IXUSR),
                      oct(mode))
            for rel in REQUIRED_APP_FILES:
                entry = app_prefix + "Contents/Resources/app/" + rel
                check(f"mac: zip contains {rel}", entry in names)
            # Hash-compare the app files straight from the zip (no full
            # extraction: the bundle is ~330 MB uncompressed and /tmp is a
            # small tmpfs on this VM).
            for rel in REQUIRED_APP_FILES:
                entry = app_prefix + "Contents/Resources/app/" + rel
                source = os.path.join(repo_root, rel)
                if entry in names and os.path.isfile(source) and rel not in HASH_COMPARE_EXCLUDE:
                    same = (
                        hashlib.sha256(zf.read(entry)).hexdigest()
                        == sha256_of(source)
                    )
                    check(f"mac-zip: matches repo source {rel}", same,
                          "" if same else "packaged copy differs from repo")
            asar_entry = app_prefix + "Contents/Resources/app.asar"
            check("mac-zip: loose files, no app.asar", asar_entry not in names,
                  "app.asar found but asar:false is configured" if asar_entry in names else "")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def verify_linux(dist_dir):
    images = sorted(
        f for f in os.listdir(dist_dir)
        if f.lower().endswith(".appimage") and os.path.isfile(os.path.join(dist_dir, f))
    )
    if not images:
        warn("linux: AppImage missing", "optional; run package:linux to build it")
        return
    ipath = os.path.join(dist_dir, images[0])
    size = os.path.getsize(ipath)
    check("linux: AppImage exists", True, f"{images[0]} ({size} bytes)")
    check("linux: AppImage sane size (>10 MB)", size > 10 * 1024 * 1024, f"{size} bytes")
    check("linux: AppImage is executable", bool(os.stat(ipath).st_mode & stat.S_IXUSR))
    with open(ipath, "rb") as f:
        magic = f.read(4)
    check("linux: AppImage ELF magic", magic == b"\x7fELF", f"header={magic!r}")


def verify_source_hygiene(repo_root):
    for rel in JS_SOURCES:
        path = os.path.join(repo_root, rel)
        if not os.path.isfile(path):
            check(f"hygiene: source present {rel}", False, "missing")
            continue
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        hits = [tok for tok in FORBIDDEN_TOKENS if tok in text]
        check(f"hygiene: no network APIs in {rel}", not hits,
              f"found: {', '.join(hits)}" if hits else "")
    pkg_path = os.path.join(repo_root, "package.json")
    with open(pkg_path, "r", encoding="utf-8") as f:
        pkg = json.load(f)
    check("hygiene: packaging uses loose files (asar:false)",
          pkg.get("build", {}).get("asar") is False)
    files = pkg.get("build", {}).get("files", [])
    check("hygiene: core.js included in packaged files", "core.js" in files)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", default=None, help="dist directory (default: <repo>/dist)")
    args = parser.parse_args()
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    dist_dir = args.dist or os.path.join(repo_root, "dist")
    print(f"repo: {repo_root}")
    print(f"dist: {dist_dir}")
    if not os.path.isdir(dist_dir):
        print(f"[FAIL] dist directory missing: {dist_dir} (run a package script first)")
        return 1
    verify_windows(dist_dir, repo_root)
    if sys.platform == "win32":
        warn("mac: zip package exists",
             "skipped on Windows runner; a Windows-only build cannot produce a Mac zip")
    else:
        verify_mac(dist_dir, repo_root)
    verify_linux(dist_dir)
    verify_source_hygiene(repo_root)
    print(f"\n{len(failures)} failure(s), {len(warnings)} warning(s)")
    if failures:
        print("FAILED: " + ", ".join(failures))
        return 1
    print("ALL ARTIFACT CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
