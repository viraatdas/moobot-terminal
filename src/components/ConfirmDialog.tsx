import { useEffect } from "react";

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

/**
 * In-app confirmation modal. Replaces window.confirm(), which is unreliable inside the
 * Tauri (WKWebView) shell — there it can return falsy and silently cancel the action
 * (that's why Cmd+W "didn't close" tabs). Pure React, so it always works in the webview.
 */
export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest | null;
  onClose: () => void;
}) {
  const open = !!request;
  useEffect(() => {
    if (!open || !request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        request.onConfirm();
        onClose();
      }
    };
    // Capture so it pre-empts the app's global Cmd+W / shortcut handlers while open.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, request, onClose]);

  if (!open || !request) return null;
  const { title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", danger, onConfirm } = request;
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/55 px-4"
      onClick={onClose}
    >
      <div
        className="w-[440px] max-w-full rounded-sm border border-hairline bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[11px] font-semibold tracking-[0.14em] text-ink uppercase">{title}</div>
        <div className="mt-2 max-h-[50vh] overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-ink-dim">
          {body}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="h-8 rounded-sm border border-hairline px-3 text-[11px] font-semibold tracking-[0.06em] text-ink-dim uppercase hover:border-amber/40 hover:text-amber"
          >
            {cancelLabel}
          </button>
          <button
            autoFocus
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className={`h-8 rounded-sm border px-3 text-[11px] font-semibold tracking-[0.06em] uppercase ${
              danger
                ? "border-neg/50 bg-neg-dim text-neg hover:bg-neg/25"
                : "border-amber/40 bg-amber-dim text-amber hover:bg-amber/25"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
