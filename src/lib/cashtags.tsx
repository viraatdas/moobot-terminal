import { marked } from "marked";

// $TICKER detection - a $ followed by 1-6 letters (so "$122" / "$5.31" don't match).
const CASHTAG_RE = /\$([A-Za-z]{1,6})\b/g;

/** Fire a global event so any surface can open the chain for a clicked ticker. */
export function openTicker(symbol: string) {
  window.dispatchEvent(new CustomEvent("moobot:ticker", { detail: symbol.toUpperCase() }));
}

/** Render plain text with $TICKERs as clickable amber pills. */
export function Cashtags({ text }: { text: string | undefined | null }) {
  if (!text) return null;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  CASHTAG_RE.lastIndex = 0;
  while ((m = CASHTAG_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const sym = m[1].toUpperCase();
    out.push(
      <button
        key={`${m.index}-${sym}`}
        className="cashtag"
        onClick={(e) => {
          e.stopPropagation();
          openTicker(sym);
        }}
      >
        ${sym}
      </button>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

let registered = false;
/** Register a marked inline extension so $TICKERs in markdown render as pills. */
export function registerCashtagExtension() {
  if (registered) return;
  registered = true;
  marked.use({
    extensions: [
      {
        name: "cashtag",
        level: "inline",
        start(src: string) {
          const i = src.indexOf("$");
          return i < 0 ? undefined : i;
        },
        tokenizer(src: string) {
          const m = /^\$([A-Za-z]{1,6})\b/.exec(src);
          if (m) return { type: "cashtag", raw: m[0], sym: m[1].toUpperCase() } as any;
          return undefined;
        },
        renderer(token: any) {
          return `<button class="cashtag" data-ticker="${token.sym}">$${token.sym}</button>`;
        },
      },
    ],
  });
}

/** Event delegation for cashtag pills inside dangerouslySetInnerHTML markdown. */
export function onCashtagClick(e: React.MouseEvent) {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-ticker]");
  if (el?.dataset.ticker) {
    e.stopPropagation();
    openTicker(el.dataset.ticker);
  }
}
