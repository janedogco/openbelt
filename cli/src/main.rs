//! openbelt: OpenBelt from a terminal. `install` signs in once and sets OpenBelt up in your agents;
//! every other command comes from the workspace's MCP tools (commands.rs), so the CLI and the server
//! never disagree about what there is.

mod agents;
mod auth;
mod bridge;
mod commands;
mod mcp;
mod output;
mod update;

use auth::Credentials;
use commands::Error;
use mcp::{Failure, Session};
use output::{bold, dim, red};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(run(&args));
}

fn run(args: &[String]) -> i32 {
    let first = args.first().map(String::as_str).unwrap_or("");
    let result = match first {
        "mcp" => return bridge::run(),
        "install" => install(&args[1..]),
        "login" => login(&args[1..]),
        "logout" => logout(),
        "status" => status(),
        "update" => update_command(&args[1..]),
        "--version" | "-v" | "version" => {
            println!("openbelt {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        _ => {
            let done = server_command(args);
            if done.is_ok() {
                update::hint();
            }
            done
        }
    };
    match result {
        Ok(()) => 0,
        Err(Error::Usage(u)) => {
            eprintln!("usage: {u}");
            2
        }
        Err(Error::Failed(Failure::Error(e))) => {
            eprintln!("{}", red(&e));
            1
        }
        Err(Error::Failed(Failure::SignedOut(e))) => {
            eprintln!("{}", red(&e));
            1
        }
    }
}

fn session() -> Result<Session, Error> {
    let c = auth::load()
        .ok_or_else(|| Error::Usage("not signed in: openbelt install <workspace url>".into()))?;
    Ok(Session::open(c)?)
}

/// Every command the server's tools offer, `call`, and help.
fn server_command(args: &[String]) -> Result<(), Error> {
    let Some(credentials) = auth::load() else {
        println!(
            "{} openbelt install <workspace url>  {}\n",
            bold("Not signed in."),
            dim("(like https://acme.openbelt.app)")
        );
        for (u, s) in commands::SETUP {
            println!("  {:<44} {}", u, dim(s));
        }
        return if args.is_empty() || matches!(args[0].as_str(), "help" | "--help" | "-h") {
            Ok(())
        } else {
            Err(Error::Usage("sign in first".into()))
        };
    };
    let mut s = Session::open(credentials)?;
    let cmds = commands::load(&mut s)?;
    // A refusal's hints name MCP calls; say them as the commands that make them.
    in_cli_words(&mut s, &cmds, args).map_err(|e| match e {
        Error::Failed(Failure::Error(m)) => {
            Error::Failed(Failure::Error(output::translate(&m, &cmds)))
        }
        other => other,
    })
}

fn in_cli_words(s: &mut Session, cmds: &[commands::Command], args: &[String]) -> Result<(), Error> {
    if args.is_empty() || matches!(args[0].as_str(), "help" | "--help" | "-h") {
        commands::help_all(cmds);
        return Ok(());
    }
    if args[0] == "call" {
        let tool = args
            .get(1)
            .ok_or_else(|| Error::Usage("openbelt call <tool> [json]".into()))?;
        let input = match args.get(2) {
            Some(j) => serde_json::from_str(j)
                .map_err(|e| Error::Usage(format!("the input isn't JSON: {e}")))?,
            None => serde_json::json!({}),
        };
        let r = s.call(tool, input)?;
        output::show(
            &r,
            args.iter().any(|a| a == "--json") || !output::is_tty(),
            cmds,
        );
        return Ok(());
    }
    match commands::find(cmds, args) {
        Some((cmd, rest)) => commands::run(s, cmds, cmd, rest),
        None if (args.len() == 1
            || args.len() == 2 && matches!(args[1].as_str(), "--help" | "-h"))
            && commands::help_group(cmds, &args[0]) =>
        {
            Ok(())
        }
        None => Err(Error::Usage(format!(
            "openbelt has no command {}; openbelt --help lists them",
            args.join(" ")
        ))),
    }
}

fn flag(args: &[String], names: &[&str]) -> bool {
    args.iter().any(|a| names.contains(&a.as_str()))
}

fn value(args: &[String], names: &[&str]) -> Vec<String> {
    args.windows(2)
        .filter(|w| names.contains(&w[0].as_str()))
        .map(|w| w[1].clone())
        .collect()
}

fn positional(args: &[String]) -> Option<String> {
    let takes = ["--token", "-a", "--agent"];
    args.iter()
        .enumerate()
        .find(|(i, a)| !a.starts_with('-') && (*i == 0 || !takes.contains(&args[i - 1].as_str())))
        .map(|(_, a)| a.clone())
}

fn sign_in(url: &str, args: &[String]) -> Result<Credentials, Error> {
    if let Some(token) = value(args, &["--token"]).pop() {
        return Ok(Credentials {
            url: url.to_string(),
            how: auth::How::Token { token },
        });
    }
    let no_open = no_open(args);
    let previous = auth::load();
    let spinner = cliclack::spinner();
    let c = auth::sign_in(url, previous.as_ref(), &|link, code| {
        let opened = !no_open && open(link);
        let _ = cliclack::log::step(format!(
            "{} and check it shows {}:\n{link}",
            if opened {
                "Your browser opened this link"
            } else {
                "Open this link on any device"
            },
            bold(code)
        ));
        spinner.start(format!("Waiting for you to sign in to {}", host(url)));
    })
    .map_err(|e| {
        spinner.error(&e);
        Error::Failed(Failure::Error(e))
    })?;
    spinner.stop(format!("Signed in to {}", bold(&host(url))));
    Ok(c)
}

/// Over SSH a browser would open on the far machine, if at all: the person opens the link where they are.
fn no_open(args: &[String]) -> bool {
    flag(args, &["--no-open"])
        || std::env::var_os("SSH_CONNECTION").is_some()
        || std::env::var_os("SSH_TTY").is_some()
}

/// How `install` gets its sign-in. In a terminal, it waits for the person. Run by an agent (`-y`, or no terminal), a
/// device sign-in only starts: it prints the code the page shows and ends at once, so the agent can tell the person
/// that code, then wait with `openbelt login --wait`. The agent sees a command's output only once it has ended.
fn signed_in(url: &str, args: &[String], interactive: bool) -> Result<Option<Credentials>, Error> {
    if interactive || !value(args, &["--token"]).is_empty() {
        return sign_in(url, args).map(Some);
    }
    let previous = auth::load();
    let mut p =
        auth::start(url, previous.as_ref()).map_err(|e| Error::Failed(Failure::Error(e)))?;
    p.agents = args
        .iter()
        .enumerate()
        .filter(|(i, a)| {
            *a == "--all-agents"
                || matches!(a.as_str(), "-a" | "--agent")
                || *i > 0 && matches!(args[i - 1].as_str(), "-a" | "--agent")
        })
        .map(|(_, a)| a.clone())
        .collect();
    auth::save_pending(&p).map_err(|e| Error::Failed(Failure::Error(e)))?;
    let opened = !no_open(args) && open(&p.link);
    let command = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "openbelt".into());
    let tell = if opened {
        format!(
            "A page opened. Check that it shows {}, click Continue, then sign in.",
            p.user_code
        )
    } else {
        format!(
            "Open {} and check that it shows {}, click Continue, then sign in.",
            p.link, p.user_code
        )
    };
    let _ = cliclack::outro(format!(
        "Sign-in started at {}\nCode: {}\nTell the person now, with the code: \"{tell}\"\nThen run: {command} login --wait (it returns once they've signed in, and sets up this agent)",
        p.link, p.user_code
    ));
    Ok(None)
}

fn open(link: &str) -> bool {
    let cmd = if cfg!(target_os = "macos") {
        ("open", vec![link])
    } else if cfg!(windows) {
        ("cmd", vec!["/c", "start", "", link])
    } else {
        ("xdg-open", vec![link])
    };
    std::process::Command::new(cmd.0)
        .args(cmd.1)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn host(url: &str) -> String {
    url.split_once("://")
        .map(|(_, h)| h.to_string())
        .unwrap_or_else(|| url.to_string())
}

fn install(args: &[String]) -> Result<(), Error> {
    let interactive = output::stdin_is_tty() && output::is_tty() && !flag(args, &["-y", "--yes"]);
    let _ = cliclack::intro(" openbelt ");
    let saved = auth::load();
    // The install script says where it came from (OPENBELT_FROM): sign in there without asking, since an agent's shell
    // can look like a terminal (a PTY) that no one answers.
    let from = std::env::var("OPENBELT_FROM")
        .ok()
        .filter(|f| !f.is_empty());
    let typed = match positional(args)
        .or_else(|| saved.as_ref().map(|c| c.url.clone()))
        .or(from)
    {
        Some(u) => u,
        None if interactive => cliclack::input("OpenBelt address")
            .placeholder("https://openbelt.com")
            .interact()
            .map_err(|_| Error::Usage("nothing changed".into()))?,
        None => return Err(Error::Usage("openbelt install <workspace url>".into())),
    };
    let url = auth::origin(&typed).map_err(Error::Usage)?;
    let credentials = match &saved {
        Some(c) if c.url == url && value(args, &["--token"]).is_empty() => c.clone(),
        _ => match signed_in(&url, args, interactive)? {
            Some(c) => c,
            None => return Ok(()),
        },
    };
    set_up(&url, credentials, args, interactive)
}

/// After the sign-in: check it, save it, and add OpenBelt to the agents chosen.
fn set_up(
    url: &str,
    mut credentials: Credentials,
    args: &[String],
    interactive: bool,
) -> Result<(), Error> {
    let url = url.to_string();
    let spinner = cliclack::spinner();
    spinner.start("Checking the connection");
    let mut s = match Session::open(credentials.clone()) {
        Ok(s) => s,
        Err(Failure::SignedOut(_)) => {
            spinner.stop("Your saved sign-in has ended");
            credentials = match signed_in(&url, args, interactive)? {
                Some(c) => c,
                None => return Ok(()),
            };
            Session::open(credentials.clone())?
        }
        Err(e) => {
            spinner.error("Couldn't connect");
            return Err(Error::Failed(e));
        }
    };
    let who = s.call("whoami", serde_json::json!({}))?;
    auth::save(&s.credentials).map_err(|e| Error::Failed(Failure::Error(e)))?;
    spinner.stop(format!(
        "Connected to {} as {}",
        bold(&host(&url)),
        who["person"]["email"].as_str().unwrap_or("you")
    ));

    let command = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "openbelt".into());
    let _ = cliclack::note(
        "Any agent: add OpenBelt as an MCP server",
        format!(
            "{{ \"mcpServers\": {{ \"openbelt\": {{ \"command\": \"{command}\", \"args\": [\"mcp\"] }} }} }}"
        ),
    );

    let named: Vec<String> = value(args, &["-a", "--agent"]);
    let found: Vec<&agents::Agent> = agents::AGENTS.iter().filter(|a| a.installed()).collect();
    let chosen: Vec<&agents::Agent> = if flag(args, &["--all-agents"]) {
        found.clone()
    } else if !named.is_empty() {
        named
            .iter()
            .map(|n| {
                agents::find(n).ok_or_else(|| {
                    Error::Usage(format!(
                        "no agent {n}; one of {}",
                        agents::AGENTS
                            .iter()
                            .map(|a| a.id)
                            .collect::<Vec<_>>()
                            .join(", ")
                    ))
                })
            })
            .collect::<Result<_, _>>()?
    } else if !interactive {
        match agents::calling().and_then(agents::find) {
            Some(a) => vec![a],
            None => found.clone(),
        }
    } else {
        let mut pick =
            cliclack::multiselect("Set OpenBelt up in these agents for you?").required(false);
        // The agents found on this machine first, already ticked; the rest after them.
        let (here, missing): (Vec<_>, Vec<_>) = agents::AGENTS.iter().partition(|a| a.installed());
        for a in here {
            pick = pick.item(a.id, a.name, "found");
        }
        for a in missing {
            pick = pick.item(a.id, a.name, "not found");
        }
        let ids: Vec<&str> = pick
            .initial_values(found.iter().map(|a| a.id).collect())
            .interact()
            .map_err(|_| Error::Usage("signed in; no agents changed".into()))?;
        ids.iter().filter_map(|id| agents::find(id)).collect()
    };
    if !chosen.is_empty() {
        let lines: Vec<String> = chosen
            .iter()
            .map(|a| match a.configure(&command) {
                Ok(o) => format!(
                    "✓ {:<12} {:<10} {}",
                    a.name,
                    o.word(),
                    dim(&tilde(&a.file()))
                ),
                Err(e) => format!("✗ {:<12} {}", a.name, e),
            })
            .collect();
        let _ = cliclack::log::success(lines.join("\n"));
    }
    let _ = cliclack::outro(format!(
        "Done. Try {} or ask your agent to build an app on OpenBelt.",
        bold("openbelt search <what you need>")
    ));
    Ok(())
}

fn tilde(p: &std::path::Path) -> String {
    let h = auth::home().display().to_string();
    let s = p.display().to_string();
    if !h.is_empty() && s.starts_with(&h) {
        format!("~{}", &s[h.len()..])
    } else {
        s
    }
}

fn login(args: &[String]) -> Result<(), Error> {
    if flag(args, &["--wait"]) {
        return login_wait(args);
    }
    let url = match positional(args).or_else(|| auth::load().map(|c| c.url)) {
        Some(u) => auth::origin(&u).map_err(Error::Usage)?,
        None => return Err(Error::Usage("openbelt login <workspace url>".into())),
    };
    let c = sign_in(&url, args)?;
    Session::open(c.clone())?;
    auth::save(&c).map_err(|e| Error::Failed(Failure::Error(e)))?;
    Ok(())
}

/// Finishes the sign-in `openbelt install -y` started: waits for the person to approve the code, then sets up as install does.
fn login_wait(args: &[String]) -> Result<(), Error> {
    let p = auth::load_pending().ok_or_else(|| {
        Error::Usage("no sign-in is waiting: run `openbelt install -y` to start one".into())
    })?;
    let _ = cliclack::intro(" openbelt ");
    let spinner = cliclack::spinner();
    spinner.start(format!(
        "Waiting for you to sign in to {} (the page shows {})",
        host(&p.url),
        p.user_code
    ));
    let c = auth::finish(&p).map_err(|e| {
        spinner.error(&e);
        auth::forget_pending();
        Error::Failed(Failure::Error(e))
    })?;
    auth::forget_pending();
    spinner.stop(format!("Signed in to {}", bold(&host(&p.url))));
    // The agents install was told to set up, unless this command names its own.
    let named = flag(args, &["--all-agents"]) || !value(args, &["-a", "--agent"]).is_empty();
    let args = if named {
        args.to_vec()
    } else {
        p.agents.clone()
    };
    set_up(&p.url, c, &args, false)
}

fn logout() -> Result<(), Error> {
    match auth::load() {
        Some(c) => {
            auth::revoke(&c);
            auth::forget();
            println!("Signed out of {}.", c.url);
        }
        None => println!("Not signed in."),
    }
    Ok(())
}

fn update_command(args: &[String]) -> Result<(), Error> {
    let check = flag(args, &["--check"]);
    match update::run(!check).map_err(|e| Error::Failed(Failure::Error(e)))? {
        update::Outcome::Current => println!("openbelt is up to date."),
        update::Outcome::Available => println!("A newer openbelt is out: openbelt update"),
        update::Outcome::Updated { from, to } => println!("Updated openbelt ({from} → {to})."),
    }
    Ok(())
}

fn status() -> Result<(), Error> {
    let mut s = session()?;
    let who = s.call("whoami", serde_json::json!({}))?;
    println!(
        "{:<8} {}  {}",
        bold("Workspace"),
        s.credentials.url,
        dim(&format!("({})", s.credentials.describe()))
    );
    println!(
        "{:<8} {} {}",
        bold("You"),
        who["person"]["email"].as_str().unwrap_or("?"),
        dim(&format!(
            "({})",
            who["person"]["role"].as_str().unwrap_or("member")
        ))
    );
    println!("{}", bold("Agents"));
    for a in agents::AGENTS {
        let mark = if a.configured() { "●" } else { "○" };
        println!("  {mark} {:<12} {}", a.name, dim(&tilde(&a.file())));
    }
    Ok(())
}
