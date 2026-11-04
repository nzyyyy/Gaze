import { describe, expect, it } from "vitest";
import { colorSchemeVariables, PALETTES, type ColorScheme } from "./colorSchemes";
import { terminalTheme } from "./terminalTabs";

function luminance(hex: string) {
  const [r, g, b] = hex
    .slice(1)
    .match(/../g)!
    .map((part) => {
      const value = parseInt(part, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
}

function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

function mixedColor(value: string) {
  const match = value.match(/^color-mix\(in srgb, (#[\da-f]{6}) (\d+)%, (#[\da-f]{6})\)$/i);
  expect(match, value).not.toBeNull();
  const [, foreground, percent, background] = match!;
  const weight = Number(percent) / 100;
  return (
    "#" +
    [1, 3, 5]
      .map((offset) =>
        Math.round(
          parseInt(foreground!.slice(offset, offset + 2), 16) * weight +
            parseInt(background!.slice(offset, offset + 2), 16) * (1 - weight),
        )
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

describe("color schemes", () => {
  for (const scheme of ["github", "catppuccin", "nord"] as ColorScheme[]) {
    for (const mode of ["light", "dark"] as const) {
      it(`${scheme} ${mode} keeps text readable and terminal surfaces consistent`, () => {
        const p = PALETTES[scheme][mode];
        for (const surface of [p.background, p.sidebar, p.raised]) {
          for (const text of [p.text, p.muted, p.faint]) {
            expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
          }
        }
        expect(contrast(p.accent, p.contrast)).toBeGreaterThanOrEqual(4.5);
        const variables = colorSchemeVariables(scheme, mode);
        expect(terminalTheme(mode === "dark", scheme).background).toBe(variables["--terminal-bg"]);
        expect(terminalTheme(mode === "dark", scheme).foreground).toBe(variables["--text"]);
      });
    }
  }
  for (const scheme of Object.keys(PALETTES) as ColorScheme[]) {
    for (const mode of ["light", "dark"] as const) {
      it(`${scheme} ${mode} keeps selected text and state indicators readable`, () => {
        const variables = colorSchemeVariables(scheme, mode);
        for (const token of ["--sidebar-active", "--tab-active", "--selected-inactive"]) {
          const background = mixedColor(variables[token]!);
          expect(contrast(variables["--text"]!, background)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(variables["--accent"]!, background)).toBeGreaterThanOrEqual(3);
        }
        expect(variables["--sidebar-active"]).not.toBe(variables["--selected-inactive"]);
      });
    }
  }
  it("keeps the original terminal on the shared reading surface without replacing its ANSI colors", () => {
    for (const mode of ["light", "dark"] as const) {
      expect(colorSchemeVariables("original", mode)["--editor-bg"]).toBe(
        PALETTES.original[mode].background,
      );
      const terminal = terminalTheme(mode === "dark", "original");
      expect(terminal.background).toBe(PALETTES.original[mode].background);
      expect(terminal.cursorAccent).toBe(terminal.background);
      for (const surface of ["background", "sidebar", "raised"] as const) {
        expect(
          contrast(PALETTES.original[mode].muted, PALETTES.original[mode][surface]),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(terminalTheme(true, "original").red).toBe("#ff5555");
    expect(terminalTheme(false, "original").red).toBe("#cb3a2a");
  });
});
