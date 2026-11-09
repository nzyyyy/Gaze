import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { memo, useEffect } from "react";
import { setLanguage, t, useLanguage } from "./i18n";
import { english } from "./messages";

afterEach(() => setLanguage("zh-CN"));

it("updates memoized views and document language without remounting", () => {
  let mounts = 0;
  const Label = memo(function Label() {
    useLanguage();
    useEffect(() => {
      mounts++;
    }, []);
    return <span>{t("设置")}</span>;
  });
  render(<Label />);
  expect(screen.getByText("设置")).toBeInTheDocument();
  act(() => {
    setLanguage("en");
  });
  expect(screen.getByText("Settings")).toBeInTheDocument();
  expect(document.documentElement.lang).toBe("en");
  act(() => setLanguage("zh-CN"));
  expect(screen.getByText("设置")).toBeInTheDocument();
  expect(mounts).toBe(1);
});

it("interpolates values literally and falls back for external diagnostics", () => {
  setLanguage("en");
  expect(t("已保存 {0}", "$& {1}.ts")).toBe("Saved $& {1}.ts");
  expect(t("External diagnostic")).toBe("External diagnostic");
  expect(t("constructor")).toBe("constructor");
  expect(t("关闭 {0}", "文件.ts")).toBe("Close 文件.ts");
  for (const [key, translation] of Object.entries(english)) {
    expect(translation.match(/\{\d+\}/g)?.sort() ?? [], key).toEqual(
      key.match(/\{\d+\}/g)?.sort() ?? [],
    );
  }
});
