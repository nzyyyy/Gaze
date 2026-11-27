import { expect, it } from "vitest";
import { DEFAULT_PREFERENCES, PREFERENCE_FIELDS, preferencesError } from "./preferences";

it("accepts defaults and validates all numeric preferences including blank and fractional values", () => {
  expect(preferencesError(DEFAULT_PREFERENCES)).toBeNull();
  expect(DEFAULT_PREFERENCES.windowGlassEnabled).toBe(true);
  expect(DEFAULT_PREFERENCES.windowSurfaceOpacity).toBe(0.8);
  for (const field of PREFERENCE_FIELDS) {
    if (field.type === "boolean") continue;
    for (const value of [NaN, Infinity, field.min - 1, field.max + 1, field.min + field.step / 2]) {
      expect(preferencesError({ ...DEFAULT_PREFERENCES, [field.key]: value })).toContain(
        field.label,
      );
    }
    expect(preferencesError({ ...DEFAULT_PREFERENCES, [field.key]: field.min })).toBeNull();
    expect(preferencesError({ ...DEFAULT_PREFERENCES, [field.key]: field.max })).toBeNull();
  }
});
