import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import { Loader2, SendHorizontal } from "lucide-react";
import { client, type ResearchTab } from "../../lib/client";
import { onCashtagClick } from "../../lib/cashtags";

export function ChatSurface({
  tab,
  markdown,
  onChanged,
}: {
  tab: ResearchTab;
  markdown: string;
  onChanged: () => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const running = tab.lastRunStatus === "running";
  const html = useMemo(() => marked.parse(markdown || "") as string, [markdown]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [markdown]);

  async function send() {
    const text = message.trim();
    if (!text || busy || running) return;
    setBusy(true);
    setError(null);
    try {
      const stamp = new Date().toISOString();
      const entry = `USER (${stamp}):\n${text}`;
      const nextNotes = [tab.notes?.trim(), entry].filter(Boolean).join("\n\n");
      const nextTopic = tab.topic && tab.topic !== "Chat" ? tab.topic : text.slice(0, 90);
      await client.request("research.update", {
        id: tab.id,
        notes: nextNotes,
        topic: nextTopic,
      });
      setMessage("");
      onChanged();
      await client.request("research.run", { id: tab.id });
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="findings min-h-0 flex-1 overflow-y-auto px-6 py-4"
        onClick={onCashtagClick}
      >
        {markdown ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <div className="flex h-full items-center justify-center text-center text-[12px] text-ink-faint">
            {running ? "Thinking…" : "No chat transcript yet."}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-hairline bg-panel px-5 py-3">
        {error && <div className="mb-2 text-[11px] text-neg">{error}</div>}
        <div className="flex items-end gap-2">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder="Ask about your book, a ticker, a venue, or a tab…"
            disabled={busy || running}
            className="min-h-11 flex-1 resize-none rounded-sm border border-hairline bg-bg px-3 py-2 text-[12px] leading-snug text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!message.trim() || busy || running}
            className="flex h-11 items-center gap-1.5 rounded-sm border border-amber/40 bg-amber-dim px-3 text-[11px] font-semibold text-amber uppercase hover:bg-amber/25 disabled:opacity-40"
            title="Send"
          >
            {busy || running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <SendHorizontal className="h-3.5 w-3.5" />
            )}
            {busy || running ? "Running" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
