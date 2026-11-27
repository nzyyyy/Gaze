import { Terminal } from "lucide-react";

import type { EditorTab } from "../editor/types";
import { t } from "../lib/i18n";
import type { Preferences } from "../lib/settings/preferences";
import { shortcutLabel } from "../lib/shortcuts";
import type { EditorStatus } from "../lib/types";
import { useBuiltinFeature } from "../plugins/runtime";

function DocumentLanguageStatus({
  tab,
  label,
  onChange,
  onNotice,
}: {
  tab: EditorTab | null;
  label: string;
  onChange: (projectId: string) => void;
  onNotice: (message: string) => void;
}) {
  const python = useBuiltinFeature("pythonEnabled", false);
  return python && tab && python.matches(tab.name) && !tab.projectId.startsWith("external:") ? (
    <python.Status
      key={tab.projectId}
      projectId={tab.projectId}
      onChange={onChange}
      onNotice={onNotice}
    />
  ) : (
    <span>{label}</span>
  );
}

interface WorkspaceStatusBarProps {
  status: EditorStatus | null;
  activeTab: EditorTab | null;
  navigationBusy: boolean;
  preferences: Preferences;
  hasProjects: boolean;
  terminalOpen: boolean;
  terminalShortcut?: string | null;
  onToggleTerminal: () => void;
  onPythonChange: (projectId: string) => void;
  onNotice: (message: string) => void;
}

export function WorkspaceStatusBar({
  status,
  activeTab,
  navigationBusy,
  preferences,
  hasProjects,
  terminalOpen,
  terminalShortcut,
  onToggleTerminal,
  onPythonChange,
  onNotice,
}: WorkspaceStatusBarProps) {
  const terminalLabel = terminalShortcut
    ? t("终端（{0}）", shortcutLabel(terminalShortcut))
    : t("终端");
  return (
    <footer className="statusbar" hidden={!preferences.showStatusBar}>
      <div className="status-left">
        {status?.readOnly && <span className="readonly-badge">{t("只读")}</span>}
        {status?.saving ? (
          <span className="status-warning">{t("保存中…")}</span>
        ) : status?.autoSavePaused ? (
          <span className="status-warning">{t("自动保存已暂停")}</span>
        ) : status?.dirty ? (
          <span className="status-dirty">{t("未保存")}</span>
        ) : null}
        {navigationBusy ? (
          <span className="status-warning">{t("正在请求符号服务…")}</span>
        ) : status ? (
          <>
            {preferences.showLanguage && (
              <DocumentLanguageStatus
                tab={activeTab}
                label={status.language}
                onChange={onPythonChange}
                onNotice={onNotice}
              />
            )}
            {preferences.showEncoding && <span>{status.encoding}</span>}
            {status.mode !== "normal" && (
              <span className="status-warning">{t("大文件纯文本模式")}</span>
            )}
          </>
        ) : (
          <span>{hasProjects ? t("选择文件以开始") : t("未导入项目")}</span>
        )}
      </div>
      <div className="status-right">
        {preferences.showTerminalButton && (
          <button
            className="status-terminal"
            onClick={onToggleTerminal}
            aria-pressed={terminalOpen}
            data-tooltip={terminalLabel}
            aria-label={terminalLabel}
          >
            <Terminal size={12} />
            <span>{t("终端")}</span>
          </button>
        )}
        {preferences.showLineCount && status && (
          <span>
            {status.lines.toLocaleString()} {t("行")}
          </span>
        )}
      </div>
    </footer>
  );
}
