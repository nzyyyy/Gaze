use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FontChoice {
    System,
    Maple,
    Consolas,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct FontSettings {
    pub ui: FontChoice,
    pub editor: FontChoice,
    pub terminal: FontChoice,
}

impl Default for FontSettings {
    fn default() -> Self {
        Self {
            ui: FontChoice::System,
            editor: FontChoice::Maple,
            terminal: FontChoice::Maple,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::Cache;

    #[tokio::test]
    async fn fonts_round_trip_and_reject_unknown_choices() {
        let settings = FontSettings {
            editor: FontChoice::Consolas,
            ..FontSettings::default()
        };
        let cache = Cache::open_in_memory().unwrap();
        cache
            .set_setting("fonts", &serde_json::to_string(&settings).unwrap())
            .await
            .unwrap();
        let stored = cache.setting("fonts").await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<FontSettings>(&stored).unwrap(),
            settings
        );
        assert_eq!(
            serde_json::from_str::<FontSettings>("{}").unwrap(),
            FontSettings::default()
        );
        assert!(serde_json::from_str::<FontSettings>(r#"{"editor":"unknown"}"#).is_err());
    }
}
