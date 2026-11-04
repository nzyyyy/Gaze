use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ColorScheme {
    #[default]
    Github,
    Catppuccin,
    Nord,
    Original,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ColorSchemes {
    pub light: ColorScheme,
    pub dark: ColorScheme,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::Cache;

    #[tokio::test]
    async fn schemes_round_trip_and_validate() {
        let settings = ColorSchemes {
            light: ColorScheme::Catppuccin,
            dark: ColorScheme::Nord,
        };
        let cache = Cache::open_in_memory().unwrap();
        cache
            .set_setting("color_schemes", &serde_json::to_string(&settings).unwrap())
            .await
            .unwrap();
        let stored = cache.setting("color_schemes").await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<ColorSchemes>(&stored).unwrap(),
            settings
        );
        assert_eq!(
            serde_json::from_str::<ColorSchemes>("{}").unwrap(),
            ColorSchemes::default()
        );
        assert_eq!(
            serde_json::from_str::<ColorSchemes>(r#"{"dark":"nord"}"#)
                .unwrap()
                .light,
            ColorScheme::Github
        );
        assert!(serde_json::from_str::<ColorSchemes>(r#"{"light":"unknown"}"#).is_err());
        assert!(serde_json::from_str::<ColorSchemes>(r#"{"other":"nord"}"#).is_err());
    }
}
