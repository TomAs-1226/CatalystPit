//! A read-only NetworkTables 4 client that knows one thing: the robot's battery voltage.
//!
//! This is Catalyst Console's client (`CatalystConsole/src-tauri/src/nt4.rs`) with everything but
//! reading taken out. The connection, the subscribe message, the timestamp keepalive and the value
//! decoding are that file's, which has been run against real robots; what was removed is the whole
//! write path. There is no `publish` message in this file, no value frame is ever built except the
//! timestamp ping the protocol requires, and there is no function that takes a value to send. A
//! test at the bottom fails the build if a publish ever appears.
//!
//! It subscribes to three topics, the same three and in the same order Console's battery reads:
//! WPILib does not put battery voltage on NetworkTables by itself, so the reading exists only when
//! robot code publishes it, and Catalyst robots do under one of these names.
//!
//! No robot is the normal state in a pit. The client retries forever in the background and reports
//! "not connected"; nothing in the app waits on it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::json;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

/// The battery topics, most specific first. The first one that has a value is the one shown.
pub const BATTERY_TOPICS: [&str; 3] = [
    "/Catalyst/Status/BatteryVolts",
    "/Catalyst/Brownout/MeasuredVoltage",
    "/Catalyst/Systemcore/BatteryVolts",
];

/// A reading older than this is not shown: the robot has stopped saying it.
const FRESH_FOR: Duration = Duration::from_secs(5);

/// What the page is told.
#[derive(Clone, Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RobotBattery {
    /// Whether looking for the robot is switched on in Settings.
    pub enabled: bool,
    pub connected: bool,
    /// The address that answered, when connected.
    pub address: String,
    /// The voltage, when the robot publishes one and it is fresh. Otherwise absent, never zero.
    pub volts: Option<f64>,
    /// The topic the voltage came from.
    pub topic: Option<String>,
}

/// Robot addresses, tried in turn. Console's list, for the same reasons: the Systemcore's mDNS
/// name, USB tether and own Wi-Fi, the team's static address, then the roboRIO's names.
pub fn candidate_addresses(team: u16) -> Vec<String> {
    vec![
        "127.0.0.1".to_string(),
        "robot.local".to_string(),
        "172.26.0.1".to_string(),
        "172.30.0.1".to_string(),
        "172.27.0.1".to_string(),
        format!("10.{}.{}.2", team / 100, team % 100),
        format!("roborio-{team}-frc.local"),
        "172.22.11.2".to_string(),
    ]
}

#[derive(Default)]
struct Shared {
    connected: bool,
    address: String,
    /// Topic name to its latest value and when it arrived.
    values: HashMap<String, (f64, Instant)>,
}

pub struct RobotLink {
    shared: Arc<Mutex<Shared>>,
    enabled: Arc<AtomicBool>,
    addresses: Arc<Mutex<Vec<String>>>,
    spawned: AtomicBool,
}

impl RobotLink {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Mutex::new(Shared::default())),
            enabled: Arc::new(AtomicBool::new(false)),
            addresses: Arc::new(Mutex::new(Vec::new())),
            spawned: AtomicBool::new(false),
        }
    }

    /// Switch the link on or off and say which team's robot to look for. Off drops any connection
    /// within a second and forgets what it had read.
    pub fn configure(&self, enabled: bool, team: u16) {
        *self.addresses.lock().unwrap() = candidate_addresses(team);
        self.enabled.store(enabled, Ordering::Relaxed);
        if !enabled {
            let mut shared = self.shared.lock().unwrap();
            shared.connected = false;
            shared.values.clear();
        }
    }

    pub fn snapshot(&self) -> RobotBattery {
        let enabled = self.enabled.load(Ordering::Relaxed);
        let shared = self.shared.lock().unwrap();
        let (volts, topic) = pick(&shared.values, Instant::now());
        RobotBattery {
            enabled,
            connected: enabled && shared.connected,
            address: if enabled && shared.connected { shared.address.clone() } else { String::new() },
            volts: if enabled && shared.connected { volts } else { None },
            topic: if enabled && shared.connected { topic } else { None },
        }
    }

    /// Start the connect-forever thread. Returns at once.
    pub fn spawn(&self) {
        if self.spawned.swap(true, Ordering::Relaxed) {
            return;
        }
        let shared = Arc::clone(&self.shared);
        let enabled = Arc::clone(&self.enabled);
        let addresses = Arc::clone(&self.addresses);

        std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() else {
                eprintln!("[nt] could not start a runtime; the robot battery reading is off");
                return;
            };
            rt.block_on(async move {
                let mut index = 0usize;
                loop {
                    if !enabled.load(Ordering::Relaxed) {
                        tokio::time::sleep(Duration::from_millis(700)).await;
                        continue;
                    }
                    let address = {
                        let list = addresses.lock().unwrap();
                        if list.is_empty() {
                            None
                        } else {
                            let picked = list[index % list.len()].clone();
                            index += 1;
                            Some(picked)
                        }
                    };
                    let Some(address) = address else {
                        tokio::time::sleep(Duration::from_millis(700)).await;
                        continue;
                    };

                    // Errors are not logged: with no robot every address fails every cycle, all day.
                    let _ = run_session(&address, &shared, &enabled).await;
                    {
                        let mut s = shared.lock().unwrap();
                        s.connected = false;
                        s.values.clear();
                    }
                    tokio::time::sleep(Duration::from_millis(600)).await;
                }
            });
        });
    }
}

/// The freshest value among the battery topics, in their order of preference.
fn pick(values: &HashMap<String, (f64, Instant)>, now: Instant) -> (Option<f64>, Option<String>) {
    for topic in BATTERY_TOPICS {
        if let Some((volts, at)) = values.get(topic) {
            // A battery is between nothing and a charger's float voltage. Anything else on the
            // topic is not a battery reading, and is not shown as one.
            if now.duration_since(*at) <= FRESH_FOR && volts.is_finite() && (0.0..=20.0).contains(volts) {
                return (Some(*volts), Some(topic.to_string()));
            }
        }
    }
    (None, None)
}

fn now_micros() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

/// The subscribe message: the three battery topics by exact name, twice a second. Nothing else is
/// asked for, so a robot with five hundred topics sends this app three numbers.
fn subscribe_message() -> String {
    json!([{
        "method": "subscribe",
        "params": { "topics": BATTERY_TOPICS, "subuid": 1, "options": { "periodic": 0.5 } }
    }])
    .to_string()
}

async fn run_session(address: &str, shared: &Arc<Mutex<Shared>>, enabled: &Arc<AtomicBool>) -> Result<(), String> {
    let url = format!("ws://{address}:5810/nt/catalyst-pit");
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    request
        .headers_mut()
        .insert("Sec-WebSocket-Protocol", HeaderValue::from_static("networktables.first.wpi.edu"));

    let connect = tokio_tungstenite::connect_async(request);
    let (stream, _) = tokio::time::timeout(Duration::from_millis(1200), connect)
        .await
        .map_err(|_| "connect timed out".to_string())?
        .map_err(|e| e.to_string())?;
    let (mut write, mut read) = stream.split();

    write.send(Message::Text(subscribe_message())).await.map_err(|e| e.to_string())?;
    {
        let mut s = shared.lock().unwrap();
        s.connected = true;
        s.address = address.to_string();
    }

    let mut topics: HashMap<i64, String> = HashMap::new();
    let mut last_ping = tokio::time::Instant::now() - Duration::from_secs(10);

    loop {
        if !enabled.load(Ordering::Relaxed) {
            return Ok(());
        }

        // The timestamp handshake, which is also the keepalive. It is the one binary frame this
        // client sends, and it is addressed to topic id -1, which is the protocol and not a topic.
        if last_ping.elapsed() > Duration::from_secs(1) {
            last_ping = tokio::time::Instant::now();
            let ping = rmpv::Value::Array(vec![
                rmpv::Value::from(-1i64),
                rmpv::Value::from(0u64),
                rmpv::Value::from(1i64),
                rmpv::Value::from(now_micros()),
            ]);
            let mut buf = Vec::new();
            if rmpv::encode::write_value(&mut buf, &ping).is_ok() {
                let _ = write.send(Message::Binary(buf)).await;
            }
        }

        let msg = tokio::select! {
            incoming = read.next() => match incoming {
                None => return Err("socket closed".into()),
                Some(Err(e)) => return Err(e.to_string()),
                Some(Ok(m)) => m,
            },
            _ = tokio::time::sleep(Duration::from_millis(400)) => continue,
        };

        match msg {
            Message::Text(text) => handle_control(&text, &mut topics),
            Message::Binary(bytes) => {
                let readings = decode_values(&bytes, &topics);
                if !readings.is_empty() {
                    let now = Instant::now();
                    let mut s = shared.lock().unwrap();
                    for (name, value) in readings {
                        s.values.insert(name, (value, now));
                    }
                }
            }
            Message::Close(_) => return Err("server closed".into()),
            Message::Ping(p) => {
                let _ = write.send(Message::Pong(p)).await;
            }
            _ => {}
        }
    }
}

/// JSON control frames. Only announcements matter: they turn the integer id in a binary frame
/// into a topic name. Only the battery topics are kept, whatever the server announces.
fn handle_control(text: &str, topics: &mut HashMap<i64, String>) {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text) else { return };
    let Some(items) = parsed.as_array() else { return };
    for item in items {
        let method = item.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = item.get("params");
        let id = params.and_then(|p| p.get("id")).and_then(|i| i.as_i64());
        match (method, id) {
            ("announce", Some(id)) => {
                if let Some(name) = params.and_then(|p| p.get("name")).and_then(|n| n.as_str()) {
                    if BATTERY_TOPICS.contains(&name) {
                        topics.insert(id, name.to_string());
                    }
                }
            }
            ("unannounce", Some(id)) => {
                topics.remove(&id);
            }
            _ => {}
        }
    }
}

/// Binary frames: msgpack arrays of `[topicId, timestampMicros, typeId, value]`, end to end. Topic
/// id -1 is the timestamp reply. Only numbers on known topics come out.
fn decode_values(bytes: &[u8], topics: &HashMap<i64, String>) -> Vec<(String, f64)> {
    let mut cursor = bytes;
    let mut out = Vec::new();
    while !cursor.is_empty() {
        let Ok(value) = rmpv::decode::read_value(&mut cursor) else { break };
        let Some(frame) = value.as_array() else { continue };
        if frame.len() < 4 {
            continue;
        }
        let Some(name) = frame[0].as_i64().and_then(|id| topics.get(&id)) else { continue };
        let number = match &frame[3] {
            rmpv::Value::F64(f) => Some(*f),
            rmpv::Value::F32(f) => Some(f64::from(*f)),
            rmpv::Value::Integer(i) => i.as_f64(),
            _ => None,
        };
        if let Some(n) = number {
            out.push((name.clone(), n));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(id: i64, value: rmpv::Value) -> Vec<u8> {
        let mut buf = Vec::new();
        let f = rmpv::Value::Array(vec![rmpv::Value::from(id), rmpv::Value::from(123u64), rmpv::Value::from(1i64), value]);
        rmpv::encode::write_value(&mut buf, &f).unwrap();
        buf
    }

    fn announced() -> HashMap<i64, String> {
        let mut topics = HashMap::new();
        handle_control(
            r#"[{"method":"announce","params":{"name":"/Catalyst/Status/BatteryVolts","id":7,"type":"double","properties":{}}},
                {"method":"announce","params":{"name":"/Catalyst/Brownout/MeasuredVoltage","id":8,"type":"double","properties":{}}},
                {"method":"announce","params":{"name":"/SmartDashboard/Secret","id":9,"type":"double","properties":{}}}]"#,
            &mut topics,
        );
        topics
    }

    #[test]
    fn this_file_never_publishes() {
        // The rule the app is built on: it reads the robot and never writes to it. NT4 writes with
        // a "publish" control message, so its absence from this source is the rule, checked.
        let source = include_str!("nt.rs");
        let needle = ["\"method\": \"pub", "lish\""].concat();
        assert!(!source.contains(&needle), "nt.rs must not contain an NT4 publish message");
        let needle = ["\"setprop", "erties\""].concat();
        assert!(!source.contains(&needle), "nor change a topic's properties");
        // And the only method it does send is subscribe.
        let message: serde_json::Value = serde_json::from_str(&subscribe_message()).unwrap();
        let methods: Vec<&str> = message.as_array().unwrap().iter().map(|m| m["method"].as_str().unwrap()).collect();
        assert_eq!(methods, vec!["subscribe"]);
    }

    #[test]
    fn it_asks_for_the_battery_topics_and_nothing_else() {
        let message: serde_json::Value = serde_json::from_str(&subscribe_message()).unwrap();
        let params = &message[0]["params"];
        assert_eq!(params["topics"], json!(BATTERY_TOPICS));
        assert!(params["options"].get("prefix").is_none(), "exact names, not a subtree");
    }

    #[test]
    fn only_battery_topics_are_kept_from_the_announcements() {
        let topics = announced();
        assert_eq!(topics.len(), 2);
        assert_eq!(topics.get(&7).map(String::as_str), Some("/Catalyst/Status/BatteryVolts"));
        assert!(topics.get(&9).is_none());
    }

    #[test]
    fn value_frames_decode_and_everything_else_is_ignored() {
        let topics = announced();
        let mut bytes = frame(7, rmpv::Value::F64(12.63));
        bytes.extend(frame(-1, rmpv::Value::from(99u64)));          // the timestamp reply
        bytes.extend(frame(9, rmpv::Value::F64(1.0)));              // not a battery topic
        bytes.extend(frame(8, rmpv::Value::from("twelve")));        // not a number
        bytes.extend(frame(8, rmpv::Value::F32(12.5)));
        assert_eq!(
            decode_values(&bytes, &topics),
            vec![("/Catalyst/Status/BatteryVolts".to_string(), 12.63), ("/Catalyst/Brownout/MeasuredVoltage".to_string(), 12.5)]
        );
        assert!(decode_values(&[0xc1, 0xff, 0x00], &topics).is_empty(), "garbage is nothing, not a panic");
    }

    #[test]
    fn the_preferred_topic_wins_and_a_stale_or_absurd_reading_is_not_shown() {
        let now = Instant::now();
        let mut values = HashMap::new();
        values.insert(BATTERY_TOPICS[1].to_string(), (12.4, now));
        assert_eq!(pick(&values, now), (Some(12.4), Some(BATTERY_TOPICS[1].to_string())));

        values.insert(BATTERY_TOPICS[0].to_string(), (12.7, now));
        assert_eq!(pick(&values, now).0, Some(12.7));

        // The preferred topic went quiet six seconds ago; the other is still talking.
        let later = now + Duration::from_secs(6);
        values.insert(BATTERY_TOPICS[1].to_string(), (12.3, later));
        assert_eq!(pick(&values, later), (Some(12.3), Some(BATTERY_TOPICS[1].to_string())));

        let mut odd = HashMap::new();
        odd.insert(BATTERY_TOPICS[0].to_string(), (480.0, now));
        assert_eq!(pick(&odd, now), (None, None));
        odd.insert(BATTERY_TOPICS[0].to_string(), (f64::NAN, now));
        assert_eq!(pick(&odd, now), (None, None));
        assert_eq!(pick(&HashMap::new(), now), (None, None));
    }

    #[test]
    fn switched_off_it_reports_nothing_even_if_it_had_a_reading() {
        let link = RobotLink::new();
        link.configure(true, 5805);
        {
            let mut s = link.shared.lock().unwrap();
            s.connected = true;
            s.address = "10.58.5.2".into();
            s.values.insert(BATTERY_TOPICS[0].to_string(), (12.8, Instant::now()));
        }
        let on = link.snapshot();
        assert_eq!((on.enabled, on.connected, on.volts), (true, true, Some(12.8)));
        assert_eq!(on.address, "10.58.5.2");

        link.configure(false, 5805);
        assert_eq!(link.snapshot(), RobotBattery::default());
    }

    #[test]
    fn the_team_number_makes_the_static_address() {
        let list = candidate_addresses(5805);
        assert!(list.contains(&"10.58.5.2".to_string()));
        assert!(list.contains(&"roborio-5805-frc.local".to_string()));
        assert!(candidate_addresses(254).contains(&"10.2.54.2".to_string()));
    }
}
