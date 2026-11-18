//! What a command prints: YAML-like text in a terminal, JSON when piped (or --json), and the
//! server's hints said as openbelt commands instead of MCP calls.

use crate::commands::{self, Command};
use serde_json::{Map, Value};
use std::io::IsTerminal;

pub fn is_tty() -> bool {
    std::io::stdout().is_terminal()
}

pub fn stdin_is_tty() -> bool {
    std::io::stdin().is_terminal()
}

fn color() -> bool {
    std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none()
}

fn paint(code: &str, s: &str) -> String {
    if color() {
        format!("\x1b[{code}m{s}\x1b[0m")
    } else {
        s.to_string()
    }
}

pub fn bold(s: &str) -> String {
    paint("1", s)
}

pub fn dim(s: &str) -> String {
    paint("2", s)
}

pub fn red(s: &str) -> String {
    paint("31", s)
}

pub fn show(v: &Value, json: bool, cmds: &[Command]) {
    let v = translate_all(v, cmds);
    if json {
        println!("{}", serde_json::to_string_pretty(&v).unwrap());
        return;
    }
    let v = match v {
        Value::Object(mut o) => {
            o.remove("trace");
            Value::Object(o)
        }
        other => other,
    };
    let mut out = String::new();
    yaml(&v, 0, &mut out);
    print!("{out}");
}

/// Text results (docs) as text, piped or not.
pub fn text(v: &Value, cmds: &[Command]) {
    match v {
        Value::String(s) => println!("{}", translate(s, cmds)),
        Value::Object(o) if o.get("text").is_some_and(Value::is_string) => {
            println!("{}", translate(o["text"].as_str().unwrap(), cmds))
        }
        other => show(other, !is_tty(), cmds),
    }
}

fn plain(s: &str) -> bool {
    !s.is_empty()
        && !s.contains(": ")
        && !s.contains(" #")
        && !s.starts_with(|c: char| "-?:,[]{}#&*!|>'\"%@` ".contains(c))
        && !s.ends_with([' ', ':'])
        && !matches!(s, "true" | "false" | "null" | "~")
        && s.parse::<f64>().is_err()
}

fn scalar(v: &Value) -> Option<String> {
    Some(match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) if s.contains('\n') => return None,
        Value::String(s) if plain(s) => s.clone(),
        Value::String(s) => serde_json::to_string(s).unwrap(),
        Value::Array(a) if a.is_empty() => "[]".into(),
        Value::Object(o) if o.is_empty() => "{}".into(),
        _ => return None,
    })
}

fn yaml(v: &Value, indent: usize, out: &mut String) {
    let pad = " ".repeat(indent);
    match v {
        Value::Object(o) => {
            for (k, v) in o {
                match (scalar(v), v) {
                    (Some(s), _) => out.push_str(&format!("{pad}{k}: {s}\n")),
                    (None, Value::String(s)) => {
                        out.push_str(&format!("{pad}{k}: |\n"));
                        for line in s.lines() {
                            out.push_str(&format!("{pad}  {line}\n"));
                        }
                    }
                    (None, _) => {
                        out.push_str(&format!("{pad}{k}:\n"));
                        yaml(v, indent + 2, out);
                    }
                }
            }
        }
        Value::Array(a) => {
            for item in a {
                match (scalar(item), item) {
                    (Some(s), _) => out.push_str(&format!("{pad}- {s}\n")),
                    (None, Value::Object(_)) => {
                        let mut inner = String::new();
                        yaml(item, indent + 2, &mut inner);
                        out.push_str(&format!("{pad}- {}", &inner[indent + 2..]));
                    }
                    (None, _) => {
                        out.push_str(&format!("{pad}-\n"));
                        yaml(item, indent + 2, out);
                    }
                }
            }
        }
        other => out.push_str(&format!(
            "{pad}{}\n",
            scalar(other).unwrap_or_else(|| other.as_str().unwrap_or("").to_string())
        )),
    }
}

/// search's results as what to run next.
pub fn search(r: &Value, cmds: &[Command]) {
    let apps = r["apps"].as_array().cloned().unwrap_or_default();
    let conns = r["connections"].as_array().cloned().unwrap_or_default();
    if apps.is_empty() && conns.is_empty() {
        println!(
            "Nothing matches. Build it: openbelt docs apps, then openbelt app deploy <folder>."
        );
    }
    for a in &apps {
        let name = a["app"].as_str().unwrap_or("");
        println!("{}  {}", bold(name), dim(a["url"].as_str().unwrap_or("")));
        if let Some(d) = a["description"].as_str() {
            println!("  {d}");
        }
        for f in a["functions"].as_array().into_iter().flatten() {
            let fname = f["name"].as_str().unwrap_or("");
            println!("  fn {fname}  {}", dim(f["about"].as_str().unwrap_or("")));
            if !f["input"].is_null() {
                println!(
                    "     input: {}",
                    f["input"]
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| f["input"].to_string())
                );
            }
            println!("     openbelt fn run {name}.{fname} '<input json>'");
        }
        for c in a["collections"].as_array().into_iter().flatten() {
            let cname = c["name"].as_str().unwrap_or("");
            let docs = c["docs"]
                .as_u64()
                .map(|n| format!(" ({n} docs)"))
                .unwrap_or_default();
            println!(
                "  data {cname}  {}{}",
                dim(c["about"].as_str().unwrap_or("")),
                dim(&docs)
            );
            println!("     openbelt data list {name}/{cname}");
        }
        for s in a["skills"].as_array().into_iter().flatten() {
            if let Some(uri) = s["uri"].as_str() {
                println!(
                    "  skill {}  openbelt skills {uri}",
                    s["name"].as_str().unwrap_or("")
                );
            }
        }
        let shown = a["functions"].as_array().map(Vec::len).unwrap_or(0) as u64;
        if a["functionCount"].as_u64().unwrap_or(0) > shown {
            println!(
                "  {}",
                dim(&format!("more functions: openbelt app info {name}"))
            );
        }
        println!();
    }
    for c in &conns {
        let name = c["name"]
            .as_str()
            .or(c["connection"].as_str())
            .unwrap_or("");
        println!(
            "{} {}  {}",
            bold(name),
            dim("(connection)"),
            c["description"]
                .as_str()
                .or(c["about"].as_str())
                .unwrap_or("")
        );
        for t in c["tools"].as_array().into_iter().flatten().take(8) {
            let tname = t["name"].as_str().or(t.as_str()).unwrap_or("");
            let full = if tname.contains('.') {
                tname.to_string()
            } else {
                format!("{name}.{tname}")
            };
            println!("  openbelt connection call {full} '<input json>'");
        }
        println!();
    }
    if let Some(n) = r["note"].as_str() {
        println!("{}", dim(&translate(n, cmds)));
    }
}

fn translate_all(v: &Value, cmds: &[Command]) -> Value {
    match v {
        Value::String(s) => Value::String(translate(s, cmds)),
        Value::Array(a) => Value::Array(a.iter().map(|x| translate_all(x, cmds)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), translate_all(x, cmds)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The server's hints say MCP calls (`function_runs({ app: "x" })`, `` `app_info` ``); here they
/// become the commands that make them (`openbelt fn runs x`, `` `openbelt app info` ``).
pub fn translate(text: &str, cmds: &[Command]) -> String {
    let mut out = String::with_capacity(text.len());
    let b = text.as_bytes();
    let mut i = 0;
    'scan: while i < b.len() {
        let at_word =
            i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_' || b[i - 1] == b'.');
        if at_word && b[i].is_ascii_lowercase() {
            for c in cmds {
                let name = c.tool.as_bytes();
                if !b[i..].starts_with(name) {
                    continue;
                }
                let after = i + name.len();
                if b.get(after) == Some(&b'(') {
                    if let Some((args, end)) = call_args(text, after + 1)
                        && let Some(r) = commands::render(cmds, &c.tool, &args)
                    {
                        out.push_str(&r);
                        i = end;
                        continue 'scan;
                    }
                } else if i > 0 && b[i - 1] == b'`' && b.get(after) == Some(&b'`') {
                    let first = cmds.iter().find(|x| x.tool == c.tool).unwrap();
                    out.push_str(&format!(
                        "openbelt {}{}",
                        first.path.join(" "),
                        if first.workspace { " --workspace" } else { "" }
                    ));
                    i = after;
                    continue 'scan;
                }
            }
        }
        let ch = text[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// After `name(`: `)` or a JS object literal then `)`; its keys and values, and where it ends.
fn call_args(text: &str, start: usize) -> Option<(Map<String, Value>, usize)> {
    let mut p = Lit {
        s: text.as_bytes(),
        i: start,
    };
    p.ws();
    if p.peek() == Some(b')') {
        return Some((Map::new(), p.i + 1));
    }
    let v = p.object()?;
    p.ws();
    (p.peek() == Some(b')')).then(|| (v, p.i + 1))
}

/// A forgiving reader of the object literals hints are written in: bare keys (`app`), optional
/// ones (`function?`), shorthand (`input`), spreads (`...common`), `[...]` and `${x}` placeholders.
struct Lit<'a> {
    s: &'a [u8],
    i: usize,
}

impl Lit<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }
    fn ws(&mut self) {
        while self.peek().is_some_and(|c| c.is_ascii_whitespace()) {
            self.i += 1;
        }
    }
    fn ident(&mut self) -> Option<String> {
        let start = self.i;
        while self
            .peek()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'$')
        {
            self.i += 1;
        }
        (self.i > start).then(|| String::from_utf8_lossy(&self.s[start..self.i]).into_owned())
    }
    fn object(&mut self) -> Option<Map<String, Value>> {
        if self.peek()? != b'{' {
            return None;
        }
        self.i += 1;
        let mut m = Map::new();
        loop {
            self.ws();
            match self.peek()? {
                b'}' => {
                    self.i += 1;
                    return Some(m);
                }
                b',' => self.i += 1,
                b'.' if self.s[self.i..].starts_with(b"...") => {
                    self.i += 3;
                    self.ident();
                }
                b'"' | b'\'' => {
                    let k = self.string()?;
                    self.entry(k, &mut m)?;
                }
                _ => {
                    let k = self.ident()?;
                    self.entry(k, &mut m)?;
                }
            }
        }
    }
    fn entry(&mut self, k: String, m: &mut Map<String, Value>) -> Option<()> {
        if self.peek() == Some(b'?') {
            self.i += 1;
        }
        self.ws();
        if self.peek() == Some(b':') {
            self.i += 1;
            self.ws();
            let v = self.value()?;
            m.insert(k, v);
        } else {
            m.insert(k.clone(), Value::String(format!("<{k}>")));
        }
        Some(())
    }
    fn value(&mut self) -> Option<Value> {
        match self.peek()? {
            b'{' => self.object().map(Value::Object),
            b'[' => {
                let start = self.i;
                let mut depth = 0;
                while let Some(c) = self.peek() {
                    self.i += 1;
                    match c {
                        b'[' => depth += 1,
                        b']' => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                let raw = String::from_utf8_lossy(&self.s[start..self.i]).into_owned();
                Some(
                    serde_json::from_str(&raw.replace('\'', "\""))
                        .unwrap_or_else(|_| Value::String("<…>".into())),
                )
            }
            b'"' | b'\'' | b'`' => self
                .string()
                .map(|s| Value::String(if s.contains("${") { placeholder(&s) } else { s })),
            b'<' => {
                let start = self.i;
                while self.peek().is_some_and(|c| c != b'>') {
                    self.i += 1;
                }
                self.i += 1;
                Some(Value::String(
                    String::from_utf8_lossy(&self.s[start..self.i]).into_owned(),
                ))
            }
            c if c == b'-' || c.is_ascii_digit() => {
                let start = self.i;
                while self
                    .peek()
                    .is_some_and(|c| c == b'-' || c == b'.' || c.is_ascii_digit())
                {
                    self.i += 1;
                }
                serde_json::from_slice(&self.s[start..self.i]).ok()
            }
            _ => {
                let id = self.ident()?;
                Some(match id.as_str() {
                    "true" => Value::Bool(true),
                    "false" => Value::Bool(false),
                    "null" => Value::Null,
                    _ => Value::String(format!("<{id}>")),
                })
            }
        }
    }
    fn string(&mut self) -> Option<String> {
        let q = self.peek()?;
        self.i += 1;
        let start = self.i;
        while let Some(c) = self.peek() {
            if c == b'\\' {
                self.i += 2;
                continue;
            }
            if c == q {
                let s = String::from_utf8_lossy(&self.s[start..self.i]).into_owned();
                self.i += 1;
                return Some(s);
            }
            self.i += 1;
        }
        None
    }
}

/// `"${app}"` in a template hint → `<app>`.
fn placeholder(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        let end = rest[i..].find('}').map(|e| i + e).unwrap_or(rest.len() - 1);
        let inner = rest[i + 2..end]
            .split(['.', ' '])
            .next_back()
            .unwrap_or("x");
        out.push_str(&format!("<{inner}>"));
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}
