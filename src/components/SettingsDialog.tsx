import { t, useLanguage, DEFAULT_LANGUAGE, type Language } from "../lib/i18n";
import { LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Select } from "./Select";

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

function SettingRow({
  id,
  label,
  description,
  children,
}: {
  id: string;
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <label id={`${id}-label`} htmlFor={id}>
          {label}
        </label>
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
  const contentRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(settings);
  const [layout, setLayout] = useState(readLayout);
  const [category, setCategory] = useState<SettingsCategory>("appearance");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const updatePreference = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setDraft({ ...draft, preferences: { ...draft.preferences, [key]: value } });
  };

  const sections = SETTINGS_CATEGORIES.map(({ id, label }) => {
    const fields = PREFERENCE_FIELDS.filter(
      (field) => field.category === id && matches(id, `${t(field.label)} ${t(field.description)}`),
    );
    const fonts = AREAS.filter(
      (area) =>
        (area.key === "ui" ? "appearance" : area.key) === id &&
        matches(id, t("{0} 字体 Maple Consolas", t(area.label))),
    );
    const colors =
      id === "appearance" && matches(id, t("日间 夜间 配色 GitHub Catppuccin Nord Gaze"));
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
          >
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

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog"
      aria-labelledby="settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
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
            await onSave(draft, layout);
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
            <h2 id="settings-title">{t("设置")}</h2>
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
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                }}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (contentRef.current) contentRef.current.scrollTop = 0;
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
                    if (contentRef.current) contentRef.current.scrollTop = 0;
                  }}
                >
                  {t(item.label)}
                </button>
              ))}
            </nav>
            <p className="settings-sidebar-note">{t("更改会在保存后生效")}</p>
          </aside>
          <div className="settings-content" ref={contentRef}>
            {search && (
              <p className="settings-search-summary" role="status">
                {t("搜索“")}
                {query.trim()}”
              </p>
            )}
            <fieldset className="settings-controls" disabled={busy}>
              {sections.length ? (
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
            disabled={busy}
            onClick={() => {
              setDraft({
                language: DEFAULT_LANGUAGE,
                theme: "system",
                fonts: { ...DEFAULT_FONT_SETTINGS },
                colorSchemes: { ...DEFAULT_COLOR_SCHEMES },
                preferences: { ...DEFAULT_PREFERENCES },
              });
              setLayout({ ...DEFAULT_LAYOUT });
              setError(null);
            }}
          >
            {t("恢复默认")}
          </button>
          <span />
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            {t("取消")}
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy && <LoaderCircle size={13} className="spin" />}
            {busy ? t("保存中…") : t("保存设置")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
