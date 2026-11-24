//! Groups of screens (requested 2026-11-24: "allow to group screens (so I can group the unreal
//! editor screens, the edvisor screens, etc), I think may be interesting to have subdivisions as
//! well (tree)"). A computer keeps how its screens are grouped beside them, in
//! `screens/groups.json`: its groups, each holding screens of one of its environments and shown
//! under that environment's computer in the Screens tab, at the top or inside another group of the
//! same environment, and the group each screen is in. Filing a screen never touches the screen's
//! own file, so its revision, its time and a page open on it stay as they were. A name is unique
//! among its neighbours, so a chat names a group by its path from the top.
use super::{now, replace, valid_id};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

/// A group of screens.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    /// The environment whose screens it holds.
    pub environment_id: String,
    pub name: String,
    /// The group it is in; none at the top of its computer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub created_at: String,
}

/// How a computer's screens are grouped.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Groups {
    #[serde(default)]
    pub groups: Vec<Group>,
    /// Each grouped screen's group, by the screen's id.
    #[serde(default)]
    pub members: BTreeMap<String, String>,
}

fn file(root: &Path) -> PathBuf {
    root.join("groups.json")
}

pub const GONE: &str = "This group is no longer on this computer.";

/// How this computer's screens are grouped: no groups before the first one.
pub fn read(root: &Path) -> Result<Groups, String> {
    let bytes = match std::fs::read(file(root)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Groups::default()),
        Err(_) => return Err("Cannot read this computer's screen groups.".into()),
    };
    let mut groups: Groups = serde_json::from_slice(&bytes)
        .map_err(|_| "This computer's screen groups are unreadable.".to_string())?;
    groups.tidy();
    Ok(groups)
}

pub fn write(root: &Path, groups: &Groups) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(groups).map_err(|_| "Cannot save the screen groups.")?;
    replace(&file(root), &bytes).map_err(|_| "Cannot save the screen groups.".into())
}

/// A group's name as lists show it: one line, without characters that hide or reorder it.
pub fn name(text: &str) -> Result<String, String> {
    super::line(Some(&Value::String(text.into())), "name", true)
        .map_err(|_| "Name the group.".to_string())
}

fn same_name(left: &str, right: &str) -> bool {
    left.to_lowercase() == right.to_lowercase()
}

fn taken(name: &str) -> String {
    format!("A group named {name} is already there.")
}

impl Groups {
    /// Leaves out what does not hold together, which no change makes: groups without an id, an
    /// environment or a name, a parent that is gone, holds another environment's screens or is
    /// inside the group itself, and members of groups that are gone.
    fn tidy(&mut self) {
        let mut seen = HashSet::new();
        self.groups.retain(|group| {
            valid_id(&group.id)
                && uuid::Uuid::parse_str(&group.environment_id).is_ok()
                && !group.name.trim().is_empty()
                && seen.insert(group.id.clone())
        });
        let environments: HashMap<String, String> = self
            .groups
            .iter()
            .map(|group| (group.id.clone(), group.environment_id.clone()))
            .collect();
        for group in &mut self.groups {
            if group.parent.as_ref().is_some_and(|parent| {
                parent == &group.id || environments.get(parent) != Some(&group.environment_id)
            }) {
                group.parent = None;
            }
        }
        while let Some(index) = self.groups.iter().position(|group| self.circles(&group.id)) {
            self.groups[index].parent = None;
        }
        let ids: HashSet<&String> = self.groups.iter().map(|group| &group.id).collect();
        self.members
            .retain(|screen, group| valid_id(screen) && ids.contains(group));
    }
    /// Whether following a group's parents leads back to it.
    fn circles(&self, id: &str) -> bool {
        let mut seen = HashSet::new();
        let mut next = self.get(id).and_then(|group| group.parent.as_deref());
        while let Some(current) = next {
            if current == id {
                return true;
            }
            if !seen.insert(current) {
                return false;
            }
            next = self.get(current).and_then(|group| group.parent.as_deref());
        }
        false
    }
    pub fn get(&self, id: &str) -> Option<&Group> {
        self.groups.iter().find(|group| group.id == id)
    }
    fn get_mut(&mut self, id: &str) -> Option<&mut Group> {
        self.groups.iter_mut().find(|group| group.id == id)
    }
    /// The group of that name among the groups of `environment` in `parent`.
    fn named(&self, environment: &str, parent: Option<&str>, name: &str) -> Option<&Group> {
        self.groups.iter().find(|group| {
            group.environment_id == environment
                && group.parent.as_deref() == parent
                && same_name(&group.name, name)
        })
    }
    /// Whether `id` is the group `outer` or lies inside it.
    fn within(&self, id: &str, outer: &str) -> bool {
        let mut seen = HashSet::new();
        let mut next = Some(id);
        while let Some(current) = next {
            if current == outer {
                return true;
            }
            if !seen.insert(current) {
                return false;
            }
            next = self.get(current).and_then(|group| group.parent.as_deref());
        }
        false
    }
    /// A group screens of `environment` may go in, or the top when none.
    fn holding(&self, environment: &str, group: Option<&str>) -> Result<(), String> {
        match group.map(|id| self.get(id)) {
            None => Ok(()),
            Some(Some(group)) if group.environment_id == environment => Ok(()),
            Some(Some(_)) => Err("That group holds another computer's screens.".into()),
            Some(None) => Err(GONE.into()),
        }
    }
    /// The names of a group and of the groups it is in, from the top.
    pub fn path(&self, id: &str) -> Vec<String> {
        let mut names = vec![];
        let mut next = Some(id);
        while let Some(current) = next {
            let Some(group) = self.get(current) else {
                break;
            };
            if names.len() > self.groups.len() {
                break;
            }
            names.push(group.name.clone());
            next = group.parent.as_deref();
        }
        names.reverse();
        names
    }
    /// The paths of an environment's groups, in the order of their names.
    pub fn paths(&self, environment: &str) -> Vec<Vec<String>> {
        let mut paths: Vec<Vec<String>> = self
            .groups
            .iter()
            .filter(|group| group.environment_id == environment)
            .map(|group| self.path(&group.id))
            .collect();
        paths.sort_by_key(|path| {
            path.iter()
                .map(|name| name.to_lowercase())
                .collect::<Vec<_>>()
        });
        paths
    }
    /// The group a screen is in, when that group holds the screen's environment.
    pub fn group_of(&self, screen: &str, environment: &str) -> Option<&Group> {
        self.members
            .get(screen)
            .and_then(|id| self.get(id))
            .filter(|group| group.environment_id == environment)
    }
    /// A new group of `environment`, in `parent` or at the top.
    pub fn create(
        &mut self,
        environment: &str,
        name: &str,
        parent: Option<&str>,
    ) -> Result<Group, String> {
        let name = self::name(name)?;
        self.holding(environment, parent)?;
        if self.named(environment, parent, &name).is_some() {
            return Err(taken(&name));
        }
        let group = Group {
            id: uuid::Uuid::new_v4().to_string(),
            environment_id: environment.into(),
            name,
            parent: parent.map(String::from),
            created_at: now(),
        };
        self.groups.push(group.clone());
        Ok(group)
    }
    pub fn rename(&mut self, id: &str, name: &str) -> Result<(), String> {
        let name = self::name(name)?;
        let group = self.get(id).ok_or(GONE)?;
        if self
            .named(&group.environment_id, group.parent.as_deref(), &name)
            .is_some_and(|other| other.id != id)
        {
            return Err(taken(&name));
        }
        if let Some(group) = self.get_mut(id) {
            group.name = name;
        }
        Ok(())
    }
    /// Moves a group, with all it holds, into another group of its environment or to the top.
    pub fn reparent(&mut self, id: &str, parent: Option<&str>) -> Result<(), String> {
        let group = self.get(id).ok_or(GONE)?.clone();
        self.holding(&group.environment_id, parent)?;
        if parent.is_some_and(|parent| self.within(parent, id)) {
            return Err("A group cannot go inside itself.".into());
        }
        if self
            .named(&group.environment_id, parent, &group.name)
            .is_some_and(|other| other.id != id)
        {
            return Err(taken(&group.name));
        }
        if let Some(group) = self.get_mut(id) {
            group.parent = parent.map(String::from);
        }
        Ok(())
    }
    /// Takes a group away and leaves what it held where it was: its screens and groups go into
    /// the group it was in, or to the top, each group joining one of its name there.
    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        let group = self.get(id).ok_or(GONE)?.clone();
        self.groups.retain(|known| known.id != id);
        self.fold(id, group.parent.as_deref());
        Ok(())
    }
    /// What the group `from` held goes into `into`.
    fn fold(&mut self, from: &str, into: Option<&str>) {
        let screens: Vec<String> = self
            .members
            .iter()
            .filter(|(_, group)| group.as_str() == from)
            .map(|(screen, _)| screen.clone())
            .collect();
        for screen in screens {
            match into {
                Some(into) => {
                    self.members.insert(screen, into.into());
                }
                None => {
                    self.members.remove(&screen);
                }
            }
        }
        let children: Vec<Group> = self
            .groups
            .iter()
            .filter(|group| group.parent.as_deref() == Some(from))
            .cloned()
            .collect();
        for child in children {
            let same = self
                .named(&child.environment_id, into, &child.name)
                .filter(|other| other.id != child.id)
                .map(|other| other.id.clone());
            match same {
                Some(same) => {
                    self.groups.retain(|known| known.id != child.id);
                    self.fold(&child.id, Some(&same));
                }
                None => {
                    if let Some(group) = self.get_mut(&child.id) {
                        group.parent = into.map(String::from);
                    }
                }
            }
        }
    }
    /// Files a screen of `environment` in a group, or at the top when none.
    pub fn place(
        &mut self,
        screen: &str,
        environment: &str,
        group: Option<&str>,
    ) -> Result<(), String> {
        self.holding(environment, group)?;
        match group {
            Some(group) => {
                self.members.insert(screen.into(), group.into());
            }
            None => {
                self.members.remove(screen);
            }
        }
        Ok(())
    }
    /// The group at `path`, names from the top, made where missing; none for the top.
    pub fn ensure(&mut self, environment: &str, path: &[String]) -> Result<Option<String>, String> {
        let mut parent: Option<String> = None;
        for name in path {
            let name = self::name(name)?;
            let id = match self.named(environment, parent.as_deref(), &name) {
                Some(group) => group.id.clone(),
                None => self.create(environment, &name, parent.as_deref())?.id,
            };
            parent = Some(id);
        }
        Ok(parent)
    }
    /// A deleted screen leaves its group.
    pub fn forget(&mut self, screen: &str) -> bool {
        self.members.remove(screen).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HERE: &str = "11111111-1111-4111-8111-111111111111";
    const WSL: &str = "22222222-2222-4222-8222-222222222222";
    fn screen(n: u8) -> String {
        format!("{n:08x}-0000-4000-8000-000000000000")
    }
    fn names(groups: &Groups, environment: &str) -> Vec<String> {
        groups
            .paths(environment)
            .into_iter()
            .map(|path| path.join("/"))
            .collect()
    }

    #[test]
    fn groups_nest_and_screens_go_in_them_by_environment() {
        let mut groups = Groups::default();
        let unreal = groups.create(HERE, "  Unreal\neditors ", None).unwrap();
        assert_eq!(unreal.name, "Unreal editors");
        assert_eq!(unreal.parent, None);
        let edvisor = groups.create(HERE, "Edvisor", None).unwrap();
        let linear = groups.create(HERE, "Linear", Some(&edvisor.id)).unwrap();
        // Names are unique among neighbours alone, whatever their case.
        assert_eq!(
            groups.create(HERE, "edvisor", None).unwrap_err(),
            "A group named edvisor is already there."
        );
        groups.create(HERE, "Linear", None).unwrap();
        groups.create(WSL, "Edvisor", None).unwrap();
        assert_eq!(
            groups.create(HERE, " \u{200b}", None).unwrap_err(),
            "Name the group."
        );
        assert_eq!(
            names(&groups, HERE),
            ["Edvisor", "Edvisor/Linear", "Linear", "Unreal editors"]
        );
        // A screen goes into a group of its own environment.
        groups.place(&screen(1), HERE, Some(&linear.id)).unwrap();
        assert_eq!(groups.group_of(&screen(1), HERE).unwrap().id, linear.id);
        assert_eq!(groups.path(&linear.id), ["Edvisor", "Linear"]);
        let wsl = groups.paths(WSL);
        assert_eq!(wsl, [vec!["Edvisor".to_string()]]);
        assert_eq!(
            groups.place(&screen(2), WSL, Some(&linear.id)).unwrap_err(),
            "That group holds another computer's screens."
        );
        assert_eq!(
            groups.create(WSL, "Inside", Some(&linear.id)).unwrap_err(),
            "That group holds another computer's screens."
        );
        groups.place(&screen(1), HERE, None).unwrap();
        assert!(groups.group_of(&screen(1), HERE).is_none());
        assert!(groups.members.is_empty());
        let gone = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            groups.place(&screen(1), HERE, Some(&gone)).unwrap_err(),
            GONE
        );
    }

    #[test]
    fn groups_are_renamed_and_moved_but_never_into_themselves() {
        let mut groups = Groups::default();
        let edvisor = groups.create(HERE, "Edvisor", None).unwrap();
        let linear = groups.create(HERE, "Linear", Some(&edvisor.id)).unwrap();
        let reports = groups.create(HERE, "Reports", Some(&linear.id)).unwrap();
        let other = groups.create(HERE, "Linear", None).unwrap();
        assert_eq!(
            groups.rename(&edvisor.id, "linear").unwrap_err(),
            "A group named linear is already there."
        );
        groups.rename(&linear.id, "Tickets").unwrap();
        // Its own name in another case is no clash.
        groups.rename(&other.id, "LINEAR").unwrap();
        assert_eq!(
            groups.reparent(&edvisor.id, Some(&reports.id)).unwrap_err(),
            "A group cannot go inside itself."
        );
        assert_eq!(
            groups.reparent(&edvisor.id, Some(&edvisor.id)).unwrap_err(),
            "A group cannot go inside itself."
        );
        groups.reparent(&reports.id, None).unwrap();
        groups.reparent(&other.id, Some(&edvisor.id)).unwrap();
        assert_eq!(
            names(&groups, HERE),
            ["Edvisor", "Edvisor/LINEAR", "Edvisor/Tickets", "Reports"]
        );
        let clash = groups.create(HERE, "Tickets", None).unwrap();
        assert_eq!(
            groups.reparent(&clash.id, Some(&edvisor.id)).unwrap_err(),
            "A group named Tickets is already there."
        );
        let gone = uuid::Uuid::new_v4().to_string();
        assert_eq!(groups.rename(&gone, "Name").unwrap_err(), GONE);
        assert_eq!(groups.reparent(&clash.id, Some(&gone)).unwrap_err(), GONE);
    }

    #[test]
    fn a_removed_group_leaves_what_it_held_a_level_up_joining_groups_of_the_same_name() {
        let mut groups = Groups::default();
        let work = groups.create(HERE, "Work", None).unwrap();
        let edvisor = groups.create(HERE, "Edvisor", Some(&work.id)).unwrap();
        let linear = groups.create(HERE, "Linear", Some(&edvisor.id)).unwrap();
        let mine = groups.create(HERE, "Mine", Some(&linear.id)).unwrap();
        let sibling = groups.create(HERE, "Linear", Some(&work.id)).unwrap();
        let theirs = groups.create(HERE, "mine", Some(&sibling.id)).unwrap();
        groups.place(&screen(1), HERE, Some(&edvisor.id)).unwrap();
        groups.place(&screen(2), HERE, Some(&linear.id)).unwrap();
        groups.place(&screen(3), HERE, Some(&mine.id)).unwrap();
        groups.place(&screen(4), HERE, Some(&theirs.id)).unwrap();
        groups.remove(&edvisor.id).unwrap();
        // Edvisor's Linear joined Work's Linear, and its Mine the mine there.
        assert_eq!(
            names(&groups, HERE),
            ["Work", "Work/Linear", "Work/Linear/mine"]
        );
        assert_eq!(groups.group_of(&screen(1), HERE).unwrap().id, work.id);
        assert_eq!(groups.group_of(&screen(2), HERE).unwrap().id, sibling.id);
        assert_eq!(groups.group_of(&screen(3), HERE).unwrap().id, theirs.id);
        assert_eq!(groups.group_of(&screen(4), HERE).unwrap().id, theirs.id);
        // A top group leaves its screens at the top.
        groups.remove(&work.id).unwrap();
        assert_eq!(names(&groups, HERE), ["Linear", "Linear/mine"]);
        assert!(groups.group_of(&screen(1), HERE).is_none());
        assert!(!groups.members.contains_key(&screen(1)));
        assert_eq!(groups.remove(&work.id).unwrap_err(), GONE);
        assert!(groups.forget(&screen(3)));
        assert!(!groups.forget(&screen(3)));
    }

    #[test]
    fn a_path_finds_its_groups_and_makes_the_missing_ones() {
        let mut groups = Groups::default();
        let edvisor = groups.create(HERE, "Edvisor", None).unwrap();
        let path = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        let linear = groups
            .ensure(HERE, &path(&["edvisor", "Linear"]))
            .unwrap()
            .unwrap();
        assert_eq!(
            groups.get(&linear).unwrap().parent.as_deref(),
            Some(edvisor.id.as_str())
        );
        assert_eq!(
            groups
                .ensure(HERE, &path(&["Edvisor", " linear "]))
                .unwrap(),
            Some(linear.clone())
        );
        assert_eq!(groups.ensure(HERE, &[]).unwrap(), None);
        assert_eq!(
            groups.ensure(HERE, &path(&["Edvisor", ""])).unwrap_err(),
            "Name the group."
        );
        assert_eq!(names(&groups, HERE), ["Edvisor", "Edvisor/Linear"]);
        // Another environment's groups of the same names are its own.
        groups.ensure(WSL, &path(&["Edvisor"])).unwrap();
        assert_eq!(groups.groups.len(), 3);
    }

    #[test]
    fn what_was_saved_is_read_back_without_what_does_not_hold_together() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("screens");
        assert_eq!(read(&root).unwrap(), Groups::default());
        let mut groups = Groups::default();
        let edvisor = groups.create(HERE, "Edvisor", None).unwrap();
        let linear = groups.create(HERE, "Linear", Some(&edvisor.id)).unwrap();
        groups.place(&screen(1), HERE, Some(&linear.id)).unwrap();
        write(&root, &groups).unwrap();
        assert_eq!(read(&root).unwrap(), groups);
        // A file no change writes: a cycle, a parent of another environment, a group without a
        // name, a duplicate id and a member of a group that is gone.
        let (a, b, c) = (
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
        );
        let group = |id: &str, environment: &str, name: &str, parent: Option<&str>| serde_json::json!({"id": id, "environmentId": environment, "name": name, "parent": parent, "createdAt": "2026-11-24T00:00:00.000Z"});
        let mut members = serde_json::Map::new();
        members.insert(screen(1), Value::String(a.clone()));
        members.insert(screen(2), Value::String(uuid::Uuid::new_v4().to_string()));
        members.insert("not a screen".into(), Value::String(b.clone()));
        std::fs::write(
            root.join("groups.json"),
            serde_json::to_vec(&serde_json::json!({
                "groups": [
                    group(&a, HERE, "A", Some(b.as_str())),
                    group(&b, HERE, "B", Some(a.as_str())),
                    group(&c, WSL, "C", Some(a.as_str())),
                    group(&a, HERE, "Again", None),
                    group(&uuid::Uuid::new_v4().to_string(), HERE, "  ", None),
                    group("not an id", HERE, "D", None),
                ],
                "members": members,
            }))
            .unwrap(),
        )
        .unwrap();
        let tidy = read(&root).unwrap();
        assert_eq!(tidy.groups.len(), 3);
        assert!(tidy.groups.iter().all(|group| !tidy.circles(&group.id)));
        assert!(tidy.groups.iter().any(|group| group.parent.is_none()));
        assert_eq!(tidy.get(&c).unwrap().parent, None);
        assert_eq!(tidy.members.len(), 1);
        assert_eq!(tidy.members[&screen(1)], a);
        std::fs::write(root.join("groups.json"), b"{").unwrap();
        assert_eq!(
            read(&root).unwrap_err(),
            "This computer's screen groups are unreadable."
        );
    }
}
