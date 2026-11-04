import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

export interface LanguageMatch {
  label: string;
  description: LanguageDescription | null;
}

export function matchLanguage(filename: string): LanguageMatch {
  const description = LanguageDescription.matchFilename(languages, filename);
  return {
    label: description?.name ?? "Plain Text",
    description,
  };
}

export function isMarkdownFile(filename: string): boolean {
  return matchLanguage(filename.toLowerCase()).label === "Markdown";
}
