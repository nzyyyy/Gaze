import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

vi.mock("./MarkdownPreview", () => {
  throw new Error("chunk unavailable");
});
vi.mock("../lib/api", () => ({
  api: {
    readRecovery: vi.fn().mockResolvedValue(null),
    writeRecovery: vi.fn().mockResolvedValue(null),
    deleteRecovery: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue({
      kind: "text",
      projectId: "p1",
      path: "README.md",
      content: "# Guide",
      encoding: "UTF-8",
      encodingKind: "utf8",
      lineEnding: "lf",
      mode: "normal",
      editable: true,
      editBlockedReason: null,
      fingerprint: { size: 7, modifiedNs: "1" },
      size: 7,
      warnings: [],
    }),
  },
  gitApi: {
    getFileBase: vi.fn().mockResolvedValue(null),
    onRepositoryChange: vi.fn().mockResolvedValue(() => {}),
  },
}));

import { CodeReader } from "./CodeReader";

it("keeps source available when the preview module cannot load", async () => {
  const user = userEvent.setup();
  render(
    <CodeReader
      tab={{
        key: "p1\u0000README.md",
        projectId: "p1",
        projectName: "Demo",
        path: "README.md",
        name: "README.md",
      }}
      active
      theme="light"
      reveal={null}
      reloadToken={0}
      externalChangeToken={0}
      onStatus={vi.fn()}
      onDirtyChange={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "预览" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("预览加载失败");
  await user.click(screen.getByRole("button", { name: "源码" }));
  await waitFor(() =>
    expect(document.querySelector(".editor-surface-wrap")).not.toHaveAttribute("hidden"),
  );
  expect(document.querySelector(".cm-content")).toHaveTextContent("# Guide");
});
