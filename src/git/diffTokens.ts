import { markEdits, tokenize, type HunkData, type HunkTokens } from "react-diff-view";
import refractor from "refractor/core";
import bash from "refractor/lang/bash";
import ini from "refractor/lang/ini";
import json from "refractor/lang/json";
import jsx from "refractor/lang/jsx";
import markdown from "refractor/lang/markdown";
import python from "refractor/lang/python";
import rust from "refractor/lang/rust";
import tsx from "refractor/lang/tsx";
import typescript from "refractor/lang/typescript";
import yaml from "refractor/lang/yaml";

let registered = false;

export function tokenizeDiff(
  hunks: HunkData[],
  language?: string,
  inlineEdits = false,
): HunkTokens {
  if (!registered) {
    [bash, ini, json, jsx, markdown, python, rust, typescript, tsx, yaml].forEach(
      refractor.register,
    );
    registered = true;
  }
  // Bound the work on large replacements while retaining whole-line colors.
  const edits = inlineEdits
    ? hunks.filter(
        ({ changes, oldLines, newLines }) =>
          oldLines > 0 &&
          newLines > 0 &&
          changes.length <= 200 &&
          changes.some((change) => change.type === "delete") &&
          changes.reduce((size, change) => size + change.content.length, 0) <= 20_000,
      )
    : [];
  const enhancers = edits.length ? [markEdits(edits)] : [];
  return language && refractor.registered(language)
    ? tokenize(hunks, { highlight: true, refractor, language, enhancers })
    : tokenize(hunks, { enhancers });
}
