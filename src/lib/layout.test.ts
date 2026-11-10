import { beforeEach, expect, it } from "vitest";

import { DEFAULT_LAYOUT, readLayout, saveLayout } from "./layout";

beforeEach(() => localStorage.clear());

it("falls back to defaults without stored data", () => {
  expect(readLayout()).toEqual(DEFAULT_LAYOUT);
});

it.each([
  [199.5, 240.5, 1001, 200, 241, 1000],
  [601, 119, 95, 600, 120, 96],
])(
  "normalizes stored panel sizes to the settings limits",
  (sidebarWidth, terminalHeight, outputHeight, width, terminal, output) => {
    localStorage.setItem(
      "gaze:layout",
      JSON.stringify({ sidebarWidth, terminalHeight, outputHeight }),
    );
    expect(readLayout()).toEqual({
      ...DEFAULT_LAYOUT,
      sidebarWidth: width,
      terminalHeight: terminal,
      outputHeight: output,
    });
  },
);

it("round-trips panel sizes and ignores bad values", () => {
  saveLayout({ sidebarWidth: 340 });
  saveLayout({ terminalHeight: 300 });
  saveLayout({ editorSplitRatio: 0.65, gitHistorySplitRatio: 0.4 });
  expect(readLayout()).toEqual({
    ...DEFAULT_LAYOUT,
    sidebarWidth: 340,
    terminalHeight: 300,
    editorSplitRatio: 0.65,
    gitHistorySplitRatio: 0.4,
  });
  localStorage.setItem("gaze:layout", "not json");
  expect(readLayout()).toEqual(DEFAULT_LAYOUT);
  localStorage.setItem(
    "gaze:layout",
    JSON.stringify({
      sidebarWidth: -5,
      terminalHeight: "x",
      editorSplitRatio: 2,
      gitHistorySplitRatio: 2,
    }),
  );
  expect(readLayout()).toEqual(DEFAULT_LAYOUT);
});

it("persists sidebar collapse separately from its expanded width and validates old layouts", () => {
  saveLayout({ sidebarWidth: 260, sidebarCollapsed: true });
  expect(readLayout()).toMatchObject({ sidebarWidth: 260, sidebarCollapsed: true });
  saveLayout({ sidebarCollapsed: false });
  expect(readLayout()).toMatchObject({ sidebarWidth: 260, sidebarCollapsed: false });
  localStorage.setItem(
    "gaze:layout",
    JSON.stringify({ sidebarWidth: 300, sidebarCollapsed: "true" }),
  );
  expect(readLayout()).toMatchObject({ sidebarWidth: 300, sidebarCollapsed: false });
});
