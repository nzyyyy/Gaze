import { useSyncExternalStore } from "react";
import { english } from "./messages";

export type Language = "zh-CN" | "en";
export const DEFAULT_LANGUAGE: Language = "zh-CN";
let language: Language = DEFAULT_LANGUAGE;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const useLanguage = () => useSyncExternalStore(subscribe, () => language);
export function setLanguage(next: Language) {
  language = next;
  document.documentElement.lang = next;
  listeners.forEach((listener) => listener());
}
export function t(message: string, ...values: unknown[]): string {
  const translated =
    language === "en" && Object.prototype.hasOwnProperty.call(english, message)
      ? english[message]!
      : message;
  return translated.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : placeholder,
  );
}
