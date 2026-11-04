import type { EditorPane } from "./types";
import { tabKey } from "./utils";

const KEY = "gaze:session";

export interface SessionTab {
  projectId: string;
  path: string;
  pane?: EditorPane;
}

export interface EditorViewState {
  line: number;
  character: number;
  scrollTop: number;
}

export interface WorkspaceSession {
  version: 1;
  tabs: SessionTab[];
  active: SessionTab | null;
  paneActive: Record<EditorPane, SessionTab | null>;
  activePane: EditorPane;
  splitOpen: boolean;
  views: Record<string, EditorViewState>;
  tree: {
    openProjects: string[];
    expandedDirectories: string[];
  };
}

export const EMPTY_SESSION: WorkspaceSession = {
  version: 1,
  tabs: [],
  active: null,
  paneActive: { primary: null, secondary: null },
  activePane: "primary",
  splitOpen: false,
  views: {},
  tree: { openProjects: [], expandedDirectories: [] },
};

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function storedTab(value: unknown): SessionTab | null {
  if (!value || typeof value !== "object") return null;
  const tab = value as Partial<SessionTab>;
  return typeof tab.projectId === "string" &&
    tab.projectId.length > 0 &&
    !tab.projectId.startsWith("external:") &&
    typeof tab.path === "string" &&
    tab.path.length > 0
    ? {
        projectId: tab.projectId,
        path: tab.path,
        pane: tab.pane === "secondary" ? "secondary" : "primary",
      }
    : null;
}

function storedView(value: unknown): EditorViewState | null {
  if (!value || typeof value !== "object") return null;
  const view = value as Partial<EditorViewState>;
  return [view.line, view.character, view.scrollTop].every(
    (item) => typeof item === "number" && Number.isFinite(item) && item >= 0,
  )
    ? { line: view.line!, character: view.character!, scrollTop: view.scrollTop! }
    : null;
}

export function readSession(): WorkspaceSession {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<WorkspaceSession>;
    if (stored.version !== 1) return EMPTY_SESSION;
    const tree = stored.tree as Partial<WorkspaceSession["tree"]> | undefined;
    return {
      version: 1,
      tabs: Array.isArray(stored.tabs)
        ? stored.tabs.map(storedTab).filter((tab): tab is SessionTab => tab !== null)
        : [],
      active: storedTab(stored.active),
      paneActive: {
        primary: storedTab(stored.paneActive?.primary),
        secondary: storedTab(stored.paneActive?.secondary),
      },
      activePane: stored.activePane === "secondary" ? "secondary" : "primary",
      splitOpen: stored.splitOpen === true,
      views: Object.fromEntries(
        Object.entries(stored.views ?? {})
          .map(([key, value]) => [key, storedView(value)] as const)
          .filter((entry): entry is [string, EditorViewState] => entry[1] !== null),
      ),
      tree: {
        openProjects: strings(tree?.openProjects),
        expandedDirectories: strings(tree?.expandedDirectories),
      },
    };
  } catch {
    return EMPTY_SESSION;
  }
}

export function saveSession(patch: Partial<Omit<WorkspaceSession, "version">>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readSession(), ...patch, version: 1 }));
  } catch {
    // Session restoration is a convenience; storage failures must not break editing.
  }
}

export function sessionTabKey(tab: SessionTab) {
  return tabKey(tab.projectId, tab.path);
}
