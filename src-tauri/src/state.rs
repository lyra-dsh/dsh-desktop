//! Managed state carrying the dsh child process id, and process-group teardown.

use std::sync::Mutex;
use std::time::Duration;

pub struct DshState {
    /// The child process id; also the process-group id (see `process_group(0)`).
    /// Cleared after a kill so teardown is idempotent.
    pid: Mutex<Option<u32>>,
}

impl DshState {
    pub fn new(pid: u32) -> Self {
        Self {
            pid: Mutex::new(Some(pid)),
        }
    }

    pub fn pid(&self) -> Option<u32> {
        *self.pid.lock().unwrap()
    }

    /// Terminate the dsh process group (SIGTERM, then SIGKILL after a grace
    /// period). The pid is cleared so repeated calls become a no-op.
    pub fn kill(&self) {
        let mut guard = self.pid.lock().unwrap();
        let Some(pid) = guard.take() else {
            return;
        };
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        std::thread::sleep(Duration::from_millis(1500));
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}
