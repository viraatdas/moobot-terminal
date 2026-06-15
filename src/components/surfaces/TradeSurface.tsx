import { marked } from "marked";
import { onCashtagClick } from "../../lib/cashtags";
import { Empty } from "./_shared";

/* ---------- Trade: plan markdown (proposals show in the right rail) ---------- */
export function TradeSurface({ markdown }: { markdown: string }) {
  if (!markdown)
    return (
      <Empty>
        No plan yet. Write your intent, @-reference other tabs, and the agent drafts
        proposals into your approval queue.
      </Empty>
    );
  return (
    <div className="findings min-h-0 flex-1 overflow-y-auto px-6 py-4" onClick={onCashtagClick}>
      <div dangerouslySetInnerHTML={{ __html: marked.parse(markdown) as string }} />
    </div>
  );
}
