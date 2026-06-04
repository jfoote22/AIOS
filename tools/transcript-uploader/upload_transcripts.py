#!/usr/bin/env python3
"""
Push Obsidian video-transcript markdown into AIOS Second Brain.

Runs on the MacBook Pro (where the transcripts live). Walks the transcripts
folder, and for each markdown file POSTs its contents to the AIOS memory-ingest
webhook so it becomes a Second Brain neuron (auto-categorized + embedded by AIOS).

Already-uploaded files are tracked in a state file so re-runs only send new
files (or, with --reupload-changed, files whose contents changed).

Dependency-free: standard library only (works with the python3 shipped on macOS).

Configuration (env vars, or edit the DEFAULT_* constants below):
  AIOS_INGEST_URL    e.g. http://192.168.1.50:8765/api/memory/ingest
  AIOS_INGEST_TOKEN  the bearer token shown in AIOS → Hermes Settings
  AIOS_TRANSCRIPTS_DIR  defaults to the known Obsidian folder

Usage:
  python3 upload_transcripts.py                 # one pass, upload new files
  python3 upload_transcripts.py --watch         # keep running, poll every 60s
  python3 upload_transcripts.py --interval 300  # poll cadence for --watch
  python3 upload_transcripts.py --reupload-changed
  python3 upload_transcripts.py --dry-run       # show what would upload
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_TRANSCRIPTS_DIR = "/Users/justinfoote/Documents/Obsidian Vault/Video Transcripts/"
DEFAULT_INGEST_URL = ""    # e.g. "http://192.168.1.50:8765/api/memory/ingest"
DEFAULT_INGEST_TOKEN = ""  # paste from AIOS → Hermes Settings → Memory ingest

STATE_DIR = os.path.expanduser("~/.aios-transcript-uploader")
STATE_FILE = os.path.join(STATE_DIR, "state.json")

JOB_NAME = "video-transcripts"
SOURCE = "Obsidian"
TAGS = ["video-transcript"]


def log(msg):
    print(f"[transcript-uploader] {msg}", flush=True)


def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_FILE)  # atomic


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def first_h1(md):
    for line in md.splitlines():
        s = line.strip()
        if s.startswith("# "):
            return s[2:].strip()
    return ""


def find_markdown(root):
    out = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if name.lower().endswith((".md", ".markdown")):
                out.append(os.path.join(dirpath, name))
    return sorted(out)


def post_transcript(url, token, title, content, rel_path):
    payload = json.dumps({
        "title": title,
        "content": content,
        "jobName": JOB_NAME,
        "source": SOURCE,
        "tags": TAGS,
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8", "replace")
        data = json.loads(body) if body else {}
        return data.get("id", "")


def run_once(args):
    root = args.dir
    if not os.path.isdir(root):
        log(f"Transcripts folder not found: {root}")
        return 1

    state = load_state()
    files = find_markdown(root)
    uploaded = skipped = failed = 0

    for path in files:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except OSError as e:
            log(f"SKIP (read error) {path}: {e}")
            failed += 1
            continue

        if not content.strip():
            continue

        digest = sha256(content)
        prev = state.get(path)
        already = prev is not None
        changed = already and prev.get("hash") != digest

        if already and not (changed and args.reupload_changed):
            skipped += 1
            continue

        title = first_h1(content) or os.path.splitext(os.path.basename(path))[0]

        if args.dry_run:
            log(f"WOULD UPLOAD {'(changed) ' if changed else ''}{path}  →  \"{title}\"")
            uploaded += 1
            continue

        try:
            neuron_id = post_transcript(args.url, args.token, title, content, path)
            state[path] = {"hash": digest, "uploaded_at": int(time.time()), "neuron_id": neuron_id}
            save_state(state)
            uploaded += 1
            log(f"UPLOADED {os.path.basename(path)}  →  {neuron_id}")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:200]
            log(f"FAILED ({e.code}) {os.path.basename(path)}: {detail}")
            failed += 1
        except (urllib.error.URLError, TimeoutError) as e:
            log(f"FAILED (network) {os.path.basename(path)}: {e}  — is AIOS running and reachable?")
            failed += 1

    log(f"done: {uploaded} uploaded, {skipped} unchanged, {failed} failed ({len(files)} files seen)")
    return 0 if failed == 0 else 2


def main():
    p = argparse.ArgumentParser(description="Upload Obsidian video transcripts into AIOS Second Brain.")
    p.add_argument("--dir", default=os.environ.get("AIOS_TRANSCRIPTS_DIR", DEFAULT_TRANSCRIPTS_DIR))
    p.add_argument("--url", default=os.environ.get("AIOS_INGEST_URL", DEFAULT_INGEST_URL))
    p.add_argument("--token", default=os.environ.get("AIOS_INGEST_TOKEN", DEFAULT_INGEST_TOKEN))
    p.add_argument("--watch", action="store_true", help="keep running, polling on --interval")
    p.add_argument("--interval", type=int, default=60, help="seconds between passes in --watch mode")
    p.add_argument("--reupload-changed", action="store_true", help="re-send files whose contents changed")
    p.add_argument("--dry-run", action="store_true", help="show what would be uploaded, send nothing")
    args = p.parse_args()

    if not args.dry_run and (not args.url or not args.token):
        log("Missing --url / --token (or AIOS_INGEST_URL / AIOS_INGEST_TOKEN). "
            "Copy them from AIOS → Hermes Settings → Memory ingest.")
        return 1

    if not args.watch:
        return run_once(args)

    log(f"watching {args.dir} every {args.interval}s — Ctrl+C to stop")
    while True:
        run_once(args)
        try:
            time.sleep(args.interval)
        except KeyboardInterrupt:
            log("stopped")
            return 0


if __name__ == "__main__":
    sys.exit(main())
