//! Allocations that wait for memory instead of ending the app.
//!
//! Rust ends the process when the system refuses an allocation. Windows refuses one when the
//! memory it has promised reaches its commit limit, which it raises by growing the page file only
//! as programs press against it. On 2026-10-20 the computer stood at 87.2 of 87.7 GB with its
//! page file growing, a save of the 170 MB workspace asked for 256 MiB, and the app closed in the
//! middle of a reply, as Explorer and RustDesk did that minute (docs/DIAGNOSTICS.md). The app's
//! allocator (`Patient`, installed on Windows by main.rs) asks again after growing pauses, for up
//! to a minute, before it lets the refusal stand, and the watchdog reports each wait as a
//! `memoryWait` report.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    ptr::null_mut,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

/// How long a refused allocation is asked again, and the pauses between: the first, doubled
/// after each refusal up to the longest.
#[derive(Clone, Copy)]
struct Patience {
    total: Duration,
    first: Duration,
    longest: Duration,
}

const PATIENCE: Patience = Patience {
    total: Duration::from_secs(60),
    first: Duration::from_millis(5),
    longest: Duration::from_secs(1),
};

/// The system allocator, asked again while the system refuses.
pub struct Patient;

// SAFETY: every block comes from `System` and goes back to it with the same layout; a refused
// `realloc` leaves its block where it was, so asking again is sound.
unsafe impl GlobalAlloc for Patient {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let block = System.alloc(layout);
        if !block.is_null() {
            return block;
        }
        wait(layout.size(), PATIENCE, &WAITS, || System.alloc(layout))
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let block = System.alloc_zeroed(layout);
        if !block.is_null() {
            return block;
        }
        wait(layout.size(), PATIENCE, &WAITS, || {
            System.alloc_zeroed(layout)
        })
    }
    unsafe fn dealloc(&self, block: *mut u8, layout: Layout) {
        System.dealloc(block, layout)
    }
    unsafe fn realloc(&self, block: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let moved = System.realloc(block, layout, size);
        if !moved.is_null() {
            return moved;
        }
        wait(size, PATIENCE, &WAITS, || {
            System.realloc(block, layout, size)
        })
    }
}

/// Asks `again` after growing pauses until it returns a block or `patience` runs out, unless no
/// wait could make room for `size` bytes. Nothing here allocates: it runs inside the allocator.
fn wait(
    size: usize,
    patience: Patience,
    waits: &Waits,
    mut again: impl FnMut() -> *mut u8,
) -> *mut u8 {
    let Some(commit) = room_for(size) else {
        return null_mut();
    };
    waits.began(size, commit);
    let started = Instant::now();
    let mut pause = patience.first;
    loop {
        sleep(pause.min(patience.total.saturating_sub(started.elapsed())));
        let block = again();
        let waited = started.elapsed();
        if !block.is_null() || waited >= patience.total {
            waits.ended(waited, !block.is_null());
            return block;
        }
        pause = (pause * 2).min(patience.longest);
    }
}

/// The memory the system had promised and could promise when a wait began, in bytes.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Commit {
    pub committed: u64,
    pub limit: u64,
}

/// Whether waiting could find `size` bytes: not when they exceed all the memory Windows can
/// promise as it stands, page file included, which only an absurd request does. With the
/// commit reading, when Windows gives one.
#[cfg(windows)]
fn room_for(size: usize) -> Option<Commit> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // SAFETY: a plain structure of integers, which the call fills in.
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    // SAFETY: `status` is a valid MEMORYSTATUSEX with its length set.
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return Some(Commit::default());
    }
    let commit = Commit {
        committed: status
            .ullTotalPageFile
            .saturating_sub(status.ullAvailPageFile),
        limit: status.ullTotalPageFile,
    };
    (size as u64 <= commit.limit).then_some(commit)
}

#[cfg(not(windows))]
fn room_for(_size: usize) -> Option<Commit> {
    Some(Commit::default())
}

#[cfg(windows)]
fn sleep(pause: Duration) {
    // SAFETY: a plain wait of this thread.
    unsafe {
        windows_sys::Win32::System::Threading::Sleep(
            u32::try_from(pause.as_millis()).unwrap_or(u32::MAX),
        )
    }
}

#[cfg(not(windows))]
fn sleep(pause: Duration) {
    std::thread::sleep(pause)
}

/// What the waits since the watchdog last asked came to.
#[derive(Debug, PartialEq)]
pub struct WaitReport {
    /// Refused allocations that waited.
    pub waits: u64,
    /// Of those, the ones still refused when their patience ran out.
    pub refused: u64,
    pub longest_ms: u64,
    pub largest_bytes: u64,
    /// The commit reading when the latest wait began.
    pub commit: Commit,
}

/// Counts waits with atomics alone, since the allocator records them.
struct Waits {
    waits: AtomicU64,
    refused: AtomicU64,
    longest_ms: AtomicU64,
    largest_bytes: AtomicU64,
    committed: AtomicU64,
    limit: AtomicU64,
}

static WAITS: Waits = Waits::new();

impl Waits {
    const fn new() -> Self {
        Self {
            waits: AtomicU64::new(0),
            refused: AtomicU64::new(0),
            longest_ms: AtomicU64::new(0),
            largest_bytes: AtomicU64::new(0),
            committed: AtomicU64::new(0),
            limit: AtomicU64::new(0),
        }
    }
    fn began(&self, size: usize, commit: Commit) {
        self.largest_bytes.fetch_max(size as u64, Ordering::SeqCst);
        self.committed.store(commit.committed, Ordering::SeqCst);
        self.limit.store(commit.limit, Ordering::SeqCst);
    }
    fn ended(&self, waited: Duration, granted: bool) {
        let waited = u64::try_from(waited.as_millis()).unwrap_or(u64::MAX);
        self.longest_ms.fetch_max(waited, Ordering::SeqCst);
        if !granted {
            self.refused.fetch_add(1, Ordering::SeqCst);
        }
        // Counted last, so a report taken meanwhile finds the rest of this wait with it.
        self.waits.fetch_add(1, Ordering::SeqCst);
    }
    fn take(&self) -> Option<WaitReport> {
        let waits = self.waits.swap(0, Ordering::SeqCst);
        (waits > 0).then(|| WaitReport {
            waits,
            refused: self.refused.swap(0, Ordering::SeqCst),
            longest_ms: self.longest_ms.swap(0, Ordering::SeqCst),
            largest_bytes: self.largest_bytes.swap(0, Ordering::SeqCst),
            commit: Commit {
                committed: self.committed.load(Ordering::SeqCst),
                limit: self.limit.load(Ordering::SeqCst),
            },
        })
    }
}

/// The waits that ended since the last call, if any did.
pub fn take_waits() -> Option<WaitReport> {
    WAITS.take()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const BRIEF: Patience = Patience {
        total: Duration::from_millis(60),
        first: Duration::from_millis(1),
        longest: Duration::from_millis(8),
    };

    #[test]
    fn asks_again_until_memory_is_granted() {
        let waits = Waits::new();
        let mut byte = 0u8;
        let granted: *mut u8 = &mut byte;
        let refusals = Cell::new(3);
        let block = wait(4096, PATIENCE, &waits, || {
            if refusals.get() == 0 {
                granted
            } else {
                refusals.set(refusals.get() - 1);
                null_mut()
            }
        });
        assert_eq!(block, granted);
        assert_eq!(refusals.get(), 0);
        let report = waits.take().unwrap();
        assert_eq!(
            (report.waits, report.refused, report.largest_bytes),
            (1, 0, 4096)
        );
        assert!(report.longest_ms < 1_000);
        // Taken once.
        assert_eq!(waits.take(), None);
    }

    #[test]
    fn lets_the_refusal_stand_once_patience_runs_out() {
        let waits = Waits::new();
        let asked = Cell::new(0);
        let started = Instant::now();
        let block = wait(64, BRIEF, &waits, || {
            asked.set(asked.get() + 1);
            null_mut()
        });
        assert!(block.is_null());
        assert!(started.elapsed() >= BRIEF.total);
        // Asked again after each pause, however coarse the system's timer.
        assert!(asked.get() >= 2, "asked {} times", asked.get());
        let report = waits.take().unwrap();
        assert_eq!((report.waits, report.refused), (1, 1));
        assert!(report.longest_ms >= 60);
    }

    #[test]
    fn reports_every_wait_since_the_last_report() {
        let waits = Waits::new();
        let mut byte = 0u8;
        let granted: *mut u8 = &mut byte;
        for size in [10, 300, 20] {
            assert_eq!(wait(size, BRIEF, &waits, || granted), granted);
        }
        let report = waits.take().unwrap();
        assert_eq!(
            (report.waits, report.refused, report.largest_bytes),
            (3, 0, 300)
        );
    }

    #[cfg(windows)]
    #[test]
    fn never_waits_for_more_than_windows_could_ever_promise() {
        let waits = Waits::new();
        let asked = Cell::new(0);
        let block = wait(usize::MAX, PATIENCE, &waits, || {
            asked.set(asked.get() + 1);
            null_mut()
        });
        assert!(block.is_null());
        assert_eq!(asked.get(), 0);
        assert_eq!(waits.take(), None);
        let commit = room_for(1).unwrap();
        assert!(commit.limit > 0 && commit.committed <= commit.limit);
    }

    #[test]
    fn hands_out_blocks_of_the_system_allocator() {
        let layout = Layout::from_size_align(1 << 20, 64).unwrap();
        // SAFETY: the layout has a nonzero size, and each block goes back as it came.
        unsafe {
            let block = Patient.alloc_zeroed(layout);
            assert!(!block.is_null() && block.align_offset(64) == 0);
            assert!(std::slice::from_raw_parts(block, 1 << 20)
                .iter()
                .all(|b| *b == 0));
            block.write(7);
            let grown = Patient.realloc(block, layout, 4 << 20);
            assert_eq!(grown.read(), 7);
            Patient.dealloc(grown, Layout::from_size_align(4 << 20, 64).unwrap());
        }
    }
}
