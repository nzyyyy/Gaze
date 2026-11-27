import { Fragment, lazy, Suspense } from "react";
import { BookOpen, FolderPlus, PanelRight } from "lucide-react";

import type { EditorTab } from "../editor/types";
import type { EditorDiffSnapshot } from "../git/EditorDiff";
import { t } from "../lib/i18n";
import type { EditorPane } from "../lib/types";
import { TabBar } from "./TabBar";

const EditorComparison = lazy(() =>
  import("../git/EditorDiff").then(({ EditorComparison }) => ({ default: EditorComparison })),
);

interface EditorPaneProps {
  pane: EditorPane;
  tabs: EditorTab[];
  activeKey: string | null;
  dirtyKeys: ReadonlySet<string>;
  splitOpen: boolean;
  gitOpen: boolean;
  hasPrimaryTabs: boolean;
  comparison?: {
    id: number;
    source: EditorTab;
    snapshot: EditorDiffSnapshot;
    selected: boolean;
  };
  editorFontFamily: string;
  tabSize: number;
  onActivatePane: () => void;
  onActivateTab: (tab: EditorTab) => void;
  onCloseTab: (tab: EditorTab) => void;
  onCloseTabs: (tabs: EditorTab[]) => void | Promise<void>;
  onNotice: (message: string) => void;
  onToggleSplit?: () => void;
  onMoveToOtherPane: (tab: EditorTab) => void;
  onReorder: (sourceKey: string, targetKey: string, after: boolean) => void;
  onActivateComparison: () => void;
  onCloseComparison: () => void;
  onImport: () => void | Promise<void>;
  onOpenSecondary: () => void;
}

export function EditorPaneView({
  pane,
  tabs,
  activeKey,
  dirtyKeys,
  splitOpen,
  gitOpen,
  hasPrimaryTabs,
  comparison,
  editorFontFamily,
  tabSize,
  onActivatePane,
  onActivateTab,
  onCloseTab,
  onCloseTabs,
  onNotice,
  onToggleSplit,
  onMoveToOtherPane,
  onReorder,
  onActivateComparison,
  onCloseComparison,
  onImport,
  onOpenSecondary,
}: EditorPaneProps) {
  return (
    <Fragment>
      <section className="editor-pane" data-pane={pane} onPointerDown={onActivatePane}>
        <TabBar
          tabs={tabs}
          activeKey={activeKey}
          dirtyKeys={dirtyKeys}
          onActivate={onActivateTab}
          onClose={onCloseTab}
          onCloseTabs={(closing) => void onCloseTabs(closing)}
          onNotice={onNotice}
          onToggleSplit={onToggleSplit}
          splitOpen={splitOpen}
          onMoveToOtherPane={onMoveToOtherPane}
          onReorder={onReorder}
          comparison={
            comparison
              ? {
                  name: t("对比 · {0}", comparison.source.name),
                  active: comparison.selected,
                  onActivate: onActivateComparison,
                  onClose: onCloseComparison,
                }
              : undefined
          }
        />
      </section>
      {comparison && (
        <div
          className="document-area document-panel editor-document"
          data-pane={pane}
          hidden={!comparison.selected || gitOpen}
          onPointerDown={onActivatePane}
        >
          <Suspense
            fallback={
              <div className="reader-state" role="status">
                {t("正在加载文件对比…")}
              </div>
            }
          >
            <EditorComparison
              key={comparison.id}
              snapshot={comparison.snapshot}
              path={comparison.source.path}
              fontFamily={editorFontFamily}
              tabSize={tabSize}
              onClose={onCloseComparison}
            />
          </Suspense>
        </div>
      )}
      {tabs.length === 0 && (
        <div className="document-area editor-empty" data-pane={pane} onPointerDown={onActivatePane}>
          <div className="welcome">
            <div className="welcome-mark">
              {pane === "primary" ? (
                <BookOpen size={34} strokeWidth={1.2} />
              ) : (
                <PanelRight size={30} strokeWidth={1.2} />
              )}
            </div>
            {pane === "primary" ? (
              <button className="button button-primary" onClick={() => void onImport()}>
                <FolderPlus size={15} />
                {t("导入项目")}
              </button>
            ) : (
              <>
                <button className="button button-primary" onClick={onOpenSecondary}>
                  {t("在右侧打开文件")}
                </button>
                {!hasPrimaryTabs && (
                  <button className="button" onClick={onToggleSplit}>
                    {t("关闭右侧编辑区")}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </Fragment>
  );
}
