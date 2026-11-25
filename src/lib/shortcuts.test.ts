import { expect, it } from "vitest";

import {
  SHORTCUT_COMMANDS,
  matchShortcut,
  normalizeShortcut,
  resolveShortcuts,
  shortcutConflicts,
  shortcutFromEvent,
  shortcutLabel,
  shortcutNeedsModifier,
} from "./shortcuts";

it("ships IDEA macOS defaults that are valid and free of conflicts", () => {
  const bindings = resolveShortcuts({});
  for (const command of SHORTCUT_COMMANDS) {
    const key = bindings[command.id];
    if (key) expect(normalizeShortcut(key), command.id).toBe(key);
  }
  expect(shortcutConflicts(bindings)).toEqual([]);
});

it("keeps ⌘C for copying a file and follows IDEA for the rest", () => {
  const bindings = resolveShortcuts({});
  expect(bindings).toMatchObject({
    settings: "Mod+Comma",
    "copy-file": "Mod+KeyC",
    "paste-file": "Mod+KeyV",
    terminal: "Ctrl+Backquote",
    "quick-open": "Mod+Shift+KeyO",
    "open-file": "Mod+KeyO",
    definition: "Mod+KeyB",
    references: "Alt+F7",
    implementation: "Mod+Alt+KeyB",
    back: "Mod+BracketLeft",
    forward: "Mod+BracketRight",
    git: "Mod+Digit9",
    rename: "Shift+F6",
    "organize-imports": "Mod+Ctrl+Alt+KeyO",
    "parameter-info": "Mod+KeyP",
    "extend-selection": "Alt+ArrowUp",
    "shrink-selection": "Alt+ArrowDown",
  });
  expect(bindings.quit).toBe("Mod+KeyQ");
});

it("lets an override replace or remove a default, and ignores unknown or invalid values", () => {
  const bindings = resolveShortcuts({
    save: "Mod+Shift+KeyS",
    quit: "",
    find: "Nonsense+KeyF",
    unknown: "Mod+KeyU",
  });
  expect(bindings.save).toBe("Mod+Shift+KeyS");
  expect(bindings.quit).toBeNull();
  expect(bindings.find).toBeNull();
  expect(bindings.settings).toBe("Mod+Comma");
  expect(bindings.unknown).toBeUndefined();
});

it("keeps Ctrl and Mod as distinct keys", () => {
  expect(normalizeShortcut("Ctrl+KeyS")).toBe("Ctrl+KeyS");
  expect(normalizeShortcut("Shift+Mod+KeyS")).toBe("Mod+Shift+KeyS");
  expect(normalizeShortcut("KeyS+Mod")).toBeNull();
  expect(normalizeShortcut("Escape")).toBeNull();
  expect(shortcutFromEvent({ code: "KeyS", key: "s", metaKey: true, ctrlKey: true })).toBe(
    "Mod+Ctrl+KeyS",
  );
});

it("matches key events by their physical key and exact modifiers", () => {
  const bindings = { save: "Mod+KeyS", "copy-file": "Mod+KeyC", definition: "Mod+KeyB" };
  expect(
    matchShortcut(
      new KeyboardEvent("keydown", { code: "KeyS", key: "s", metaKey: true }),
      bindings,
    ),
  ).toBe("save");
  expect(
    matchShortcut(
      new KeyboardEvent("keydown", { code: "KeyS", key: "S", metaKey: true, shiftKey: true }),
      bindings,
    ),
  ).toBeNull();
  expect(
    matchShortcut(
      new KeyboardEvent("keydown", { code: "KeyS", key: "s", ctrlKey: true }),
      bindings,
    ),
  ).toBeNull();
  expect(
    matchShortcut(new KeyboardEvent("keydown", { code: "KeyS", key: "s" }), bindings),
  ).toBeNull();
  expect(shortcutFromEvent({ code: "F7", key: "F7", altKey: true })).toBe("Alt+F7");
  expect(shortcutFromEvent({ code: "", key: "q", ctrlKey: true })).toBe("Ctrl+KeyQ");
  expect(shortcutFromEvent({ code: "", key: "4", ctrlKey: true, metaKey: true })).toBe(
    "Mod+Ctrl+Digit4",
  );
});

it("formats shortcuts for menus and tooltips", () => {
  expect(shortcutLabel("Mod+Shift+KeyO")).toBe("⇧⌘O");
  expect(shortcutLabel("Mod+Ctrl+Alt+KeyO")).toBe("⌃⌥⌘O");
  expect(shortcutLabel("Mod+Digit9")).toBe("⌘9");
  expect(shortcutLabel("Mod+BracketLeft")).toBe("⌘[");
  expect(shortcutLabel("Mod+Comma")).toBe("⌘,");
  expect(shortcutLabel("Ctrl+Backquote")).toBe("⌃`");
  expect(shortcutLabel("Mod+Backspace")).toBe("⌘⌫");
  expect(shortcutLabel("Alt+Enter")).toBe("⌥⏎");
  expect(shortcutLabel("Shift+F6")).toBe("⇧F6");
  expect(shortcutLabel(null)).toBe("未设置");
});

it("reports shared keys and modifier requirements", () => {
  expect(
    shortcutConflicts({ save: "Mod+KeyA", find: "Mod+KeyA", quit: "Mod+KeyA", git: "Mod+KeyB" }),
  ).toEqual([["Mod+KeyA", ["save", "quit", "find"]]]);
  expect(shortcutNeedsModifier("Mod+KeyA")).toBe(false);
  expect(shortcutNeedsModifier("F5")).toBe(false);
  expect(shortcutNeedsModifier("KeyA")).toBe(true);
  expect(shortcutNeedsModifier("Shift+KeyA")).toBe(true);
  expect(shortcutNeedsModifier("Shift+F6")).toBe(false);
  expect(resolveShortcuts({ save: "Shift+KeyA" }).save).toBeNull();
});
