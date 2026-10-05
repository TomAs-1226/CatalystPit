//! The one request this app makes to the internet: the Nexus for FRC event status.
//!
//! `GET https://frc.nexus/api/v1/event/{eventKey}` with the key in a `Nexus-Api-Key` header. The
//! header name was established by the team's scouting portal: a request carrying it with a bad
//! value is answered 403 (key recognised, invalid), where any other header, or none, is answered
//! 401 (key missing).
//!
//! The request is made here rather than from the webview so that the key never enters the page,
//! and so the page's content security policy can stay closed to the network entirely. The response
//! body is handed up as JSON without interpretation; reading it is `src/core/queue.js`'s job, where
//! it is tested against a fixture.
//!
//! Failure is ordinary. A venue's network is bad, and the driver station laptop is often on the
//! robot's radio with no route out at all. Every failure comes back as one plain sentence, and
//! nothing an upstream server said is ever relayed.

use std::time::Duration;

use serde_json::Value;

use crate::settings::clean_event_key;

pub const BASE: &str = "https://frc.nexus/api/v1";
pub const KEY_HEADER: &str = "Nexus-Api-Key";

/// Larger than any event's status by a wide margin; a response past it is not what was asked for.
const MAX_BODY: u64 = 4 * 1024 * 1024;

pub fn event_url(base: &str, event_key: &str) -> Result<String, String> {
    let key = clean_event_key(event_key)?;
    if key.is_empty() {
        return Err("No event key is set. Add one in Settings.".into());
    }
    Ok(format!("{}/event/{}", base.trim_end_matches('/'), key))
}

/// What an HTTP status from Nexus means to someone standing in a pit.
pub fn explain_status(status: u16) -> String {
    match status {
        401 => "Nexus did not receive an API key.".into(),
        403 => "Nexus rejected the API key. Check it in Settings.".into(),
        404 => "Nexus has no event with that key. Check the event key in Settings.".into(),
        429 => "Nexus is rate-limiting this key. It will be tried again shortly.".into(),
        500..=599 => format!("Nexus is having trouble (HTTP {status})."),
        other => format!("Nexus answered with HTTP {other}."),
    }
}

/// Fetch the event from `base`. Split from [`fetch`] so the tests can aim it at a listener on
/// this machine; the app only ever passes [`BASE`].
pub fn fetch_from(base: &str, event_key: &str, api_key: &str) -> Result<Value, String> {
    let url = event_url(base, event_key)?;
    if api_key.is_empty() {
        return Err("No Nexus API key is set. Add one in Settings.".into());
    }

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .redirects(0)
        .user_agent(concat!("catalyst-pit/", env!("CARGO_PKG_VERSION")))
        .build();

    let response = match agent.get(&url).set(KEY_HEADER, api_key).set("Accept", "application/json").call() {
        Ok(response) => response,
        Err(ureq::Error::Status(code, _)) => return Err(explain_status(code)),
        Err(ureq::Error::Transport(_)) => return Err("Could not reach Nexus. The schedule already here is unchanged.".into()),
    };
    // With redirects off a 3xx arrives as a success. Following one would send the key to wherever
    // it pointed, so it is refused instead.
    if !(200..300).contains(&response.status()) {
        return Err(explain_status(response.status()));
    }

    let mut body = Vec::new();
    use std::io::Read;
    response
        .into_reader()
        .take(MAX_BODY + 1)
        .read_to_end(&mut body)
        .map_err(|_| "The connection to Nexus dropped part way through.".to_string())?;
    if body.len() as u64 > MAX_BODY {
        return Err("Nexus sent far more than an event's status. It was not read.".into());
    }
    serde_json::from_slice(&body).map_err(|_| "Nexus answered with something that is not JSON.".to_string())
}

pub fn fetch(event_key: &str, api_key: &str) -> Result<Value, String> {
    fetch_from(BASE, event_key, api_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    const FIXTURE: &str = include_str!("../../src/fixtures/nexus-event.json");

    /// Answer exactly one HTTP request on a local port with the given status and body, and hand
    /// back what was asked for: the request line and the headers.
    fn serve_once(status: &'static str, body: &'static str) -> (String, mpsc::Receiver<(String, Vec<String>)>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/api/v1", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            let mut headers = Vec::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line.trim().is_empty() {
                    break;
                }
                headers.push(line.trim().to_string());
            }
            let _ = tx.send((request_line.trim().to_string(), headers));
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        });
        (base, rx)
    }

    #[test]
    fn the_url_is_the_documented_one_and_takes_only_an_event_key() {
        assert_eq!(event_url(BASE, "2026casd").unwrap(), "https://frc.nexus/api/v1/event/2026casd");
        assert_eq!(event_url("http://127.0.0.1:9/api/v1/", " 2026CASD ").unwrap(), "http://127.0.0.1:9/api/v1/event/2026casd");
        assert!(event_url(BASE, "").unwrap_err().contains("No event key"));
        for bad in ["2026/casd", "../admin", "2026casd?x=1", "a b", "é"] {
            assert!(event_url(BASE, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn nothing_is_sent_without_a_key() {
        // Port 9 is discard: if a request were attempted this would be a transport error instead.
        let err = fetch_from("http://127.0.0.1:9/api/v1", "2026casd", "").unwrap_err();
        assert!(err.contains("No Nexus API key"), "{err}");
    }

    #[test]
    fn the_fixture_is_fetched_with_the_key_in_the_right_header() {
        let (base, seen) = serve_once("200 OK", FIXTURE);
        let value = fetch_from(&base, "demo2026", "test-key-123").unwrap();
        assert_eq!(value["eventKey"], "demo2026");
        assert_eq!(value["nowQueuing"], "Qualification 11");
        assert_eq!(value["matches"].as_array().unwrap().len(), 4);

        let (request_line, headers) = seen.recv().unwrap();
        assert_eq!(request_line, "GET /api/v1/event/demo2026 HTTP/1.1");
        assert!(headers.iter().any(|h| h.eq_ignore_ascii_case("Nexus-Api-Key: test-key-123")), "{headers:?}");
        assert!(!request_line.contains("test-key-123"), "the key is never in the URL");
    }

    #[test]
    fn a_rejected_key_and_a_missing_event_are_told_apart() {
        let (base, _) = serve_once("403 Forbidden", "{\"error\":\"secret upstream detail\"}");
        let err = fetch_from(&base, "demo2026", "bad").unwrap_err();
        assert!(err.contains("rejected the API key"), "{err}");
        assert!(!err.contains("secret upstream detail"), "upstream bodies are not relayed");

        let (base, _) = serve_once("404 Not Found", "{}");
        assert!(fetch_from(&base, "demo2026", "k").unwrap_err().contains("no event with that key"));

        let (base, _) = serve_once("401 Unauthorized", "{}");
        assert!(fetch_from(&base, "demo2026", "k").unwrap_err().contains("did not receive an API key"));

        let (base, _) = serve_once("503 Service Unavailable", "{}");
        assert!(fetch_from(&base, "demo2026", "k").unwrap_err().contains("HTTP 503"));
    }

    #[test]
    fn a_redirect_is_refused_rather_than_followed_with_the_key() {
        let (base, _) = serve_once("302 Found", "");
        let err = fetch_from(&base, "demo2026", "k").unwrap_err();
        assert!(err.contains("HTTP 302"), "{err}");
    }

    #[test]
    fn a_body_that_is_not_json_is_said_to_be_so() {
        let (base, _) = serve_once("200 OK", "<html>captive portal</html>");
        let err = fetch_from(&base, "demo2026", "k").unwrap_err();
        assert!(err.contains("not JSON"), "{err}");
    }

    #[test]
    fn no_network_is_one_plain_sentence() {
        // A port nothing is listening on: bind one, note it, and close it again.
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let err = fetch_from(&format!("http://127.0.0.1:{port}/api/v1"), "demo2026", "k").unwrap_err();
        assert!(err.contains("Could not reach Nexus"), "{err}");
    }
}
