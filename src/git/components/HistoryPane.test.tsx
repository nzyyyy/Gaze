import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { HistoryPane } from "./HistoryPane";

it("marks the current branch with a leading star and an accessible description", () => {
  render(
    <HistoryPane
      branches={["main", "dev"].map((name) => ({
        name,
        current: name === "main",
        remote: false,
        oid: "abcdef12",
        upstream: null,
        committedAt: null,
      }))}
      branchRef={null}
      onBranchChange={vi.fn()}
      commits={[]}
      loading={false}
      hasMore={false}
      onLoadMore={vi.fn()}
      onSelect={vi.fn()}
      onRun={vi.fn()}
    />,
  );
  const current = screen.getByRole("button", { name: "main (current)", hidden: true });
  expect(current).toHaveTextContent(/^main$/);
  expect(current.firstElementChild?.tagName).toBe("svg");
  expect(current.firstElementChild).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByRole("button", { name: "dev", hidden: true }).querySelector("svg")).toBeNull();
});

it.each([
  ["fix: 搜索提交", "message"],
  ["bad", "message"],
  ["abcdg", "message"],
  ["ab cd", "message"],
  ["a".repeat(65), "message"],
  ["abcd", "sha"],
  ["ABCDEF12", "sha"],
  ["a".repeat(40), "sha"],
  ["a".repeat(64), "sha"],
  ["  abcdef12  ", "sha"],
  ["  fix: search  ", "message"],
  ["   ", null],
])("automatically searches %j as %s", (query, type) => {
  const onSearch = vi.fn();
  render(
    <HistoryPane
      branches={[]}
      branchRef={null}
      onBranchChange={vi.fn()}
      commits={[]}
      loading={false}
      hasMore={false}
      onLoadMore={vi.fn()}
      onSelect={vi.fn()}
      onRun={vi.fn()}
      onSearch={onSearch}
    />,
  );
  const input = screen.getByRole("searchbox", { name: "Search message or SHA" });
  fireEvent.change(input, { target: { value: query } });
  fireEvent.submit(input.closest("form")!);
  expect(onSearch).toHaveBeenLastCalledWith(type ? { type, query: query.trim() } : null);
  expect(screen.queryByRole("button", { name: "SHA" })).not.toBeInTheDocument();
  if (type) {
    fireEvent.click(screen.getByRole("button", { name: "Clear commit search" }));
    expect(input).toHaveValue("");
    expect(onSearch).toHaveBeenLastCalledWith(null);
  }
});
