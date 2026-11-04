/** Line-level diff used to decorate the editor with the file's local changes. */

export type ChangeKind = "added" | "modified" | "deleted";

export interface ChangeBlock {
  kind: ChangeKind;
  /** First line of the block in the current document (1-based); for `deleted` this is the insertion point. */
  from: number;
  /** Last line of the block in the current document (inclusive); `from - 1` for `deleted`. */
  to: number;
  /** First line of the block in the base document (1-based). */
  oldStart: number;
  oldLines: string[];
  newLines: string[];
}

/**
 * Give up on pathological inputs instead of spending seconds in the edit graph.
 * Each step keeps only the band `[-d, d]` of the frontier, so the whole history
 * costs (edits + 1)² Int32s — 16 MB at this limit — rather than a full copy of
 * the frontier per step.
 */
const MAX_EDITS = 2000;

type Step = { type: "equal" | "insert" | "delete"; line: string };

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

function fallback(a: string[], b: string[]): Step[] {
  return [
    ...a.map((line): Step => ({ type: "delete", line })),
    ...b.map((line): Step => ({ type: "insert", line })),
  ];
}

/** Myers' O(ND) diff over line arrays. */
function myers(a: string[], b: string[]): Step[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return fallback(a, b);
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const at = (index: number) => v[index] ?? 0;
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDITS) return fallback(a, b);
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && at(offset + k - 1) < at(offset + k + 1))) {
        x = at(offset + k + 1);
      } else {
        x = at(offset + k - 1) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  return fallback(a, b);
}

function backtrack(trace: Int32Array[], a: string[], b: string[]): Step[] {
  const steps: Step[] = [];
  const offset = a.length + b.length;
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d];
    if (!v) break;
    const bandStart = offset - d;
    const at = (index: number) => v[index - bandStart] ?? 0;
    const k = x - y;
    const previousK =
      k === -d || (k !== d && at(offset + k - 1) < at(offset + k + 1)) ? k + 1 : k - 1;
    const previousX = at(offset + previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      steps.push({ type: "equal", line: a[x - 1] ?? "" });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === previousX) {
        steps.push({ type: "insert", line: b[y - 1] ?? "" });
        y -= 1;
      } else {
        steps.push({ type: "delete", line: a[x - 1] ?? "" });
        x -= 1;
      }
    }
  }
  return steps.reverse();
}

function diffOperations(oldLines: string[], newLines: string[]): Step[] {
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start += 1;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const steps = oldLines.slice(0, start).map((line): Step => ({ type: "equal", line }));
  steps.push(...myers(oldLines.slice(start, oldEnd), newLines.slice(start, newEnd)));
  steps.push(...oldLines.slice(oldEnd).map((line): Step => ({ type: "equal", line })));
  return steps;
}

/** Groups the diff between `base` and `current` into contiguous change blocks. */
export function computeChangeBlocks(base: string, current: string): ChangeBlock[] {
  const steps = diffOperations(splitLines(base), splitLines(current));
  const blocks: ChangeBlock[] = [];
  let oldLine = 1;
  let newLine = 1;
  let pending: {
    oldStart: number;
    oldLines: string[];
    newStart: number;
    newLines: string[];
  } | null = null;
  const flush = () => {
    if (!pending) return;
    const { oldStart, oldLines, newStart, newLines } = pending;
    const kind: ChangeKind =
      oldLines.length === 0 ? "added" : newLines.length === 0 ? "deleted" : "modified";
    blocks.push({
      kind,
      from: newStart,
      to: newLines.length === 0 ? newStart - 1 : newStart + newLines.length - 1,
      oldStart,
      oldLines,
      newLines,
    });
    pending = null;
  };
  for (const step of steps) {
    if (step.type === "equal") {
      flush();
      oldLine += 1;
      newLine += 1;
      continue;
    }
    pending ??= { oldStart: oldLine, oldLines: [], newStart: newLine, newLines: [] };
    if (step.type === "delete") {
      pending.oldLines.push(step.line);
      oldLine += 1;
    } else {
      pending.newLines.push(step.line);
      newLine += 1;
    }
  }
  flush();
  return blocks;
}
