import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const cssFiles = [
  "src/styles.css",
  "src/components/fileTree/FileTree.css",
  "src/components/common/ContextMenu.css",
  "src/components/editor/editor.css",
  "src/components/settings/SettingsDialog.css",
  "src/components/search/SearchPanel.css",
  "src/components/navigation/QuickOpen.css",
  "src/components/navigation/SymbolPanel.css",
  "src/components/navigation/ReferencePanel.css",
  "src/components/navigation/CodeLocationPreview.css",
  "src/components/navigation/LocationPicker.css",
  "src/components/terminal/TerminalPanel.css",
  "src/components/fileTree/FileOperationDialog.css",
  "src/App.css",
];
const css = cssFiles.map((file) => readFileSync(file, "utf8")).join("\n");
const gitCss = readFileSync("src/git/styles.css", "utf8");

const style = document.createElement("style");

afterEach(() => {
  style.remove();
  document.body.replaceChildren();
  delete document.documentElement.dataset.overlayGlass;
});

function applyStyles(state: "enabled" | "disabled", reduceTransparency = false) {
  document.documentElement.dataset.overlayGlass = state;
  style.textContent = css + gitCss;
  document.head.append(style);
  // jsdom does not evaluate media queries; activate only the requested preference.
  style.textContent = Array.from(style.sheet!.cssRules, (rule) => {
    if (rule instanceof CSSMediaRule) {
      return reduceTransparency && rule.conditionText === "(prefers-reduced-transparency: reduce)"
        ? Array.from(rule.cssRules, (child) => child.cssText).join("\n")
        : "";
    }
    return rule.cssText;
  }).join("\n");
  return getComputedStyle(document.documentElement);
}

it("turns off transparency and blur when glass is disabled", () => {
  const root = applyStyles("disabled");
  expect(root.getPropertyValue("--popover-material")).toBe("var(--surface-raised)");
  expect(root.getPropertyValue("--overlay-glass-filter")).toBe("none");
  document.body.innerHTML =
    '<div class="palette-backdrop"></div><div class="dialog-backdrop"></div>';
  for (const backdrop of document.body.children) {
    expect(getComputedStyle(backdrop).getPropertyValue("backdrop-filter")).toBe("none");
  }
});

it("gives code hovers and other overlays the same glass background layer", () => {
  const root = applyStyles("enabled");
  expect(root.getPropertyValue("--popover-material")).toContain("var(--overlay-glass-opacity)");
  expect(root.getPropertyValue("--overlay-glass-filter")).toBe("blur(12px)");
  document.body.innerHTML = `<div class="gaze-git-workspace">
    <div class="quick-open"></div><dialog class="settings-dialog"></dialog>
    <div class="cm-tooltip code-hover"></div><div class="operation-toast"></div>
  </div>`;
  const rules = Array.from(style.sheet!.cssRules);
  for (const overlay of document.body.firstElementChild!.children) {
    expect(getComputedStyle(overlay).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(overlay).getPropertyValue("backdrop-filter")).toBe("none");
    const background = rules.find(
      (rule): rule is CSSStyleRule =>
        rule instanceof CSSStyleRule &&
        rule.selectorText.endsWith("::before") &&
        overlay.matches(rule.selectorText.slice(0, -"::before".length)),
    );
    expect(background?.style.getPropertyValue("background")).toBe("var(--popover-material)");
    expect(background?.style.getPropertyValue("backdrop-filter")).toBe(
      "var(--overlay-glass-filter)",
    );
  }
});

it("clips the select frame and scrolls its items inside the glass background", () => {
  applyStyles("enabled");
  document.body.innerHTML =
    '<div class="app-select-options"><ul class="app-select-items"><li>Python</li></ul></div>';
  const frame = document.body.firstElementChild!;
  const list = frame.firstElementChild!;
  expect(getComputedStyle(frame).overflow).toBe("hidden");
  expect(getComputedStyle(list).overflow).toBe("hidden auto");
  const backgrounds = Array.from(style.sheet!.cssRules)
    .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
    .filter((rule) => rule.selectorText.endsWith("::before"))
    .map((rule) => rule.selectorText.slice(0, -8));
  expect(backgrounds.some((selector) => frame.matches(selector))).toBe(true);
  expect(backgrounds.some((selector) => list.matches(selector))).toBe(false);
});

it("honors reduced transparency even when glass is enabled", () => {
  const root = applyStyles("enabled", true);
  expect(root.getPropertyValue("--popover-material")).toBe("var(--surface-raised)");
  expect(root.getPropertyValue("--overlay-glass-filter")).toBe("none");
});

it("keeps Chinese and English controls on one line with the same size rules", () => {
  applyStyles("disabled");
  document.body.innerHTML = [
    ["关闭右侧", "预览", "替换", "隐藏", "全局搜索"],
    ["Close to the Right", "Preview", "Replace", "Hidden", "Search workspace"],
  ]
    .map(
      ([close, preview, replace, hidden, heading]) => `
      <section style="width: 200px">
        <div class="file-tree-menu"><button>${close}</button></div>
        <div class="replace-actions">
          <button class="button button-small">${preview}</button>
          <button class="button button-small">${replace}</button>
        </div>
        <button class="option-toggle option-text">${hidden}</button>
        <div class="pane-heading"><span>${heading}</span><button>+</button></div>
        <div class="pane-message"><span>${"long/path/".repeat(30)}</span></div>
      </section>`,
    )
    .join("");
  for (const section of document.body.children) {
    const menu = getComputedStyle(section.querySelector(".file-tree-menu button")!);
    expect(menu.whiteSpace).toBe("nowrap");
    expect(menu.height).toBe("32px");
    const actions = getComputedStyle(section.querySelector(".replace-actions")!);
    expect(actions.display).toBe("grid");
    expect(actions.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    for (const button of section.querySelectorAll(".replace-actions button")) {
      expect(getComputedStyle(button).whiteSpace).toBe("nowrap");
      expect(getComputedStyle(button).height).toBe("26px");
    }
    expect(getComputedStyle(section.querySelector(".option-text")!).width).toBe("56px");
    const heading = getComputedStyle(section.querySelector(".pane-heading span")!);
    expect(heading.minWidth).toBe("0px");
    expect(heading.textOverflow).toBe("ellipsis");
    expect(heading.whiteSpace).toBe("nowrap");
    expect(getComputedStyle(section.querySelector(".pane-message")!).overflowWrap).toBe("anywhere");
  }
});

it("keeps palette shortcut tokens above the shared key hint defaults", () => {
  applyStyles("disabled");
  const rules = Array.from(style.sheet!.cssRules).filter(
    (rule): rule is CSSStyleRule =>
      rule instanceof CSSStyleRule &&
      rule.selectorText.includes(".palette-key") &&
      rule.selectorText.includes(".palette-hints kbd"),
  );
  const palette = rules.at(-1)!;
  expect(palette.style.getPropertyValue("border-color")).toBe("var(--border-strong)");
  expect(palette.style.getPropertyValue("background")).toBe("var(--bg)");
  expect(palette.style.getPropertyValue("color")).toBe("var(--text-faint)");
});

it("keeps the expanded Python environment trigger highlighted", () => {
  applyStyles("disabled");
  const selectors = [
    ".python-environment .app-select .app-select-trigger",
    '.app-select .app-select-trigger[aria-expanded="true"]',
  ];
  const rules = Array.from(style.sheet!.cssRules).filter(
    (rule): rule is CSSStyleRule =>
      rule instanceof CSSStyleRule &&
      selectors.includes(rule.selectorText) &&
      rule.style.getPropertyValue("border-color") !== "",
  );
  const expanded = rules.at(-1)!;
  expect(expanded.selectorText).toBe(selectors[1]);
  expect(expanded.style.getPropertyValue("border-color")).toBe("var(--accent)");
});
