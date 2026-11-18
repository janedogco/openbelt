//! `openbelt mcp`: what `openbelt install` writes into each agent's config. It passes JSON-RPC
//! between the agent (newline-delimited on stdin and stdout) and the workspace's /mcp, with the saved
//! sign-in, so no agent's config holds a token. Requests run at once, each on its own thread:
//! agents call tools in parallel.

use crate::auth;
use crate::mcp::{self, Failure, Session};
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

pub fn run() -> i32 {
    let Some(credentials) = auth::load() else {
        eprintln!("openbelt: not signed in; run `openbelt install <workspace url>`");
        return 1;
    };
    let session = Arc::new(Mutex::new(Session::bridge(credentials)));
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let mut threads = vec![];
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            write(
                &out,
                &json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "not JSON" } }),
            );
            continue;
        };
        let initialize = message["method"] == "initialize";
        let (session, out) = (session.clone(), out.clone());
        let work = move || {
            // initialize runs before the next line is read, so every later request has its session.
            let mut s = session.lock().unwrap().clone_for_request();
            let answers = match s.forward(&message) {
                Ok(Some(list)) => Ok(list),
                Ok(None) => renew(&session, &mut s).and_then(|()| {
                    s.forward(&message)?
                        .ok_or_else(|| mcp::signed_out(&s.credentials))
                }),
                Err(e) => Err(e),
            };
            session.lock().unwrap().adopt(&s);
            match answers {
                Ok(list) => list.iter().for_each(|m| write(&out, m)),
                Err(f) => {
                    let why = match f {
                        Failure::Error(e) | Failure::SignedOut(e) => e,
                    };
                    eprintln!("openbelt: {why}");
                    if let Some(id) = message.get("id") {
                        write(
                            &out,
                            &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": why } }),
                        );
                    }
                }
            }
        };
        if initialize {
            work();
        } else {
            threads.push(std::thread::spawn(work));
        }
    }
    for t in threads {
        let _ = t.join();
    }
    0
}

/// After a 401: the sign-in another request already renewed, or a renewal now, one at a time
/// (a refresh token is spent when it's used).
fn renew(shared: &Mutex<Session>, s: &mut Session) -> Result<(), Failure> {
    let mut current = shared.lock().unwrap();
    if current.credentials.bearer() == s.credentials.bearer() {
        if !current.credentials.can_refresh() {
            return Err(mcp::signed_out(&current.credentials));
        }
        auth::refresh(&mut current.credentials).map_err(Failure::SignedOut)?;
    }
    s.credentials = current.credentials.clone();
    Ok(())
}

fn write(out: &Arc<Mutex<std::io::Stdout>>, m: &Value) {
    let mut o = out.lock().unwrap();
    let _ = writeln!(o, "{m}");
    let _ = o.flush();
}
