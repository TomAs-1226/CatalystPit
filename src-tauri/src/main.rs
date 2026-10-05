// Catalyst Pit — the match-day pit companion.
//
// Catalyst installs the library, Console shows the robot while it drives, Sim is practice. This is
// the part of a competition day none of them covers: the twenty minutes between matches, in the
// pit, when the questions are "is it ready", "which battery" and "when are we up".
//
// Three rules shape the backend.
//
// **It works with no network.** The driver station laptop is usually on the robot's radio or on
// nothing. Everything is a local file; Nexus is an extra that fills in the schedule when it can be
// reached and is never waited on.
//
// **It never writes to the robot.** The one thing it reads from it is the battery voltage, over
// NetworkTables, through a client with no publish path at all (`nt.rs`). It opens no Driver Station
// connection, and never will: only the official Driver Station may.
//
// **It does not lose notes.** Saves are atomic with a backup, a damaged file is kept rather than
// overwritten, and a file from a newer build is refused untouched (`storage.rs`, and
// `src/core/store.js` for the shape).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod nexus;
mod nt;
mod settings;
mod storage;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

use settings::{Patch, PublicSettings, Settings};
use storage::Loaded;

struct AppState {
    dir: PathBuf,
    settings: Mutex<Settings>,
    robot: nt::RobotLink,
}

impl AppState {
    fn data_file(&self) -> PathBuf {
        self.dir.join("pit.json")
    }
    fn settings_file(&self) -> PathBuf {
        self.dir.join("settings.json")
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: &'static str,
    data_dir: String,
}

#[tauri::command]
fn app_info(state: tauri::State<'_, AppState>) -> AppInfo {
    AppInfo { version: env!("CARGO_PKG_VERSION"), data_dir: state.dir.to_string_lossy().to_string() }
}

/// What was on disk, and anything the crew should be told about how it was found.
#[derive(Serialize)]
struct LoadedState {
    /// The event, exactly as stored; `null` on a first run. The page migrates it.
    data: Option<Value>,
    /// Set when the backup had to be used or the file was damaged.
    notice: Option<String>,
    /// Set when the file was damaged and nothing could be recovered.
    damaged: bool,
}

#[tauri::command]
fn load_state(state: tauri::State<'_, AppState>) -> LoadedState {
    match storage::read_json(&state.data_file()) {
        Loaded::Missing => LoadedState { data: None, notice: None, damaged: false },
        Loaded::Current(value) => LoadedState { data: Some(value), notice: None, damaged: false },
        Loaded::FromBackup(value, note) => LoadedState { data: Some(value), notice: Some(note), damaged: false },
        Loaded::Damaged(note) => LoadedState { data: None, notice: Some(note), damaged: true },
    }
}

/// Save the event. The page owns the shape; this checks only that it is being handed an event at
/// all, so a bug upstairs cannot replace a day's notes with `null` or a string.
#[tauri::command]
fn save_state(state: tauri::State<'_, AppState>, data: Value) -> Result<(), String> {
    if !data.is_object() || !data.get("schema").map(Value::is_u64).unwrap_or(false) {
        return Err("Refused to save: that is not an event.".into());
    }
    storage::write_json(&state.data_file(), &data)
}

/// Keep a finished event as its own file under `archive/`, before the page starts the next one.
/// Returns the file's name.
#[tauri::command]
fn archive_event(state: tauri::State<'_, AppState>, data: Value, name: String) -> Result<String, String> {
    if !data.is_object() {
        return Err("Refused to archive: that is not an event.".into());
    }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let file = format!("{stamp}-{}.json", storage::safe_name(&name));
    storage::write_json(&state.dir.join("archive").join(&file), &data)?;
    Ok(file)
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> PublicSettings {
    PublicSettings::from(&*state.settings.lock().unwrap())
}

/// Change some settings. All of the patch is applied or none of it.
#[tauri::command]
fn set_settings(state: tauri::State<'_, AppState>, patch: Patch) -> Result<PublicSettings, String> {
    let mut settings = state.settings.lock().unwrap();
    let mut next = settings.clone();
    next.apply(patch)?;
    settings::save(&state.settings_file(), &next)?;
    *settings = next;
    state.robot.configure(settings.robot_link, settings.team);
    Ok(PublicSettings::from(&*settings))
}

/// Ask Nexus for the event. Returns its JSON for the page to read, or one sentence on why not.
#[tauri::command]
async fn nexus_fetch(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let (event_key, api_key) = {
        let s = state.settings.lock().unwrap();
        (s.event_key.clone(), s.nexus_key.clone())
    };
    // Blocking I/O, so off the async runtime's own threads.
    tauri::async_runtime::spawn_blocking(move || nexus::fetch(&event_key, &api_key))
        .await
        .map_err(|_| "The request to Nexus was interrupted.".to_string())?
}

/// Save the event report where the crew chooses. Returns the path, or `None` if they cancelled.
#[tauri::command]
async fn export_report(app: tauri::AppHandle, markdown: String, file_name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let suggested = if file_name.trim().is_empty() { "pit-report.md".to_string() } else { file_name };
    // The dialog blocks until it is answered, so it must not run on the main thread.
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Save the pit report")
            .set_file_name(suggested)
            .add_filter("Markdown", &["md"])
            .blocking_save_file()
    })
    .await
    .map_err(|_| "The save dialog was interrupted.".to_string())?;

    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    // The report is Markdown for people: plain UTF-8, no byte order mark.
    storage::write_atomic(&path, markdown.as_bytes()).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// The robot's battery voltage, if a robot is there and says. Read-only; see `nt.rs`.
#[tauri::command]
fn robot_battery(state: tauri::State<'_, AppState>) -> nt::RobotBattery {
    state.robot.snapshot()
}

fn main() {
    tauri::Builder::default()
        // Must be registered first. A second launch hands off to the Pit that is already running
        // and exits: two would be two writers on one data file.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app_info,
            load_state,
            save_state,
            archive_event,
            get_settings,
            set_settings,
            nexus_fetch,
            export_report,
            robot_battery
        ])
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let settings = settings::load(&dir.join("settings.json"));

            let robot = nt::RobotLink::new();
            robot.configure(settings.robot_link, settings.team);
            robot.spawn();

            app.manage(AppState { dir, settings: Mutex::new(settings), robot });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Catalyst Pit");
}
