import "katex/dist/katex.min.css";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useBuiltinEnabled } from "./runtime";

const markdownMath = { remark: remarkMath, rehype: rehypeKatex };

export function useMarkdownMath(fallback: boolean) {
  return useBuiltinEnabled("markdownMathEnabled", fallback) ? markdownMath : undefined;
}
