//! `openbelt update`: this binary swapped for the build the signed-in workspace hands out (/_cli/*), when
//! its sha256 differs from this one's, checked before it replaces anything. Once a day another
//! command asks the same and says when there's a new one.

use crate::auth;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, time::Duration};

/// This machine's build, as the platform names it (runtime/cli.ts CLI_TARGETS).
pub fn target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-musl"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-musl"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-gnu.exe"),
        _ => None,
    }
}

fn agent(seconds: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(seconds)))
        .build()
        .into()
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn me() -> Result<(PathBuf, String), String> {
    let exe = std::env::current_exe().map_err(|e| format!("can't find this openbelt: {e}"))?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let bytes = fs::read(&exe).map_err(|e| format!("can't read {}: {e}", exe.display()))?;
    Ok((exe, hex(&bytes)))
}

/// The sha256 of the workspace's build for this machine.
fn offered(url: &str, target: &str, seconds: u64) -> Result<String, String> {
    let link = format!("{url}/_cli/openbelt-{target}.sha256");
    let mut res = agent(seconds)
        .get(&link)
        .call()
        .map_err(|e| format!("can't reach {url}: {e}"))?;
    let body = res.body_mut().read_to_string().unwrap_or_default();
    if res.status() == 404 {
        return Err(format!("{url} has no openbelt build for {target}"));
    }
    if !res.status().is_success() {
        return Err(format!("{link} answered {}", res.status()));
    }
    Ok(body.trim().to_string())
}

pub enum Outcome {
    Current,
    Available,
    Updated { from: String, to: String },
}

/// Checks (and with `apply`, installs) the workspace's build for this machine.
pub fn run(apply: bool) -> Result<Outcome, String> {
    let c = auth::load().ok_or(
        "openbelt update asks your workspace for its build: run openbelt install <workspace url> first",
    )?;
    let target = target().ok_or("there's no openbelt build for this platform")?;
    let want = offered(&c.url, target, 30)?;
    let (exe, have) = me()?;
    if want == have {
        return Ok(Outcome::Current);
    }
    if !apply {
        return Ok(Outcome::Available);
    }
    let mut res = agent(120)
        .get(&format!("{}/_cli/openbelt-{target}", c.url))
        .call()
        .map_err(|e| format!("can't download the new openbelt: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("the download answered {}", res.status()));
    }
    let bytes = res
        .body_mut()
        .with_config()
        .limit(64 * 1024 * 1024)
        .read_to_vec()
        .map_err(|e| format!("the download broke off: {e}"))?;
    let got = hex(&bytes);
    if got != want {
        return Err(format!(
            "the download doesn't match its sha256 ({got}, not {want}); nothing changed"
        ));
    }
    replace(&exe, &bytes)?;
    Ok(Outcome::Updated {
        from: have[..12].to_string(),
        to: want[..12].to_string(),
    })
}

/// Writes the new build beside this one, then renames it over this one.
fn replace(exe: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    let fresh = exe.with_extension("new");
    let denied = |e: std::io::Error| {
        format!(
            "can't write beside {} ({e}): run openbelt update as whoever installed it",
            exe.display()
        )
    };
    fs::write(&fresh, bytes).map_err(denied)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&fresh, fs::Permissions::from_mode(0o755)).map_err(denied)?;
    }
    // Windows won't overwrite a running program, but it renames one.
    #[cfg(windows)]
    {
        let old = exe.with_extension("old");
        let _ = fs::remove_file(&old);
        fs::rename(exe, &old).map_err(denied)?;
    }
    fs::rename(&fresh, exe).map_err(|e| {
        let _ = fs::remove_file(&fresh);
        denied(e)
    })
}

fn stamp() -> PathBuf {
    std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| auth::home().join(".cache"))
        .join("openbelt")
        .join("update-checked")
}

/// Once a day: a line on stderr when the workspace has a newer openbelt. Quiet on any failure.
pub fn hint() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = stamp();
    let last: u64 = fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    if now.saturating_sub(last) < 24 * 60 * 60 {
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(&path, now.to_string());
    let (Some(c), Some(target)) = (auth::load(), target()) else {
        return;
    };
    if let (Ok(want), Ok((_, have))) = (offered(&c.url, target, 3), me())
        && want != have
    {
        eprintln!(
            "openbelt: {} has a newer openbelt: run openbelt update",
            c.url
        );
    }
}
