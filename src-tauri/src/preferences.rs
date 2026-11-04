use crate::{
    cache::Cache,
    color_schemes::ColorSchemes,
    error::{GazeError, GazeResult},
    fonts::FontSettings,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub editor_font_size: f64,
    pub editor_line_height: f64,
    pub tab_size: f64,
    pub word_wrap: bool,
    pub line_numbers: bool,
    pub show_minimap: bool,
    pub highlight_active_line: bool,
    pub code_folding: bool,
    pub match_brackets: bool,
    pub indent_with_tab: bool,
    pub auto_save: bool,
    pub auto_save_delay: f64,
    pub search_case_sensitive: bool,
    pub search_regex: bool,
    pub search_hidden: bool,
    pub search_ignored: bool,
    pub terminal_font_size: f64,
    pub terminal_line_height: f64,
    pub terminal_scrollback: f64,
    pub terminal_cursor_blink: bool,
    pub show_status_bar: bool,
    pub show_language: bool,
    pub show_encoding: bool,
    pub show_line_count: bool,
    pub show_terminal_button: bool,
    pub terminal_cursor_style: CursorStyle,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CursorStyle {
    #[default]
    Block,
    Underline,
    Bar,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            editor_font_size: 13.5,
            editor_line_height: 1.65,
            tab_size: 4.0,
            word_wrap: true,
            line_numbers: true,
            show_minimap: true,
            highlight_active_line: true,
            code_folding: true,
            match_brackets: true,
            indent_with_tab: true,
            auto_save: true,
            auto_save_delay: 800.0,
            search_case_sensitive: false,
            search_regex: false,
            search_hidden: false,
            search_ignored: false,
            terminal_font_size: 13.0,
            terminal_line_height: 1.0,
            terminal_scrollback: 5000.0,
            terminal_cursor_blink: true,
            show_status_bar: true,
            show_language: true,
            show_encoding: true,
            show_line_count: true,
            show_terminal_button: true,
            terminal_cursor_style: CursorStyle::Block,
        }
    }
}

impl Preferences {
    pub fn validate(&self) -> GazeResult<()> {
        for (value, min, max, step, label) in [
            (self.editor_font_size, 10.0, 32.0, 0.5, "编辑器字号"),
            (self.editor_line_height, 1.2, 2.4, 0.05, "编辑器行高"),
            (self.tab_size, 1.0, 8.0, 1.0, "缩进宽度"),
            (self.auto_save_delay, 200.0, 10000.0, 100.0, "自动保存延迟"),
            (self.terminal_font_size, 10.0, 32.0, 1.0, "终端字号"),
            (self.terminal_line_height, 1.0, 2.0, 0.1, "终端行高"),
            (
                self.terminal_scrollback,
                100.0,
                100000.0,
                100.0,
                "终端回滚行数",
            ),
        ] {
            let steps = (value - min) / step;
            if !value.is_finite()
                || !(min..=max).contains(&value)
                || (steps - steps.round()).abs() > 0.00001
            {
                return Err(GazeError::Message(format!("{label}超出允许范围。")));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettings {
    pub theme: ThemePreference,
    pub fonts: FontSettings,
    pub color_schemes: ColorSchemes,
    pub preferences: Preferences,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    System,
    Light,
    Dark,
}

impl AppSettings {
    pub async fn save(&self, cache: &Cache) -> GazeResult<()> {
        self.preferences.validate()?;
        let value = serde_json::to_value(self).map_err(|e| GazeError::Message(e.to_string()))?;
        cache
            .set_settings(vec![
                (
                    "theme".into(),
                    match self.theme {
                        ThemePreference::System => "system",
                        ThemePreference::Light => "light",
                        ThemePreference::Dark => "dark",
                    }
                    .to_owned(),
                ),
                ("fonts".into(), value["fonts"].to_string()),
                ("color_schemes".into(), value["colorSchemes"].to_string()),
                ("preferences".into(), value["preferences"].to_string()),
            ])
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn preferences_validate_and_round_trip_with_existing_settings() {
        let defaults = Preferences::default();
        assert_eq!(serde_json::from_str::<Preferences>("{}").unwrap(), defaults);
        assert!(defaults.show_minimap);
        defaults.validate().unwrap();
        let mut settings = AppSettings {
            theme: ThemePreference::Dark,
            fonts: FontSettings::default(),
            color_schemes: ColorSchemes::default(),
            preferences: Preferences {
                word_wrap: false,
                show_minimap: false,
                terminal_font_size: 16.0,
                ..defaults.clone()
            },
        };
        let cache = Cache::open_in_memory().unwrap();
        settings.save(&cache).await.unwrap();
        assert_eq!(
            cache.setting("theme").await.unwrap().as_deref(),
            Some("dark")
        );
        assert_eq!(
            serde_json::from_str::<Preferences>(
                &cache.setting("preferences").await.unwrap().unwrap()
            )
            .unwrap(),
            settings.preferences
        );
        assert!(cache.setting("fonts").await.unwrap().is_some());
        assert!(cache.setting("color_schemes").await.unwrap().is_some());
        settings.preferences.tab_size = 2.5;
        settings.theme = ThemePreference::Light;
        assert!(settings.save(&cache).await.is_err());
        assert_eq!(
            cache.setting("theme").await.unwrap().as_deref(),
            Some("dark")
        );
        let value = serde_json::to_value(&defaults).unwrap();
        for (key, number) in value.as_object().unwrap() {
            if !number.is_number() {
                continue;
            }
            for invalid in [-1.0, 1_000_000.0] {
                let mut bad = value.clone();
                bad[key] = serde_json::json!(invalid);
                assert!(
                    serde_json::from_value::<Preferences>(bad)
                        .unwrap()
                        .validate()
                        .is_err(),
                    "{key}"
                );
            }
        }
        assert!(
            serde_json::from_str::<Preferences>(r#"{"terminalCursorStyle":"unknown"}"#).is_err()
        );
        assert!(serde_json::from_str::<Preferences>(r#"{"other":true}"#).is_err());
    }
}
