//! The commands that come from the server: each MCP tool's `_meta["openbelt/cli"]` gives its command
//! lines and summaries, its input schema the types of its flags. A few tools read or write files
//! here (deploy, pull, data list --all, a JSON array of updates); every other command is one
//! tool call.

use crate::mcp::{Failure, Session};
use crate::output;
use serde_json::{Map, Value, json};
use std::{fs, io::Read, path::Path};

pub struct Command {
    pub path: Vec<String>,
    pub usage: String,
    pub summary: String,
    pub tool: String,
    pub description: String,
    pub schema: Value,
    pub workspace: bool,
    slots: Vec<Slot>,
}

struct Slot {
    names: Vec<String>,
    sep: Option<char>,
    optional: bool,
    rest: bool,
}

pub enum Error {
    Usage(String),
    Failed(Failure),
}

impl From<Failure> for Error {
    fn from(f: Failure) -> Self {
        Error::Failed(f)
    }
}

fn usage(s: impl Into<String>) -> Error {
    Error::Usage(s.into())
}

/// Every command the server's tools offer.
pub fn load(session: &mut Session) -> Result<Vec<Command>, Failure> {
    let list = session.request("tools/list", json!({}))?;
    let mut out = vec![];
    for t in list["tools"].as_array().into_iter().flatten() {
        for c in t["_meta"]["openbelt/cli"].as_array().into_iter().flatten() {
            let (Some(u), Some(name)) = (c["usage"].as_str(), t["name"].as_str()) else {
                continue;
            };
            let mut command = parse_usage(u, c["summary"].as_str().unwrap_or(""), name, t);
            command.workspace = c["workspace"].as_bool().unwrap_or(false);
            if command.workspace {
                command.usage.push_str(" --workspace");
            }
            out.push(command);
        }
    }
    Ok(out)
}

fn parse_usage(usage: &str, summary: &str, tool: &str, t: &Value) -> Command {
    let mut path = vec![];
    let mut slots = vec![];
    for w in usage.split_whitespace() {
        if !(w.starts_with('<') || w.starts_with('[')) {
            path.push(w.to_string());
            continue;
        }
        let optional = w.starts_with('[');
        let inner = w.trim_matches(|c| matches!(c, '<' | '>' | '[' | ']'));
        let rest = inner.ends_with("...");
        let inner = inner.trim_end_matches("...");
        let sep = if inner.contains(">/<") {
            Some('/')
        } else if inner.contains(">.<") {
            Some('.')
        } else {
            None
        };
        let names = match sep {
            Some(s) => inner.split(&format!(">{s}<")).map(str::to_string).collect(),
            None => vec![inner.to_string()],
        };
        slots.push(Slot {
            names,
            sep,
            optional,
            rest,
        });
    }
    Command {
        path,
        usage: usage.to_string(),
        summary: summary.to_string(),
        tool: tool.to_string(),
        description: t["description"].as_str().unwrap_or("").to_string(),
        schema: t["inputSchema"].clone(),
        workspace: false,
        slots,
    }
}

/// The command `args` name (its longest match) and the words after it.
pub fn find<'a>(cmds: &'a [Command], args: &'a [String]) -> Option<(&'a Command, &'a [String])> {
    let workspace = args.iter().any(|a| a == "--workspace");
    cmds.iter()
        .filter(|c| c.workspace == workspace)
        .filter(|c| c.path.len() <= args.len() && c.path.iter().zip(args).all(|(p, a)| p == a))
        .max_by_key(|c| c.path.len())
        .map(|c| (c, &args[c.path.len()..]))
}

// ---- arguments

struct Parsed {
    pos: Vec<String>,
    flags: Map<String, Value>,
    json: bool,
    help: bool,
}

fn kinds(s: &Value) -> Vec<String> {
    if let Some(any) = s["anyOf"].as_array() {
        return any.iter().flat_map(kinds).collect();
    }
    match &s["type"] {
        Value::String(t) => vec![t.clone()],
        Value::Array(a) => a
            .iter()
            .filter_map(|t| t.as_str().map(str::to_string))
            .collect(),
        _ => vec!["any".into()],
    }
}

fn read_stdin() -> String {
    let mut s = String::new();
    let _ = std::io::stdin().read_to_string(&mut s);
    s.strip_suffix('\n').map(str::to_string).unwrap_or(s)
}

/// A word as the schema wants it: text as it is, numbers and booleans, JSON (or `@file`, or `-`
/// for stdin) for objects and arrays, and a plain word for an array of one.
fn coerce(raw: &str, schema: &Value, name: &str) -> Result<Value, Error> {
    let k = kinds(schema);
    let has = |t: &str| k.iter().any(|x| x == t);
    let structured = has("object") || has("array") || has("any") || k.is_empty();
    if has("string") && !structured {
        return Ok(Value::String(raw.to_string()));
    }
    if (has("integer") || has("number")) && !structured {
        return raw
            .parse::<f64>()
            .map(|n| json!(n))
            .map(|v| if has("integer") { json!(n_int(&v)) } else { v })
            .map_err(|_| usage(format!("{name} wants a number, not {raw}")));
    }
    if has("boolean") && !structured && (raw == "true" || raw == "false") {
        return Ok(Value::Bool(raw == "true"));
    }
    let text = if raw == "-" {
        read_stdin()
    } else if let Some(f) = raw.strip_prefix('@') {
        fs::read_to_string(f).map_err(|e| usage(format!("can't read {f} for {name}: {e}")))?
    } else {
        raw.to_string()
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => Ok(if has("array") && !v.is_array() && !has("object") {
            json!([v])
        } else {
            v
        }),
        Err(_) if has("array") => Ok(json!(text.split(',').map(str::trim).collect::<Vec<_>>())),
        Err(_) if has("string") || has("boolean") && (text == "true" || text == "false") => {
            Ok(if has("boolean") && (text == "true" || text == "false") {
                Value::Bool(text == "true")
            } else {
                Value::String(text)
            })
        }
        Err(e) => Err(usage(format!(
            "{name} wants JSON ({}): {e}; quote it in the shell, like '{{\"a\": 1}}', or pass @file",
            k.join(" or ")
        ))),
    }
}

fn n_int(v: &Value) -> i64 {
    v.as_f64().unwrap_or(0.0) as i64
}

fn parse_args(cmd: &Command, words: &[String]) -> Result<Parsed, Error> {
    let props = cmd.schema["properties"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut p = Parsed {
        pos: vec![],
        flags: Map::new(),
        json: false,
        help: false,
    };
    let mut i = 0;
    while i < words.len() {
        let w = &words[i];
        i += 1;
        if w == "--workspace" && cmd.workspace {
            continue;
        } else if w == "--json" {
            p.json = true;
        } else if w == "--help" || w == "-h" {
            p.help = true;
        } else if let Some(f) = w.strip_prefix("--") {
            let (name, inline) = match f.split_once('=') {
                Some((n, v)) => (n.to_string(), Some(v.to_string())),
                None => (f.to_string(), None),
            };
            let local = local_flags(&cmd.tool);
            let Some(schema) = props.get(&name).cloned().or_else(|| {
                local
                    .iter()
                    .find(|(n, _, _)| *n == name)
                    .map(|(_, t, _)| json!({ "type": t }))
            }) else {
                let mut known: Vec<String> = props
                    .keys()
                    .filter(|k| !cmd.slots.iter().any(|s| s.names.contains(k)))
                    .map(|k| format!("--{k}"))
                    .collect();
                known.extend(local.iter().map(|(k, _, _)| format!("--{k}")));
                return Err(usage(format!(
                    "openbelt {} has no --{name}; it takes {}",
                    cmd.path.join(" "),
                    if known.is_empty() {
                        "no flags".into()
                    } else {
                        known.join(", ")
                    }
                )));
            };
            let only_bool = kinds(&schema).iter().all(|k| k == "boolean");
            let raw = match inline {
                Some(v) => v,
                // `--screenshot false` as well as `--screenshot`: a true or false after it is its value, not a word.
                None if only_bool && words.get(i).is_some_and(|n| n == "true" || n == "false") => {
                    i += 1;
                    words[i - 1].clone()
                }
                None if only_bool => "true".into(),
                None if i < words.len() => {
                    i += 1;
                    words[i - 1].clone()
                }
                None => return Err(usage(format!("--{name} needs a value"))),
            };
            p.flags
                .insert(name.clone(), coerce(&raw, &schema, &format!("--{name}"))?);
        } else {
            p.pos.push(w.clone());
        }
    }
    Ok(p)
}

/// Flags a command takes here that its tool doesn't: (name, type, what it does).
fn local_flags(tool: &str) -> &'static [(&'static str, &'static str, &'static str)] {
    match tool {
        "deploy_app" => &[("app", "string", "the app's name (default: the folder's)")],
        "collection_list" => &[(
            "all",
            "boolean",
            "every document: follows the cursor page by page",
        )],
        _ => &[],
    }
}

fn build_input(cmd: &Command, p: &Parsed) -> Result<Map<String, Value>, Error> {
    let props = cmd.schema["properties"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut input = Map::new();
    let mut pos = p.pos.iter();
    for slot in &cmd.slots {
        let word = if slot.rest {
            let rest: Vec<&String> = pos.by_ref().collect();
            (!rest.is_empty()).then(|| {
                rest.iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
        } else {
            pos.next().cloned()
        };
        let Some(word) = word else {
            if slot.optional {
                continue;
            }
            return Err(usage(format!("openbelt {}", cmd.usage)));
        };
        let parts: Vec<String> = match slot.sep {
            Some(s) => match word.split_once(s) {
                Some((a, b)) if !a.is_empty() && !b.is_empty() => vec![a.into(), b.into()],
                _ => {
                    return Err(usage(format!(
                        "openbelt {}  ({} is <{}>)",
                        cmd.usage,
                        word,
                        slot.names.join(&format!(">{s}<"))
                    )));
                }
            },
            None => vec![word],
        };
        for (name, raw) in slot.names.iter().zip(parts) {
            let schema = props
                .get(name)
                .cloned()
                .unwrap_or(json!({ "type": "string" }));
            input.insert(name.clone(), coerce(&raw, &schema, name)?);
        }
    }
    if let Some(extra) = pos.next() {
        return Err(usage(format!(
            "openbelt {} takes no more words (got {extra}); a JSON value with spaces needs quotes",
            cmd.usage
        )));
    }
    for (k, v) in &p.flags {
        input.insert(k.clone(), v.clone());
    }
    Ok(input)
}

// ---- running one

pub fn run(
    session: &mut Session,
    cmds: &[Command],
    cmd: &Command,
    words: &[String],
) -> Result<(), Error> {
    let p = parse_args(cmd, words)?;
    if p.help {
        help_one(cmds, cmd);
        return Ok(());
    }
    let json = p.json || !output::is_tty();
    let result = match cmd.tool.as_str() {
        "deploy_app" => deploy(session, cmd, &p)?,
        "app_files" => return pull(session, &p),
        "collection_list" if p.flags.contains_key("all") => every_page(session, cmd, &p)?,
        tool => {
            let mut input = build_input(cmd, &p)?;
            match tool {
                "set_secret" if !input.contains_key("value") => {
                    if output::stdin_is_tty() {
                        return Err(usage(
                            "openbelt app secret <app> <name>: pipe the value in (printf %s \"$KEY\" | openbelt app secret …), so it stays out of your shell history",
                        ));
                    }
                    input.insert("value".into(), Value::String(read_stdin()));
                }
                "connection_token_set" | "connection_workspace_token_set" => {
                    if !input.contains_key("token")
                        || input.get("token").and_then(Value::as_str) == Some("-")
                    {
                        if output::stdin_is_tty() {
                            return Err(usage(
                                "openbelt connection token <connection>: pipe the token in so it stays out of your shell history",
                            ));
                        }
                        input.insert("token".into(), Value::String(read_stdin()));
                    }
                }
                "connection_client_set"
                    if input.get("secret").and_then(Value::as_str) == Some("-") =>
                {
                    if output::stdin_is_tty() {
                        return Err(usage("pipe the client secret in with --secret -"));
                    }
                    input.insert("secret".into(), Value::String(read_stdin()));
                }
                "collection_add" => {
                    if !input.contains_key("data")
                        && !input.contains_key("docs")
                        && !output::stdin_is_tty()
                    {
                        input.insert(
                            "data".into(),
                            serde_json::from_str(&read_stdin()).map_err(|e| {
                                usage(format!("the document on stdin isn't JSON: {e}"))
                            })?,
                        );
                    }
                    if let Some(Value::Array(docs)) = input.get("data").cloned() {
                        input.remove("data");
                        let wrapped = docs
                            .into_iter()
                            .map(|d| if is_doc(&d) { d } else { json!({ "data": d }) })
                            .collect();
                        input.insert("docs".into(), Value::Array(wrapped));
                    }
                }
                "collection_update" => many_updates(&mut input)?,
                _ => {}
            }
            session.call(tool, Value::Object(input))?
        }
    };
    match cmd.tool.as_str() {
        "search" if !json => output::search(&result, cmds),
        "docs" => output::text(&result, cmds),
        _ => output::show(&result, json, cmds),
    }
    Ok(())
}

/// `data list --all`: every page, as one list.
fn every_page(session: &mut Session, cmd: &Command, p: &Parsed) -> Result<Value, Error> {
    let mut input = build_input(cmd, p)?;
    input.remove("all");
    input.entry("limit").or_insert(json!(1000));
    let mut docs = vec![];
    loop {
        let page = session.call("collection_list", Value::Object(input.clone()))?;
        docs.extend(page["docs"].as_array().cloned().unwrap_or_default());
        match page["cursor"].as_str() {
            Some(c) => {
                input.insert("cursor".into(), json!(c));
            }
            None => return Ok(json!({ "docs": docs, "count": docs.len() })),
        }
    }
}

/// `data update <app>/<collection> '[{"id": …, "data": {…}}, …]'` (or the array on stdin): many
/// changes in one call, all or none. The array arrives as the id word; it's the tool's docs.
fn many_updates(input: &mut Map<String, Value>) -> Result<(), Error> {
    let from_word = match input.get("id") {
        Some(Value::String(s)) if s.trim_start().starts_with('[') => {
            let text = s.clone();
            input.remove("id");
            Some(text)
        }
        Some(Value::String(s)) if s.starts_with('@') || s == "-" => {
            let text = if s == "-" {
                read_stdin()
            } else {
                fs::read_to_string(&s[1..])
                    .map_err(|e| usage(format!("can't read {}: {e}", &s[1..])))?
            };
            input.remove("id");
            Some(text)
        }
        _ => None,
    };
    let text = match from_word {
        Some(t) => t,
        None if !input.contains_key("id")
            && !input.contains_key("docs")
            && !output::stdin_is_tty() =>
        {
            read_stdin()
        }
        None => return Ok(()),
    };
    let docs: Vec<Value> = serde_json::from_str(&text)
        .map_err(|e| usage(format!("the changes aren't a JSON array: {e}")))?;
    if let Some(bad) = docs
        .iter()
        .find(|d| d["id"].as_str().is_none() || !d["data"].is_object())
    {
        return Err(usage(format!(
            "each change is {{\"id\": \"<doc id>\", \"data\": {{…fields}}}}; got {bad}"
        )));
    }
    input.insert("docs".into(), Value::Array(docs));
    Ok(())
}

fn is_doc(d: &Value) -> bool {
    d.as_object()
        .is_some_and(|o| o.contains_key("data") && o.keys().all(|k| k == "data" || k == "id"))
}

const SKIP: &[&str] = &["node_modules", ".git", ".DS_Store"];

fn walk(dir: &Path, base: &Path, out: &mut Vec<Value>) -> Result<(), Error> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| usage(format!("can't read {}: {e}", dir.display())))?
        .flatten()
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if SKIP.contains(&name.as_str()) || name.starts_with('.') {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            walk(&p, base, out)?;
            continue;
        }
        let rel = p
            .strip_prefix(base)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let bytes = fs::read(&p).map_err(|e| usage(format!("can't read {}: {e}", p.display())))?;
        out.push(match String::from_utf8(bytes) {
            Ok(text) if !text.contains('\0') => json!({ "path": rel, "content": text }),
            Ok(text) => json!({ "path": rel, "base64": b64(text.as_bytes()) }),
            Err(e) => json!({ "path": rel, "base64": b64(e.as_bytes()) }),
        });
    }
    Ok(())
}

fn b64(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}

/// `app deploy [dir]`: every file in the folder (not dotfiles or node_modules), as the app named
/// by --app or the folder.
fn deploy(session: &mut Session, cmd: &Command, p: &Parsed) -> Result<Value, Error> {
    let dir = Path::new(p.pos.first().map(String::as_str).unwrap_or("."));
    if p.pos.len() > 1 {
        return Err(usage(format!("openbelt {}: one folder", cmd.usage)));
    }
    let dir = dir
        .canonicalize()
        .map_err(|_| usage(format!("{} isn't a folder", dir.display())))?;
    if !dir.is_dir() {
        return Err(usage(format!(
            "{} isn't a folder; deploy takes the app's folder",
            dir.display()
        )));
    }
    let mut files = vec![];
    walk(&dir, &dir, &mut files)?;
    if files.is_empty() {
        return Err(usage(format!("{} has no files to deploy", dir.display())));
    }
    let mut input = p.flags.clone();
    let app = match input.remove("app") {
        Some(Value::String(a)) => a,
        _ => dir
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default(),
    };
    input.insert("app".into(), Value::String(app));
    input.insert("files".into(), Value::Array(files));
    Ok(session.call("deploy_app", Value::Object(input))?)
}

/// `app pull <app> [dir]`: the files written into the folder (default: one named after the app).
fn pull(session: &mut Session, p: &Parsed) -> Result<(), Error> {
    let app = p
        .pos
        .first()
        .ok_or_else(|| usage("openbelt app pull <app> [dir]"))?;
    let dir = Path::new(p.pos.get(1).unwrap_or(app)).to_path_buf();
    let mut input = p.flags.clone();
    input.insert("app".into(), json!(app));
    let r = session.call("app_files", Value::Object(input.clone()))?;
    let mut count = 0;
    for f in r["files"].as_array().into_iter().flatten() {
        let path = f["path"].as_str().unwrap_or_default();
        let file = if f.get("content").is_some() || f.get("base64").is_some() {
            f.clone()
        } else {
            let mut one = input.clone();
            one.insert("paths".into(), json!([path]));
            let r = session.call("app_files", Value::Object(one))?;
            r["files"]
                .as_array()
                .and_then(|a| a.iter().find(|x| x["path"] == path).cloned())
                .unwrap_or_default()
        };
        let target = dir.join(path);
        if !target.starts_with(&dir) || path.contains("..") {
            continue;
        }
        fs::create_dir_all(target.parent().unwrap()).map_err(|e| usage(e.to_string()))?;
        let bytes = match (file["content"].as_str(), file["base64"].as_str()) {
            (Some(t), _) => t.as_bytes().to_vec(),
            (_, Some(b)) => {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD
                    .decode(b)
                    .unwrap_or_default()
            }
            _ => continue,
        };
        fs::write(&target, bytes)
            .map_err(|e| usage(format!("can't write {}: {e}", target.display())))?;
        count += 1;
    }
    let version = r["version"].as_str().unwrap_or("");
    println!(
        "{count} files of {app} (version {version}) in {}",
        dir.display()
    );
    Ok(())
}

// ---- help

pub fn help_all(cmds: &[Command]) {
    let b = output::bold;
    println!(
        "{} openbelt search <what you need>; nothing fits? openbelt docs, then openbelt app deploy <folder>.\n",
        b("Start with")
    );
    println!("{}", b("SETUP"));
    for (u, s) in SETUP {
        println!("  {:<44} {}", u, output::dim(s));
    }
    let mut groups: Vec<&str> = vec![];
    for c in cmds {
        if !groups.contains(&c.path[0].as_str()) {
            groups.push(&c.path[0]);
        }
    }
    let mut single: Vec<&Command> = cmds.iter().filter(|c| c.path.len() == 1).collect();
    let first = ["search", "docs"];
    single.sort_by_key(|c| {
        first
            .iter()
            .position(|f| *f == c.path[0])
            .unwrap_or(first.len())
    });
    println!("\n{}", b("FIND AND RUN"));
    for c in &single {
        println!("  {:<44} {}", c.usage, output::dim(&c.summary));
    }
    for g in groups
        .iter()
        .filter(|g| cmds.iter().any(|c| c.path[0] == **g && c.path.len() > 1))
    {
        println!("\n{}", b(&g.to_uppercase()));
        for c in cmds.iter().filter(|c| c.path[0] == *g && c.path.len() > 1) {
            println!("  {:<44} {}", c.usage, output::dim(&c.summary));
        }
    }
    println!(
        "\n{}",
        output::dim(
            "Values are words, numbers or JSON ('{\"a\": 1}', @file, or - for stdin). Output is JSON when piped, or with --json.\nopenbelt <command> --help shows a command's flags."
        )
    );
}

pub const SETUP: &[(&str, &str)] = &[
    (
        "install [workspace url]",
        "Sign in, and set OpenBelt up in your agents",
    ),
    (
        "status",
        "Your workspace, who you are, which agents have OpenBelt",
    ),
    (
        "login [workspace url] · login --wait · logout",
        "Sign in again, finish the sign-in install -y started, or sign out",
    ),
    (
        "update [--check]",
        "This openbelt swapped for your workspace's newest",
    ),
    ("call <tool> [json]", "Call any MCP tool by name"),
];

pub fn help_group(cmds: &[Command], group: &str) -> bool {
    let list: Vec<&Command> = cmds.iter().filter(|c| c.path[0] == group).collect();
    for c in &list {
        println!("  {:<44} {}", c.usage, output::dim(&c.summary));
    }
    !list.is_empty()
}

fn help_one(cmds: &[Command], c: &Command) {
    println!("openbelt {}\n\n{}\n", c.usage, c.summary);
    println!("{}\n", output::translate(&c.description, cmds));
    let in_slots: Vec<&String> = c.slots.iter().flat_map(|s| &s.names).collect();
    let props = c.schema["properties"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let flags: Vec<_> = props
        .iter()
        .filter(|(k, _)| !in_slots.contains(k))
        .collect();
    let workspace_variant = cmds
        .iter()
        .any(|other| other.path == c.path && other.workspace);
    if !flags.is_empty() || !local_flags(&c.tool).is_empty() || workspace_variant {
        println!("{}", output::bold("Flags"));
    }
    if workspace_variant {
        println!(
            "  --{:<18} {:<14} {}",
            "workspace",
            output::dim("boolean"),
            if c.workspace {
                "change or inspect workspace settings"
            } else {
                "use workspace settings instead of your own"
            }
        );
    }
    for (k, t, about) in local_flags(&c.tool) {
        println!("  --{:<18} {:<14} {}", k, output::dim(t), about);
    }
    for (k, s) in flags {
        if c.tool == "deploy_app" && (k == "files" || k == "app") {
            continue;
        }
        let d: String = output::translate(s["description"].as_str().unwrap_or(""), cmds)
            .chars()
            .take(160)
            .collect();
        println!(
            "  --{:<18} {:<14} {}",
            k,
            output::dim(&kinds(s).join("|")),
            d
        );
    }
}

// ---- hints written as MCP calls, said as commands

/// `call_function({ app: "x", function: "y", input })` as `openbelt fn run x.y '<input>'`.
pub fn render(cmds: &[Command], tool: &str, args: &Map<String, Value>) -> Option<String> {
    let c = cmds
        .iter()
        .filter(|c| c.tool == tool && fits(c, args))
        .max_by_key(|c| placed(c, args))?;
    let mut rest = args.clone();
    let mut words = vec!["openbelt".to_string()];
    words.extend(c.path.iter().cloned());
    for s in &c.slots {
        let vals: Vec<Option<Value>> = s.names.iter().map(|n| rest.remove(n)).collect();
        if vals.iter().all(Option::is_none) {
            if !s.optional {
                words.push(format!(
                    "<{}>",
                    s.names
                        .join(&s.sep.map(|c| format!(">{c}<")).unwrap_or_default())
                ));
            }
            continue;
        }
        let parts: Vec<String> = vals
            .iter()
            .zip(&s.names)
            .map(|(v, n)| v.as_ref().map(word).unwrap_or(format!("<{n}>")))
            .collect();
        words.push(parts.join(&s.sep.map(String::from).unwrap_or_default()));
    }
    if c.workspace {
        words.push("--workspace".into());
    }
    for (k, v) in rest {
        words.push(format!("--{k}"));
        if v != Value::Bool(true) {
            words.push(word(&v));
        }
    }
    Some(words.join(" "))
}

/// A tool with several commands (connections: list, info) takes the one whose arguments these are.
fn fits(c: &Command, args: &Map<String, Value>) -> bool {
    c.slots
        .iter()
        .all(|s| s.optional || s.names.iter().any(|n| args.contains_key(n)))
}

/// How many of the arguments a command's words take: the one that takes most says it best.
fn placed(c: &Command, args: &Map<String, Value>) -> usize {
    c.slots
        .iter()
        .flat_map(|s| &s.names)
        .filter(|n| args.contains_key(*n))
        .count()
}

fn word(v: &Value) -> String {
    match v {
        Value::String(s) if s.starts_with('<') && s.ends_with('>') => s.clone(),
        Value::String(s)
            if !s.is_empty()
                && s.chars()
                    .all(|c| c.is_alphanumeric() || "-_./:@".contains(c)) =>
        {
            s.clone()
        }
        Value::String(s) => format!("'{}'", s.replace('\'', "'\\''")),
        other => format!("'{other}'"),
    }
}
