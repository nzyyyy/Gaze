import { render } from "@testing-library/react";
import { test } from "vitest";

import MarkdownPreview from "./MarkdownPreview";

const content = Array.from(
  { length: 20_000 },
  (_, index) => `Line ${index}: Markdown rendering throughput baseline with searchable plain text.`,
).join("\n");

test("large Markdown preview", async ({ bench }) => {
  await bench("render 1 MiB / 20,000-line Markdown preview", () => {
    const view = render(
      <MarkdownPreview
        content={content}
        projectId="benchmark"
        documentPath="docs/large.md"
        active
        onNotice={() => undefined}
      />,
    );
    view.unmount();
  }).run({ iterations: 3, warmupIterations: 0 });
}, 120_000);
