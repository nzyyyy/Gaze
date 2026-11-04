import { beforeEach, expect, it } from "vitest";

import { EMPTY_SESSION, readSession, saveSession, sessionTabKey } from "./session";

beforeEach(() => localStorage.clear());

it("falls back to an empty session for missing, malformed or versioned data", () => {
  expect(readSession()).toEqual(EMPTY_SESSION);
  localStorage.setItem("gaze:session", "not json");
  expect(readSession()).toEqual(EMPTY_SESSION);
  localStorage.setItem("gaze:session", JSON.stringify({ version: 2, tabs: [{}] }));
  expect(readSession()).toEqual(EMPTY_SESSION);
});

it("merges valid session patches and filters unsafe or invalid entries", () => {
  const tabs = [
    { projectId: "p1", path: "src/a.ts" },
    { projectId: "external:temp", path: "outside.ts" },
    { projectId: "p2", path: "" },
  ];
  saveSession({
    tabs,
    active: tabs[0],
    views: {
      "p1\u0000src/a.ts": { line: 2, character: 4, scrollTop: 30 },
      broken: { line: -1, character: 0, scrollTop: 0 },
    },
  });
  saveSession({ tree: { openProjects: ["p1"], expandedDirectories: ["p1\u0000src"] } });
  expect(readSession()).toEqual({
    version: 1,
    tabs: [{ ...tabs[0], pane: "primary" }],
    active: { ...tabs[0], pane: "primary" },
    paneActive: { primary: null, secondary: null },
    activePane: "primary",
    splitOpen: false,
    views: { "p1\u0000src/a.ts": { line: 2, character: 4, scrollTop: 30 } },
    tree: { openProjects: ["p1"], expandedDirectories: ["p1\u0000src"] },
  });
  expect(sessionTabKey(tabs[0]!)).toBe("p1\u0000src/a.ts");
});

it("validates each pane selection and reads older sessions without pane selections", () => {
  saveSession({
    paneActive: {
      primary: { projectId: "p1", path: "a.ts" },
      secondary: { projectId: "external:temp", path: "b.ts" },
    },
  });
  expect(readSession().paneActive).toEqual({
    primary: { projectId: "p1", path: "a.ts", pane: "primary" },
    secondary: null,
  });
  localStorage.setItem(
    "gaze:session",
    JSON.stringify({ version: 1, paneActive: { primary: null, secondary: 123 } }),
  );
  expect(readSession().paneActive).toEqual({ primary: null, secondary: null });
});
