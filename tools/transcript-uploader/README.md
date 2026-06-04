# Transcript uploader (Mac → AIOS Second Brain)

Pushes the video-transcript markdown in your Obsidian vault on the **MacBook Pro**
into **AIOS Second Brain** on the Windows machine, via the memory-ingest webhook.

```
Mac: Obsidian/Video Transcripts/*.md
        │  upload_transcripts.py  (walks folder, dedupes, POSTs each new file)
        ▼
Windows: AIOS  POST /api/memory/ingest   →  neuron (auto-categorized + embedded)
```

The script lives here for version control — **copy it to the MacBook Pro to run it.**
It has no dependencies beyond the `python3` already on macOS.

## One-time setup

1. **In AIOS (Windows)** → **Hermes Settings → "Second Brain memory ingest"**:
   - Toggle it **Enabled**.
   - Copy the **Ingest URL** (e.g. `http://192.168.1.50:8765/api/memory/ingest`) and the **bearer token**.
   - First connection from the Mac may trigger a **Windows Firewall** prompt — allow it (private network).

2. **On the MacBook Pro**, copy this folder over (e.g. to `~/tools/transcript-uploader/`).

3. **Test the round-trip** (sends nothing on `--dry-run`; then a real pass):
   ```bash
   export AIOS_INGEST_URL="http://<windows-ip>:8765/api/memory/ingest"
   export AIOS_INGEST_TOKEN="<token>"
   python3 upload_transcripts.py --dry-run        # lists what it would send
   python3 upload_transcripts.py                  # uploads new transcripts
   ```
   Each success prints `UPLOADED <file> → <neuron id>`. Open Second Brain in AIOS —
   the transcripts appear as neurons (give them a moment to embed).

## Keep it running automatically

Use the included **launchd** template so new transcripts upload on their own every 5 min:

1. Edit `com.aios.transcript-uploader.plist` — set the URL, token, and the absolute
   path to `upload_transcripts.py`.
2. ```bash
   cp com.aios.transcript-uploader.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.aios.transcript-uploader.plist
   tail -f /tmp/aios-transcript-uploader.log
   ```

Alternatives: `python3 upload_transcripts.py --watch --interval 300` in a terminal,
or a Hermes cron job that runs the same command.

## Behavior & flags

- **Upload-once per file** by default — tracked in `~/.aios-transcript-uploader/state.json`
  (records a content hash + the returned neuron id).
- `--reupload-changed` — also re-send a transcript whose contents changed. Note: AIOS
  mints a **new** neuron per POST, so a re-upload creates a second neuron rather than
  replacing the first. Leave this off unless your transcripts get edited after creation.
- `--watch [--interval N]` — keep running, poll every N seconds (default 60).
- `--dry-run` — list what would upload, send nothing.
- `--dir PATH` — override the transcripts folder (default is the Obsidian path).

## Notes

- Title = the file's first `# H1` if present, else the filename.
- Each note is tagged `video-transcript` and sourced `Obsidian`; AIOS auto-derives the
  topical category, tags, summary, and chunking on its side.
- Failed files (network down, AIOS closed, 4xx/5xx) are **not** marked done, so the next
  pass retries them.
