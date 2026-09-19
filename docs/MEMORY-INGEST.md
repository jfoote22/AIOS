# Memory ingest — the contract for external clients

The LAN webhook that turns external markdown (Hermes task output, transcripts,
Obsidian notes) into Second Brain neurons. Served by `electron/memory-ingest.cjs`.

This document is the contract. The reference client is
`video_to_obsidian.py` → `upload_note_to_aios()` on the Mac.

## Endpoint

```
POST http://<host>:8765/api/memory/ingest
Authorization: Bearer <token>
Content-Type: application/json
```

Get the host, port, and token from **Settings → Hermes → Second Brain memory
ingest** in AIOS. Off by default. The token is generated on first enable and can
be regenerated there (regenerating invalidates the old one immediately).

### Authentication — read this carefully

The route reads **exactly one header**:

```js
const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
if (!token || provided !== token) return res.status(401).json({ error: 'Invalid or missing bearer token.' });
```

There is **no `X-token` fallback, no query parameter, and no cookie**. A client
that sends the token anywhere other than `Authorization` gets a 401, always.

### Body

JSON (preferred):

| Field | Type | Notes |
|---|---|---|
| `content` | string | **Required.** The markdown. Must be non-empty after trimming. |
| `title` | string | Optional. Falls back to the first `# H1`, then `jobName`, then `"Hermes note"`. Truncated to 200 chars. |
| `tags` | string[] | Optional. Non-strings are dropped. |
| `source` | string | Optional. Defaults to `"Hermes"`. |
| `category` | string | Optional. Defaults to `"Hermes"`. |
| `jobName` | string | Optional. Stored as `memoryJobName`. |

A raw `text/markdown` or `text/plain` body also works and is treated as `content`.
Payload limit is 25 MB.

### Responses

| Status | Meaning | Client should |
|---|---|---|
| `200 {ok, id}` | Stored as a raw neuron, pending enrichment | Consider delivered |
| `400` | `content` was empty | **Not** retryable — fix the caller |
| `401` | Bad or missing bearer token | **Not** retryable — fix the token |
| `500` | Store write failed | Retryable |
| connection refused / timeout | Listener down, firewall, host asleep | Retryable |

**A 200 does not mean the note is visible in Second Brain yet.** The main process
stores it with `status: 'analyzing'` and `memoryPending: true`; the renderer then
categorizes, chunks, and embeds it (`src/lib/memory.ts`). That step needs a
Gemini API key and can itself fail transiently — AIOS now retries those with
backoff rather than parking the note.

## Client requirements

### 1. Send the token in `Authorization` on every path

Every fallback path must carry the real token. A redacted placeholder such as
`Bearer ***` — easy to introduce by copying a logged request — produces a
guaranteed 401, and because 401 is not a network exception it can look like a
"successful" attempt to a client that only catches transport errors.

```python
headers = {
    "Authorization": f"Bearer {token}",   # the real token, never a placeholder
    "Content-Type": "application/json",
}
```

Log requests with the token redacted, but never *send* the redacted form.

### 2. Retry on HTTP failures, not only transport failures

Catching only `URLError` misses 429/500/503, which are exactly the failures worth
retrying. Treat as retryable: any connection error, timeout, `429`, and `5xx`.
Treat `400` and `401` as permanent — retrying them forever just hides a bug.

```python
RETRYABLE_STATUS = {429, 500, 502, 503, 504}

def _attempt(url, payload, token, timeout=30):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers=_headers(token), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        return (False, e.code, body)          # retryable iff e.code in RETRYABLE_STATUS
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return (False, None, str(e))          # transport failure — retryable
```

Back off between attempts (e.g. 2s, 8s, 30s) rather than retrying tightly.

### 3. Spool failures durably

In-process retries do not survive the script exiting, and the note is then only
in Obsidian with nothing recording that it never reached AIOS. Write a spool
entry and drain it on the next run.

```python
SPOOL = Path.home() / ".hermes" / "spool" / "aios-ingest"

def enqueue(payload):
    SPOOL.mkdir(parents=True, exist_ok=True)
    p = SPOOL / f"{int(time.time()*1000)}-{uuid.uuid4().hex[:6]}.json"
    p.write_text(json.dumps(payload), encoding="utf-8")

def drain(url, token, limit=50):
    """Call at the START of every run, before handling the new note."""
    for p in sorted(SPOOL.glob("*.json"))[:limit]:
        payload = json.loads(p.read_text(encoding="utf-8"))
        ok, status, _ = _attempt(url, payload, token)
        if ok:
            p.unlink()                        # delivered
        elif status in (400, 401):
            p.rename(p.with_suffix(".rejected"))   # permanent; needs a human
        else:
            break                             # still down — stop, try next run
```

Draining at the start of each run means the next transcript that arrives also
flushes everything stranded before it. For notes that arrive rarely, a small
cron (`*/30 * * * *`) that only calls `drain()` closes the gap.

### 4. Make the spool observable

A silent spool is as bad as a silent drop. Log the queue depth on each run and
surface anything that lands in `.rejected`.

## Host-side reliability

- **The listener binds one fixed port (8765) at startup.** AIOS now retries the
  bind with backoff and takes a single-instance lock, so a lingering tray
  instance can no longer take the port from a new one. If it still fails, the
  Hermes settings tab shows a red banner and a desktop notification fires.
- **Firewall:** the inbound rule must cover the profile the machine is actually
  on. A rule for `Public` only goes dead the moment Windows classifies the
  network as `Private`.
- **Addressing:** prefer a hostname (`hood_canal_pc.lan`) over a literal IP, and
  give the machine a DHCP reservation so the name keeps resolving after a lease
  change.

## Checking it end to end

```bash
# 1. Is the listener reachable? 401 proves it is alive and authenticating.
curl -si -X POST http://hood_canal_pc.lan:8765/api/memory/ingest \
  -H 'Content-Type: application/json' -d '{"content":"probe"}' | head -1

# 2. Full round trip with the real token — expect {"ok":true,"id":"hermes-..."}
curl -s -X POST http://hood_canal_pc.lan:8765/api/memory/ingest \
  -H "Authorization: Bearer $AIOS_INGEST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"# Probe\n\nEnd-to-end check.","source":"probe"}'
```

Then confirm it actually *indexed*: the note should appear in Second Brain within
a few seconds. If it stays absent, check the Gemini key — enrichment is what
makes a delivered note visible.
