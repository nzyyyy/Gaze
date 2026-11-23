import "katex/dist/katex.min.css";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

export const markdownMath = { remark: remarkMath, rehype: rehypeKatex };
