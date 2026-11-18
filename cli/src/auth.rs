//! The sign-in: a workspace's URL and either an API token or OAuth tokens (OpenBelt's own sign-in for
//! agents, with a device code: a client registered once, a link and a code the person approves in
//! any browser, on this machine or another, while the CLI asks for the tokens). Kept in
//! `$XDG_CONFIG_HOME/openbelt/credentials.json` (else `~/.config`), readable by you alone: agents start
//! `openbelt mcp` with only HOME set, so the file is found from HOME too. A sign-in started for an agent and not
//! finished yet (`openbelt install -y`, then `openbelt login --wait`) waits in `pending.json` beside it.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Serialize, Deserialize, Clone)]
pub struct Credentials {
    /// The workspace's origin, `https://acme.openbelt.app`.
    pub url: String,
    #[serde(flatten)]
    pub how: How,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum How {
    Token {
        token: String,
    },
    Oauth {
        client_id: String,
        token_endpoint: String,
        access_token: String,
        refresh_token: Option<String>,
    },
}

impl Credentials {
    pub fn bearer(&self) -> &str {
        match &self.how {
            How::Token { token } => token,
            How::Oauth { access_token, .. } => access_token,
        }
    }

    pub fn can_refresh(&self) -> bool {
        matches!(
            &self.how,
            How::Oauth {
                refresh_token: Some(_),
                ..
            }
        )
    }

    pub fn describe(&self) -> &'static str {
        match self.how {
            How::Token { .. } => "an API token",
            How::Oauth { .. } => "signed in with the browser",
        }
    }
}

pub fn file() -> PathBuf {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config"));
    config.join("openbelt").join("credentials.json")
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

pub fn load() -> Option<Credentials> {
    serde_json::from_str(&fs::read_to_string(file()).ok()?).ok()
}

pub fn save(c: &Credentials) -> Result<(), String> {
    write_private(&file(), &serde_json::to_string_pretty(c).unwrap())
}

/// A file only you can read: it holds a token or a device code.
fn write_private(path: &std::path::Path, text: &str) -> Result<(), String> {
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| format!("can't write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn forget() {
    let _ = fs::remove_file(file());
}

/// A device sign-in started and not finished: what `finish` asks the token endpoint with, and what the person is shown.
#[derive(Serialize, Deserialize)]
pub struct Pending {
    pub url: String,
    client_id: String,
    token_endpoint: String,
    device_code: String,
    /// The code the sign-in page shows, `BCDF-GHJK`.
    pub user_code: String,
    /// The page to approve it at, with the code in it.
    pub link: String,
    /// When the code runs out, in seconds since 1970.
    expires: u64,
    interval: u64,
    /// The agents install was told to set up (`-a codex`, `--all-agents`), for `login --wait` to set up the same.
    #[serde(default)]
    pub agents: Vec<String>,
}

fn pending_file() -> PathBuf {
    file().with_file_name("pending.json")
}

pub fn save_pending(p: &Pending) -> Result<(), String> {
    write_private(&pending_file(), &serde_json::to_string_pretty(p).unwrap())
}

pub fn load_pending() -> Option<Pending> {
    serde_json::from_str(&fs::read_to_string(pending_file()).ok()?).ok()
}

pub fn forget_pending() {
    let _ = fs::remove_file(pending_file());
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `https://acme.openbelt.app`, from what someone typed: a host, a URL, or one with /mcp on it.
pub fn origin(typed: &str) -> Result<String, String> {
    let t = typed.trim().trim_end_matches('/');
    let with = if t.contains("://") {
        t.to_string()
    } else if t.ends_with(".localhost") || t.contains(".localhost:") {
        format!("http://{t}")
    } else {
        format!("https://{t}")
    };
    let rest = with.split_once("://").map(|(_, r)| r).unwrap_or("");
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() {
        return Err(format!(
            "{typed} isn't a workspace's address (like https://acme.openbelt.app)"
        ));
    }
    Ok(format!("{}://{host}", with.split_once("://").unwrap().0))
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .into()
}

fn get_json(url: &str) -> Result<Value, String> {
    let mut res = agent()
        .get(url)
        .call()
        .map_err(|e| format!("can't reach {url}: {e}"))?;
    let status = res.status();
    let text = res.body_mut().read_to_string().unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "{url} answered {status}: {}",
            text.chars().take(200).collect::<String>()
        ));
    }
    serde_json::from_str(&text)
        .map_err(|_| format!("{url} didn't answer JSON; is it an OpenBelt workspace's address?"))
}

/// An OAuth endpoint's refusal: its error code (`authorization_pending`, `invalid_grant`, ...) and why.
struct Refused {
    error: String,
    why: String,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.error, self.why)
    }
}

fn post_oauth(url: &str, form: &[(&str, &str)]) -> Result<Value, Refused> {
    let refused = |error: &str, why: String| Refused {
        error: error.into(),
        why,
    };
    let mut res = agent()
        .post(url)
        .send_form(form.iter().copied())
        .map_err(|e| refused("unreachable", format!("can't reach {url}: {e}")))?;
    let text = res.body_mut().read_to_string().unwrap_or_default();
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if let Some(e) = v.get("error") {
        return Err(refused(
            e.as_str().unwrap_or("refused"),
            v["error_description"].as_str().unwrap_or("").to_string(),
        ));
    }
    if !res.status().is_success() {
        // A 5xx with no OAuth error is the server or its proxy, not an answer: worth asking again.
        let kind = if res.status().is_server_error() {
            "unreachable"
        } else {
            "refused"
        };
        return Err(refused(kind, format!("{url} answered {}", res.status())));
    }
    Ok(v)
}

fn post(url: &str, form: &[(&str, &str)]) -> Result<Value, String> {
    post_oauth(url, form).map_err(|r| r.to_string())
}

const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// Signs in with a device code (RFC 8628) and returns the credentials (not yet saved). `show` gets
/// the link to approve it at (the code in it) and the code itself: it opens a browser or prints them.
pub fn sign_in(
    url: &str,
    previous: Option<&Credentials>,
    show: &dyn Fn(&str, &str),
) -> Result<Credentials, String> {
    let p = start(url, previous)?;
    show(&p.link, &p.user_code);
    finish(&p)
}

/// The first half of a device sign-in: the CLI registered (once per workspace) and a code to approve.
pub fn start(url: &str, previous: Option<&Credentials>) -> Result<Pending, String> {
    let meta = get_json(&format!("{url}/.well-known/oauth-authorization-server"))?;
    let endpoint = |k: &str| {
        meta[k].as_str().map(str::to_string).ok_or_else(|| {
            format!("{url} has no {k}; is it an OpenBelt workspace, and up to date?")
        })
    };
    let (device, token_endpoint, register) = (
        endpoint("device_authorization_endpoint")?,
        endpoint("token_endpoint")?,
        endpoint("registration_endpoint")?,
    );

    let client_id = match previous.map(|c| &c.how) {
        Some(How::Oauth { client_id, .. }) if previous.unwrap().url == url => client_id.clone(),
        _ => {
            let mut res = agent()
                .post(&register)
                .send_json(serde_json::json!({ "client_name": "OpenBelt CLI", "grant_types": [DEVICE_GRANT, "refresh_token"], "token_endpoint_auth_method": "none" }))
                .map_err(|e| format!("can't reach {register}: {e}"))?;
            let v: Value =
                serde_json::from_str(&res.body_mut().read_to_string().unwrap_or_default())
                    .unwrap_or(Value::Null);
            v["client_id"]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("{register} didn't register the CLI: {v}"))?
        }
    };

    let started = post(&device, &[("client_id", &client_id)])?;
    let device_code = started["device_code"]
        .as_str()
        .ok_or("the device authorization endpoint gave no device_code")?;
    let link = started["verification_uri_complete"]
        .as_str()
        .or(started["verification_uri"].as_str())
        .ok_or("the device authorization endpoint gave no verification_uri")?;
    Ok(Pending {
        url: url.to_string(),
        client_id,
        token_endpoint,
        device_code: device_code.to_string(),
        user_code: started["user_code"].as_str().unwrap_or("").to_string(),
        link: link.to_string(),
        expires: now() + started["expires_in"].as_u64().unwrap_or(600),
        interval: started["interval"].as_u64().unwrap_or(5).max(1),
        agents: vec![],
    })
}

/// The second half: asks for the tokens until the person approves the code, refuses it, or it runs out.
pub fn finish(p: &Pending) -> Result<Credentials, String> {
    let Pending {
        url,
        client_id,
        token_endpoint,
        device_code,
        ..
    } = p;
    let resource = format!("{url}/mcp");
    let deadline = Instant::now() + Duration::from_secs(p.expires.saturating_sub(now()));
    let mut every = Duration::from_secs(p.interval);
    let t = loop {
        std::thread::sleep(every);
        // Asked once more past the deadline, so an approval in its last seconds still counts.
        let late = Instant::now() > deadline;
        match post_oauth(
            token_endpoint,
            &[
                ("grant_type", DEVICE_GRANT),
                ("device_code", device_code.as_str()),
                ("client_id", client_id.as_str()),
                ("resource", &resource),
            ],
        ) {
            Ok(t) => break t,
            Err(r) if late && (r.error == "authorization_pending" || r.error == "unreachable") => {
                return Err(
                    "nobody approved the sign-in in time: run `openbelt login` again".into(),
                );
            }
            Err(r) if r.error == "authorization_pending" || r.error == "unreachable" => {}
            Err(r) if r.error == "slow_down" => every += Duration::from_secs(5),
            Err(r) if r.error == "access_denied" => {
                return Err(format!("the sign-in didn't finish: {}", r.why));
            }
            Err(r) if r.error == "expired_token" => {
                return Err("the code ran out: run `openbelt login` again".into());
            }
            Err(r) => return Err(r.to_string()),
        }
    };

    Ok(Credentials {
        url: url.to_string(),
        how: How::Oauth {
            client_id: client_id.clone(),
            token_endpoint: token_endpoint.clone(),
            access_token: t["access_token"]
                .as_str()
                .ok_or("the token endpoint gave no access_token")?
                .to_string(),
            refresh_token: t["refresh_token"].as_str().map(str::to_string),
        },
    })
}

/// Trades the refresh token for new tokens and saves them.
pub fn refresh(c: &mut Credentials) -> Result<(), String> {
    let How::Oauth {
        client_id,
        token_endpoint,
        access_token,
        refresh_token,
    } = &mut c.how
    else {
        return Err("an API token can't be refreshed".into());
    };
    let Some(refresh) = refresh_token.clone() else {
        return Err("signed out: run `openbelt login`".into());
    };
    let t = post(
        token_endpoint,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh),
            ("client_id", client_id),
        ],
    )
    .map_err(|e| {
        format!("your sign-in ran out and couldn't be renewed ({e}): run `openbelt login`")
    })?;
    *access_token = t["access_token"]
        .as_str()
        .ok_or("the token endpoint gave no access_token")?
        .to_string();
    if let Some(r) = t["refresh_token"].as_str() {
        *refresh_token = Some(r.to_string());
    }
    save(c)
}

/// Signs the grant out on the server (RFC 7009), best effort.
pub fn revoke(c: &Credentials) {
    if let How::Oauth {
        client_id,
        refresh_token: Some(r),
        ..
    } = &c.how
    {
        let _ = post(
            &format!("{}/_oauth/revoke", c.url),
            &[("token", r), ("client_id", client_id)],
        );
    }
}
