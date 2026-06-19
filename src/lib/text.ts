export function deAiText(value: unknown): string {
  return String(value ?? "")
    .replace(/[ \t]*[\u2014\u2013][ \t]*/g, ", ")
    .replace(/\u2026/g, "...")
    .replace(/\u2212/g, "-")
    .replace(/\s+-\s+/g, " - ");
}

export function deAiMarkdown(value: unknown): string {
  return deAiText(value);
}
