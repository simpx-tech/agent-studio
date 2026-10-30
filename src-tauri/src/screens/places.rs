//! Where a screen runs an action or calls an MCP tool (docs/SCREENS.md): the place of the chat
//! that created it, unless the action, the tool or the page names another place of the same
//! computer: `windows`, the Windows computer itself, `wsl`, its default WSL distribution, or a
//! distribution by its name. A screen of a Windows chat can so call the MCP servers signed in
//! inside WSL, and a screen of a WSL chat run PowerShell on Windows.
use super::{Account, Site};
use serde_json::Value;

/// A place as a screen names it, checked when a chat saves the screen or a page asks for it.
pub fn checked(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.eq_ignore_ascii_case("windows") || name.eq_ignore_ascii_case("wsl") {
        return Ok(name.to_ascii_lowercase());
    }
    if !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        return Ok(name.into());
    }
    Err(format!(
        "where must be windows, wsl or the name of a WSL distribution, not {value}."
    ))
}

/// This computer's own environment and the WSL distributions it manages, as its saved
/// workspace lists them.
#[derive(Clone, Debug, Default)]
pub struct Computer {
    /// This installation's id, which is also its own environment's.
    pub local: String,
    /// Each managed distribution's environment and name.
    pub distributions: Vec<(String, String)>,
}

impl Computer {
    /// The computer as `fleet` records it: only distributions this installation discovered run
    /// through its wsl.exe.
    pub fn from_fleet(local: &str, fleet: &Value) -> Self {
        let distributions = fleet["environments"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| e["platform"] == "wsl" && e["discoveredOn"] == local)
            .filter_map(|e| {
                Some((
                    e["id"].as_str()?.to_string(),
                    e["distribution"].as_str()?.to_string(),
                ))
            })
            .collect();
        Self {
            local: local.into(),
            distributions,
        }
    }
    /// The environment of a distribution this computer manages, or would once it found it.
    fn distribution(&self, name: &str) -> Option<(String, String)> {
        if let Some((id, known)) = self
            .distributions
            .iter()
            .find(|(_, known)| known.eq_ignore_ascii_case(name))
        {
            return Some((id.clone(), known.clone()));
        }
        #[cfg(windows)]
        if let Ok(host) = uuid::Uuid::parse_str(&self.local) {
            return Some((crate::wsl::distribution_id(host, name), name.into()));
        }
        None
    }
}

/// The folder a place reaches the screen's folder by: the same folder through `\\wsl.localhost`
/// or `/mnt/<drive>`, or none, which is the distribution's home folder.
pub fn folder_in(site: &Site, distribution: Option<&str>) -> String {
    match (site.distribution.as_deref(), distribution) {
        (None, None) => site.folder.clone(),
        (Some(own), Some(other)) if own == other => site.folder.clone(),
        (Some(own), None) => {
            format!(r"\\wsl.localhost\{own}{}", site.folder.replace('/', "\\"))
        }
        (None, Some(other)) => linux_path(&site.folder, other).unwrap_or_default(),
        (Some(_), Some(_)) => String::new(),
    }
}

/// A Windows folder as a WSL distribution reaches it: a drive's folder under `/mnt`, and one of
/// that distribution's own folders by its Linux path.
fn linux_path(folder: &str, distribution: &str) -> Option<String> {
    let lower = folder.to_ascii_lowercase();
    for share in [
        r"\\wsl.localhost\",
        r"\\wsl$\",
        "//wsl.localhost/",
        "//wsl$/",
    ] {
        if let Some(rest) = lower.strip_prefix(share) {
            let name_length = rest.find(['\\', '/']).unwrap_or(rest.len());
            if !rest[..name_length].eq_ignore_ascii_case(distribution) {
                return None;
            }
            let path = &folder[share.len() + name_length..];
            let path = path.replace('\\', "/");
            return Some(if path.is_empty() { "/".into() } else { path });
        }
    }
    let mut chars = folder.chars();
    let drive = chars.next().filter(char::is_ascii_alphabetic)?;
    if chars.next() != Some(':') {
        return None;
    }
    let rest = folder[2..].replace('\\', "/");
    let rest = rest.trim_end_matches('/');
    Some(format!(
        "/mnt/{}{}",
        drive.to_ascii_lowercase(),
        if rest.is_empty() || rest.starts_with('/') {
            rest.to_string()
        } else {
            format!("/{rest}")
        }
    ))
}

/// The site a place names, from the screen's own: its environment, distribution and folder.
pub fn resolve(site: &Site, place: Option<&str>, computer: &Computer) -> Result<Site, String> {
    let Some(place) = place else {
        return Ok(site.clone());
    };
    let place = checked(place)?;
    let (environment_id, distribution) = match place.as_str() {
        "windows" => {
            if !cfg!(windows) {
                return Err("This computer is not Windows: name a place it has.".into());
            }
            (computer.local.clone(), None)
        }
        "wsl" => match &site.distribution {
            Some(own) => (site.environment_id.clone(), Some(own.clone())),
            None => {
                let (id, name) = computer.distributions.first().cloned().ok_or(
                    "This computer manages no WSL distribution. Add one in Connections first.",
                )?;
                (id, Some(name))
            }
        },
        name => {
            if !cfg!(windows) {
                return Err(format!(
                    "WSL distributions run on Windows; this computer cannot reach {name}."
                ));
            }
            let (id, name) = computer
                .distribution(name)
                .ok_or_else(|| format!("This computer has no WSL distribution named {name}."))?;
            (id, Some(name))
        }
    };
    if environment_id == site.environment_id && distribution == site.distribution {
        return Ok(site.clone());
    }
    Ok(Site {
        environment_id,
        folder: folder_in(site, distribution.as_deref()),
        distribution,
        project: site.project.clone(),
    })
}

/// An account that may call a tool in a place, with the name its messages give it.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub account: Account,
    pub name: String,
}

/// The account a screen calls as, named as the model and the page read it.
pub fn account_name(fleet: &Value, account: &Account) -> String {
    let provider = provider_name(&account.provider);
    let Some(connection) = &account.connection_id else {
        return format!("this computer's {provider} CLI login");
    };
    fleet["connections"]
        .as_array()
        .and_then(|list| list.iter().find(|c| c["id"] == connection.as_str()))
        .and_then(|connection| {
            fleet["accounts"]
                .as_array()?
                .iter()
                .find(|a| a["id"] == connection["accountId"])?["name"]
                .as_str()
                .map(|name| format!("the {provider} account {name}"))
        })
        .unwrap_or_else(|| format!("a {provider} account no longer connected here"))
}

fn provider_name(provider: &str) -> &str {
    match provider {
        "claude" => "Claude",
        "codex" => "Codex",
        other => other,
    }
}

/// The accounts that may call MCP tools in `site`'s environment, in the order they are tried:
/// one the screen or page names, then, in the screen's own place, the account it records and
/// the environment's CLI login, and elsewhere the CLI login there before the same account,
/// whose separate profile keeps MCP sign-ins of its own; then every other account there. The
/// screen's agent comes before the other, whose CLI may know other servers.
pub fn candidates(
    fleet: &Value,
    local: &str,
    site: &Site,
    own: Option<&Account>,
    own_place: bool,
    named: Option<&str>,
) -> Vec<Candidate> {
    let accounts = fleet["accounts"].as_array().cloned().unwrap_or_default();
    let account_of = |connection: &Value| {
        accounts
            .iter()
            .find(|a| a["id"] == connection["accountId"])
            .cloned()
    };
    let own_account_id = own
        .and_then(|own| own.connection_id.as_deref())
        .and_then(|id| {
            fleet["connections"]
                .as_array()?
                .iter()
                .find(|c| c["id"] == id)
                .map(|c| c["accountId"].clone())
        });
    let own_provider = own.map(|own| own.provider.as_str()).unwrap_or("claude");
    let mut ranked: Vec<((u8, u8, u8, usize), Candidate)> = vec![];
    // The agents whose CLI login has a connection here, which is this computer's own login.
    let mut logins: Vec<&str> = vec![];
    for (index, connection) in fleet["connections"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        if connection["environmentId"] != site.environment_id.as_str() {
            continue;
        }
        let (Some(id), Some(account)) = (connection["id"].as_str(), account_of(connection)) else {
            continue;
        };
        let Some(provider) = account["provider"]
            .as_str()
            .filter(|p| matches!(*p, "claude" | "codex"))
        else {
            continue;
        };
        let name = account["name"].as_str().unwrap_or_default().to_string();
        let login = connection["profile"] == "existing";
        if login {
            logins.push(if provider == "claude" {
                "claude"
            } else {
                "codex"
            });
        }
        let same = own.and_then(|own| own.connection_id.as_deref()) == Some(id);
        let same_account = own_account_id
            .as_ref()
            .is_some_and(|account| *account == connection["accountId"]);
        let kind = match (own_place, same, same_account, login) {
            (true, true, _, _) => 0,
            (true, _, _, true) => 1,
            (true, _, true, _) => 2,
            (false, _, _, true) => 0,
            (false, _, true, _) | (false, true, _, _) => 1,
            _ => 3,
        };
        let rank = (
            u8::from(!named.is_some_and(|wanted| name.eq_ignore_ascii_case(wanted.trim()))),
            u8::from(provider != own_provider),
            kind,
            index,
        );
        ranked.push((
            rank,
            Candidate {
                account: Account {
                    provider: provider.into(),
                    connection_id: Some(id.into()),
                },
                name: format!("{name} ({})", provider_name(provider)),
            },
        ));
    }
    ranked.sort_by_key(|(rank, _)| *rank);
    let mut list: Vec<Candidate> = ranked.into_iter().map(|(_, c)| c).collect();
    // This computer's own CLI login, which needs no connection, closes the list where it runs.
    if site.distribution.is_none() && site.environment_id == local {
        for provider in [
            own_provider,
            if own_provider == "claude" {
                "codex"
            } else {
                "claude"
            },
        ] {
            let login = Account {
                provider: provider.into(),
                connection_id: None,
            };
            if own.is_some_and(|own| *own == login) {
                list.insert(
                    0,
                    Candidate {
                        name: format!("this computer's {} CLI login", provider_name(provider)),
                        account: login,
                    },
                );
            } else if !logins.contains(&provider) {
                list.push(Candidate {
                    name: format!("this computer's {} CLI login", provider_name(provider)),
                    account: login,
                });
            }
        }
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn site(environment: &str, distribution: Option<&str>, folder: &str) -> Site {
        Site {
            environment_id: environment.into(),
            distribution: distribution.map(String::from),
            folder: folder.into(),
            project: String::new(),
        }
    }

    #[test]
    fn places_are_windows_wsl_or_a_distribution() {
        assert_eq!(checked(" Windows ").unwrap(), "windows");
        assert_eq!(checked("WSL").unwrap(), "wsl");
        assert_eq!(checked("Ubuntu-24.04").unwrap(), "Ubuntu-24.04");
        for wrong in ["", " ", "Ubuntu 24", "a/b", "x;y", "$(x)"] {
            assert!(checked(wrong).is_err(), "{wrong}");
        }
    }

    #[test]
    fn folders_follow_the_screen_into_other_places() {
        let windows = site("w", None, r"C:\Users\me\Project ñ");
        assert_eq!(
            folder_in(&windows, Some("Ubuntu")),
            "/mnt/c/Users/me/Project ñ"
        );
        assert_eq!(folder_in(&windows, None), windows.folder);
        assert_eq!(
            folder_in(&site("w", None, r"D:\"), Some("Ubuntu")),
            "/mnt/d"
        );
        // A WSL folder a Windows chat ran through its share is that distribution's own.
        let shared = site("w", None, r"\\wsl.localhost\Ubuntu\home\me\app");
        assert_eq!(folder_in(&shared, Some("ubuntu")), "/home/me/app");
        assert_eq!(folder_in(&shared, Some("Debian")), "");
        let linux = site("u", Some("Ubuntu"), "/home/me/app");
        assert_eq!(
            folder_in(&linux, None),
            r"\\wsl.localhost\Ubuntu\home\me\app"
        );
        assert_eq!(folder_in(&linux, Some("Ubuntu")), "/home/me/app");
        // Another distribution starts in its own home folder.
        assert_eq!(folder_in(&linux, Some("Debian")), "");
    }

    #[cfg(windows)]
    #[test]
    fn a_place_resolves_to_this_computer_or_its_distributions() {
        let local = "62d59a2b-8cf7-4938-aa77-dcccd60e3e44";
        let fleet = json!({"environments": [
            {"id": local, "platform": "windows"},
            {"id": "u", "platform": "wsl", "discoveredOn": local, "distribution": "Ubuntu"},
            {"id": "other", "platform": "wsl", "discoveredOn": "elsewhere", "distribution": "Foreign"},
        ]});
        let computer = Computer::from_fleet(local, &fleet);
        assert_eq!(computer.distributions, [("u".into(), "Ubuntu".into())]);
        let windows = site(local, None, r"C:\work");
        assert_eq!(resolve(&windows, None, &computer).unwrap(), windows);
        let wsl = resolve(&windows, Some("wsl"), &computer).unwrap();
        assert_eq!(wsl, site("u", Some("Ubuntu"), "/mnt/c/work"));
        assert_eq!(resolve(&windows, Some("ubuntu"), &computer).unwrap(), wsl);
        assert_eq!(
            resolve(&wsl, Some("windows"), &computer).unwrap(),
            site(local, None, r"\\wsl.localhost\Ubuntu\mnt\c\work")
        );
        // A distribution it does not list yet takes the id it would have.
        let debian = resolve(&windows, Some("Debian"), &computer).unwrap();
        assert_eq!(debian.distribution.as_deref(), Some("Debian"));
        assert_eq!(
            debian.environment_id,
            crate::wsl::distribution_id(uuid::Uuid::parse_str(local).unwrap(), "Debian")
        );
        let none = Computer {
            local: local.into(),
            distributions: vec![],
        };
        assert!(resolve(&windows, Some("wsl"), &none)
            .unwrap_err()
            .contains("no WSL distribution"));
    }

    #[test]
    fn accounts_are_tried_where_their_mcp_sign_ins_most_likely_are() {
        let fleet = json!({
            "accounts": [
                {"id": "work", "name": "Work", "provider": "claude"},
                {"id": "login", "name": "Claude CLI login", "provider": "claude"},
                {"id": "home", "name": "Home", "provider": "claude"},
                {"id": "codex", "name": "Codex CLI login", "provider": "codex"},
                {"id": "gemini", "name": "Gemini", "provider": "gemini"},
            ],
            "connections": [
                {"id": "work-win", "accountId": "work", "environmentId": "win", "profile": "isolated"},
                {"id": "home-wsl", "accountId": "home", "environmentId": "wsl", "profile": "isolated"},
                {"id": "codex-wsl", "accountId": "codex", "environmentId": "wsl", "profile": "existing"},
                {"id": "work-wsl", "accountId": "work", "environmentId": "wsl", "profile": "isolated"},
                {"id": "login-wsl", "accountId": "login", "environmentId": "wsl", "profile": "existing"},
                {"id": "gemini-wsl", "accountId": "gemini", "environmentId": "wsl", "profile": "existing"},
                {"id": "login-win", "accountId": "login", "environmentId": "win", "profile": "existing"},
            ],
        });
        let own = Account {
            provider: "claude".into(),
            connection_id: Some("work-win".into()),
        };
        let ids = |list: Vec<Candidate>| {
            list.into_iter()
                .map(|c| c.account.connection_id.unwrap_or_else(|| "none".into()))
                .collect::<Vec<_>>()
        };
        let wsl = site("wsl", Some("Ubuntu"), "/mnt/c/work");
        // Elsewhere the terminal's own login comes first, then the same account, then the rest,
        // the other agent last.
        assert_eq!(
            ids(candidates(&fleet, "win", &wsl, Some(&own), false, None)),
            ["login-wsl", "work-wsl", "home-wsl", "codex-wsl"]
        );
        // A named account goes first.
        assert_eq!(
            ids(candidates(
                &fleet,
                "win",
                &wsl,
                Some(&own),
                false,
                Some("home")
            ))[0],
            "home-wsl"
        );
        // In its own place the screen's account comes first, and this computer's own login
        // without a connection closes the list for an agent that has no login connection there.
        let windows = site("win", None, r"C:\work");
        let listed = candidates(&fleet, "win", &windows, Some(&own), true, None);
        assert_eq!(ids(listed.clone()), ["work-win", "login-win", "none"]);
        assert_eq!(listed[0].name, "Work (Claude)");
        assert_eq!(listed[2].name, "this computer's Codex CLI login");
        // A screen saved before accounts were recorded starts with the login there.
        assert_eq!(
            ids(candidates(&fleet, "win", &windows, None, true, None)),
            ["login-win", "work-win", "none"]
        );
        assert_eq!(account_name(&fleet, &own), "the Claude account Work");
    }
}
