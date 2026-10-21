// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// An allocation Windows refuses waits for memory rather than ending the app (memory.rs).
#[cfg(windows)]
#[global_allocator]
static ALLOCATOR: agent_studio_lib::memory::Patient = agent_studio_lib::memory::Patient;

fn main() {
    agent_studio_lib::run()
}
