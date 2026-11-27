export function detectIndentation(text: string, fallback: number): string {
  // shortcut: infer from whitespace; use syntax-aware detection if mixed indentation needs exact handling.
  const widths = new Map<number, number>();
  let previous = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*\*/.test(line)) continue;
    const prefix = /^[\t ]*/.exec(line)![0];
    if (prefix.startsWith("\t")) return "\t";
    const increase = prefix.length - previous;
    if (increase > 0 && increase <= 8) widths.set(increase, (widths.get(increase) ?? 0) + 1);
    previous = prefix.length;
  }
  const width = [...widths].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? fallback;
  return " ".repeat(width);
}
