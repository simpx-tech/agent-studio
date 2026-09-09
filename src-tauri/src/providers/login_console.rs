use base64::{engine::general_purpose::STANDARD, Engine};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::null;
use windows_sys::Win32::{
    Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::{
        SystemInformation::GetSystemDirectoryW,
        Threading::{
            CreateEventW, CreateProcessW, GetExitCodeProcess, WaitForMultipleObjects,
            WaitForSingleObject, CREATE_NEW_CONSOLE, PROCESS_INFORMATION, STARTUPINFOW,
        },
    },
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

// A GUI process may have redirected or closed standard handles. Let Windows create
// real console handles for this shell instead of inheriting the GUI's handles.
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
    let mut system_dir = vec![0u16; 32768];
    let length =
        unsafe { GetSystemDirectoryW(system_dir.as_mut_ptr(), system_dir.len() as u32) } as usize;
    if length == 0 || length >= system_dir.len() {
        return Err("Cannot locate Windows PowerShell".into());
    }
    let shell = format!(
        "{}\\WindowsPowerShell\\v1.0\\powershell.exe",
        String::from_utf16_lossy(&system_dir[..length])
    );
    let application = wide(&shell);
    let mut command = wide(&format!(
        "\"{shell}\" -NoLogo -NoProfile -NoExit -EncodedCommand {encoded}"
    ));
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut process = PROCESS_INFORMATION::default();
    let started = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_NEW_CONSOLE,
            null(),
            null(),
            &startup,
            &mut process,
        )
    };
    if started == 0 {
        return Err(format!(
            "Could not open the sign-in terminal: {}",
            std::io::Error::last_os_error()
        ));
    }
    let process_handle = unsafe { OwnedHandle::from_raw_handle(process.hProcess) };
    let _thread_handle = unsafe { OwnedHandle::from_raw_handle(process.hThread) };
    let handles = [event.as_raw_handle(), process_handle.as_raw_handle()];
    let ready = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, 10000) };
    if ready == WAIT_OBJECT_0
        && unsafe { WaitForSingleObject(process_handle.as_raw_handle(), 400) } == WAIT_TIMEOUT
    {
        return Ok(process.dwProcessId);
    }
    if ready == WAIT_TIMEOUT {
        return Err("The sign-in terminal did not become ready. Check the opened window, then retry sign-in if needed.".into());
    }
    let mut code = 0;
    unsafe {
        GetExitCodeProcess(process_handle.as_raw_handle(), &mut code);
    }
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
