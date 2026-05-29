# READY-03 — Structured Chat UI: Parse & Render the JSON Stream

**Column:** Ready
**Priority:** High
**Tag:** ui / chat
**Estimate:** Medium (3–5 h)
**Source:** Expanded from [BACKLOG-01](../backlog/BACKLOG-01-claude-code-tab.md)
**Depends on:** READY-01 (tab shell), READY-02 (IPC bridge must be wired)

---

## Problem Statement

The `window.aios.claudeCode` bridge delivers raw NDJSON lines from Claude Code's
`--output-format stream-json` output. Nothing in the UI reads those lines or renders
them to the user. This card builds the chat-like message view inside `ClaudeCodeTab`.

## Scope

**In:**
- A scrollable message thread that shows alternating User / Assistant messages
- Streaming support: assistant text appends token-by-token as `claudecode:data` events
  arrive; a typing indicator shows while the response is in flight
- Tool-call events (type `"tool_use"` / `"tool_result"`) rendered as a collapsible
  inline badge: shows tool name + collapsed summary, expands on click to show full
  input/output JSON
- An input bar at the bottom: multi-line textarea + "Send" button. Sends the prompt via
  `window.aios.claudeCode.spawn` (new session) or `write` (follow-up turn)
- Error display: stderr lines and `claudecode:exit` with non-zero code shown as a
  red banner
- A "New session" button that kills the current session and resets the message list

**Out:**
- Session history persistence (READY-04)
- Project/CWD selector (READY-04)
- Multi-session split-panes (future)

---

## Acceptance Criteria

1. Typing a prompt and pressing Send (or Ctrl+Enter) starts a Claude Code session and
   renders the user message immediately in the thread.
2. Assistant tokens stream in real-time — the message box grows character by character.
3. A spinner / typing indicator is visible between Send and the first token.
4. When the stream ends (`claudecode:exit` with code 0), the indicator disappears and
   the input bar is re-enabled.
5. A `tool_use` event renders a badge like `⚙ Bash • ls -la` collapsed; clicking it
   expands to show the full tool input.
6. A `tool_result` event appended after the matching `tool_use` badge shows the output.
7. A non-zero exit or a `type:"error"` event shows a red error banner above the input bar.
8. "New session" clears the thread and kills any running process.
9. The message list auto-scrolls to the bottom on new content but does not steal focus
   from the input bar while the user is typing.
10. Layout matches the existing app aesthetic (zinc-950 background, indigo accents,
    zinc-100 text, `text-[12px]` body, `text-[11px]` meta).

---

## Technical Notes

### Claude Code `--output-format stream-json` event types (subset)

Each line is a JSON object. Key types to handle:

| `type` | When | Key fields |
|--------|------|------------|
| `"system"` / `"init"` | Session start | `session_id`, `tools` |
| `"assistant"` | LLM output turn | `message.content[]` where each content item has `type: "text"` or `type: "tool_use"` |
| `"user"` | Tool results returned to model | `message.content[]` with `type: "tool_result"` |
| `"result"` | Final result | `subtype: "success" \| "error"`, `result` string |

For streaming text the content item will arrive as partial chunks — buffer them by
`tool_use` block `id` or simply append to the current assistant message.

### Suggested component structure inside `ClaudeCodeTab.tsx`

```
ClaudeCodeTab
├── SessionHeader          (cwd display + New session button)  ← READY-04 owns full version
├── MessageThread          (scrollable list of MessageBubble)
│   ├── UserBubble
│   ├── AssistantBubble    (streams text; contains ToolCallBadge children)
│   └── ToolCallBadge      (collapsible inline tool event)
├── StreamingIndicator     (animated dots, visible while session running)
└── InputBar               (textarea + Send button)
```

### State shape (inside the hook / component)

```ts
type MessageRole = 'user' | 'assistant' | 'tool';

interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;          // accumulated assistant text or user prompt
  toolName?: string;     // for role==='tool'
  toolInput?: unknown;
  toolOutput?: unknown;
  expanded?: boolean;    // for collapsible tool badges
  streaming?: boolean;   // true while this message is incomplete
}
```

### Parsing sketch

```ts
function handleLine(line: string, setMessages: ...) {
  let evt: any;
  try { evt = JSON.parse(line); } catch { return; }

  if (evt.type === 'assistant') {
    for (const item of evt.message?.content ?? []) {
      if (item.type === 'text') {
        // append to the current streaming assistant bubble
      } else if (item.type === 'tool_use') {
        // push a new tool badge message
      }
    }
  } else if (evt.type === 'user') {
    for (const item of evt.message?.content ?? []) {
      if (item.type === 'tool_result') {
        // attach output to the matching tool badge
      }
    }
  } else if (evt.type === 'result') {
    // mark streaming done; show error banner if subtype==='error'
  }
}
```

### Styling reference

- Outer container: `flex-1 flex flex-col overflow-hidden` (matches all other tab bodies)
- Message thread: `flex-1 overflow-y-auto px-6 py-4 space-y-3`
- User bubble: right-aligned, `bg-indigo-600/20 border border-indigo-500/30 rounded-2xl px-4 py-2 text-[12px]`
- Assistant bubble: left-aligned, `bg-zinc-900 border border-zinc-800 rounded-2xl px-4 py-2 text-[12px]`
- Tool badge: `inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-zinc-800 border border-zinc-700 cursor-pointer` with `⚙` icon from lucide `Wrench`
- Input bar: `border-t border-zinc-800 px-4 py-3 flex gap-2`; textarea `bg-zinc-900 border border-zinc-800 rounded-lg text-[12px] resize-none flex-1`

---

## Dependencies

- READY-01 — `ClaudeCodeTab.tsx` must exist
- READY-02 — `window.aios.claudeCode.*` must be wired in preload
