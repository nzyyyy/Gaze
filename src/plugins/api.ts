import { invoke } from "@tauri-apps/api/core";

export type PluginContribution =
  { kind: "command"; id: string; title: string } | { kind: "markdown"; language: string };

export interface InstalledPlugin {
  manifest: {
    id: string;
    name: string;
    version: string;
    apiVersion: number;
    runtime: "javaScript" | "native";
    entry: string;
    contributes: PluginContribution[];
  };
  revision: string;
  enabled: boolean;
}

export type PluginInput =
  | { kind: "command"; id: string; text: string; language: string }
  | { kind: "markdown"; language: string; code: string };

export type CommandOutput = { kind: "unchanged" } | { kind: "replace"; text: string };
export type MarkdownOutput =
  { kind: "text"; text: string } | { kind: "table"; headers: string[]; rows: string[][] };

export const pluginApi = {
  list: () => invoke<InstalledPlugin[]>("list_plugins"),
  install: (directory: string) => invoke<InstalledPlugin[]>("install_plugin", { directory }),
  enable: (
    plugin: InstalledPlugin,
    enabled: boolean,
    approved: boolean,
    reservedLanguages: string[],
  ) =>
    invoke<InstalledPlugin[]>("set_plugin_enabled", {
      id: plugin.manifest.id,
      revision: plugin.revision,
      enabled,
      approved,
      reservedLanguages,
    }),
  uninstall: (revision: string) => invoke<InstalledPlugin[]>("uninstall_plugin", { revision }),
  async run(revision: string, input: PluginInput, signal: AbortSignal) {
    if (signal.aborted) return null;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const requestId = [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
    const cancel = () => void invoke("cancel_plugin", { requestId }).catch(() => undefined);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await invoke<CommandOutput | MarkdownOutput>("invoke_plugin", {
        revision,
        requestId,
        input,
      });
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  },
};
