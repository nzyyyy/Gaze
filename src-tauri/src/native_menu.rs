use serde::Deserialize;

use crate::preferences::ThemePreference;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct NativeMenuState {
    ready: bool,
    blocked: bool,
    has_file: bool,
    can_save: bool,
    can_navigate: bool,
    can_go_back: bool,
    can_go_forward: bool,
    split_open: bool,
    terminal_open: bool,
    sidebar_view: String,
    theme: ThemePreference,
    auto_save: bool,
    word_wrap: bool,
    line_numbers: bool,
    show_status_bar: bool,
}

#[cfg(any(target_os = "macos", test))]
impl NativeMenuState {
    fn enabled(&self, action: &str) -> bool {
        if !self.ready || self.blocked {
            return false;
        }
        match action {
            "save" => self.can_save,
            "close-tab" | "find" => self.has_file,
            "definition" | "references" | "implementation" => self.can_navigate,
            "back" => self.can_go_back,
            "forward" => self.can_go_forward,
            "toggle-split" => self.has_file || self.split_open,
            _ => true,
        }
    }

    fn checked(&self, action: &str) -> Option<bool> {
        Some(match action {
            "auto-save" => self.auto_save,
            "word-wrap" => self.word_wrap,
            "line-numbers" => self.line_numbers,
            "status-bar" => self.show_status_bar,
            "terminal" => self.terminal_open,
            "files" | "search" | "symbols" | "git" => self.sidebar_view == action,
            "theme-system" => matches!(self.theme, ThemePreference::System),
            "theme-light" => matches!(self.theme, ThemePreference::Light),
            "theme-dark" => matches!(self.theme, ThemePreference::Dark),
            _ => return None,
        })
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::collections::HashMap;

    use tauri::{
        menu::{
            AboutMetadata, CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu,
        },
        Emitter, Manager,
    };

    use super::NativeMenuState;

    struct NativeMenu(HashMap<String, MenuItemKind<tauri::Wry>>);

    pub fn install(app: &tauri::App) -> tauri::Result<()> {
        let action = |id: &str, text: &str, key: Option<&str>| {
            MenuItem::with_id(app, format!("gaze.{id}"), text, false, key)
        };
        let check = |id: &str, text: &str, key: Option<&str>| {
            CheckMenuItem::with_id(app, format!("gaze.{id}"), text, false, false, key)
        };
        let separator = || PredefinedMenuItem::separator(app);
        let app_menu = Submenu::with_items(
            app,
            "Gaze",
            true,
            &[
                &PredefinedMenuItem::about(
                    app,
                    Some("关于 Gaze"),
                    Some(AboutMetadata {
                        name: Some("Gaze".into()),
                        version: Some(app.package_info().version.to_string()),
                        ..Default::default()
                    }),
                )?,
                &separator()?,
                &action("settings", "设置…", Some("Cmd+,"))?,
                &separator()?,
                &PredefinedMenuItem::services(app, Some("服务"))?,
                &separator()?,
                &PredefinedMenuItem::hide(app, Some("隐藏 Gaze"))?,
                &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
                &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
                &separator()?,
                // The native quit item bypasses the editor's save/conflict protection.
                &action("quit", "退出 Gaze", Some("Cmd+Q"))?,
            ],
        )?;
        let file_menu = Submenu::with_items(
            app,
            "文件",
            true,
            &[
                &action("open-file", "打开文件…", Some("Cmd+O"))?,
                &action("import-project", "导入项目目录…", Some("Cmd+Shift+O"))?,
                &separator()?,
                &action("save", "保存", Some("Cmd+S"))?,
                &action("close-tab", "关闭标签页", Some("Cmd+W"))?,
                &separator()?,
                &check("auto-save", "自动保存", None)?,
            ],
        )?;
        let edit_menu = Submenu::with_items(
            app,
            "编辑",
            true,
            &[
                &PredefinedMenuItem::undo(app, Some("撤销"))?,
                &PredefinedMenuItem::redo(app, Some("重做"))?,
                &separator()?,
                &PredefinedMenuItem::cut(app, Some("剪切"))?,
                &PredefinedMenuItem::copy(app, Some("复制"))?,
                &PredefinedMenuItem::paste(app, Some("粘贴"))?,
                &PredefinedMenuItem::select_all(app, Some("全选"))?,
                &separator()?,
                &action("find", "文件内查找", None)?,
                &action("search-workspace", "工作区搜索", Some("Cmd+Shift+F"))?,
            ],
        )?;
        let theme_menu = Submenu::with_items(
            app,
            "主题",
            true,
            &[
                &check("theme-system", "跟随系统", None)?,
                &check("theme-light", "浅色", None)?,
                &check("theme-dark", "深色", None)?,
            ],
        )?;
        let view_menu = Submenu::with_items(
            app,
            "视图",
            true,
            &[
                &check("files", "文件侧栏", None)?,
                &check("search", "搜索侧栏", None)?,
                &check("symbols", "符号与大纲", None)?,
                &check("git", "Git 管理", Some("Cmd+Shift+G"))?,
                &separator()?,
                // The webview handles the physical key before editor and terminal keymaps.
                &check("terminal", "终端", None)?,
                &action("toggle-split", "切换右侧编辑区", Some("Cmd+Backslash"))?,
                &separator()?,
                &check("word-wrap", "自动换行", None)?,
                &check("line-numbers", "显示行号", None)?,
                &check("status-bar", "显示状态栏", None)?,
                &theme_menu,
            ],
        )?;
        let go_menu = Submenu::with_items(
            app,
            "前往",
            true,
            &[
                &action("back", "后退", Some("Cmd+Alt+Left"))?,
                &action("forward", "前进", Some("Cmd+Alt+Right"))?,
                &separator()?,
                &action("quick-open", "快速打开", Some("Cmd+P"))?,
                &separator()?,
                &action("definition", "跳转到定义", Some("F12"))?,
                &action("references", "查找引用", Some("Shift+F12"))?,
                &action("implementation", "查找实现", None)?,
            ],
        )?;
        let window_menu = Submenu::with_items(
            app,
            "窗口",
            true,
            &[
                &PredefinedMenuItem::minimize(app, Some("最小化"))?,
                &PredefinedMenuItem::maximize(app, Some("缩放"))?,
                &PredefinedMenuItem::fullscreen(app, Some("进入全屏"))?,
                &separator()?,
                &PredefinedMenuItem::bring_all_to_front(app, Some("将全部窗口置于前端"))?,
            ],
        )?;
        let menu = Menu::with_items(
            app,
            &[
                &app_menu,
                &file_menu,
                &edit_menu,
                &view_menu,
                &go_menu,
                &window_menu,
            ],
        )?;
        let mut items = HashMap::new();
        collect(menu.items()?, &mut items)?;
        app.manage(NativeMenu(items));
        app.set_menu(menu)?;
        window_menu.set_as_windows_menu_for_nsapp()?;
        app.on_menu_event(|app, event| {
            if let Some(action) = event.id().as_ref().strip_prefix("gaze.") {
                if let Err(error) = app.emit_to("main", "gaze://menu-action", action) {
                    tracing::warn!(%error, "failed to dispatch menu action");
                }
            }
        });
        Ok(())
    }

    fn collect(
        entries: Vec<MenuItemKind<tauri::Wry>>,
        items: &mut HashMap<String, MenuItemKind<tauri::Wry>>,
    ) -> tauri::Result<()> {
        for item in entries {
            if let MenuItemKind::Submenu(submenu) = &item {
                collect(submenu.items()?, items)?;
            } else if let Some(action) = item.id().as_ref().strip_prefix("gaze.") {
                items.insert(action.to_owned(), item);
            }
        }
        Ok(())
    }

    pub fn sync(app: &tauri::AppHandle, state: &NativeMenuState) -> tauri::Result<()> {
        for (action, item) in &app.state::<NativeMenu>().0 {
            match item {
                MenuItemKind::MenuItem(item) => item.set_enabled(state.enabled(action))?,
                MenuItemKind::Check(item) => {
                    item.set_enabled(state.enabled(action))?;
                    if let Some(checked) = state.checked(action) {
                        item.set_checked(checked)?;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub use macos::install;

#[tauri::command]
pub fn sync_menu_state(app: tauri::AppHandle, state: NativeMenuState) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::sync(&app, &state).map_err(|error| error.to_string());
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> NativeMenuState {
        serde_json::from_value(serde_json::json!({
            "ready": true, "blocked": false, "hasFile": false,
            "canSave": false, "canNavigate": false, "canGoBack": false, "canGoForward": false,
            "splitOpen": false, "terminalOpen": false, "sidebarView": "files", "theme": "system", "autoSave": true,
            "wordWrap": true, "lineNumbers": true, "showStatusBar": true
        }))
        .unwrap()
    }

    #[test]
    fn disables_unavailable_and_blocked_actions() {
        let mut state = state();
        assert!(state.enabled("open-file"));
        assert!(state.enabled("terminal"));
        for action in [
            "save",
            "find",
            "close-tab",
            "definition",
            "references",
            "implementation",
            "back",
            "forward",
            "toggle-split",
        ] {
            assert!(!state.enabled(action), "{action}");
        }
        state.has_file = true;
        state.can_save = true;
        state.can_navigate = true;
        state.can_go_back = true;
        state.can_go_forward = true;
        for action in [
            "save",
            "find",
            "close-tab",
            "definition",
            "terminal",
            "back",
            "forward",
            "toggle-split",
        ] {
            assert!(state.enabled(action), "{action}");
        }
        state.blocked = true;
        for action in ["save", "quit", "settings", "auto-save", "theme-light"] {
            assert!(!state.enabled(action), "{action}");
        }
        state.blocked = false;
        state.ready = false;
        assert!(!state.enabled("open-file"));
    }

    #[test]
    fn checked_items_follow_committed_settings_and_views() {
        let mut state = state();
        assert_eq!(state.checked("theme-system"), Some(true));
        assert_eq!(state.checked("theme-light"), Some(false));
        state.theme = ThemePreference::Dark;
        state.auto_save = false;
        state.sidebar_view = "git".into();
        state.terminal_open = true;
        for action in [
            "theme-dark",
            "git",
            "terminal",
            "word-wrap",
            "line-numbers",
            "status-bar",
        ] {
            assert_eq!(state.checked(action), Some(true), "{action}");
        }
        for action in ["theme-system", "theme-light", "auto-save", "files"] {
            assert_eq!(state.checked(action), Some(false), "{action}");
        }
        assert_eq!(state.checked("save"), None);
    }
}
