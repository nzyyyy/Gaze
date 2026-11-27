import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useState } from "react";
import { api } from "../../lib/platform/api";
import { t, useLanguage } from "../../lib/i18n";
import type { PythonEnvironment, PythonEnvironmentStatus } from "../../lib/types";
import { errorMessage } from "../../lib/utils";
import { Select } from "../../components/common/Select";

const AUTO = "auto";
const BROWSE = "browse";
const DISCOVERING = "discovering";

export function PythonEnvironmentSelect({
  projectId,
  onChange,
  onNotice,
}: {
  projectId: string;
  onChange: (projectId: string) => void;
  onNotice: (message: string) => void;
}) {
  useLanguage();
  const id = useId();
  const [status, setStatus] = useState<PythonEnvironmentStatus | null>(null);
  const [candidates, setCandidates] = useState<PythonEnvironment[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void api.getPythonEnvironment(projectId).then(
      (result) => {
        if (active) setStatus(result);
      },
      (error) => {
        if (!active) return;
        setStatus({ selected: null, environment: null, automatic: null });
        onNotice(errorMessage(error));
      },
    );
    return () => {
      active = false;
    };
  }, [projectId, onNotice]);

  const discover = async () => {
    if (discovering) return;
    setDiscovering(true);
    try {
      setCandidates(await api.listPythonEnvironments(projectId));
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setDiscovering(false);
    }
  };

  const select = async (value: string) => {
    if (value === DISCOVERING || saving) return;
    setSaving(true);
    try {
      const interpreter =
        value === BROWSE
          ? await open({ title: t("Python 解释器"), directory: false, multiple: false })
          : value === AUTO
            ? null
            : value;
      if (value === BROWSE && !interpreter) return;
      const next = await api.setPythonEnvironment(projectId, interpreter);
      setStatus(next);
      onChange(projectId);
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const current = status?.environment;
  const automatic = status?.automatic;
  const missing = status?.selected && !current;
  const environments =
    current && !candidates.some((item) => item.path === current.path)
      ? [current, ...candidates]
      : candidates;
  const groups = new Map<string, PythonEnvironment[]>();
  for (const item of environments) {
    const group = groups.get(item.kind);
    if (group) group.push(item);
    else groups.set(item.kind, [item]);
  }
  const groupLabels: Record<string, string> = {
    uv: "uv",
    conda: "Conda",
    venv: t("虚拟环境（venv）"),
    pyenv: "pyenv",
    poetry: "Poetry",
    pipenv: "Pipenv",
    system: t("系统解释器"),
    custom: t("自定义解释器"),
  };
  return (
    <div className="python-environment">
      <Select
        id={id}
        label={t("Python 解释器")}
        value={status?.selected ?? AUTO}
        triggerLabel={
          current
            ? `Python · ${current.name}`
            : missing
              ? `Python · ${t("找不到解释器")}`
              : "Python"
        }
        menuMaxWidth={440}
        options={[
          {
            value: AUTO,
            label: t("自动发现 Python 环境"),
            description: automatic
              ? `${automatic.name} · ${automatic.path}`
              : t("未自动选定解释器"),
          },
          { value: BROWSE, label: t("选择解释器文件…") },
          ...(missing && status.selected
            ? [{ value: status.selected, label: t("找不到解释器"), description: status.selected }]
            : []),
          ...Array.from(groups, ([kind, items]) => ({
            label: groupLabels[kind] ?? kind,
            options: items.map((item) => ({
              value: item.path,
              label: item.name,
              description: item.path,
            })),
          })),
          ...(discovering ? [{ value: DISCOVERING, label: t("正在查找 Python 环境…") }] : []),
        ]}
        disabled={saving || !status}
        commitOnTab={false}
        onOpen={() => void discover()}
        onChange={(value) => void select(value)}
      />
    </div>
  );
}
