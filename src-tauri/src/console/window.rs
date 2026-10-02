//! A new console window for a shell on Windows. A GUI process may have redirected or closed
//! standard handles, so Windows creates real console handles for the shell instead of
//! inheriting ours, and a successful spawn alone does not prove that the window stayed open.
use std::{
    ffi::OsString,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    },
    path::{Path, PathBuf},
    ptr::null,
};
use windows_sys::Win32::{
    Foundation::WAIT_OBJECT_0,
    System::{
        SystemInformation::GetSystemDirectoryW,
        Threading::{
            CreateProcessW, GetExitCodeProcess, WaitForSingleObject, CREATE_NEW_CONSOLE,
            CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTF_USESHOWWINDOW, STARTUPINFOW,
        },
    },
    UI::WindowsAndMessaging::SW_HIDE,
};

pub(crate) struct Start<'a> {
    pub application: &'a Path,
    /// The whole command line, starting with the quoted application.
    pub command_line: &'a str,
    pub directory: Option<&'a Path>,
    pub title: Option<&'a str>,
    /// The shell's whole environment; ours when absent.
    pub environment: Option<&'a [(OsString, OsString)]>,
    /// Tests run their consoles without showing a window.
    pub hidden: bool,
}

pub(crate) struct Console {
    pub pid: u32,
    process: OwnedHandle,
}

impl Console {
    pub fn handle(&self) -> RawHandle {
        self.process.as_raw_handle()
    }
    /// The exit code of a console that closed within this time, or nothing while it stays open.
    pub fn closed_within(&self, milliseconds: u32) -> Option<u32> {
        // SAFETY: the handle is owned by this value and stays valid during both calls.
        unsafe {
            if WaitForSingleObject(self.handle(), milliseconds) != WAIT_OBJECT_0 {
                return None;
            }
            let mut code = 0;
            GetExitCodeProcess(self.handle(), &mut code);
            Some(code)
        }
    }
}

fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

/// One argument of a Windows command line, quoted the way the C runtime and `wsl.exe` read it
/// back: backslashes are literal except before a quote, where they are doubled.
pub(crate) fn quote(argument: &str) -> String {
    let mut quoted = String::from('"');
    let mut backslashes = 0;
    for character in argument.chars() {
        if character == '\\' {
            backslashes += 1;
        } else {
            if character == '"' {
                quoted.extend(std::iter::repeat_n('\\', backslashes + 1));
            }
            backslashes = 0;
        }
        quoted.push(character);
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes));
    quoted.push('"');
    quoted
}

// Windows keeps a process's variables sorted by name without regard to case.
fn environment_block(variables: &[(OsString, OsString)]) -> Vec<u16> {
    let mut sorted: Vec<_> = variables.iter().collect();
    sorted.sort_by_key(|(name, _)| name.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (name, value) in sorted {
        block.extend(name.encode_wide());
        block.push(u16::from(b'='));
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

pub(crate) fn start(start: Start) -> std::io::Result<Console> {
    let application = wide(start.application.as_os_str());
    let mut command_line = wide(start.command_line.as_ref());
    let directory = start.directory.map(|path| wide(path.as_os_str()));
    let mut title = start.title.map(|title| wide(title.as_ref()));
    let environment = start.environment.map(environment_block);
    let mut startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    if let Some(title) = &mut title {
        startup.lpTitle = title.as_mut_ptr();
    }
    if start.hidden {
        startup.dwFlags |= STARTF_USESHOWWINDOW;
        startup.wShowWindow = SW_HIDE as u16;
    }
    let mut process = PROCESS_INFORMATION::default();
    // SAFETY: all pointers refer to initialized buffers that remain alive during the call.
    let started = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
            environment
                .as_ref()
                .map_or(null(), |block| block.as_ptr().cast()),
            directory.as_ref().map_or(null(), |path| path.as_ptr()),
            &startup,
            &mut process,
        )
    };
    if started == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: a successful call returns two handles that this process owns.
    let _thread = unsafe { OwnedHandle::from_raw_handle(process.hThread) };
    Ok(Console {
        pid: process.dwProcessId,
        process: unsafe { OwnedHandle::from_raw_handle(process.hProcess) },
    })
}

/// The Windows system directory, where its own shells live.
pub(crate) fn system_directory() -> Option<PathBuf> {
    let mut buffer = vec![0u16; 32768];
    // SAFETY: the buffer is writable for the length passed.
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    (length != 0 && length < buffer.len())
        .then(|| PathBuf::from(String::from_utf16_lossy(&buffer[..length])))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arguments_are_quoted_as_the_c_runtime_reads_them() {
        assert_eq!(quote("plain"), r#""plain""#);
        assert_eq!(quote(""), r#""""#);
        assert_eq!(quote(r"C:\Program Files\Git"), r#""C:\Program Files\Git""#);
        assert_eq!(quote(r#"say "hi""#), r#""say \"hi\"""#);
        // Backslashes are doubled only where a quote would otherwise swallow them.
        assert_eq!(quote(r"ends\"), r#""ends\\""#);
        assert_eq!(quote(r#"a\\"b"#), r#""a\\\\\"b""#);
        assert_eq!(quote("two\nlines $(x) 'y'"), "\"two\nlines $(x) 'y'\"");
    }
    #[test]
    fn the_environment_block_is_sorted_and_terminated() {
        let block = environment_block(&[
            ("b".into(), "2".into()),
            ("A".into(), "1".into()),
            ("=C:".into(), r"C:\x".into()),
        ]);
        let text = String::from_utf16(&block).unwrap();
        assert_eq!(text, "=C:=C:\\x\0A=1\0b=2\0\0");
    }
}
