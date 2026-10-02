use crate::console::window;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::null;
use windows_sys::Win32::{
    Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{CreateEventW, WaitForMultipleObjects},
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

// The shell gets a console of its own (`console::window`), and signals once it runs the script.
pub(super) fn open(script: &str) -> Result<u32, String> {
    let event_name = format!("Local\\AgentStudio.SignIn.{}", uuid::Uuid::new_v4());
    let event_name_wide = wide(&event_name);
    // SAFETY: all pointers refer to initialized buffers that remain alive during each call.
    let event = unsafe { CreateEventW(null(), 1, 0, event_name_wide.as_ptr()) };
    if event.is_null() {
        return Err("Cannot prepare the sign-in window".into());
    }
    let event = unsafe { OwnedHandle::from_raw_handle(event) };
    let script = format!(
        "$ready = [System.Threading.EventWaitHandle]::OpenExisting('{event_name}'); $null = $ready.Set(); $ready.Dispose()\n{script}"
    );
    let encoded = STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let shell = window::system_directory()
        .ok_or("Cannot locate Windows PowerShell")?
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let console = window::start(window::Start {
        application: &shell,
        command_line: &format!(
            "{} -NoLogo -NoProfile -NoExit -EncodedCommand {encoded}",
            window::quote(&shell.to_string_lossy())
        ),
        directory: None,
        title: None,
        environment: None,
        hidden: false,
    })
    .map_err(|error| format!("Could not open the sign-in terminal: {error}"))?;
    let handles = [event.as_raw_handle(), console.handle()];
    // SAFETY: both handles are owned here and stay valid during the wait.
    let ready = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, 10000) };
    if ready == WAIT_OBJECT_0 && console.closed_within(400).is_none() {
        return Ok(console.pid);
    }
    if ready == WAIT_TIMEOUT {
        return Err("The sign-in terminal did not become ready. Check the opened window, then retry sign-in if needed.".into());
    }
    let code = console.closed_within(0).unwrap_or_default();
    Err(format!(
        "The sign-in terminal closed before it was ready (exit {code:#x}). Retry sign-in."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Opt-in visible Windows console test; no provider or authentication"]
    fn console_stays_open_with_real_input_after_command_failure() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("console.txt");
        let script = format!("[IO.File]::WriteAllText('{}', [Console]::IsInputRedirected.ToString()); Write-Error 'Synthetic sign-in failure'", marker.to_string_lossy().replace('\'', "''"));
        let pid = open(&script).unwrap();
        let result = std::fs::read_to_string(&marker);
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
        assert_eq!(result.unwrap(), "False");
    }
}
