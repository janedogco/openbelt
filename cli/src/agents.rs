//! The agents `openbelt install` sets up: where each keeps its MCP servers, and the entry that starts
//! `openbelt mcp`. Files are edited in place: other servers, settings, comments and layout stay.

use crate::auth::home;
use jsonc_parser::cst::{CstInputValue, CstRootNode};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

pub struct Agent {
    pub id: &'static str,
    pub name: &'static str,
    file: fn() -> PathBuf,
    bins: &'static [&'static str],
    dirs: &'static [&'static str],
    format: Format,
    key: &'static [&'static str],
    entry: fn(&str) -> Value,
}

enum Format {
    Json,
    Toml,
}

fn env_dir(var: &str, default: &str) -> PathBuf {
    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(default))
}

fn config_dir() -> PathBuf {
    env_dir("XDG_CONFIG_HOME", ".config")
}

pub const AGENTS: &[Agent] = &[
    Agent {
        id: "claude",
        name: "Claude Code",
        file: || {
            std::env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(home)
                .join(".claude.json")
        },
        bins: &["claude"],
        dirs: &[".claude"],
        format: Format::Json,
        key: &["mcpServers", "openbelt"],
        entry: |cmd| json!({ "type": "stdio", "command": cmd, "args": ["mcp"] }),
    },
    Agent {
        id: "codex",
        name: "Codex",
        file: || env_dir("CODEX_HOME", ".codex").join("config.toml"),
        bins: &["codex"],
        dirs: &[".codex"],
        format: Format::Toml,
        key: &["mcp_servers", "openbelt"],
        entry: |cmd| json!({ "command": cmd, "args": ["mcp"] }),
    },
    Agent {
        id: "opencode",
        name: "OpenCode",
        file: || {
            let dir = config_dir().join("opencode");
            let json = dir.join("opencode.json");
            if json.exists() {
                json
            } else {
                dir.join("opencode.jsonc")
            }
        },
        bins: &["opencode"],
        dirs: &[".config/opencode"],
        format: Format::Json,
        // OpenCode 2 lists servers under mcp.servers; 1 put them straight under mcp (key()).
        key: &["mcp", "servers", "openbelt"],
        entry: |cmd| json!({ "type": "local", "command": [cmd, "mcp"] }),
    },
    Agent {
        id: "cursor",
        name: "Cursor",
        file: || home().join(".cursor/mcp.json"),
        bins: &["cursor-agent", "cursor"],
        dirs: &[".cursor"],
        format: Format::Json,
        key: &["mcpServers", "openbelt"],
        entry: |cmd| json!({ "command": cmd, "args": ["mcp"] }),
    },
    Agent {
        id: "gemini",
        name: "Gemini CLI",
        file: || env_dir("GEMINI_CLI_HOME", "").join(".gemini/settings.json"),
        bins: &["gemini"],
        dirs: &[".gemini"],
        format: Format::Json,
        key: &["mcpServers", "openbelt"],
        entry: |cmd| json!({ "command": cmd, "args": ["mcp"] }),
    },
    Agent {
        id: "pi",
        name: "pi",
        file: || home().join(".pi/agent/mcp.json"),
        bins: &["pi"],
        dirs: &[".pi"],
        format: Format::Json,
        key: &["mcpServers", "openbelt"],
        entry: |cmd| json!({ "command": cmd, "args": ["mcp"] }),
    },
];

pub fn find(id: &str) -> Option<&'static Agent> {
    AGENTS
        .iter()
        .find(|a| a.id == id || a.name.eq_ignore_ascii_case(id))
}

pub enum Outcome {
    Added,
    Updated,
    Unchanged,
}

impl Outcome {
    pub fn word(&self) -> &'static str {
        match self {
            Outcome::Added => "added",
            Outcome::Updated => "updated",
            Outcome::Unchanged => "unchanged",
        }
    }
}

impl Agent {
    pub fn file(&self) -> PathBuf {
        (self.file)()
    }

    fn key(&self) -> &'static [&'static str] {
        if self.id == "opencode" && opencode_1() {
            &["mcp", "openbelt"]
        } else {
            self.key
        }
    }

    /// On this machine: its command is on PATH, or its folder exists.
    pub fn installed(&self) -> bool {
        self.bins.iter().any(|b| on_path(b)) || self.dirs.iter().any(|d| home().join(d).exists())
    }

    /// Whether its file already starts OpenBelt.
    pub fn configured(&self) -> bool {
        self.current().is_some_and(|v| !v.is_null())
    }

    fn current(&self) -> Option<Value> {
        let text = fs::read_to_string(self.file()).ok()?;
        let root: Value = match self.format {
            Format::Json => {
                jsonc_parser::parse_to_serde_value::<Value>(&text, &Default::default()).ok()?
            }
            Format::Toml => toml_to_json(
                &text
                    .parse::<toml_edit::DocumentMut>()
                    .ok()?
                    .as_item()
                    .clone(),
            ),
        };
        self.key().iter().try_fold(root, |v, k| v.get(k).cloned())
    }

    /// Adds OpenBelt (`command mcp`) to the agent's file, or says it was already there.
    pub fn configure(&self, command: &str) -> Result<Outcome, String> {
        let file = self.file();
        let entry = (self.entry)(command);
        let key = self.key();
        let before = self.current();
        if before.as_ref() == Some(&entry) {
            return Ok(Outcome::Unchanged);
        }
        let text = fs::read_to_string(&file).unwrap_or_default();
        let after = match self.format {
            Format::Json => {
                let source = if text.trim().is_empty() {
                    "{}\n"
                } else {
                    text.as_str()
                };
                let root = CstRootNode::parse(source, &Default::default()).map_err(|e| {
                    format!("{} isn't valid JSON ({e}); left as it is", file.display())
                })?;
                let mut obj = root.object_value_or_set();
                for k in &key[..key.len() - 1] {
                    obj = obj.object_value_or_set(k);
                }
                let last = key[key.len() - 1];
                match obj.get(last) {
                    Some(prop) => prop.set_value(cst(&entry)),
                    None => {
                        obj.append(last, cst(&entry));
                    }
                }
                root.to_string()
            }
            Format::Toml => {
                let mut doc: toml_edit::DocumentMut = text.parse().map_err(|e| {
                    format!("{} isn't valid TOML ({e}); left as it is", file.display())
                })?;
                let mut table = toml_edit::Table::new();
                table.insert(
                    "command",
                    toml_edit::value(entry["command"].as_str().unwrap_or_default()),
                );
                table.insert(
                    "args",
                    toml_edit::value(toml_edit::Array::from_iter(["mcp"])),
                );
                if !doc.contains_key(key[0]) {
                    let mut t = toml_edit::Table::new();
                    t.set_implicit(true);
                    doc.insert(key[0], toml_edit::Item::Table(t));
                }
                doc[key[0]][key[1]] = toml_edit::Item::Table(table);
                doc.to_string()
            }
        };
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::write(&file, after).map_err(|e| format!("can't write {}: {e}", file.display()))?;
        Ok(if before.is_some() {
            Outcome::Updated
        } else {
            Outcome::Added
        })
    }
}

fn cst(v: &Value) -> CstInputValue {
    match v {
        Value::Null => CstInputValue::Null,
        Value::Bool(b) => CstInputValue::Bool(*b),
        Value::Number(n) => CstInputValue::Number(n.to_string()),
        Value::String(s) => CstInputValue::String(s.clone()),
        Value::Array(a) => CstInputValue::Array(a.iter().map(cst).collect()),
        Value::Object(o) => {
            CstInputValue::Object(o.iter().map(|(k, v)| (k.clone(), cst(v))).collect())
        }
    }
}

fn toml_to_json(item: &toml_edit::Item) -> Value {
    match item {
        toml_edit::Item::Table(t) => Value::Object(
            t.iter()
                .map(|(k, v)| (k.to_string(), toml_to_json(v)))
                .collect(),
        ),
        toml_edit::Item::Value(v) => match v {
            toml_edit::Value::String(s) => Value::String(s.value().clone()),
            toml_edit::Value::Integer(i) => json!(i.value()),
            toml_edit::Value::Float(f) => json!(f.value()),
            toml_edit::Value::Boolean(b) => json!(b.value()),
            toml_edit::Value::Array(a) => Value::Array(
                a.iter()
                    .map(|v| toml_to_json(&toml_edit::Item::Value(v.clone())))
                    .collect(),
            ),
            toml_edit::Value::InlineTable(t) => Value::Object(
                t.iter()
                    .map(|(k, v)| {
                        (
                            k.to_string(),
                            toml_to_json(&toml_edit::Item::Value(v.clone())),
                        )
                    })
                    .collect(),
            ),
            toml_edit::Value::Datetime(d) => Value::String(d.to_string()),
        },
        _ => Value::Null,
    }
}

/// Whether the OpenCode here is a 1.x (`opencode --version` says 1.4.2, or v2.2.6 for a 2).
fn opencode_1() -> bool {
    std::process::Command::new("opencode")
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .is_some_and(|v| v.trim().trim_start_matches('v').starts_with("1."))
}

pub fn on_path(bin: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|p| {
        std::env::split_paths(&p)
            .any(|d| d.join(bin).is_file() || d.join(format!("{bin}.exe")).is_file())
    })
}

/// The agent this command runs inside, from its environment.
pub fn calling() -> Option<&'static str> {
    let e = |k: &str| std::env::var(k).ok();
    if e("CLAUDECODE").as_deref() == Some("1") || e("CLAUDE_CODE_ENTRYPOINT").is_some() {
        Some("claude")
    } else if e("CODEX_THREAD_ID").is_some() {
        Some("codex")
    } else if e("CURSOR_AGENT").is_some() {
        Some("cursor")
    } else if e("GEMINI_CLI").as_deref() == Some("1") {
        Some("gemini")
    } else if e("OPENCODE").as_deref() == Some("1") {
        Some("opencode")
    } else {
        None
    }
}
