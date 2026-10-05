//! Where the event lives on disk, and how it gets there without being lost.
//!
//! The data is a pit crew's notes for a whole event, on a laptop that gets its lid slammed, its
//! battery pulled and its power strip kicked. So a save never writes over the file in place: it
//! writes a complete new file beside it and renames that over the old one, which the file system
//! does in one step. A crash at any point leaves either the old file or the new one, never half of
//! each. The file being replaced is first copied to `.bak`, so there is always one older copy.
//!
//! Reading is as careful in the other direction. A file that will not parse is moved aside under a
//! name that says so, never deleted and never overwritten by the next save, and the backup is tried
//! in its place.
//!
//! What is *in* the file is not this module's business. The shape and its schema version belong to
//! `src/core/store.js`; here it is JSON and nothing more.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

/// What a read found.
#[derive(Debug, PartialEq)]
pub enum Loaded {
    /// No file and no backup: a first run.
    Missing,
    /// The file, read and parsed.
    Current(Value),
    /// The file was missing or unreadable and the backup was used. The message says which, and
    /// where a damaged file was moved to.
    FromBackup(Value, String),
    /// The file was unreadable and there was no usable backup. The damaged file has been moved
    /// aside; the message says where.
    Damaged(String),
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

pub fn backup_path(path: &Path) -> PathBuf {
    sibling(path, ".bak")
}

fn parse(path: &Path) -> Option<Result<Value, String>> {
    match fs::read(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => Some(Err(e.to_string())),
        // A UTF-8 byte order mark is not JSON, but it is what Windows tools add when someone opens
        // the file to look at it and saves. Reading past it is kinder than calling the file damaged.
        Ok(bytes) => {
            let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
            Some(serde_json::from_slice::<Value>(body).map_err(|e| e.to_string()))
        }
    }
}

/// Read a JSON file, falling back to its backup.
pub fn read_json(path: &Path) -> Loaded {
    let backup = backup_path(path);
    match parse(path) {
        Some(Ok(value)) => Loaded::Current(value),
        None => match parse(&backup) {
            Some(Ok(value)) => Loaded::FromBackup(
                value,
                "The data file was missing, so the last backup was opened.".to_string(),
            ),
            _ => Loaded::Missing,
        },
        Some(Err(_)) => {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let aside = sibling(path, &format!(".damaged-{stamp}"));
            let moved = fs::rename(path, &aside).is_ok();
            let place = if moved {
                format!("It was kept as {}.", aside.file_name().unwrap_or_default().to_string_lossy())
            } else {
                "It could not be moved aside.".to_string()
            };
            match parse(&backup) {
                Some(Ok(value)) => Loaded::FromBackup(
                    value,
                    format!("The data file could not be read, so the last backup was opened. {place}"),
                ),
                _ => Loaded::Damaged(format!("The data file could not be read and there is no backup. {place}")),
            }
        }
    }
}

/// Write `bytes` to `path` so that a crash leaves the old contents or the new, never a mixture.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent directory"))?;
    fs::create_dir_all(dir)?;

    // In the same directory, so the rename below stays on one volume and is a rename, not a copy.
    let temp = sibling(path, &format!(".tmp-{}", std::process::id()));
    let written = (|| {
        let mut file = File::create(&temp)?;
        file.write_all(bytes)?;
        // Through the OS cache and onto the disk before the rename makes it the real file.
        file.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }

    // The outgoing version, kept. Only a file that parses is worth keeping as the backup: copying
    // a damaged one over a good backup would destroy the thing the backup is for.
    if matches!(parse(path), Some(Ok(_))) {
        let _ = fs::copy(path, backup_path(path));
    }

    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&temp);
            Err(e)
        }
    }
}

/// Serialise and write a JSON value. Pretty-printed: the file is small, and someone will open it.
pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let mut body = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    body.push(b'\n');
    write_atomic(path, &body).map_err(|e| e.to_string())
}

/// A file name made only of characters every file system accepts. Empty input gives "event".
pub fn safe_name(text: &str) -> String {
    let mut out = String::new();
    for c in text.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    let cut: String = trimmed.chars().take(60).collect();
    if cut.is_empty() { "event".to_string() } else { cut }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A directory of this test's own under the system temp dir, removed when it goes out of scope.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("catalyst-pit-test-{}-{n}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
        fn names(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.0)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_first_run_finds_nothing() {
        let dir = Scratch::new();
        assert_eq!(read_json(&dir.file("pit.json")), Loaded::Missing);
    }

    #[test]
    fn what_is_written_is_what_is_read() {
        let dir = Scratch::new();
        let path = dir.file("pit.json");
        let value = json!({ "schema": 1, "event": { "name": "Chezy — “Champs” ·" }, "batteries": [] });
        write_json(&path, &value).unwrap();
        assert_eq!(read_json(&path), Loaded::Current(value));
        // Plain UTF-8, no byte order mark, ends with a newline.
        let bytes = fs::read(&path).unwrap();
        assert_ne!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(bytes.last(), Some(&b'\n'));
        assert!(String::from_utf8(bytes).unwrap().contains("Chezy — “Champs” ·"));
    }

    #[test]
    fn a_save_leaves_no_temporary_file_and_keeps_the_previous_version() {
        let dir = Scratch::new();
        let path = dir.file("pit.json");
        write_json(&path, &json!({ "schema": 1, "n": 1 })).unwrap();
        assert_eq!(dir.names(), vec!["pit.json"]);
        write_json(&path, &json!({ "schema": 1, "n": 2 })).unwrap();
        assert_eq!(dir.names(), vec!["pit.json", "pit.json.bak"]);
        assert_eq!(read_json(&path), Loaded::Current(json!({ "schema": 1, "n": 2 })));
        assert_eq!(parse(&backup_path(&path)), Some(Ok(json!({ "schema": 1, "n": 1 }))));
    }

    #[test]
    fn the_directory_is_made_if_it_is_not_there() {
        let dir = Scratch::new();
        let path = dir.file("deep/er/pit.json");
        write_json(&path, &json!({ "schema": 1 })).unwrap();
        assert_eq!(read_json(&path), Loaded::Current(json!({ "schema": 1 })));
    }

    #[test]
    fn a_damaged_file_is_moved_aside_and_the_backup_opened() {
        let dir = Scratch::new();
        let path = dir.file("pit.json");
        write_json(&path, &json!({ "schema": 1, "n": 1 })).unwrap();
        write_json(&path, &json!({ "schema": 1, "n": 2 })).unwrap();
        // Half a file: what a power cut during an in-place write would have left.
        fs::write(&path, b"{ \"schema\": 1, \"n\": ").unwrap();

        match read_json(&path) {
            Loaded::FromBackup(value, note) => {
                assert_eq!(value, json!({ "schema": 1, "n": 1 }));
                assert!(note.contains("pit.json.damaged-"), "{note}");
            }
            other => panic!("expected the backup, got {other:?}"),
        }
        assert!(!path.exists(), "the damaged file is no longer where a save would overwrite it");
        let names = dir.names();
        assert!(names.iter().any(|n| n.starts_with("pit.json.damaged-")), "{names:?}");
        assert!(names.contains(&"pit.json.bak".to_string()));
    }

    #[test]
    fn a_damaged_file_with_no_backup_is_still_kept() {
        let dir = Scratch::new();
        let path = dir.file("pit.json");
        fs::write(&path, b"not json at all").unwrap();
        match read_json(&path) {
            Loaded::Damaged(note) => assert!(note.contains("no backup"), "{note}"),
            other => panic!("expected damage to be reported, got {other:?}"),
        }
        let kept = dir.names().into_iter().find(|n| n.starts_with("pit.json.damaged-")).expect("kept");
        assert_eq!(fs::read(dir.file(&kept)).unwrap(), b"not json at all");
    }

    #[test]
    fn a_damaged_file_never_replaces_a_good_backup() {
        let dir = Scratch::new();
        let path = dir.file("pit.json");
        write_json(&path, &json!({ "n": 1 })).unwrap();
        write_json(&path, &json!({ "n": 2 })).unwrap();
        fs::write(&path, b"{{{{").unwrap();
        // A save made without reading first, straight over the damage.
        write_json(&path, &json!({ "n": 3 })).unwrap();
        assert_eq!(parse(&backup_path(&path)), Some(Ok(json!({ "n": 1 }))));
        assert_eq!(read_json(&path), Loaded::Current(json!({ "n": 3 })));
    }

    #[test]
    fn a_missing_file_with_a_backup_opens_the_backup() {
        let dir = Scratch::new();
        let path = dir.file("pit.json");
        write_json(&path, &json!({ "n": 1 })).unwrap();
        write_json(&path, &json!({ "n": 2 })).unwrap();
        fs::remove_file(&path).unwrap();
        assert!(matches!(read_json(&path), Loaded::FromBackup(v, _) if v == json!({ "n": 1 })));
    }

    #[test]
    fn a_byte_order_mark_is_read_past() {
        let dir = Scratch::new();
        let path = dir.file("pit.json");
        fs::write(&path, b"\xEF\xBB\xBF{\"schema\":1}").unwrap();
        assert_eq!(read_json(&path), Loaded::Current(json!({ "schema": 1 })));
    }

    #[test]
    fn archive_names_are_safe_on_any_file_system() {
        assert_eq!(safe_name("Chezy Champs 2026"), "chezy-champs-2026");
        assert_eq!(safe_name("  ../..\\Río: Regional?  "), "r-o-regional");
        assert_eq!(safe_name("???"), "event");
        assert_eq!(safe_name(""), "event");
        assert!(safe_name(&"x".repeat(200)).len() <= 60);
    }
}
