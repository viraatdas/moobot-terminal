import { useCallback, useRef, useState } from "react";
import { indexFromClientX } from "../../lib/charts";

// Owns the drag-select state machine for a line chart: a hover crosshair index
// plus an optional [start,end] range produced by dragging across the plot. The
// four pointer handlers and the drag ref live here so a host component only has
// to spread the returned handlers onto its capture <rect> and read hoverIndex /
// selection. `count` is the number of data points (used to map clientX → index).
export interface RangeSelection {
  hoverIndex: number | null;
  selection: { start: number; end: number } | null;
  // Clears all transient interaction state (call when the underlying data reloads).
  reset: () => void;
  handlers: {
    onMouseDown: (event: { clientX: number; currentTarget: Element }) => void;
    onMouseMove: (event: { clientX: number; currentTarget: Element }) => void;
    onMouseUp: () => void;
    onMouseLeave: () => void;
  };
}

export function useRangeSelection(count: number): RangeSelection {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const dragRef = useRef<{ start: number; moved: boolean } | null>(null);

  const reset = useCallback(() => {
    setHoverIndex(null);
    setSelection(null);
    dragRef.current = null;
  }, []);

  const onMouseDown = useCallback(
    (event: { clientX: number; currentTarget: Element }) => {
      const i = indexFromClientX(event.clientX, event.currentTarget.getBoundingClientRect(), count);
      dragRef.current = { start: i, moved: false };
      setSelection(null);
      setHoverIndex(i);
    },
    [count],
  );

  const onMouseMove = useCallback(
    (event: { clientX: number; currentTarget: Element }) => {
      const i = indexFromClientX(event.clientX, event.currentTarget.getBoundingClientRect(), count);
      setHoverIndex(i);
      const drag = dragRef.current;
      if (drag) {
        if (i !== drag.start) drag.moved = true;
        if (drag.moved) setSelection({ start: drag.start, end: i });
      }
    },
    [count],
  );

  const onMouseUp = useCallback(() => {
    const drag = dragRef.current;
    if (drag && !drag.moved) setSelection(null);
    dragRef.current = null;
  }, []);

  const onMouseLeave = useCallback(() => {
    const drag = dragRef.current;
    if (drag && !drag.moved) setSelection(null);
    dragRef.current = null;
    setHoverIndex(null);
  }, []);

  return {
    hoverIndex,
    selection,
    reset,
    handlers: { onMouseDown, onMouseMove, onMouseUp, onMouseLeave },
  };
}
