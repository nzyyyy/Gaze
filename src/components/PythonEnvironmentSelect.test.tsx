import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { open } from "@tauri-apps/plugin-dialog";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import { PythonEnvironmentSelect } from "./PythonEnvironmentSelect";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../lib/api", () => ({
  api: {
    getPythonEnvironment: vi.fn(),
    listPythonEnvironments: vi.fn(),
    setPythonEnvironment: vi.fn(),
  },
}));

const auto = { path: "/work/project/.venv/bin/python", name: ".venv", kind: "uv" };
const conda = { path: "/tools/conda/envs/work/bin/python", name: "work", kind: "conda" };
const uv = { path: "/tools/uv/python/3.12/bin/python", name: "Python 3.12", kind: "uv" };
const automaticStatus = { selected: null, environment: auto, automatic: auto };

beforeEach(() => {
  setLanguage("zh-CN");
  vi.resetAllMocks();
  vi.mocked(api.getPythonEnvironment).mockResolvedValue(automaticStatus);
  vi.mocked(api.listPythonEnvironments).mockResolvedValue([auto, conda, uv]);
});

it("discovers on open, selects a project-specific interpreter and can return to automatic", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  vi.mocked(api.setPythonEnvironment)
    .mockResolvedValueOnce({ selected: conda.path, environment: conda, automatic: auto })
    .mockResolvedValueOnce(automaticStatus);
  render(<PythonEnvironmentSelect projectId="first" onChange={onChange} onNotice={vi.fn()} />);
  const picker = screen.getByRole("combobox", { name: "Python 解释器" });
  await waitFor(() => expect(picker).toHaveTextContent("Python · .venv"));
  expect(api.listPythonEnvironments).not.toHaveBeenCalled();
  await user.click(picker);
  const menu = screen.getByRole("listbox");
  expect(menu).toHaveStyle({ maxWidth: "440px" });
  const automatic = screen.getByRole("option", { name: /^自动发现 Python 环境/ });
  expect(automatic).toHaveTextContent(`${auto.name} · ${auto.path}`);
  expect(automatic).toHaveAttribute("aria-selected", "true");
  const condaGroup = await screen.findByRole("group", { name: "Conda" });
  const uvGroup = screen.getByRole("group", { name: "uv" });
  expect(within(uvGroup).getAllByRole("option")).toHaveLength(2);
  const option = within(condaGroup).getByRole("option", { name: /^work,/ });
  expect(option.querySelector(".app-select-option-description")).toHaveTextContent(conda.path);
  expect(option).toHaveAttribute("data-tooltip", conda.path);
  await user.keyboard("{Home}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
  expect(picker).toHaveAttribute("aria-activedescendant", option.id);
  await user.keyboard("{Enter}");
  expect(api.setPythonEnvironment).toHaveBeenLastCalledWith("first", conda.path);
  expect(onChange).toHaveBeenCalledWith("first");
  expect(picker).toHaveTextContent("Python · work");

  await user.click(picker);
  const automaticWhileManual = screen.getByRole("option", { name: /^自动发现 Python 环境/ });
  expect(automaticWhileManual).toHaveTextContent(auto.path);
  expect(automaticWhileManual).not.toHaveTextContent(conda.path);
  expect(automaticWhileManual).toHaveAttribute("aria-selected", "false");
  await user.click(automaticWhileManual);
  expect(api.setPythonEnvironment).toHaveBeenLastCalledWith("first", null);
  expect(picker).toHaveTextContent("Python · .venv");
});

it("allows selecting any interpreter with the native file picker and ignores cancellation", async () => {
  const user = userEvent.setup();
  const manual = { path: "/outside/env/bin/python", name: "env", kind: "venv" };
  vi.mocked(api.getPythonEnvironment).mockResolvedValue({
    selected: null,
    environment: null,
    automatic: null,
  });
  vi.mocked(open).mockResolvedValueOnce(null).mockResolvedValueOnce(manual.path);
  vi.mocked(api.setPythonEnvironment).mockResolvedValueOnce({
    selected: manual.path,
    environment: manual,
    automatic: null,
  });
  render(<PythonEnvironmentSelect projectId="second" onChange={vi.fn()} onNotice={vi.fn()} />);
  const picker = screen.getByRole("combobox");
  await waitFor(() => expect(picker).toBeEnabled());
  await user.click(picker);
  expect(screen.getByRole("option", { name: /^自动发现 Python 环境/ })).toHaveTextContent(
    "未自动选定解释器",
  );
  await user.click(screen.getByRole("option", { name: "选择解释器文件…" }));
  expect(api.setPythonEnvironment).not.toHaveBeenCalled();
  await waitFor(() => expect(picker).toBeEnabled());
  await user.click(picker);
  await user.click(screen.getByRole("option", { name: "选择解释器文件…" }));
  expect(api.setPythonEnvironment).toHaveBeenCalledWith("second", manual.path);
  expect(picker).toHaveTextContent("Python · env");
});
