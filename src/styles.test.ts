import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/styles.css", "utf8");
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

it("honors reduced transparency even when glass is enabled", () => {
  const root = applyStyles("enabled", true);
  expect(root.getPropertyValue("--popover-material")).toBe("var(--surface-raised)");
  expect(root.getPropertyValue("--overlay-glass-filter")).toBe("none");
});
