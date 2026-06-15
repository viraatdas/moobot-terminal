// Low-level SVG chart geometry helpers shared across price/equity line surfaces
// (SymbolChart, PortfolioPerformanceModal, StrategySurface's EquityChart). These
// are the truly-identical primitives only — each surface keeps its OWN domain /
// bounds policy (SymbolChart uses a raw low/high domain with no padding, while
// the equity surfaces pad ~8%) and its own crosshair/overlay JSX.

// Map a value within [min, max] to a y-pixel (SVG origin is top-left, so larger
// values map nearer the top). Collapses to the vertical center when the domain
// is degenerate (max <= min) to avoid divide-by-zero / NaN.
export function scale(value: number, min: number, max: number, size: number): number {
  if (max <= min) return size / 2;
  return size - ((value - min) / (max - min)) * size;
}

// Close a line path into a filled area by dropping to the baseline at both ends.
export function areaFor(linePath: string, width: number, height: number): string {
  if (!linePath) return "";
  return `${linePath} L${width} ${height} L0 ${height} Z`;
}

// Convert a pointer clientX into the nearest data index given the element's
// bounding rect and the number of points. Returns 0 when there is at most one
// point (nothing to interpolate across).
export function indexFromClientX(clientX: number, rect: DOMRect, count: number): number {
  if (count <= 1) return 0;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return Math.round(ratio * (count - 1));
}
