import { t, useLanguage, DEFAULT_LANGUAGE, type Language } from "../lib/i18n";
import { ChevronLeft, ChevronRight, Eye, EyeOff, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Select } from "./Select";
import { ExternalPlugins } from "./ExternalPlugins";

import mapleLicense from "../assets/fonts/LICENSE.txt?raw";
import {
  COLOR_SCHEME_NAMES,
  DEFAULT_COLOR_SCHEMES,
  PALETTES,
  type ColorScheme,
} from "../lib/colorSchemes";
import { DEFAULT_FONT_SETTINGS, fontStack, type FontChoice } from "../lib/fonts";
import { errorMessage } from "../lib/utils";
import {
  DEFAULT_PREFERENCES,
  PREFERENCE_FIELDS,
  SETTINGS_CATEGORIES,
  preferencesError,
  type AppSettings,
  type Preferences,
  type SettingsCategory,
} from "../lib/preferences";
import { DEFAULT_LAYOUT, LAYOUT_SIZE_LIMITS, readLayout, type Layout } from "../lib/layout";
import { BUILTIN_PLUGIN_CATEGORIES, type BuiltinPluginCategory } from "../plugins/builtins";
import { api } from "../lib/api";
import {
  aiCompletionError,
  AI_PROTOCOLS,
  type AiCompletionConfig,
} from "../plugins/ai-completion-config";

interface SettingsDialogProps {
  settings: AppSettings;
  isMac?: boolean;
  onSave: (settings: AppSettings, layout: Layout) => Promise<void>;
  onClose: () => void;
}

const AREAS = [
  { key: "ui", label: "界面", sample: "项目文件　全局搜索　设置　Gaze" },
  {
    key: "editor",
    label: "编辑器",
    sample: "// 中文注释 · 0O 1lI\nconst gaze = (value) => value !== null;",
  },
  { key: "terminal", label: "终端", sample: "❯ ~/项目/gaze   main\n pnpm dev  ✓ ready" },
] as const;

const PLUGIN_FILTERS = { all: "全部", ...BUILTIN_PLUGIN_CATEGORIES };
const pluginFilterIds = Object.keys(PLUGIN_FILTERS) as (keyof typeof PLUGIN_FILTERS)[];

function SettingRow({
  id,
  label,
  description,
  tag,
  children,
}: {
  id: string;
  label: string;
  description: string;
  tag?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <label id={`${id}-label`} htmlFor={id}>
          {label}
        </label>
        {tag && <span className="settings-plugin-tag">{tag}</span>}
        <p id={`${id}-description`}>{description}</p>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

const LAYOUT_FIELDS = [
  { key: "sidebarWidth", label: "项目栏宽度", ...LAYOUT_SIZE_LIMITS.sidebarWidth },
  { key: "terminalHeight", label: "终端面板高度", ...LAYOUT_SIZE_LIMITS.terminalHeight },
  { key: "outputHeight", label: "Git 输出面板高度", ...LAYOUT_SIZE_LIMITS.outputHeight },
] as const;

export function SettingsDialog({ settings, isMac = false, onSave, onClose }: SettingsDialogProps) {
  useLanguage();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const aiSettingsTitleRef = useRef<HTMLHeadingElement>(null);
  const aiSettingsEntryRef = useRef<HTMLButtonElement>(null);
  const pluginScrollTopRef = useRef<number | null>(null);
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [draft, setDraft] = useState(settings);
  const [layout, setLayout] = useState(readLayout);
  const [category, setCategory] = useState<SettingsCategory>("appearance");
  const [pluginFilter, setPluginFilter] = useState<BuiltinPluginCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiApiKeyVisible, setAiApiKeyVisible] = useState(false);
  const [testingAi, setTestingAi] = useState(false);
  const [aiTest, setAiTest] = useState<{ ok: boolean; message: string } | null>(null);
  const aiConfig = draft.preferences.aiCompletion;
  const manualShortcut = isMac ? "⌘⇧↩" : "Ctrl+Shift+Enter";
  const search = query.trim().toLowerCase();
  const matches = (id: SettingsCategory, text: string) =>
    search
      ? `${t(SETTINGS_CATEGORIES.find((item) => item.id === id)!.label)} ${text}`
          .toLowerCase()
          .includes(search)
      : category === id;

  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    titleRef.current?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  useLayoutEffect(() => {
    if (showAiSettings) {
      if (contentRef.current) contentRef.current.scrollTop = 0;
      aiSettingsTitleRef.current?.focus({ preventScroll: true });
    } else if (pluginScrollTopRef.current !== null) {
      if (contentRef.current) contentRef.current.scrollTop = pluginScrollTopRef.current;
      pluginScrollTopRef.current = null;
      aiSettingsEntryRef.current?.focus({ preventScroll: true });
    }
  }, [showAiSettings]);

  const resetContent = () => {
    pluginScrollTopRef.current = null;
    setShowAiSettings(false);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  };

  const updatePreference = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setDraft({ ...draft, preferences: { ...draft.preferences, [key]: value } });
  };
  const updateAiConfig = (patch: Partial<AiCompletionConfig>) => {
    updatePreference("aiCompletion", { ...aiConfig, ...patch });
    setAiTest(null);
  };

  const sections = SETTINGS_CATEGORIES.map(({ id, label }) => {
    if (showAiSettings) return null;
    const fields = PREFERENCE_FIELDS.filter((field) => {
      if (field.category !== id) return false;
      if (!search && id === "plugins" && pluginFilter !== "all") {
        return category === id && field.pluginCategory === pluginFilter;
      }
      const tag = field.pluginCategory ? t(BUILTIN_PLUGIN_CATEGORIES[field.pluginCategory]) : "";
      const detailTerms =
        field.key === "aiCompletionEnabled"
          ? `${t("API 格式")} ${t("Base URL")} ${t("模型 ID")} API Key ${t("测试连接")} Responses Chat Completions Messages /v1/responses /v1/chat/completions /v1/messages`
          : "";
      return matches(id, `${t(field.label)} ${t(field.description)} ${tag} ${detailTerms}`);
    });
    const fonts = AREAS.filter(
      (area) =>
        (area.key === "ui" ? "appearance" : area.key) === id &&
        matches(id, t("{0} 字体 Maple Consolas", t(area.label))),
    );
    const colors =
      id === "appearance" && matches(id, t("日间 夜间 配色 Codex GitHub Catppuccin Nord Gaze"));
    const locale = id === "appearance" && matches(id, t("语言") + " language 中文 English");
    const mode = id === "appearance" && matches(id, t("主题 模式 跟随系统 日间 夜间"));
    const cursor = id === "terminal" && matches(id, t("光标样式 方块 竖线 下划线"));
    const sizes =
      id === "layout" ? LAYOUT_FIELDS.filter((field) => matches(id, t(field.label))) : [];
    if (!fields.length && !fonts.length && !colors && !mode && !locale && !cursor && !sizes.length)
      return null;
    return (
      <section className="settings-section" key={id} aria-labelledby={`settings-${id}-title`}>
        <h3 id={`settings-${id}-title`}>{t(label)}</h3>
        {id === "plugins" && !search && (
          <div className="settings-plugin-filters" role="group" aria-label={t("插件分类")}>
            {pluginFilterIds.map((filter) => (
              <button
                key={filter}
                type="button"
                aria-pressed={pluginFilter === filter}
                onClick={() => setPluginFilter(filter)}
              >
                {t(PLUGIN_FILTERS[filter])}
              </button>
            ))}
          </div>
        )}
        {id === "plugins" && !search && pluginFilter === "all" && <ExternalPlugins />}
        {locale && (
          <SettingRow id="language" label={t("语言")} description={t("选择界面语言，保存后生效。")}>
            <Select<Language>
              id="language"
              value={draft.language}
              describedBy="language-description"
              options={[
                { value: "zh-CN", label: "简体中文" },
                { value: "en", label: "English" },
              ]}
              onChange={(language) => setDraft({ ...draft, language })}
            />
          </SettingRow>
        )}
        {mode && (
          <SettingRow
            id="theme-mode"
            label={t("主题模式")}
            description={t("选择日间、夜间，或随系统外观自动切换。")}
          >
            <Select<AppSettings["theme"]>
              id="theme-mode"
              value={draft.theme}
              describedBy="theme-mode-description"
              options={[
                { value: "system", label: t("跟随系统") },
                { value: "light", label: t("日间模式") },
                { value: "dark", label: t("夜间模式") },
              ]}
              onChange={(theme) => setDraft({ ...draft, theme })}
            />
          </SettingRow>
        )}
        {colors && (
          <div className="settings-color-section">
            <p className="settings-description">{t("日间与夜间分别选择配色，保存后生效。")}</p>
            {(["light", "dark"] as const).map((mode) => (
              <fieldset className="settings-colors" key={mode}>
                <legend>{mode === "light" ? t("日间配色") : t("夜间配色")}</legend>
                <div className="color-scheme-options">
                  {(Object.keys(COLOR_SCHEME_NAMES) as ColorScheme[]).map((scheme) => {
                    const palette = PALETTES[scheme][mode];
                    return (
                      <button
                        key={scheme}
                        type="button"
                        className="color-scheme-option"
                        aria-pressed={draft.colorSchemes[mode] === scheme}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            colorSchemes: { ...draft.colorSchemes, [mode]: scheme },
                          })
                        }
                      >
                        <span
                          className="color-scheme-swatch"
                          aria-hidden="true"
                          style={{
                            background: palette.background,
                            color: palette.text,
                            borderColor: palette.border,
                          }}
                        >
                          <span style={{ background: palette.sidebar }} />
                          Aa <i style={{ background: palette.accent }} />
                        </span>
                        <span>{t(COLOR_SCHEME_NAMES[scheme][mode])}</span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>
        )}
        {fonts.map(({ key, label, sample }) => (
          <SettingRow
            key={key}
            id={`font-${key}`}
            label={t("{0}字体", t(label))}
            description={t("Maple 已内置；Consolas 缺失时回退到 Maple。")}
          >
            <Select<FontChoice>
              id={`font-${key}`}
              value={draft.fonts[key]}
              describedBy={`font-${key}-description`}
              options={[
                { value: "system", label: key === "ui" ? t("系统默认") : t("原有等宽字体") },
                { value: "maple", label: t("Maple Mono NF CN（内置）") },
                { value: "consolas", label: t("Consolas（本机字体）") },
              ]}
              onChange={(value) => setDraft({ ...draft, fonts: { ...draft.fonts, [key]: value } })}
            />
            <pre
              className="settings-preview"
              style={{ fontFamily: fontStack(draft.fonts[key], key) }}
            >
              {t(sample)}
            </pre>
          </SettingRow>
        ))}
        {fields.map((field) => (
          <SettingRow
            key={field.key}
            id={field.key}
            label={t(field.label)}
            description={t(field.description)}
            tag={
              field.pluginCategory && (search || pluginFilter === "all")
                ? t(BUILTIN_PLUGIN_CATEGORIES[field.pluginCategory])
                : undefined
            }
          >
            {field.key === "aiCompletionEnabled" && (
              <button
                type="button"
                ref={aiSettingsEntryRef}
                className="button button-small settings-plugin-open"
                aria-label={t("配置 AI 行内补全")}
                onClick={() => {
                  pluginScrollTopRef.current = contentRef.current?.scrollTop ?? 0;
                  setShowAiSettings(true);
                }}
              >
                {t("配置")}
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            )}
            {field.type === "boolean" ? (
              <input
                id={field.key}
                type="checkbox"
                role="switch"
                className="setting-switch"
                checked={draft.preferences[field.key]}
                disabled={field.key === "windowGlassEnabled" && !isMac}
                aria-describedby={`${field.key}-description`}
                onChange={(event) => updatePreference(field.key, event.target.checked)}
              />
            ) : field.type === "range" ? (
              <div className="setting-range">
                <input
                  id={field.key}
                  type="range"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  disabled={!isMac || !draft.preferences.windowGlassEnabled}
                  aria-describedby={`${field.key}-description`}
                  value={
                    Number.isFinite(draft.preferences[field.key])
                      ? draft.preferences[field.key]
                      : field.min
                  }
                  onChange={(event) => updatePreference(field.key, event.target.valueAsNumber)}
                />
                <output htmlFor={field.key}>
                  {Math.round(draft.preferences[field.key] * 100)}%
                </output>
              </div>
            ) : (
              <input
                id={field.key}
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                aria-describedby={`${field.key}-description`}
                value={
                  Number.isFinite(draft.preferences[field.key]) ? draft.preferences[field.key] : ""
                }
                onChange={(event) => updatePreference(field.key, event.target.valueAsNumber)}
              />
            )}
          </SettingRow>
        ))}
        {cursor && (
          <SettingRow
            id="terminalCursorStyle"
            label={t("光标样式")}
            description={t("选择终端的光标形状。")}
          >
            <Select<Preferences["terminalCursorStyle"]>
              id="terminalCursorStyle"
              value={draft.preferences.terminalCursorStyle}
              describedBy="terminalCursorStyle-description"
              options={[
                { value: "block", label: t("方块") },
                { value: "bar", label: t("竖线") },
                { value: "underline", label: t("下划线") },
              ]}
              onChange={(value) => updatePreference("terminalCursorStyle", value)}
            />
          </SettingRow>
        )}
        {sizes.map((field) => (
          <SettingRow
            key={field.key}
            id={field.key}
            label={t(field.label)}
            description={t(
              "单位 px；实际尺寸会根据窗口可用空间自动限制。范围 {0}–{1}。",
              field.min,
              field.max,
            )}
          >
            <input
              id={field.key}
              type="number"
              min={field.min}
              max={field.max}
              step={1}
              value={Number.isFinite(layout[field.key]) ? layout[field.key] : ""}
              onChange={(event) =>
                setLayout({ ...layout, [field.key]: event.target.valueAsNumber })
              }
            />
          </SettingRow>
        ))}
        {fonts.length > 0 && (
          <details className="settings-license">
            <summary>{t("Maple Mono 字体许可")}</summary>
            <pre>{mapleLicense}</pre>
          </details>
        )}
      </section>
    );
  }).filter(Boolean);

  const aiSettings = showAiSettings && (
    <section aria-labelledby="settings-ai-title">
      <header className="settings-plugin-detail-header">
        <button
          type="button"
          className="button button-small"
          aria-label={t("返回插件列表")}
          onClick={() => setShowAiSettings(false)}
        >
          <ChevronLeft size={14} aria-hidden="true" />
          {t("插件")}
        </button>
        <h3 id="settings-ai-title" ref={aiSettingsTitleRef} tabIndex={-1}>
          {t("AI 行内补全")}
        </h3>
      </header>
      <SettingRow
        id="ai-protocol"
        label={t("API 格式")}
        description={t("选择服务支持的请求协议；保存时按协议在 Base URL 后补全路径。")}
      >
        <Select<AiCompletionConfig["protocol"]>
          id="ai-protocol"
          describedBy="ai-protocol-description"
          value={aiConfig.protocol}
          options={AI_PROTOCOLS.map(({ value, label, path }) => ({
            value,
            label: `${label} (${path})`,
          }))}
          onChange={(protocol) => updateAiConfig({ protocol })}
        />
      </SettingRow>
      <SettingRow
        id="ai-url"
        label={t("Base URL")}
        description={t(
          "只填基础地址。保存时按所选接口补全路径，已带的版本不会重复；补全会把光标附近的代码和少量相关声明发送到此接口。",
        )}
      >
        <input
          id="ai-url"
          type="url"
          value={aiConfig.url}
          maxLength={2048}
          spellCheck={false}
          aria-describedby="ai-url-description"
          onChange={(event) => updateAiConfig({ url: event.target.value })}
        />
      </SettingRow>
      <SettingRow
        id="ai-model"
        label={t("模型 ID")}
        description={t("填写接口要求的模型标识。按 {0} 手动触发补全。", manualShortcut)}
      >
        <input
          id="ai-model"
          type="text"
          value={aiConfig.model}
          maxLength={256}
          spellCheck={false}
          aria-describedby="ai-model-description"
          onChange={(event) => updateAiConfig({ model: event.target.value })}
        />
      </SettingRow>
      <SettingRow
        id="ai-key"
        label="API Key"
        description={t("随设置保存在本机，只会发送给上面填写的接口。")}
      >
        <div className="settings-secret">
          <input
            id="ai-key"
            type={aiApiKeyVisible ? "text" : "password"}
            value={aiConfig.apiKey}
            maxLength={4096}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="ai-key-description"
            onChange={(event) => updateAiConfig({ apiKey: event.target.value })}
          />
          <button
            type="button"
            className="button button-small settings-secret-toggle"
            aria-label={t(aiApiKeyVisible ? "隐藏 API Key" : "显示 API Key")}
            aria-pressed={aiApiKeyVisible}
            onClick={() => setAiApiKeyVisible((visible) => !visible)}
          >
            {aiApiKeyVisible ? (
              <EyeOff size={14} aria-hidden="true" />
            ) : (
              <Eye size={14} aria-hidden="true" />
            )}
          </button>
        </div>
        <button
          type="button"
          className="button"
          disabled={
            testingAi || !aiConfig.url.trim() || !aiConfig.model.trim() || !aiConfig.apiKey.trim()
          }
          onClick={async () => {
            setTestingAi(true);
            setAiTest(null);
            try {
              await api.testAiCompletion(aiConfig);
              setAiTest({ ok: true, message: t("模型连接成功。") });
            } catch (error) {
              setAiTest({ ok: false, message: aiCompletionError(error) });
            } finally {
              setTestingAi(false);
            }
          }}
        >
          {t(testingAi ? "正在测试连接…" : "测试连接")}
        </button>
        {aiTest && <span role={aiTest.ok ? "status" : "alert"}>{aiTest.message}</span>}
      </SettingRow>
    </section>
  );

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog"
      aria-labelledby="settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (busy) return;
        if (showAiSettings) setShowAiSettings(false);
        else onClose();
      }}
    >
      <form
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || testingAi) return;
          const invalidSize = LAYOUT_FIELDS.find(
            (field) =>
              !Number.isInteger(layout[field.key]) ||
              layout[field.key] < field.min ||
              layout[field.key] > field.max,
          );
          const invalid =
            preferencesError(draft.preferences) ??
            (invalidSize
              ? t(
                  "{0}：请输入 {1}–{2} 之间的整数。",
                  t(invalidSize.label),
                  invalidSize.min,
                  invalidSize.max,
                )
              : null);
          if (invalid) {
            setError(invalid);
            return;
          }
          setBusy(true);
          setError(null);
          try {
            const config = {
              ...aiConfig,
              url: aiConfig.url.trim(),
              model: aiConfig.model.trim(),
              apiKey: aiConfig.apiKey.trim(),
            };
            const configured = !!config.url && !!config.model && !!config.apiKey;
            const next = {
              ...draft,
              preferences: {
                ...draft.preferences,
                aiCompletion: config,
                // An incomplete configuration cannot be enabled, so clearing a field disables it.
                aiCompletionEnabled: configured && draft.preferences.aiCompletionEnabled,
              },
            };
            await onSave(next, layout);
            onClose();
          } catch (error) {
            setError(t("保存失败：{0}", errorMessage(error)));
          } finally {
            setBusy(false);
          }
        }}
      >
        <header className="settings-header">
          <div>
            <h2 id="settings-title" ref={titleRef} tabIndex={-1}>
              {t("设置")}
            </h2>
            <p>{t("自定义你的阅读与编辑环境")}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t("关闭设置")}
            onClick={onClose}
            disabled={busy}
          >
            <X size={16} />
          </button>
        </header>
        <div className="settings-body">
          <aside className="settings-sidebar">
            <div className="settings-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                aria-label={t("搜索设置")}
                placeholder={t("搜索设置…")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                }}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  resetContent();
                }}
              />
            </div>
            <nav aria-label={t("设置分类")}>
              {SETTINGS_CATEGORIES.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-current={!search && item.id === category ? "page" : undefined}
                  onClick={() => {
                    setCategory(item.id);
                    setQuery("");
                    resetContent();
                  }}
                >
                  {t(item.label)}
                </button>
              ))}
            </nav>
            <p className="settings-sidebar-note">{t("更改会在保存后生效")}</p>
          </aside>
          <div className="settings-content" ref={contentRef}>
            {!showAiSettings && search && (
              <p className="settings-search-summary" role="status">
                {t("搜索“")}
                {query.trim()}”
              </p>
            )}
            <fieldset className="settings-controls" disabled={busy || testingAi}>
              {showAiSettings ? (
                aiSettings
              ) : sections.length ? (
                sections
              ) : (
                <p className="settings-empty" role="status">
                  {t("没有匹配的设置，试试“字体”“换行”或“终端”。")}
                </p>
              )}
            </fieldset>
          </div>
        </div>
        {error && (
          <p className="dialog-error settings-error" role="alert">
            {error}
          </p>
        )}
        <footer className="settings-actions">
          <button
            type="button"
            className="button button-quiet"
            disabled={busy || testingAi}
            onClick={() => {
              setDraft({
                language: DEFAULT_LANGUAGE,
                theme: "system",
                fonts: { ...DEFAULT_FONT_SETTINGS },
                colorSchemes: { ...DEFAULT_COLOR_SCHEMES },
                preferences: { ...DEFAULT_PREFERENCES },
              });
              setLayout({ ...DEFAULT_LAYOUT });
              setAiApiKeyVisible(false);
              setAiTest(null);
              setError(null);
            }}
          >
            {t("恢复默认")}
          </button>
          <span />
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            {t("取消")}
          </button>
          <button type="submit" className="button button-primary" disabled={busy || testingAi}>
            {busy && <LoaderCircle size={13} className="spin" />}
            {t(busy ? "保存中…" : "保存设置")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
