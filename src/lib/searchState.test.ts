import { describe, expect, it } from "vitest";

import { initialSearchState, searchReducer, type SearchState } from "./searchState";
import type { SearchHit, SearchOptions } from "./types";

const options: SearchOptions = {
  caseSensitive: false,
  regex: false,
  includeIgnored: false,
  includeHidden: false,
};

const hit = (line: number): SearchHit => ({
  projectId: "p",
  projectName: "Demo",
  path: "src/main.ts",
  line,
  preview: "needle",
  ranges: [{ start: 0, end: 6 }],
});

describe("searchReducer", () => {
  it("streams batches and pauses for explicit continuation", () => {
    let state: SearchState = searchReducer(initialSearchState, {
      type: "started",
      requestId: "r1",
      query: "needle",
      options,
    });
    state = searchReducer(state, {
      type: "event",
      event: {
        type: "batch",
        requestId: "r1",
        matches: [hit(1), hit(2)],
        received: 2,
      },
    });
    expect(state.results).toHaveLength(2);
    expect(state.status).toBe("running");

    state = searchReducer(state, {
      type: "event",
      event: { type: "paused", requestId: "r1", received: 200, hasMore: true },
    });
    expect(state.status).toBe("paused");
    expect(state.hasMore).toBe(true);

    state = searchReducer(state, { type: "resume" });
    state = searchReducer(state, {
      type: "event",
      event: { type: "done", requestId: "r1", received: 220, truncated: false },
    });
    expect(state.status).toBe("done");
    expect(state.received).toBe(220);
  });

  it("drops stale events from a cancelled request", () => {
    let state = searchReducer(initialSearchState, {
      type: "started",
      requestId: "new",
      query: "new",
      options,
    });
    state = searchReducer(state, {
      type: "event",
      event: {
        type: "batch",
        requestId: "old",
        matches: [hit(99)],
        received: 1,
      },
    });
    state = searchReducer(state, {
      type: "event",
      event: {
        type: "error",
        requestId: "old",
        code: "error",
        message: "stale",
      },
    });
    expect(state.results).toHaveLength(0);
    expect(state.status).toBe("running");
    expect(state.error).toBeNull();
  });

  it("ignores queued events from the previous request while debouncing", () => {
    let state = searchReducer(initialSearchState, {
      type: "started",
      requestId: "old",
      query: "old",
      options,
    });
    state = searchReducer(state, { type: "waiting" });
    state = searchReducer(state, {
      type: "event",
      event: {
        type: "batch",
        requestId: "old",
        matches: [hit(1)],
        received: 1,
      },
    });
    expect(state.results).toHaveLength(0);
    expect(state.requestId).toBeNull();
  });

  it("shows errors and truncation without inventing more pages", () => {
    let state = searchReducer(initialSearchState, {
      type: "started",
      requestId: "r",
      query: "x",
      options,
    });
    state = searchReducer(state, {
      type: "event",
      event: { type: "done", requestId: "r", received: 5000, truncated: true },
    });
    expect(state.truncated).toBe(true);
    expect(state.hasMore).toBe(false);

    state = searchReducer(state, {
      type: "event",
      event: {
        type: "error",
        requestId: "r",
        code: "toolMissing",
        message: "no rg",
      },
    });
    expect(state.status).toBe("error");
    expect(state.error).toBe("no rg");
  });
});
