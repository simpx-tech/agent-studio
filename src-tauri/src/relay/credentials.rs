//! Only Agent Studio's own relay pairing. Never enumerate or read provider credentials.
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub(super) struct Pairing {
    pub url: String,
    pub token: String,
}

pub(super) fn target(identifier: &str, environment: &str) -> String {
    format!("{identifier}/relay/{environment}")
}

#[cfg(windows)]
mod windows {
    use super::Pairing;
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_NOT_FOUND},
        Security::Credentials::{
            CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW,
            CRED_MAX_CREDENTIAL_BLOB_SIZE, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
        },
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    pub(super) fn save(target: &str, pairing: &Pairing) -> Result<(), String> {
        let mut name = wide(target);
        let mut username = wide("Agent Studio relay");
        let mut bytes = serde_json::to_vec(pairing).map_err(|_| "Cannot encode relay pairing")?;
        if bytes.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
            return Err("Relay address and key exceed Windows protected storage capacity".into());
        }
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: name.as_mut_ptr(),
            CredentialBlobSize: bytes.len() as u32,
            CredentialBlob: bytes.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: username.as_mut_ptr(),
            ..Default::default()
        };
        // All pointers remain valid for this synchronous call. The credential is scoped
        // to this Windows user, this machine, app identifier, and installation identity.
        let saved = unsafe { CredWriteW(&credential, 0) } != 0;
        bytes.fill(0);
        if saved {
            Ok(())
        } else {
            Err(
                "Cannot save relay pairing in Windows Credential Manager. Pairing was not changed."
                    .into(),
            )
        }
    }

    pub(super) fn load(target: &str) -> Result<Option<Pairing>, String> {
        let name = wide(target);
        let mut credential: *mut CREDENTIALW = ptr::null_mut();
        // CredRead allocates one block; it is always released below, including parse errors.
        if unsafe { CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
            return if unsafe { GetLastError() } == ERROR_NOT_FOUND {
                Ok(None)
            } else {
                Err("Cannot read saved relay pairing from Windows Credential Manager. Retry or set up sync again.".into())
            };
        }
        let pairing = unsafe {
            let value = &*credential;
            let result = if value.CredentialBlob.is_null() || value.CredentialBlobSize == 0 {
                Err("Saved relay pairing is unreadable. Set up sync again.".into())
            } else {
                let bytes = std::slice::from_raw_parts_mut(
                    value.CredentialBlob,
                    value.CredentialBlobSize as usize,
                );
                let result = serde_json::from_slice(bytes)
                    .map(Some)
                    .map_err(|_| "Saved relay pairing is unreadable. Set up sync again.".into());
                bytes.fill(0);
                result
            };
            CredFree(credential.cast());
            result
        };
        pairing
    }

    pub(super) fn remove(target: &str) -> Result<(), String> {
        let name = wide(target);
        if unsafe { CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0
            || unsafe { GetLastError() } == ERROR_NOT_FOUND
        {
            Ok(())
        } else {
            Err("Cannot remove saved relay pairing from Windows Credential Manager. Disconnect was not completed; retry.".into())
        }
    }
}

pub(super) fn save(target: &str, pairing: &Pairing) -> Result<(), String> {
    #[cfg(windows)]
    return windows::save(target, pairing);
    #[cfg(not(windows))]
    {
        let _ = (target, pairing);
        Ok(()) // Other platforms retain the existing in-memory pairing behavior.
    }
}

pub(super) fn load(target: &str) -> Result<Option<Pairing>, String> {
    #[cfg(windows)]
    return windows::load(target);
    #[cfg(not(windows))]
    {
        let _ = target;
        Ok(None)
    }
}

pub(super) fn remove(target: &str) -> Result<(), String> {
    #[cfg(windows)]
    return windows::remove(target);
    #[cfg(not(windows))]
    {
        let _ = target;
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn protected_pairing_roundtrips_isolates_replaces_and_forgets() {
        let name = target(
            "com.vinicius.agentstudio.test",
            &uuid::Uuid::new_v4().to_string(),
        );
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = remove(&self.0);
            }
        }
        let _cleanup = Cleanup(name.clone());
        assert!(load(&name).unwrap().is_none());
        let mut pairing = Pairing {
            url: "https://relay.example.com".into(),
            token: "synthetic-test-key-".repeat(2),
        };
        save(&name, &pairing).unwrap();
        let restored = load(&name).unwrap().unwrap();
        assert_eq!(restored.url, pairing.url);
        assert!(restored.token == pairing.token);
        assert!(load(&format!("{name}/other-profile")).unwrap().is_none());
        pairing.token = "synthetic-replacement-key-".repeat(2);
        save(&name, &pairing).unwrap();
        assert!(load(&name).unwrap().unwrap().token == pairing.token);
        let oversized = Pairing {
            url: pairing.url.clone(),
            token: "x".repeat(3000),
        };
        assert!(save(&name, &oversized).is_err());
        assert!(load(&name).unwrap().unwrap().token == pairing.token);
        remove(&name).unwrap();
        remove(&name).unwrap();
        assert!(load(&name).unwrap().is_none());
    }
}
