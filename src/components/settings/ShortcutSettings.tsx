import { RotateCcw } from "lucide-react";
import { useState } from "react";

import { t, useLanguage } from "../../lib/i18n";
import {
  SHORTCUT_COMMANDS,
  SHORTCUT_GROUPS,
  isModifierKey,
  resolveShortcuts,
  shortcutCommandLabel,
  shortcutConflicts,
  shortcutFromEvent,
  shortcutLabel,
  shortcutNeedsModifier,
  type ShortcutOverrides,
} from "../../lib/shortcuts";

interface ShortcutSettingsProps {
  shortcuts: ShortcutOverrides;
  onChange: (shortcuts: ShortcutOverrides) => void;
}

export function ShortcutSettings({ shortcuts, onChange }: ShortcutSettingsProps) {
  useLanguage();
  const bindings = resolveShortcuts(shortcuts);
  const conflicts = new Map<string, string[]>();
  for (const [, ids] of shortcutConflicts(bindings)) {
    for (const id of ids)
      conflicts.set(
        id,
        ids.filter((other) => other !== id),
      );
  }
  const [recording, setRecording] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);

  const stop = () => {
    setRecording(null);
    setInvalid(null);
  };
  const record = (command: string, event: React.KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") stop();
    else if (
      (event.key === "Backspace" || event.key === "Delete") &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      onChange({ ...shortcuts, [command]: "" });
      stop();
    } else if (isModifierKey(event)) {
      // Keep waiting for the key the user wants to bind.
    } else {
      const shortcut = shortcutFromEvent(event);
      if (!shortcut) setInvalid(t("无法识别这个按键，请换一个组合。"));
      else if (shortcutNeedsModifier(shortcut)) setInvalid(t("请搭配 ⌘、⌥、⌃，或使用功能键。"));
      else {
        onChange({ ...shortcuts, [command]: shortcut });
        stop();
      }
    }
  };

  return (
    <div className="settings-shortcuts">
      <div className="settings-shortcut-toolbar">
        <p className="settings-description">
          {t("点击快捷键后按下新的组合键；按 Backspace 或 Delete 清除，Esc 取消。保存后生效。")}
        </p>
        <button
          type="button"
          className="button button-small"
          disabled={!Object.keys(shortcuts).length}
          onClick={() => {
            onChange({});
            stop();
          }}
        >
          <RotateCcw size={13} aria-hidden="true" />
          {t("恢复默认快捷键")}
        </button>
      </div>
      {SHORTCUT_GROUPS.map((group) => (
        <div className="settings-shortcut-group" key={group.id}>
          <h4>{t(group.label)}</h4>
          {SHORTCUT_COMMANDS.filter((command) => command.group === group.id).map((command) => {
            const conflict = conflicts.get(command.id);
            return (
              <div className="settings-shortcut" key={command.id}>
                <span id={`shortcut-${command.id}-label`}>{t(command.label)}</span>
                <div className="settings-shortcut-value">
                  {conflict && (
                    <span className="settings-shortcut-conflict" role="alert">
                      {t("与 {0} 冲突", conflict.map(shortcutCommandLabel).join("、"))}
                    </span>
                  )}
                  {invalid && recording === command.id && (
                    <span className="settings-shortcut-conflict" role="alert">
                      {invalid}
                    </span>
                  )}
                  <button
                    type="button"
                    className="shortcut-key"
                    aria-labelledby={`shortcut-${command.id}-label`}
                    aria-live="polite"
                    data-recording={recording === command.id || undefined}
                    onClick={() => {
                      setInvalid(null);
                      setRecording(recording === command.id ? null : command.id);
                    }}
                    onBlur={() => {
                      if (recording === command.id) stop();
                    }}
                    onKeyDown={(event) => {
                      if (recording === command.id) record(command.id, event);
                    }}
                  >
                    {recording === command.id
                      ? t("请按下新的快捷键…")
                      : shortcutLabel(bindings[command.id])}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
