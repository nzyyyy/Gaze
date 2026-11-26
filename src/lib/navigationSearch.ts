import type { TextPosition } from "./types";

export function parseFileQuery(query: string): { path: string; position?: TextPosition } {
  const path = query.trim();
  const suffix = /^(.+?):([0-9]+)(?::([0-9]+))?$/.exec(path);
  if (!suffix) return { path };
  const line = Number(suffix[2]);
  const column = Number(suffix[3] ?? "1");
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1)
    return { path };
  return { path: suffix[1]!, position: { line: line - 1, character: column - 1 } };
}

export function matchesNavigationQuery(label: string, query: string) {
  const normalized = label.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => normalized.includes(word));
}
