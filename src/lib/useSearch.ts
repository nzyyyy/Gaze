import { useCallback, useEffect, useReducer, useRef } from "react";

import { api } from "./api";
import { initialSearchState, searchReducer } from "./searchState";
import type { SearchOptions } from "./types";
import { errorMessage } from "./utils";

const SEARCH_DEBOUNCE_MS = 280;

interface UseSearchArgs {
  query: string;
  options: SearchOptions;
  enabled: boolean;
}

export function useSearch({ query, options, enabled }: UseSearchArgs) {
  const [state, dispatch] = useReducer(searchReducer, initialSearchState);
  const activeRequest = useRef<string | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    api
      .onSearchEvent((event) => dispatch({ type: "event", event }))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
      const current = activeRequest.current;
      if (current) void api.cancelSearch(current).catch(() => undefined);
    };
  }, []);

  const run = useCallback(
    async (nextQuery: string, nextOptions: SearchOptions) => {
      const previous = activeRequest.current;
      if (previous) {
        activeRequest.current = null;
        void api.cancelSearch(previous).catch(() => undefined);
      }
      if (!enabled || nextQuery.trim().length === 0) {
        dispatch({ type: "reset" });
        return;
      }
      const requestId = crypto.randomUUID();
      activeRequest.current = requestId;
      dispatch({
        type: "started",
        requestId,
        query: nextQuery,
        options: nextOptions,
      });
      try {
        await api.startSearch(requestId, nextQuery, nextOptions);
      } catch (error) {
        if (activeRequest.current === requestId) {
          activeRequest.current = null;
          dispatch({ type: "error", requestId, message: errorMessage(error) });
        }
      }
    },
    [enabled],
  );

  useEffect(() => {
    if (!enabled) {
      dispatch({ type: "reset" });
      return;
    }
    if (query.trim().length === 0) {
      const current = activeRequest.current;
      if (current) void api.cancelSearch(current).catch(() => undefined);
      activeRequest.current = null;
      dispatch({ type: "reset" });
      return;
    }
    const current = activeRequest.current;
    if (current) void api.cancelSearch(current).catch(() => undefined);
    activeRequest.current = null;
    dispatch({ type: "waiting" });
    const timer = window.setTimeout(() => {
      void run(query, options);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, options, query, run]);

  const loadMore = useCallback(() => {
    const requestId = activeRequest.current;
    if (!requestId) return;
    dispatch({ type: "resume" });
    api.continueSearch(requestId).catch((error: unknown) => {
      dispatch({
        type: "error",
        requestId,
        message: errorMessage(error),
      });
    });
  }, []);

  const cancel = useCallback(() => {
    const requestId = activeRequest.current;
    if (requestId) void api.cancelSearch(requestId).catch(() => undefined);
    activeRequest.current = null;
    dispatch({ type: "reset" });
  }, []);

  const retry = useCallback(() => {
    if (!query.trim()) return;
    void run(query, optionsRef.current);
  }, [query, run]);

  return { state, loadMore, cancel, retry };
}
