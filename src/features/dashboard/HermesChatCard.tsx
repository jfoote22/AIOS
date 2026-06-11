import { useEffect, useRef, useState } from "react";
import { Feather, Send, Loader2, Settings as SettingsIcon } from "lucide-react";
import { cn } from "@/ui";
import { apiUrl, initApiBase } from "@/lib/apiBase";
import { navigateTo } from "@/lib/navigate";
import { useExternalInputSync } from "@/lib/useExternalInputSync";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Compact Hermes chat for the top of the dashboard. Reuses HermesTab's exact
 * backend contracts (/api/hermes/config + /api/hermes/chat) — a second instance
 * is safe (stateless one-shot fetch, independent local history). Deliberately a
 * fresh component (not the whole HermesTab) so it sizes to a card and doesn't
 * double-run the cron manager.
 */
export default function HermesChatCard() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [model, setModel] = useState("hermes-mac");
  const [baseUrl, setBaseUrl] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const canUse = !!baseUrl.trim() && hasApiKey;

  useEffect(() => {
    const loadConfig = async () => {
      try {
        await initApiBase();
        const r = await fetch(apiUrl("/api/hermes/config"));
        const cfg = await r.json();
        if (cfg.baseUrl) setBaseUrl(cfg.baseUrl);
        if (cfg.model) setModel(cfg.model);
        setHasApiKey(!!cfg.hasApiKey);
      } catch {
        /* leave defaults — card shows the configure hint */
      }
    };
    loadConfig();
    window.addEventListener("aios:hermes-config-changed", loadConfig);
    return () => window.removeEventListener("aios:hermes-config-changed", loadConfig);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  // Adopt text injected by dictation tools (e.g. Wispr Flow) that write the
  // DOM value directly and bypass React's onChange.
  useExternalInputSync(inputRef, input, setInput);

  const send = async () => {
    // Read the live DOM value, not just state — a dictation tool may have
    // injected text moments ago that the sync hook hasn't adopted yet.
    const text = (inputRef.current?.value ?? input).trim();
    if (!text || sending || !canUse) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setInput("");
    if (inputRef.current) inputRef.current.value = "";
    setSending(true);
    // Return the cursor to the field right away (clicking Send moves focus to
    // the button); the field stays enabled while Hermes responds.
    requestAnimationFrame(() => inputRef.current?.focus());
    try {
      await initApiBase();
      const res = await fetch(apiUrl("/api/hermes/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model.trim(), messages: next }),
      });
      const data = await res.json();
      setMessages((m) => [...m, { role: "assistant", content: data.content || "(empty response)" }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: `Error: ${(e as Error)?.message || String(e)}` }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="rounded-[var(--radius-xl)] border border-line bg-surface flex flex-col overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 h-12 border-b border-line-subtle shrink-0">
        <div className="w-7 h-7 rounded-[var(--radius-md)] flex items-center justify-center shrink-0" style={{ backgroundImage: "var(--gradient-brand)" }}>
          <Feather className="w-4 h-4 text-white" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink leading-none">Hermes</h2>
          <p className="text-[10px] text-ink-3 mt-0.5">{canUse ? `Gateway · ${model}` : "Gateway not configured"}</p>
        </div>
        <span className={cn("ml-auto w-2 h-2 rounded-full", canUse ? "bg-success" : "bg-ink-4")} title={canUse ? "Connected" : "Not configured"} />
      </div>

      <div ref={scrollRef} className="h-[300px] overflow-y-auto scrollbar-thin px-4 py-3 space-y-3">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 text-ink-3">
            <Feather className="w-6 h-6 text-ink-4" />
            <p className="text-sm">Chat with your Hermes gateway</p>
            <p className="text-xs text-ink-4 max-w-xs">Ask it to run tasks, draft jobs, or reach your remote agents.</p>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-[var(--radius-lg)] px-3 py-2 text-sm whitespace-pre-wrap break-words",
                  m.role === "user" ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2 border border-line",
                )}
              >
                {m.content}
              </div>
            </div>
          ))
        )}
        {sending && (
          <div className="flex justify-start">
            <div className="rounded-[var(--radius-lg)] bg-surface-2 border border-line px-3 py-2">
              <Loader2 className="w-4 h-4 animate-spin text-ink-3" />
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-line-subtle p-2.5 shrink-0">
        {!hasApiKey && (
          <button
            onClick={() => navigateTo("settings")}
            className="focus-ring w-full mb-2 flex items-center justify-center gap-1.5 text-xs text-warning-ink bg-warning-soft border border-warning/30 rounded-[var(--radius-md)] py-1.5"
          >
            <SettingsIcon className="w-3.5 h-3.5" /> Configure the Hermes gateway in Settings
          </button>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={canUse ? "Message Hermes…" : "Configure the gateway to chat"}
            disabled={!canUse}
            className="flex-1 resize-none max-h-28 bg-surface-2 border border-line rounded-[var(--radius-md)] px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus-ring focus:border-accent disabled:opacity-50 scrollbar-thin"
          />
          <button
            onClick={send}
            disabled={sending || !input.trim() || !canUse}
            aria-label="Send to Hermes"
            style={{ backgroundImage: "var(--gradient-brand)" }}
            className="focus-ring h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-[var(--radius-md)] text-white shadow-[var(--glow-accent)] disabled:opacity-40 disabled:shadow-none transition-opacity"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </section>
  );
}
