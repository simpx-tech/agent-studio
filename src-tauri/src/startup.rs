//! Verify Windows' physical storage destination before Tauri or any provider starts.
//! A child of an MSIX app can have no package identity and still inherit file redirection.

#[cfg(not(windows))]
pub fn verify(_identifier: &str) -> Result<(), &'static str> {
    Ok(())
}

#[cfg(not(windows))]
pub fn show_error(_message: &str) {}

#[cfg(windows)]
pub use windows::{show_error, verify};

#[cfg(windows)]
mod windows {
    use std::{
        fs::OpenOptions,
        os::windows::{ffi::OsStringExt, fs::OpenOptionsExt, io::AsRawHandle},
        path::{Path, PathBuf},
        ptr::null_mut,
    };
    use windows_sys::Win32::{
        Storage::FileSystem::{
            GetFinalPathNameByHandleW, FILE_ATTRIBUTE_TEMPORARY, FILE_FLAG_DELETE_ON_CLOSE,
        },
        System::Com::CoTaskMemFree,
        UI::{
            Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath, KF_FLAG_NO_PACKAGE_REDIRECTION},
            WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK},
        },
    };

    const UNVERIFIED: &str = "Agent Studio could not verify its Windows data folder and has not opened. Your saved chats and accounts have not been changed. Open Agent Studio from the Windows Start menu or File Explorer.";
    const REDIRECTED: &str = "Windows is redirecting Agent Studio's data into another application's storage. Agent Studio has not opened, to protect your saved chats and accounts. Open it from the Windows Start menu or File Explorer.";

    pub fn verify(identifier: &str) -> Result<(), &'static str> {
        let root = local_data()?.join(identifier);
        verify_root(&root)
    }

    fn local_data() -> Result<PathBuf, &'static str> {
        let mut raw = null_mut();
        // SAFETY: the API initializes raw on success; its allocation is freed below.
        let status = unsafe {
            SHGetKnownFolderPath(
                &FOLDERID_LocalAppData,
                KF_FLAG_NO_PACKAGE_REDIRECTION as u32,
                null_mut(),
                &mut raw,
            )
        };
        if status < 0 || raw.is_null() {
            return Err(UNVERIFIED);
        }
        let path = unsafe {
            let mut length = 0;
            while length < 32768 && *raw.add(length) != 0 {
                length += 1;
            }
            let path = (length < 32768)
                .then(|| std::ffi::OsString::from_wide(std::slice::from_raw_parts(raw, length)));
            CoTaskMemFree(raw.cast());
            path.ok_or(UNVERIFIED)?
        };
        Ok(path.into())
    }

    fn verify_root(root: &Path) -> Result<(), &'static str> {
        // An empty directory and a unique, empty, delete-on-close probe are the only
        // permitted writes before validation. Existing identities/workspaces are not read.
        std::fs::create_dir_all(root).map_err(|_| UNVERIFIED)?;
        let expected = root.join(format!(".startup-{}.tmp", uuid::Uuid::new_v4()));
        let probe = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .custom_flags(FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE)
            .open(&expected)
            .map_err(|_| UNVERIFIED)?;
        let mut buffer = vec![0u16; 32768];
        // SAFETY: probe owns a live file handle; buffer is writable for the supplied length.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                probe.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        } as usize;
        if length == 0 || length >= buffer.len() {
            return Err(UNVERIFIED);
        }
        let actual = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length]));
        validate_destination(&expected, &actual)
        // Dropping probe deletes only this invocation's temporary file on every path.
    }

    fn validate_destination(expected: &Path, actual: &Path) -> Result<(), &'static str> {
        fn normalized(path: &Path) -> String {
            let path = path.to_string_lossy().replace('/', "\\");
            path.strip_prefix(r"\\?\").unwrap_or(&path).to_lowercase()
        }
        if normalized(expected) == normalized(actual) {
            Ok(())
        } else {
            Err(REDIRECTED)
        }
    }

    pub fn show_error(message: &str) {
        let text: Vec<_> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<_> = "Agent Studio could not start"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        // SAFETY: both strings are NUL-terminated and remain alive until the dialog closes.
        unsafe {
            MessageBoxW(
                null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn redirected_or_different_destinations_are_rejected() {
            let expected = Path::new(r"C:\Users\Test\AppData\Local\studio\probe.tmp");
            for actual in [
                r"\\?\C:\Users\Test\AppData\Local\Packages\Example_123\LocalCache\Local\studio\probe.tmp",
                r"\\?\C:\Users\Test\AppData\Local\other-studio\probe.tmp",
            ] {
                assert_eq!(
                    validate_destination(expected, Path::new(actual)),
                    Err(REDIRECTED)
                );
            }
            assert!(validate_destination(
                expected,
                Path::new(r"\\?\c:\users\test\appdata\local\studio\probe.tmp")
            )
            .is_ok());
        }

        #[test]
        fn verification_keeps_existing_files_and_removes_its_probe() {
            let root = tempfile::tempdir().unwrap();
            let identity = root.path().join("installation.json");
            std::fs::write(&identity, b"preserved fixture").unwrap();
            // The test runner itself may inherit MSIX redirection of its temp
            // directory. Exercise the positive case at its actual destination.
            verify_root(&std::fs::canonicalize(root.path()).unwrap()).unwrap();
            assert_eq!(std::fs::read(identity).unwrap(), b"preserved fixture");
            assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
        }

        #[test]
        fn storage_errors_stop_startup_without_replacing_data() {
            let root = tempfile::tempdir().unwrap();
            let file = root.path().join("not-a-directory");
            std::fs::write(&file, b"preserved").unwrap();
            assert_eq!(verify_root(&file), Err(UNVERIFIED));
            assert_eq!(std::fs::read(file).unwrap(), b"preserved");
        }
    }
}
