import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import { Loader2, SendHorizontal } from "lucide-react";
import { client, type ResearchTab } from "../../lib/client";
import { onCashtagClick } from "../../lib/cashtags";
import { deAiMarkdown, deAiText } from "../../lib/text";

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
  const html = useMemo(() => marked.parse(deAiMarkdown(markdown)) as string, [markdown]);

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
      setError(deAiText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <div
        ref={scrollRef}
        className="chat-findings min-h-0 flex-1 overflow-y-auto px-5 py-5"
        onClick={onCashtagClick}
      >
        {markdown ? (
          <div className="mx-auto max-w-3xl" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center text-center">
            <div className="grid h-10 w-10 place-items-center rounded-sm border border-hairline bg-panel text-amber">
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
            </div>
            <div className="mt-3 text-[13px] font-semibold text-ink">
              {running ? "Working on it" : "Ask across your connected sources"}
            </div>
            <div className="mt-1 text-[12px] leading-relaxed text-ink-faint">
              Portfolio, positions, live venues, research tabs, and web context are available from one chat.
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-hairline bg-panel/95 px-5 py-3">
        <div className="mx-auto max-w-3xl">
          {error && (
            <div className="mb-2 rounded-sm border border-neg/30 bg-neg-dim px-2 py-1.5 text-[11px] text-neg">
              {error}
            </div>
          )}
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
              placeholder="Ask about your book, a ticker, a venue, or a tab..."
              disabled={busy || running}
              className="min-h-12 flex-1 resize-none rounded-sm border border-hairline bg-bg px-3 py-2.5 text-[12px] leading-snug text-ink shadow-inner placeholder:text-ink-faint focus:border-amber/50 focus:outline-none disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!message.trim() || busy || running}
              className="grid h-12 w-12 shrink-0 place-items-center rounded-sm border border-amber/40 bg-amber-dim text-amber hover:bg-amber/25 disabled:opacity-40"
              title="Send"
            >
              {busy || running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <SendHorizontal className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
