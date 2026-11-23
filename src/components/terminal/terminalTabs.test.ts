import { describe, expect, it } from "vitest";

import {
  folderName,
  nextTerminalTitle,
  parseOsc633Cwd,
  parseOsc7Cwd,
  removeTerminal,
  shellName,
  type TerminalTab,
} from "./terminalTabs";

function tab(id: string, projectId: string, title: string): TerminalTab {
  return { id, projectId, title, shell: "/bin/zsh", exited: false, exitCode: null };
}

describe("shellName", () => {
  it("strips directories and .exe", () => {
    expect(shellName("/bin/zsh")).toBe("zsh");
    expect(shellName("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
  });
});

describe("nextTerminalTitle", () => {
  it("numbers duplicates", () => {
    const tabs = [tab("1", "p", "zsh"), tab("2", "q", "zsh 2")];
    expect(nextTerminalTitle(tabs, "/bin/zsh")).toBe("zsh 3");
    expect(nextTerminalTitle([], "/bin/bash")).toBe("bash");
  });
});

describe("folderName", () => {
  it("uses the last path segment as the tab title", () => {
    expect(folderName("/Users/me/Projects/Gaze")).toBe("Gaze");
    expect(folderName("/Users/me/Projects/Gaze/")).toBe("Gaze");
    expect(folderName("C:\\Users\\me\\Gaze")).toBe("Gaze");
    expect(folderName("/")).toBe("/");
    expect(folderName("")).toBeNull();
  });
});

describe("parseOsc7Cwd", () => {
  it("reads file URLs and bare paths", () => {
    expect(parseOsc7Cwd("file://host/Users/me/My%20Project")).toBe("/Users/me/My Project");
    expect(parseOsc7Cwd("/Users/me/Gaze")).toBe("/Users/me/Gaze");
    expect(parseOsc7Cwd("relative/path")).toBeNull();
    expect(parseOsc7Cwd("")).toBeNull();
  });
});

describe("parseOsc633Cwd", () => {
  it("reads the Cwd property from shell integration payloads", () => {
    expect(parseOsc633Cwd("P;Cwd=/Users/me/Gaze")).toBe("/Users/me/Gaze");
    expect(parseOsc633Cwd("P;IsWindows=False;Cwd=/tmp/demo")).toBe("/tmp/demo");
    expect(parseOsc633Cwd("A")).toBeNull();
  });
});

describe("removeTerminal", () => {
  const tabs = [tab("a", "p", "zsh"), tab("b", "p", "zsh 2"), tab("c", "q", "zsh 3")];

  it("keeps the active tab when closing another", () => {
    expect(removeTerminal(tabs, "a", "b")).toEqual({
      tabs: [tabs[0]!, tabs[2]!],
      activeId: "a",
    });
  });

  it("activates the next tab when closing the active tab", () => {
    const result = removeTerminal(tabs, "a", "a");
    expect(result.tabs.map((item) => item.id)).toEqual(["b", "c"]);
    expect(result.activeId).toBe("b");
  });

  it("activates the next tab even when it started in another project", () => {
    expect(removeTerminal(tabs, "b", "b").activeId).toBe("c");
  });

  it("falls back to the previous tab when closing the last tab", () => {
    expect(removeTerminal(tabs, "c", "c").activeId).toBe("b");
    expect(removeTerminal([tabs[0]!], "a", "a")).toEqual({ tabs: [], activeId: null });
  });
});
