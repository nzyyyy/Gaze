import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type { EditorState } from "@codemirror/state";
import type { CompletionContribution } from "../lib/completion";
import { isJavaScriptOrTypeScriptFile, isPythonFile } from "../lib/language";
import { minimap } from "../lib/minimap";
import { BUILTIN_PLUGINS, type BuiltinPluginKey } from "./builtins";
import { aiInlineCompletion } from "./ai-completion";
import { PythonEnvironmentSelect } from "./python/PythonEnvironmentSelect";
import type { Preferences } from "../lib/preferences";
import { MermaidDiagram } from "./mermaid/MermaidDiagram";
import { markdownInsert, markdownSlashQuery } from "./markdown-insert";
import { pluginApi, type InstalledPlugin, type PluginInput } from "./api";

type Completion = {
  kind: "completion";
  language: string;
  contribution: CompletionContribution;
  reservesCompletion: (state: EditorState) => boolean;
};

export type MarkdownRenderer = {
  kind: "markdown";
  language: string;
} & ({ component: ComponentType<{ code: string }> } | { revision: string });

type Command = {
  kind: "command";
  key: string;
  id: string;
  title: string;
  pluginName: string;
  revision: string;
};

type Contribution = Completion | MarkdownRenderer | Command;

const builtins = [
  {
    id: "gaze.mermaid",
    preference: "mermaidEnabled",
    contributes: [{ kind: "markdown", language: "mermaid", component: MermaidDiagram }],
  },
  {
    id: "gaze.markdown-insert",
    preference: "markdownInsertEnabled",
    contributes: [
      {
        kind: "completion",
        language: "Markdown",
        contribution: markdownInsert,
        reservesCompletion: (state) => !!markdownSlashQuery(state, state.selection.main.head),
      },
    ],
  },
] satisfies { id: string; preference: keyof Preferences; contributes: Contribution[] }[];

const reservedLanguages = builtins.flatMap(({ contributes }) =>
  contributes.flatMap((item) => (item.kind === "markdown" ? [item.language] : [])),
);

const builtinFeatures = {
  aiCompletionEnabled: aiInlineCompletion,
  pythonEnabled: { matches: isPythonFile, Status: PythonEnvironmentSelect },
  typescriptEnabled: { matches: isJavaScriptOrTypeScriptFile },
  showMinimap: minimap,
};

type RuntimePreferences = Record<BuiltinPluginKey, boolean>;

function registry(preferences: RuntimePreferences, installed: InstalledPlugin[]) {
  const builtinEnabled = new Set(
    BUILTIN_PLUGINS.filter(({ key }) => preferences[key]).map(({ key }) => key),
  );
  const renderers = new Map<string, MarkdownRenderer & { pluginId: string }>();
  const completions = new Map<string, Completion & { pluginId: string }>();
  const commands: Command[] = [];

  const register = (pluginId: string, item: Contribution) => {
    switch (item.kind) {
      case "completion":
        completions.set(item.language, { ...item, pluginId });
        break;
      case "markdown":
        if (!renderers.has(item.language)) renderers.set(item.language, { ...item, pluginId });
        break;
      case "command":
        commands.push(item);
        break;
    }
  };
  for (const plugin of builtins) {
    if (builtinEnabled.has(plugin.preference))
      plugin.contributes.forEach((item) => register(plugin.id, item));
  }
  for (const { enabled, manifest, revision } of installed) {
    if (!enabled) continue;
    for (const contribution of manifest.contributes) {
      if (contribution.kind === "command") {
        register(manifest.id, {
          ...contribution,
          key: `${manifest.id}/${contribution.id}`,
          pluginName: manifest.name,
          revision,
        });
      } else if (!reservedLanguages.includes(contribution.language)) {
        register(manifest.id, { ...contribution, revision });
      }
    }
  }
  return { renderers, completions, commands, builtinEnabled };
}

const noPlugins: InstalledPlugin[] = [];
const builtinRegistries = {
  enabled: registry(
    Object.fromEntries(BUILTIN_PLUGINS.map(({ key }) => [key, true])) as RuntimePreferences,
    noPlugins,
  ),
  disabled: registry(
    Object.fromEntries(BUILTIN_PLUGINS.map(({ key }) => [key, false])) as RuntimePreferences,
    noPlugins,
  ),
};

type PluginRuntime = ReturnType<typeof registry> & {
  installed: InstalledPlugin[];
  loadError: unknown;
  reload(): Promise<void>;
  install(directory: string): Promise<void>;
  setEnabled(plugin: InstalledPlugin, enabled: boolean, approved: boolean): Promise<void>;
  uninstall(plugin: InstalledPlugin): Promise<void>;
  isEnabled(revision: string): boolean;
  run(revision: string, input: PluginInput, signal: AbortSignal): ReturnType<typeof pluginApi.run>;
};

const RuntimeContext = createContext<PluginRuntime | null>(null);
export const usePlugins = () => useContext(RuntimeContext);

export function useBuiltinEnabled(key: BuiltinPluginKey, fallback: boolean) {
  return usePlugins()?.builtinEnabled.has(key) ?? fallback;
}

export function useBuiltinFeature<K extends keyof typeof builtinFeatures>(
  key: K,
  fallback: boolean,
) {
  const enabled = useBuiltinEnabled(key, fallback);
  return enabled ? builtinFeatures[key] : undefined;
}

export function useSemanticAvailability(filename: string, preferences: RuntimePreferences) {
  const enabled = usePlugins()?.builtinEnabled;
  return (["pythonEnabled", "typescriptEnabled"] as const).every(
    (key) => !builtinFeatures[key].matches(filename) || (enabled?.has(key) ?? preferences[key]),
  );
}

export function useEditorCompletion(language: string, enabled: boolean) {
  const plugins = usePlugins();
  return (plugins ?? builtinRegistries[enabled ? "enabled" : "disabled"]).completions.get(language);
}

export function useMarkdownRenderers(enabled: boolean) {
  return usePlugins()?.renderers ?? builtinRegistries[enabled ? "enabled" : "disabled"].renderers;
}

export function PluginProvider({
  preferences,
  children,
}: {
  preferences: Preferences;
  children: ReactNode;
}) {
  const [installed, setInstalled] = useState(noPlugins);
  const [loadError, setLoadError] = useState<unknown>(null);
  const installedRef = useRef(installed);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const blocked = useRef(new Set<string>());

  const change = useCallback((action: () => Promise<InstalledPlugin[]>) => {
    const pending = queue.current.then(async () => {
      const next = await action();
      installedRef.current = next;
      setInstalled(next);
      setLoadError(null);
    });
    queue.current = pending.catch(() => undefined);
    return pending;
  }, []);
  const reload = useCallback(async () => {
    try {
      await change(pluginApi.list);
    } catch (error) {
      setLoadError(error);
    }
  }, [change]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const isEnabled = useCallback(
    (revision: string) =>
      !blocked.current.has(revision) &&
      installedRef.current.some((plugin) => plugin.revision === revision && plugin.enabled),
    [],
  );
  const run = useCallback(
    async (revision: string, input: PluginInput, signal: AbortSignal) => {
      if (!isEnabled(revision)) return null;
      const result = await pluginApi.run(revision, input, signal);
      return !signal.aborted && isEnabled(revision) ? result : null;
    },
    [isEnabled],
  );

  const contributions = useMemo(() => registry(preferences, installed), [preferences, installed]);
  const value: PluginRuntime = {
    ...contributions,
    installed,
    loadError,
    reload,
    install: (directory) => change(() => pluginApi.install(directory)),
    setEnabled: async (plugin, enabled, approved) => {
      if (!enabled) blocked.current.add(plugin.revision);
      try {
        await change(() => pluginApi.enable(plugin, enabled, approved, reservedLanguages));
      } finally {
        blocked.current.delete(plugin.revision);
      }
    },
    uninstall: async (plugin) => {
      blocked.current.add(plugin.revision);
      try {
        await change(() => pluginApi.uninstall(plugin.revision));
      } finally {
        blocked.current.delete(plugin.revision);
      }
    },
    isEnabled,
    run,
  };
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}
