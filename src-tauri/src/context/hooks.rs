use super::*;
use crate::protocol::hooks::{event_name, handler_type, identifier, source_label};

impl Scan {
    fn hook(&mut self, path: &str, name: String, scope: &str, status: &str, detail: String) {
        if path.is_empty() || path.len() > 4096 || path.chars().any(char::is_control) {
            self.note("Some hook metadata was invalid and could not be displayed.");
            return;
        }
        if self
            .snapshot
            .entries
            .iter()
            .any(|e| e.kind == "hooks" && e.path == path && e.name == name)
        {
            return;
        }
        if self.snapshot.entries.len() >= MAX_ENTRIES {
            self.snapshot.truncated = true;
            return;
        }
        self.snapshot.entries.push(ContextEntry {
            name,
            path: path.into(),
            kind: "hooks".into(),
            scope: scope.into(),
            status: status.into(),
            detail,
        });
    }

    fn claude_hooks(&mut self, path: &Path, value: &Value, scope: &str) {
        let Some(events) = value["hooks"].as_object() else {
            if !value["hooks"].is_null() {
                self.note("Some Claude hook definitions could not be inspected.");
            }
            return;
        };
        let mut count = 0;
        if events.len() > MAX_ENTRIES {
            self.snapshot.truncated = true;
        }
        for (event, groups) in events.iter().take(MAX_ENTRIES) {
            let Some(groups) = groups.as_array() else {
                self.note("Some Claude hook definitions could not be inspected.");
                continue;
            };
            if groups.len() > MAX_ENTRIES {
                self.snapshot.truncated = true;
            }
            for group in groups.iter().take(MAX_ENTRIES) {
                let Some(handlers) = group["hooks"].as_array() else {
                    self.note("Some Claude hook definitions could not be inspected.");
                    continue;
                };
                for handler in handlers {
                    count += 1;
                    if count > MAX_ENTRIES {
                        self.snapshot.truncated = true;
                        return;
                    }
                    let event = event_name(&json!(event));
                    let kind = handler_type(&handler["type"]);
                    let mut detail = format!(
                        "{kind} hook discovered in configuration; execution is unconfirmed."
                    );
                    if let Some(matcher) = identifier(&group["matcher"], 200) {
                        detail.push_str(&format!(" Matcher: {matcher}."));
                    }
                    if handler["async"] == true {
                        detail.push_str(" Runs asynchronously.");
                    }
                    if let Some(timeout) = handler["timeout"].as_u64() {
                        detail.push_str(&format!(" Timeout: {timeout}s."));
                    }
                    self.hook(
                        &self.display(path),
                        format!("{event} · {kind} {count}"),
                        scope,
                        "discovered",
                        detail,
                    );
                }
            }
        }
    }

    pub(super) fn claude_hook_file(&mut self, path: &Path, scope: &str) {
        match std::fs::metadata(self.physical(path)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Ok(meta) if meta.is_file() && meta.len() <= 2_000_000 => {}
            _ => {
                self.note("Some hook configuration files could not be inspected.");
                return;
            }
        }
        match self.json(path) {
            Some(value) => self.claude_hooks(path, &value, scope),
            None => self.note("Some hook configuration files could not be parsed."),
        }
    }

    pub(super) fn claude_plugin_hooks(&mut self, root: &Path) {
        let manifest_path = root.join(".claude-plugin/plugin.json");
        let manifest = self.json(&manifest_path).unwrap_or(Value::Null);
        if manifest["hooks"].is_object() {
            self.claude_hooks(&manifest_path, &manifest["hooks"], "Plugin");
        }
        // Plugin manifests can add hook files; the conventional file is always discovered.
        let mut paths = vec![root.join("hooks/hooks.json")];
        for entry in std::iter::once(&manifest["hooks"])
            .chain(manifest["hooks"].as_array().into_iter().flatten())
            .take(32)
        {
            if let Some(path) = identifier(entry, 4096) {
                let relative = path.strip_prefix("${CLAUDE_PLUGIN_ROOT}/").unwrap_or(path);
                paths.push(root.join(relative));
            }
        }
        paths.sort();
        paths.dedup();
        for path in paths {
            // Never follow a plugin declaration outside that plugin's installation.
            let contained = std::fs::canonicalize(self.physical(&path))
                .ok()
                .zip(std::fs::canonicalize(self.physical(root)).ok())
                .is_some_and(|(p, r)| p.starts_with(r));
            if contained {
                self.claude_hook_file(&path, "Plugin");
            }
        }
    }
}

// Discard commands, prompts, MCP targets, hashes, raw diagnostics and other config at the IPC boundary.
pub(super) fn codex_report(report: &mut Value, result: &Value, folder: &str) {
    let Some(groups) = result["data"].as_array() else {
        return;
    };
    let mut hooks = vec![];
    let mut matched = false;
    for group in groups.iter().take(MAX_ENTRIES) {
        if group["cwd"]
            .as_str()
            .is_none_or(|cwd| !path_within(cwd, folder) || !path_within(folder, cwd))
        {
            continue;
        }
        let Some(entries) = group["hooks"].as_array() else {
            continue;
        };
        matched = true;
        if ["errors", "warnings"]
            .iter()
            .any(|key| group[key].as_array().is_some_and(|v| !v.is_empty()))
        {
            report["hookIncomplete"] = json!(true);
        }
        for hook in entries {
            if hooks.len() >= MAX_ENTRIES {
                report["hookTruncated"] = json!(true);
                break;
            }
            let Some(path) = identifier(&hook["sourcePath"], 4096) else {
                report["hookIncomplete"] = json!(true);
                continue;
            };
            let trust = hook["trustStatus"]
                .as_str()
                .filter(|s| matches!(*s, "managed" | "trusted" | "untrusted" | "modified"))
                .unwrap_or("unknown");
            hooks.push(json!({
                "path":path, "event":event_name(&hook["eventName"]), "handler":handler_type(&hook["handlerType"]),
                "scope":source_label(&hook["source"]), "enabled":hook["enabled"].as_bool(), "trust":trust,
                "matcher":identifier(&hook["matcher"], 200), "async":hook["async"] == true,
                "timeout":hook["timeoutSec"].as_u64(),
            }));
        }
    }
    if matched {
        report["hooks"] = json!(hooks);
    }
}

pub(super) fn merge_codex(scan: &mut Scan, report: &Value) {
    let Some(hooks) = report["hooks"].as_array() else {
        scan.note("Codex did not return a hook catalog. Hook availability is unknown; this CLI may not support hooks/list.");
        return;
    };
    if report["hookIncomplete"] == true {
        scan.note(
            "Codex reported hook discovery warnings or errors. The hook catalog may be incomplete.",
        );
    }
    if report["hookTruncated"] == true {
        scan.snapshot.truncated = true;
    }
    for (index, hook) in hooks.iter().take(MAX_ENTRIES).enumerate() {
        let event = hook["event"].as_str().unwrap_or("Unknown event");
        let kind = hook["handler"].as_str().unwrap_or("Unknown handler");
        let trust = hook["trust"].as_str().unwrap_or("unknown");
        let state = if hook["enabled"] == false {
            "disabled"
        } else if matches!(trust, "untrusted" | "modified") {
            "needsReview"
        } else if hook["enabled"] == true {
            "configured"
        } else {
            "unknown"
        };
        let mut detail = format!(
            "{kind} hook reported by the selected CLI. Trust: {trust}. Execution is unconfirmed."
        );
        if let Some(matcher) = hook["matcher"].as_str() {
            detail.push_str(&format!(" Matcher: {matcher}."));
        }
        if hook["async"] == true {
            detail.push_str(" Runs asynchronously.");
        }
        if let Some(timeout) = hook["timeout"].as_u64() {
            detail.push_str(&format!(" Timeout: {timeout}s."));
        }
        scan.hook(
            hook["path"].as_str().unwrap_or_default(),
            format!("{event} · {kind} {}", index + 1),
            hook["scope"].as_str().unwrap_or("Unknown"),
            state,
            detail,
        );
    }
    scan.note("Hook configuration and trust are reported by Codex. Inspection does not execute hooks. Work history records only lifecycle events actually reported by the CLI; asynchronous hooks may not emit them.");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::tests::{file, scanner};

    #[test]
    fn codex_catalog_is_scoped_bounded_and_keeps_disabled_and_review_states() {
        let entries: Vec<_> = [(true,"trusted"), (false,"trusted"), (true,"untrusted"), (true,"modified"), (true,"managed")].iter().map(|(enabled,trust)| json!({
            "eventName":"preToolUse","handlerType":"command","source":"project","sourcePath":"/fixture/hooks.json",
            "enabled":enabled,"trustStatus":trust,"matcher":"Bash","timeoutSec":10,"command":"PRIVATE_COMMAND","currentHash":"PRIVATE_HASH","statusMessage":"PRIVATE_STATUS"
        })).collect();
        let mut report = json!({});
        codex_report(
            &mut report,
            &json!({"data":[{"cwd":"/other","hooks":[{"sourcePath":"/other/hooks.json"}]},{"cwd":"/fixture","hooks":entries,"errors":[{"message":"PRIVATE_ERROR"}]}]}),
            "/fixture",
        );
        assert!(!report.to_string().contains("PRIVATE"));
        let mut scan = scanner("codex", Path::new("/fixture"));
        merge_codex(&mut scan, &report);
        assert_eq!(
            scan.snapshot
                .entries
                .iter()
                .map(|e| e.status.as_str())
                .collect::<Vec<_>>(),
            vec![
                "configured",
                "disabled",
                "needsReview",
                "needsReview",
                "configured"
            ]
        );
        assert_eq!(
            scan.snapshot
                .entries
                .iter()
                .map(|e| &e.name)
                .collect::<HashSet<_>>()
                .len(),
            5
        );
        assert!(!serde_json::to_string(&scan.snapshot)
            .unwrap()
            .contains("PRIVATE"));
        assert!(scan.snapshot.notes.iter().any(|n| n.contains("incomplete")));
        let mut unavailable = scanner("codex", Path::new("/fixture"));
        merge_codex(&mut unavailable, &json!({}));
        assert!(unavailable.snapshot.notes[0].contains("unknown"));
        let mut empty = scanner("codex", Path::new("/fixture"));
        merge_codex(&mut empty, &json!({"hooks":[]}));
        assert!(!empty.snapshot.notes.iter().any(|n| n.contains("unknown")));
        let mut report = json!({});
        codex_report(
            &mut report,
            &json!({"data":[{"cwd":"/fixture","hooks":vec![json!({"sourcePath":"/fixture/hooks.json"}); MAX_ENTRIES + 1]}]}),
            "/fixture",
        );
        assert_eq!(report["hooks"].as_array().unwrap().len(), MAX_ENTRIES);
        assert_eq!(report["hookTruncated"], true);
    }

    #[test]
    fn claude_discovers_only_selected_profile_project_and_enabled_plugin_metadata() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("selected");
        let project = root.path().join("project");
        let home = root.path().join("home");
        let plugin = root.path().join("plugin");
        let hooks = r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"PRIVATE_COMMAND"},{"type":"prompt","prompt":"PRIVATE_PROMPT"}]}]}}"#;
        file(&profile.join("settings.json"), hooks);
        file(
            &home.join(".claude/settings.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command"}]}]}}"#,
        );
        file(
            &project.join(".claude/settings.json"),
            r#"{"enabledPlugins":{"demo":true},"disableAllHooks":true}"#,
        );
        file(&project.join(".claude/settings.local.json"), hooks);
        file(&plugin.join("hooks/hooks.json"), hooks);
        file(&profile.join("plugins/installed_plugins.json"), &json!({"plugins":{"demo":[{"installPath":plugin,"projectPath":project}],"disabled":[{"installPath":home}]}}).to_string());
        let scan = inventory(scanner("claude", &project), home, profile);
        let hooks: Vec<_> = scan
            .snapshot
            .entries
            .iter()
            .filter(|e| e.kind == "hooks")
            .collect();
        assert_eq!(hooks.len(), 6);
        assert!(hooks.iter().all(|e| e.status == "disabled"));
        assert!(hooks.iter().any(|e| e.scope == "Plugin"));
        assert!(!serde_json::to_string(&scan.snapshot)
            .unwrap()
            .contains("PRIVATE"));
        let mut malformed = scanner("claude", &project);
        let path = root.path().join("bad.json");
        file(&path, "not json");
        malformed.claude_hook_file(&path, "User");
        assert!(malformed
            .snapshot
            .notes
            .iter()
            .any(|n| n.contains("could not be parsed")));
    }
}
