//! Settings: the team, the Nexus event and key, the robot link and the battery thresholds.
//!
//! They live in their own file in the app's data directory, apart from the event data, for one
//! reason: the Nexus API key. It is a secret that belongs to a person's Nexus account, so it stays
//! out of the file a crew might email to a mentor or attach to a report, and it never leaves this
//! process except in the header of a request to Nexus. The webview is told only whether a key is
//! set (`PublicSettings`), never what it is.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::storage::{self, Loaded};

/// The team whose robot code Catalyst was first written for. Only a starting value.
pub const DEFAULT_TEAM: u16 = 5805;

pub const SCHEMA: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub schema: u32,
    pub team: u16,
    /// The Nexus event key, such as `2026casd`. Empty when Nexus is not in use.
    pub event_key: String,
    /// The Nexus API key. Never serialised to the webview.
    pub nexus_key: String,
    /// Whether to look for the robot on NetworkTables for its battery voltage.
    pub robot_link: bool,
    /// A "ready" battery resting below this is flagged.
    pub low_rest_volts: f64,
    /// A battery at or above this internal resistance is flagged.
    pub weak_milliohm: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema: SCHEMA,
            team: DEFAULT_TEAM,
            event_key: String::new(),
            nexus_key: String::new(),
            robot_link: true,
            low_rest_volts: 12.5,
            weak_milliohm: 20.0,
        }
    }
}

/// What the webview may see.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicSettings {
    pub team: u16,
    pub event_key: String,
    pub has_nexus_key: bool,
    pub robot_link: bool,
    pub low_rest_volts: f64,
    pub weak_milliohm: f64,
}

impl From<&Settings> for PublicSettings {
    fn from(s: &Settings) -> Self {
        Self {
            team: s.team,
            event_key: s.event_key.clone(),
            has_nexus_key: !s.nexus_key.is_empty(),
            robot_link: s.robot_link,
            low_rest_volts: s.low_rest_volts,
            weak_milliohm: s.weak_milliohm,
        }
    }
}

/// A change to some of the settings. A field left out is left alone; `nexus_key: ""` clears the key.
#[derive(Deserialize, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Patch {
    pub team: Option<u32>,
    pub event_key: Option<String>,
    pub nexus_key: Option<String>,
    pub robot_link: Option<bool>,
    pub low_rest_volts: Option<f64>,
    pub weak_milliohm: Option<f64>,
}

/// An event key as Nexus and The Blue Alliance write them: lower-case letters and digits. Empty is
/// allowed and means "no event". Anything else is refused here, because the key goes into a URL.
pub fn clean_event_key(text: &str) -> Result<String, String> {
    let key = text.trim().to_ascii_lowercase();
    if key.is_empty() {
        return Ok(key);
    }
    if key.len() > 32 || !key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) {
        return Err("An event key is letters and digits only, such as 2026casd.".into());
    }
    Ok(key)
}

/// An API key as it will go into a request header: visible ASCII, no spaces, no line breaks.
pub fn clean_api_key(text: &str) -> Result<String, String> {
    let key = text.trim().to_string();
    if key.len() > 256 || !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err("That does not look like an API key: it has spaces or characters a key cannot contain.".into());
    }
    Ok(key)
}

impl Settings {
    /// Apply a patch, or change nothing and say what was wrong with it.
    pub fn apply(&mut self, patch: Patch) -> Result<(), String> {
        let mut next = self.clone();
        if let Some(team) = patch.team {
            if team == 0 || team > 9999 {
                return Err("A team number is between 1 and 9999.".into());
            }
            next.team = team as u16;
        }
        if let Some(key) = patch.event_key {
            next.event_key = clean_event_key(&key)?;
        }
        if let Some(key) = patch.nexus_key {
            next.nexus_key = clean_api_key(&key)?;
        }
        if let Some(on) = patch.robot_link {
            next.robot_link = on;
        }
        if let Some(v) = patch.low_rest_volts {
            if !v.is_finite() || !(10.0..=14.0).contains(&v) {
                return Err("The resting-voltage limit is between 10 and 14 volts.".into());
            }
            next.low_rest_volts = v;
        }
        if let Some(r) = patch.weak_milliohm {
            if !r.is_finite() || !(5.0..=100.0).contains(&r) {
                return Err("The resistance limit is between 5 and 100 milliohms.".into());
            }
            next.weak_milliohm = r;
        }
        *self = next;
        Ok(())
    }
}

/// Missing, unreadable or malformed settings fall back to the defaults, field by field. A bad
/// preferences file must never be the reason a drive team has no checklist.
pub fn load(path: &Path) -> Settings {
    let value = match storage::read_json(path) {
        Loaded::Current(v) | Loaded::FromBackup(v, _) => v,
        Loaded::Missing | Loaded::Damaged(_) => return Settings::default(),
    };
    let mut settings: Settings = serde_json::from_value(value).unwrap_or_default();
    // Whatever was on disk goes through the same checks a change from the UI would.
    let defaults = Settings::default();
    if settings.team == 0 || settings.team > 9999 {
        settings.team = defaults.team;
    }
    settings.event_key = clean_event_key(&settings.event_key).unwrap_or_default();
    settings.nexus_key = clean_api_key(&settings.nexus_key).unwrap_or_default();
    if !settings.low_rest_volts.is_finite() || !(10.0..=14.0).contains(&settings.low_rest_volts) {
        settings.low_rest_volts = defaults.low_rest_volts;
    }
    if !settings.weak_milliohm.is_finite() || !(5.0..=100.0).contains(&settings.weak_milliohm) {
        settings.weak_milliohm = defaults.weak_milliohm;
    }
    settings.schema = SCHEMA;
    settings
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    let value = serde_json::to_value(settings).map_err(|e| e.to_string())?;
    storage::write_json(path, &value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("catalyst-pit-settings-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn defaults_are_team_5805_with_nexus_off() {
        let s = Settings::default();
        assert_eq!(s.team, 5805);
        assert!(s.event_key.is_empty() && s.nexus_key.is_empty());
        assert_eq!(PublicSettings::from(&s).has_nexus_key, false);
    }

    #[test]
    fn the_webview_is_told_a_key_exists_and_never_what_it_is() {
        let mut s = Settings::default();
        s.apply(Patch { nexus_key: Some("  sk_live_ABC123-xyz  ".into()), ..Default::default() }).unwrap();
        assert_eq!(s.nexus_key, "sk_live_ABC123-xyz");
        let public = serde_json::to_string(&PublicSettings::from(&s)).unwrap();
        assert!(public.contains("\"hasNexusKey\":true"), "{public}");
        assert!(!public.contains("sk_live"), "{public}");
        assert!(!public.to_lowercase().contains("nexuskey\":\""), "{public}");
    }

    #[test]
    fn a_patch_changes_only_what_it_names() {
        let mut s = Settings::default();
        s.apply(Patch { nexus_key: Some("k".into()), event_key: Some(" 2026CASD ".into()), ..Default::default() }).unwrap();
        s.apply(Patch { team: Some(254), ..Default::default() }).unwrap();
        assert_eq!((s.team, s.event_key.as_str(), s.nexus_key.as_str()), (254, "2026casd", "k"));
        s.apply(Patch { nexus_key: Some(String::new()), ..Default::default() }).unwrap();
        assert!(s.nexus_key.is_empty(), "an empty key clears it");
        assert_eq!(s.event_key, "2026casd");
    }

    #[test]
    fn a_bad_patch_changes_nothing_at_all() {
        let mut s = Settings::default();
        let before = s.clone();
        // The team is fine; the event key is not. Neither is applied.
        assert!(s.apply(Patch { team: Some(254), event_key: Some("2026/../x".into()), ..Default::default() }).is_err());
        assert_eq!(s, before);
        assert!(s.apply(Patch { team: Some(0), ..Default::default() }).is_err());
        assert!(s.apply(Patch { team: Some(10000), ..Default::default() }).is_err());
        assert!(s.apply(Patch { nexus_key: Some("two words".into()), ..Default::default() }).is_err());
        assert!(s.apply(Patch { nexus_key: Some("key\r\nX-Injected: 1".into()), ..Default::default() }).is_err());
        assert!(s.apply(Patch { low_rest_volts: Some(f64::NAN), ..Default::default() }).is_err());
        assert!(s.apply(Patch { low_rest_volts: Some(3.0), ..Default::default() }).is_err());
        assert!(s.apply(Patch { weak_milliohm: Some(0.0), ..Default::default() }).is_err());
        assert_eq!(s, before);
    }

    #[test]
    fn settings_round_trip_through_the_file() {
        let path = scratch("roundtrip");
        let mut s = Settings::default();
        s.apply(Patch { team: Some(1678), event_key: Some("2026cc".into()), nexus_key: Some("abc".into()), robot_link: Some(false), low_rest_volts: Some(12.6), weak_milliohm: Some(18.0) }).unwrap();
        save(&path, &s).unwrap();
        assert_eq!(load(&path), s);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"eventKey\": \"2026cc\""), "{text}");
        assert!(text.contains("\"schema\": 1"), "{text}");
    }

    #[test]
    fn missing_or_broken_settings_are_the_defaults_and_bad_fields_are_replaced() {
        let path = scratch("broken");
        assert_eq!(load(&path), Settings::default());
        std::fs::write(&path, b"{ nope").unwrap();
        assert_eq!(load(&path), Settings::default());

        let path = scratch("fields");
        std::fs::write(&path, br#"{ "team": 0, "eventKey": "BAD KEY!", "nexusKey": "ok-key", "lowRestVolts": 99, "robotLink": false }"#).unwrap();
        let s = load(&path);
        assert_eq!(s.team, 5805);
        assert_eq!(s.event_key, "");
        assert_eq!(s.nexus_key, "ok-key");
        assert_eq!(s.low_rest_volts, 12.5);
        assert_eq!(s.weak_milliohm, 20.0, "a field the file lacks is the default");
        assert_eq!(s.robot_link, false);
    }
}
