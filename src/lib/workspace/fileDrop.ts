export type FileDropTarget =
  | { kind: "copy"; projectId: string | null; parent: string; element: HTMLElement }
  | { kind: "open"; element: HTMLElement };

export function fileDropTarget(
  position: { x: number; y: number },
  activeProjectId: string | null,
  // Wry 0.57 reports AppKit points on macOS despite Tauri's PhysicalPosition type.
  scale = /Mac/.test(navigator.userAgent) ? 1 : window.devicePixelRatio,
): FileDropTarget | null {
  const hit = document.elementFromPoint(position.x / scale, position.y / scale);
  if (!hit || hit.closest('[role="dialog"], [role="menu"]')) return null;
  const tree = hit.closest<HTMLElement>(".file-tree-pane");
  if (tree) {
    const row = hit.closest<HTMLElement>("[data-drop-project]");
    return {
      kind: "copy",
      projectId: row?.dataset.dropProject ?? activeProjectId,
      parent: row?.dataset.dropParent ?? "",
      element: row ?? tree,
    };
  }
  const reader = hit.closest<HTMLElement>(".document-area, .tab-strip");
  return reader ? { kind: "open", element: reader } : null;
}
