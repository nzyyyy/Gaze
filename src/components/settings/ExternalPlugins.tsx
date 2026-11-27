import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { usePlugins } from "../../plugins/runtime";
import { errorMessage } from "../../lib/utils";
import { t } from "../../lib/i18n";

export function ExternalPlugins() {
  const plugins = usePlugins();
  const [pendingApproval, setPendingApproval] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  if (!plugins) return null;

  const change = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    setPendingApproval(null);
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const install = () =>
    change(async () => {
      const directory = await open({ directory: true, multiple: false, title: t("导入插件目录") });
      if (typeof directory === "string") await plugins.install(directory);
    });

  return (
    <div className="settings-external-plugins">
      <div className="setting-row">
        <div className="setting-copy">
          <h4>{t("外部插件")}</h4>
          <p>{t("选择包含 gaze-plugin.json 的目录。外部插件在此处立即启停。")}</p>
        </div>
        <div className="setting-control">
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={() => void install()}
          >
            {t("导入插件目录")}
          </button>
        </div>
      </div>
      {plugins.loadError != null && (
        <div className="setting-row">
          <p role="alert">{errorMessage(plugins.loadError)}</p>
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={() => void change(plugins.reload)}
          >
            {t("重试")}
          </button>
        </div>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {plugins.installed.map((plugin) => {
        const { manifest, revision, enabled } = plugin;
        const native = manifest.runtime === "native";
        const approving = pendingApproval === revision;
        return (
          <div className="setting-row" key={revision}>
            <div className="setting-copy">
              <h4>{manifest.name}</h4>
              <p>
                {manifest.id} · {manifest.version} · {native ? t("本机插件") : t("受限 JavaScript")}
              </p>
              {approving && (
                <p role="status">
                  {t(
                    "此版本会以你的系统用户权限运行，可以访问该用户可访问的文件和网络。只授权你信任的插件。",
                  )}
                </p>
              )}
            </div>
            <div className="setting-control">
              {approving ? (
                <>
                  <button
                    type="button"
                    className="button button-small"
                    autoFocus
                    onClick={() => void change(() => plugins.setEnabled(plugin, true, true))}
                  >
                    {t("授权并启用")}
                  </button>
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => setPendingApproval(null)}
                  >
                    {t("取消")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="button button-small"
                    disabled={busy}
                    aria-label={
                      enabled ? t("停用插件 {0}", manifest.name) : t("启用插件 {0}", manifest.name)
                    }
                    onClick={() => {
                      if (native && !enabled) setPendingApproval(revision);
                      else void change(() => plugins.setEnabled(plugin, !enabled, false));
                    }}
                  >
                    {enabled ? t("停用") : t("启用")}
                  </button>
                  <button
                    type="button"
                    className="button button-small"
                    disabled={busy}
                    aria-label={t("卸载插件 {0}", manifest.name)}
                    onClick={() => void change(() => plugins.uninstall(plugin))}
                  >
                    {t("卸载")}
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
