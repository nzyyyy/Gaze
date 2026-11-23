import { afterEach, expect, it, vi } from "vitest";

const { render } = vi.hoisted(() => ({
  render: vi.fn(async (_id: string, source: string) => ({ svg: source })),
}));
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render } }));

import { renderMermaid } from "./render";

afterEach(() => vi.useRealTimers());

it("skips cancelled diagrams in the queue and yields before starting the next render", async () => {
  vi.useFakeTimers();
  let finish!: (output: { svg: string }) => void;
  render.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const controller = new AbortController();
  const cancelled = new AbortController();
  const first = renderMermaid("first", controller.signal);
  const rejected = expect(renderMermaid("cancelled", cancelled.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  const last = renderMermaid("last", controller.signal);

  await vi.advanceTimersByTimeAsync(16);
  expect(render.mock.calls.map(([, code]) => code)).toEqual(["first"]);
  cancelled.abort();
  finish({ svg: "first" });
  await expect(first).resolves.toBe("first");
  await rejected;
  expect(render).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(16);
  await expect(last).resolves.toBe("last");
  expect(render.mock.calls.map(([, code]) => code)).toEqual(["first", "last"]);
});
