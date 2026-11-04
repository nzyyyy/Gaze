import { tokenize, type HunkData, type HunkTokens } from "react-diff-view";
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

export function tokenizeDiff(hunks: HunkData[], language: string): HunkTokens {
  if (!registered) {
    [bash, ini, json, jsx, markdown, python, rust, typescript, tsx, yaml].forEach(
      refractor.register,
    );
    registered = true;
  }
  return tokenize(hunks, { highlight: true, refractor, language });
}
