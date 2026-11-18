//! OpenBelt's MCP endpoint over HTTP: one session per command, JSON or SSE answers, and the saved
//! sign-in (an API token, or OAuth tokens refreshed once when the server says they've run out).

use crate::auth::{self, Credentials};
use serde_json::{Value, json};

pub const CLIENT: &str = "openbelt-cli";

const PROTOCOL: &str = "2025-06-18";

/// What a request ended in, besides a result.
pub enum Failure {
    /// The server or the network said no; the message says why.
    Error(String),
    /// The sign-in is gone (revoked, or a refresh that failed): `openbelt login` again.
    SignedOut(String),
}

pub struct Session {
    pub credentials: Credentials,
    session: Option<String>,
    /// The protocol version initialize settled on, sent on every request after it.
    protocol: Option<String>,
    next: u64,
}

impl Session {
    /// Opens a session: initialize, then the initialized notification.
    pub fn open(credentials: Credentials) -> Result<Session, Failure> {
        let mut s = Session {
            credentials,
            session: None,
            protocol: None,
            next: 0,
        };
        s.request(
            "initialize",
            json!({ "protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": { "name": CLIENT, "version": env!("CARGO_PKG_VERSION") } }),
        )?;
        s.notify("notifications/initialized");
        Ok(s)
    }

    /// A session the agent opens itself (the bridge passes its initialize on).
    pub fn bridge(credentials: Credentials) -> Session {
        Session {
            credentials,
            session: None,
            protocol: None,
            next: 0,
        }
    }

    pub fn clone_for_request(&self) -> Session {
        Session {
            credentials: self.credentials.clone(),
            session: self.session.clone(),
            protocol: self.protocol.clone(),
            next: 0,
        }
    }

    /// Keeps what a request learned: the session id and protocol (never its credentials, which
    /// only a renewal under the bridge's lock changes).
    pub fn adopt(&mut self, other: &Session) {
        if other.session.is_some() {
            self.session = other.session.clone();
        }
        if other.protocol.is_some() {
            self.protocol = other.protocol.clone();
        }
    }

    pub fn endpoint(&self) -> String {
        format!("{}/mcp", self.credentials.url)
    }

    /// A JSON-RPC request, its result or why not; one retry after refreshing an OAuth sign-in.
    pub fn request(&mut self, method: &str, params: Value) -> Result<Value, Failure> {
        self.next += 1;
        let body = json!({ "jsonrpc": "2.0", "id": self.next, "method": method, "params": params });
        let answer = match self.post(&body)? {
            Posted::Unauthorized if self.credentials.can_refresh() => {
                auth::refresh(&mut self.credentials).map_err(Failure::SignedOut)?;
                match self.post(&body)? {
                    Posted::Unauthorized => return Err(signed_out(&self.credentials)),
                    Posted::Answer(v) => v,
                }
            }
            Posted::Unauthorized => return Err(signed_out(&self.credentials)),
            Posted::Answer(v) => v,
        };
        match answer.get("error") {
            Some(e) => Err(Failure::Error(
                e["message"]
                    .as_str()
                    .unwrap_or("the server refused")
                    .to_string(),
            )),
            None => Ok(answer["result"].clone()),
        }
    }

    pub fn notify(&self, method: &str) {
        let _ = self.send(&json!({ "jsonrpc": "2.0", "method": method }));
    }

    /// Sends one JSON-RPC message as it is (the stdio bridge): the server's answers, in order.
    /// None when the server refused the sign-in: the bridge renews it once for every request at
    /// once (bridge.rs), so a request that started before a renewal never undoes it.
    pub fn forward(&mut self, message: &Value) -> Result<Option<Vec<Value>>, Failure> {
        let mut res = self.send(message).map_err(Failure::Error)?;
        if res.status() == 401 {
            return Ok(None);
        }
        self.remember(&res);
        let text = res
            .body_mut()
            .read_to_string()
            .map_err(|e| Failure::Error(e.to_string()))?;
        let list = messages(&text);
        self.learn(&list);
        Ok(Some(list))
    }

    fn post(&mut self, body: &Value) -> Result<Posted, Failure> {
        let mut res = self.send(body).map_err(Failure::Error)?;
        if res.status() == 401 {
            return Ok(Posted::Unauthorized);
        }
        self.remember(&res);
        let status = res.status();
        let text = res
            .body_mut()
            .read_to_string()
            .map_err(|e| Failure::Error(e.to_string()))?;
        let id = body.get("id");
        let list = messages(&text);
        self.learn(&list);
        list.into_iter()
            .find(|m| m.get("id") == id)
            .map(Posted::Answer)
            .ok_or_else(|| {
                Failure::Error(format!(
                    "{} answered {status}: {}",
                    self.endpoint(),
                    text.chars().take(300).collect::<String>()
                ))
            })
    }

    fn send(&self, body: &Value) -> Result<ureq::http::Response<ureq::Body>, String> {
        let mut req = ureq::post(&self.endpoint())
            .config()
            .http_status_as_error(false)
            .build()
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header(
                "authorization",
                &format!("Bearer {}", self.credentials.bearer()),
            );
        if let Some(s) = &self.session {
            req = req.header("mcp-session-id", s);
        }
        if let Some(p) = &self.protocol {
            req = req.header("mcp-protocol-version", p);
        }
        req.send_json(body)
            .map_err(|e| format!("can't reach {}: {e}", self.credentials.url))
    }

    /// An initialize answer says which protocol version the session speaks.
    fn learn(&mut self, answers: &[Value]) {
        if let Some(p) = answers
            .iter()
            .find_map(|m| m["result"]["protocolVersion"].as_str())
        {
            self.protocol = Some(p.to_string());
        }
    }

    fn remember(&mut self, res: &ureq::http::Response<ureq::Body>) {
        if let Some(s) = res
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            self.session = Some(s.to_string());
        }
    }

    /// Calls a tool: its structured result (else its text, as JSON when it is), or the refusal. A
    /// terminal can't show an image, so each one goes to a file and the result names its path.
    pub fn call(&mut self, tool: &str, arguments: Value) -> Result<Value, Failure> {
        let r = self.request(
            "tools/call",
            json!({ "name": tool, "arguments": arguments }),
        )?;
        let text = r["content"]
            .as_array()
            .map(|c| {
                c.iter()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        if r["isError"].as_bool() == Some(true) {
            return Err(Failure::Error(text));
        }
        let mut result = match r.get("structuredContent") {
            Some(v) if !v.is_null() => v.clone(),
            _ => serde_json::from_str(&text).unwrap_or(Value::String(text)),
        };
        if let (Value::Object(o), Some(path)) = (&mut result, save_image(tool, &r["content"])?) {
            let key = if tool == "check_app" {
                "screenshot"
            } else {
                "image"
            };
            o.insert(key.into(), Value::String(path));
        }
        Ok(result)
    }
}

enum Posted {
    Answer(Value),
    Unauthorized,
}

/// A result's first image, written to `<temp>/openbelt/<tool>-<ms>-<pid>.<type>`: its path, or None
/// when the result has none.
fn save_image(tool: &str, content: &Value) -> Result<Option<String>, Failure> {
    use base64::Engine;
    let Some(image) = content
        .as_array()
        .and_then(|c| c.iter().find(|p| p["type"] == "image"))
    else {
        return Ok(None);
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image["data"].as_str().unwrap_or(""))
        .map_err(|e| Failure::Error(format!("{tool} sent an image that isn't base64: {e}")))?;
    let kind = image["mimeType"]
        .as_str()
        .and_then(|m| m.strip_prefix("image/"))
        .filter(|k| k.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("bin");
    let dir = std::env::temp_dir().join("openbelt");
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let path = dir.join(format!("{tool}-{ms}-{}.{kind}", std::process::id()));
    std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::write(&path, bytes))
        .map_err(|e| {
            Failure::Error(format!(
                "can't save {tool}'s image to {}: {e}",
                path.display()
            ))
        })?;
    Ok(Some(path.display().to_string()))
}

pub fn signed_out(c: &Credentials) -> Failure {
    Failure::SignedOut(format!(
        "{} no longer takes this sign-in: run `openbelt login`",
        c.url
    ))
}

/// A response body's JSON-RPC messages: one JSON object, or SSE `data:` events.
fn messages(text: &str) -> Vec<Value> {
    let t = text.trim_start();
    if t.starts_with('{') || t.starts_with('[') {
        return match serde_json::from_str::<Value>(t) {
            Ok(Value::Array(a)) => a,
            Ok(v) => vec![v],
            Err(_) => vec![],
        };
    }
    let mut out = vec![];
    let mut data = String::new();
    for line in text.lines().chain(std::iter::once("")) {
        if let Some(d) = line.strip_prefix("data:") {
            data.push_str(d.trim_start());
        } else if line.is_empty() && !data.is_empty() {
            if let Ok(v) = serde_json::from_str(&data) {
                out.push(v);
            }
            data.clear();
        }
    }
    out
}
