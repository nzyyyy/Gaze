import { ChevronLeft, ChevronRight, PanelRight, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { errorMessage } from "../lib/utils";
import type { EditorTab } from "./CodeReader";
import { ContextMenu, type MenuTarget } from "./ContextMenu";
import { FileIcon } from "./FileIcon";

interface TabBarProps {
  tabs: EditorTab[];
  activeKey: string | null;
  dirtyKeys: ReadonlySet<string>;
  onActivate: (tab: EditorTab) => void;
  onClose: (tab: EditorTab) => void;
  onCloseTabs: (tabs: EditorTab[]) => void;
  onNotice: (message: string) => void;
  onToggleSplit?: () => void;
  splitOpen?: boolean;
  onMoveToOtherPane?: (tab: EditorTab) => void;
  onReorder?: (sourceKey: string, targetKey: string, after: boolean) => void;
}

type DropTarget = { key: string; after: boolean };

export function TabBar({
  tabs,
  activeKey,
  dirtyKeys,
  onActivate,
  onClose,
  onCloseTabs,
  onNotice,
  onToggleSplit,
  splitOpen = false,
  onMoveToOtherPane,
  onReorder,
}: TabBarProps) {
  const activeTabRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusedTabKeyRef = useRef<string | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    key: string;
    pointerId: number;
    x: number;
    width: number;
    left: number;
    contentWidth: number;
    scrollLeft: number;
    dragging: boolean;
    target: DropTarget | null;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const positionsRef = useRef<Map<HTMLElement, number> | null>(null);
  const [scrollEdges, setScrollEdges] = useState({ left: false, right: false });
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [menu, setMenu] = useState<(MenuTarget & { tab: EditorTab }) | null>(null);
  const stopDrag = useCallback(() => {
    const drag = dragRef.current;
    if (drag?.dragging && stripRef.current) {
      positionsRef.current = new Map(
        Array.from(stripRef.current!.querySelectorAll<HTMLElement>(".tab"), (element) => [
          element,
          element.getBoundingClientRect().left,
        ]),
      );
    }
    dragRef.current = null;
    setDraggingKey(null);
    setDropTarget(null);
    const strip = stripRef.current;
    if (drag?.dragging && strip?.hasPointerCapture(drag.pointerId))
      strip.releasePointerCapture(drag.pointerId);
    return drag;
  }, []);
  useLayoutEffect(() => {
    const drag = dragRef.current;
    if (drag && !tabs.some((tab) => tab.key === drag.key)) stopDrag();
  }, [tabs, stopDrag]);
  const updateScrollEdges = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const left = strip.scrollLeft > 1;
    const right = strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1;
    setScrollEdges((previous) =>
      previous.left === left && previous.right === right ? previous : { left, right },
    );
  }, []);
  const scrollTabs = (direction: number) => {
    const strip = stripRef.current!;
    const elements = Array.from(strip.querySelectorAll<HTMLElement>(".tab"));
    const target =
      direction < 0
        ? elements.reverse().find((element) => element.offsetLeft < strip.scrollLeft - 1)
        : elements.find((element) => element.offsetLeft > strip.scrollLeft + 1);
    strip.scrollTo({
      left: target?.offsetLeft ?? (direction < 0 ? 0 : strip.scrollWidth),
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  };
  useLayoutEffect(() => {
    const positions = positionsRef.current;
    positionsRef.current = null;
    if (positions) {
      for (const [element, left] of positions) {
        if (!element.isConnected) continue;
        element.getAnimations?.().forEach((animation) => animation.cancel());
        const delta = left - element.getBoundingClientRect().left;
        if (
          Math.abs(delta) > 0.5 &&
          !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ) {
          element.animate?.(
            [{ transform: `translateX(${delta}px)` }, { transform: "translateX(0)" }],
            { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" },
          );
        }
      }
    }
    updateScrollEdges();
  }, [tabs, draggingKey, updateScrollEdges]);
  const hasTabs = tabs.length > 0;
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const observer = new ResizeObserver(() => {
      if (!dragRef.current?.dragging)
        activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
      updateScrollEdges();
    });
    observer.observe(strip);
    return () => observer.disconnect();
  }, [hasTabs, updateScrollEdges]);
  useEffect(() => {
    window.addEventListener("blur", stopDrag);
    return () => {
      window.removeEventListener("blur", stopDrag);
      dragRef.current = null;
    };
  }, [stopDrag]);
  useLayoutEffect(() => {
    activeTabRef.current?.scrollIntoView({
      behavior: "instant",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeKey, tabs.length]);
  useLayoutEffect(() => {
    const focusedKey = focusedTabKeyRef.current;
    if (!focusedKey || tabs.some((tab) => tab.key === focusedKey)) return;
    const nextKey =
      activeKey && tabs.some((tab) => tab.key === activeKey) ? activeKey : tabs[0]?.key;
    focusedTabKeyRef.current = nextKey ?? null;
    if (nextKey) tabRefs.current.get(nextKey)?.focus();
  }, [activeKey, tabs]);
  const closeMenu = useCallback(() => setMenu(null), []);
  const target = menu && tabs.find((tab) => tab.key === menu.tab.key);
  const targetIndex = target ? tabs.indexOf(target) : -1;
  const closeGroup = (closing: EditorTab[]) => {
    closeMenu();
    onCloseTabs(closing);
  };
  const nativeAction = (action: () => Promise<void>, message?: string) => {
    closeMenu();
    void action()
      .then(() => {
        if (message) onNotice(message);
      })
      .catch((error) => onNotice(errorMessage(error)));
  };
  if (tabs.length === 0) return null;
  const nameCounts = new Map<string, number>();
  for (const tab of tabs) {
    nameCounts.set(tab.name, (nameCounts.get(tab.name) ?? 0) + 1);
  }
  const sourceIndex = tabs.findIndex((tab) => tab.key === draggingKey);
  const targetIndexForDrop = tabs.findIndex((tab) => tab.key === dropTarget?.key);
  const insertionIndex = targetIndexForDrop + (dropTarget?.after ? 1 : 0);
  const destination = dropTarget
    ? insertionIndex - (sourceIndex < insertionIndex ? 1 : 0)
    : sourceIndex;
  const dragWidth = dragRef.current?.width ?? 0;
  return (
    <>
      <div className="tab-bar">
        <div
          ref={stripRef}
          className={`tab-strip${draggingKey ? " is-dragging" : ""}`}
          role="tablist"
          aria-label="打开的文件"
          onScroll={updateScrollEdges}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              focusedTabKeyRef.current = null;
          }}
          onDragStart={(event) => event.preventDefault()}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            if (!drag.dragging && Math.abs(event.clientX - drag.x) < 5) return;
            event.preventDefault();
            const strip = event.currentTarget;
            if (!drag.dragging) {
              drag.dragging = true;
              suppressClickRef.current = true;
              setDraggingKey(drag.key);
              setMenu(null);
              strip.setPointerCapture(event.pointerId);
            }
            const rect = strip.getBoundingClientRect();
            let target: DropTarget | null = null;
            if (
              event.clientY >= rect.top &&
              event.clientY <= rect.bottom &&
              event.clientX >= rect.left &&
              event.clientX <= rect.right
            ) {
              if (event.clientX < rect.left + 24) strip.scrollLeft -= 20;
              else if (event.clientX > rect.right - 24) strip.scrollLeft += 20;
              const elements = Array.from(strip.querySelectorAll<HTMLElement>(".tab"));
              // Hit-test layout positions so the animation cannot shift its own drop target.
              const index = elements.findIndex((element) => {
                return (
                  event.clientX <
                  rect.left + element.offsetLeft - strip.scrollLeft + element.offsetWidth / 2
                );
              });
              const tab = tabs[index < 0 ? tabs.length - 1 : index];
              if (tab) target = { key: tab.key, after: index < 0 };
            }
            strip.style.setProperty(
              "--tab-drag-offset",
              `${Math.max(-drag.left, Math.min(drag.contentWidth - drag.left - drag.width, event.clientX - drag.x + strip.scrollLeft - drag.scrollLeft))}px`,
            );
            drag.target = target;
            setDropTarget((previous) =>
              previous?.key === target?.key && previous?.after === target?.after
                ? previous
                : target,
            );
          }}
          onPointerUp={(event) => {
            if (dragRef.current?.pointerId !== event.pointerId) return;
            const drag = stopDrag();
            const rect = event.currentTarget.getBoundingClientRect();
            if (
              drag?.dragging &&
              drag.target &&
              event.clientX >= rect.left &&
              event.clientX <= rect.right &&
              event.clientY >= rect.top &&
              event.clientY <= rect.bottom
            )
              onReorder?.(drag.key, drag.target.key, drag.target.after);
          }}
          onPointerCancel={stopDrag}
          onLostPointerCapture={stopDrag}
          onPointerLeave={() => {
            if (dragRef.current && !dragRef.current.dragging) stopDrag();
          }}
        >
          {tabs.map((tab, index) => {
            const showProject = (nameCounts.get(tab.name) ?? 0) > 1;
            const isDirty = dirtyKeys.has(tab.key);
            return (
              <div
                className={`tab ${tab.key === activeKey ? "is-active" : ""}${tab.key === draggingKey ? " is-dragging" : ""}`}
                style={{
                  transform:
                    tab.key === draggingKey
                      ? "translateX(var(--tab-drag-offset, 0px))"
                      : sourceIndex >= 0 && index > sourceIndex && index <= destination
                        ? `translateX(${-dragWidth}px)`
                        : sourceIndex >= 0 && index < sourceIndex && index >= destination
                          ? `translateX(${dragWidth}px)`
                          : undefined,
                }}
                data-drop={
                  dropTarget?.key === tab.key ? (dropTarget.after ? "after" : "before") : undefined
                }
                ref={tab.key === activeKey ? activeTabRef : null}
                key={tab.key}
                onFocus={() => {
                  focusedTabKeyRef.current = tab.key;
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  const trigger = event.currentTarget.querySelector<HTMLElement>(".tab-main")!;
                  const rect = trigger.getBoundingClientRect();
                  setMenu({
                    tab,
                    trigger,
                    x: event.clientX || rect.left,
                    y: event.clientY || rect.bottom,
                  });
                }}
              >
                <button
                  ref={(element) => {
                    if (element) tabRefs.current.set(tab.key, element);
                    else tabRefs.current.delete(tab.key);
                  }}
                  className="tab-main"
                  role="tab"
                  tabIndex={tab.key === activeKey ? 0 : -1}
                  aria-selected={tab.key === activeKey}
                  aria-label={`${showProject ? `${tab.projectName} ` : ""}${tab.name}${
                    isDirty ? "（未保存）" : ""
                  }`}
                  onPointerDown={(event) => {
                    suppressClickRef.current = false;
                    if (event.button !== 0 || !onReorder) return;
                    dragRef.current = {
                      key: tab.key,
                      pointerId: event.pointerId,
                      x: event.clientX,
                      width: event.currentTarget.parentElement!.offsetWidth,
                      left: event.currentTarget.parentElement!.offsetLeft,
                      contentWidth: stripRef.current!.scrollWidth,
                      scrollLeft: stripRef.current!.scrollLeft,
                      dragging: false,
                      target: null,
                    };
                  }}
                  onClick={(event) => {
                    if (suppressClickRef.current && event.detail !== 0) {
                      suppressClickRef.current = false;
                      return;
                    }
                    onActivate(tab);
                  }}
                  aria-keyshortcuts={
                    onReorder ? "Alt+Shift+ArrowLeft Alt+Shift+ArrowRight" : undefined
                  }
                  onKeyDown={(event) => {
                    if (
                      onReorder &&
                      event.altKey &&
                      event.shiftKey &&
                      ["ArrowLeft", "ArrowRight"].includes(event.key)
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      const after = event.key === "ArrowRight";
                      const target = tabs[index + (after ? 1 : -1)];
                      if (target) onReorder(tab.key, target.key, after);
                      return;
                    }
                    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                    const targetIndex =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? tabs.length - 1
                          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
                            tabs.length;
                    const target = tabs[targetIndex];
                    if (!target) return;
                    event.preventDefault();
                    event.stopPropagation();
                    tabRefs.current.get(target.key)?.focus();
                    onActivate(target);
                  }}
                  data-tooltip={`${tab.projectName}/${tab.path}${isDirty ? "（未保存）" : ""}`}
                >
                  <FileIcon name={tab.name} size={14} />
                  {showProject && <span className="tab-project">{tab.projectName}</span>}
                  <span className="tab-name">{tab.name}</span>
                  {isDirty && (
                    <span className="tab-dirty" aria-hidden>
                      ●
                    </span>
                  )}
                </button>
                <button
                  className="tab-close"
                  onClick={() => onClose(tab)}
                  data-tooltip={`关闭 ${tab.name}`}
                  aria-label={`关闭 ${tab.name}`}
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="tab-tools">
          {(scrollEdges.left || scrollEdges.right) && (
            <>
              <button
                className="tab-scroll"
                aria-label="向左滚动标签页"
                data-tooltip="向左滚动标签页"
                disabled={!scrollEdges.left}
                onClick={() => scrollTabs(-1)}
              >
                <ChevronLeft size={14} />
              </button>
              <button
                className="tab-scroll"
                aria-label="向右滚动标签页"
                data-tooltip="向右滚动标签页"
                disabled={!scrollEdges.right}
                onClick={() => scrollTabs(1)}
              >
                <ChevronRight size={14} />
              </button>
            </>
          )}
          {onToggleSplit && (
            <button
              className={`tab-split ${splitOpen ? "is-on" : ""}`}
              onClick={onToggleSplit}
              data-tooltip={splitOpen ? "关闭右侧编辑区" : "在右侧打开编辑区"}
              aria-label={splitOpen ? "关闭右侧编辑区" : "在右侧打开编辑区"}
              aria-pressed={splitOpen}
            >
              <PanelRight size={14} />
            </button>
          )}
        </div>
      </div>
      {menu && target && (
        <ContextMenu target={menu} label="标签页操作" onClose={closeMenu}>
          <button
            role="menuitem"
            onClick={() => {
              closeMenu();
              onClose(target);
            }}
          >
            关闭
          </button>
          <button
            role="menuitem"
            disabled={tabs.length < 2}
            onClick={() => closeGroup(tabs.filter((tab) => tab.key !== target.key))}
          >
            关闭其他
          </button>
          {onMoveToOtherPane && (
            <button
              role="menuitem"
              onClick={() => {
                closeMenu();
                onMoveToOtherPane(target);
              }}
            >
              移动到另一编辑区
            </button>
          )}
          <button
            role="menuitem"
            disabled={targetIndex === tabs.length - 1}
            onClick={() => closeGroup(tabs.slice(targetIndex + 1))}
          >
            关闭右侧
          </button>
          <button
            role="menuitem"
            disabled={targetIndex === 0}
            onClick={() => closeGroup(tabs.slice(0, targetIndex))}
          >
            关闭左侧
          </button>
          <button role="menuitem" onClick={() => closeGroup(tabs)}>
            关闭所有
          </button>
          <button
            role="menuitem"
            disabled={!/Mac/.test(navigator.userAgent)}
            onClick={() =>
              nativeAction(
                () => api.copyEntryPath(target.projectId, target.path, false),
                "已复制绝对路径",
              )
            }
          >
            复制绝对路径
          </button>
          <button
            role="menuitem"
            disabled={!/Mac/.test(navigator.userAgent)}
            onClick={() =>
              nativeAction(
                () => api.copyEntryPath(target.projectId, target.path, true),
                "已复制相对路径",
              )
            }
          >
            复制相对路径
          </button>
          <button
            role="menuitem"
            disabled={!/Mac/.test(navigator.userAgent)}
            onClick={() => nativeAction(() => api.revealEntry(target.projectId, target.path))}
          >
            在访达中打开
          </button>
        </ContextMenu>
      )}
    </>
  );
}
