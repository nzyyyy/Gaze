import type { SearchEvent, SearchHit, SearchOptions } from "./types";

export type SearchStatus = "idle" | "waiting" | "running" | "paused" | "done" | "error";

export interface SearchState {
  requestId: string | null;
  query: string;
  options: SearchOptions | null;
  status: SearchStatus;
  results: SearchHit[];
  received: number;
  hasMore: boolean;
  truncated: boolean;
  error: string | null;
}

export type SearchAction =
  | { type: "reset" }
  | { type: "waiting" }
  | { type: "started"; requestId: string; query: string; options: SearchOptions }
  | { type: "event"; event: SearchEvent }
  | { type: "resume" }
  | { type: "error"; requestId: string; message: string };

export const initialSearchState: SearchState = {
  requestId: null,
  query: "",
  options: null,
  status: "idle",
  results: [],
  received: 0,
  hasMore: false,
  truncated: false,
  error: null,
};

export function searchReducer(state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case "reset":
      return initialSearchState;
    case "waiting":
      return {
        ...state,
        requestId: null,
        status: "waiting",
        results: [],
        received: 0,
        hasMore: false,
        truncated: false,
        error: null,
      };
    case "started":
      return {
        requestId: action.requestId,
        query: action.query,
        options: action.options,
        status: "running",
        results: [],
        received: 0,
        hasMore: false,
        truncated: false,
        error: null,
      };
    case "resume":
      return state.status === "paused" ? { ...state, status: "running" } : state;
    case "error":
      if (state.requestId !== action.requestId) return state;
      return { ...state, status: "error", error: action.message };
    case "event": {
      const event = action.event;
      if (!state.requestId || event.requestId !== state.requestId) return state;
      switch (event.type) {
        case "batch":
          return {
            ...state,
            status: "running",
            results: [...state.results, ...event.matches],
            received: event.received,
          };
        case "paused":
          return {
            ...state,
            status: "paused",
            received: event.received,
            hasMore: event.hasMore,
          };
        case "done":
          return {
            ...state,
            status: "done",
            received: event.received,
            hasMore: false,
            truncated: event.truncated,
          };
        case "error":
          return { ...state, status: "error", error: event.message, hasMore: false };
      }
    }
  }
}
