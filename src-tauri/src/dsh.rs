//! dsh subprocess discovery, environment, spawning, and readiness probing.
//!
//! A GUI app on macOS does not inherit a shell PATH, so we resolve the dsh
//! binary explicitly and hand the child a PATH that also contains node (dsh is a
//! node script) plus the usual tool dirs.

use crate::config::Config;
use std::net::TcpStream;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Best-match node bin dir under `~/.nvm/versions/node/<version>/bin`.
/// Lexicographic sort is fine for dotted semver-ish directory names.
fn latest_nvm_bin() -> Option<PathBuf> {
    let h = home()?;
    let nvm = h.join(".nvm").join("versions").join("node");
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&nvm)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort_by(|a, b| b.cmp(a));
    dirs.into_iter().next().map(|d| d.join("bin"))
}

/// Resolve an explicit candidate: a real file path, or a name found on PATH.
fn resolve_candidate(s: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(s);
    if p.is_file() {
        return Ok(p);
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            if dir.is_empty() {
                continue;
            }
            let c = PathBuf::from(dir).join(s);
            if c.is_file() {
                return Ok(c);
            }
        }
    }
    Err(format!("dsh binary not found: {s}"))
}

/// Locate the dsh binary: explicit config, then an env override, then known
/// locations, then PATH. Returns an absolute path to an existing file.
pub fn resolve_bin(cfg: &Config) -> Result<PathBuf, String> {
    if let Some(explicit) = cfg.dsh_bin.as_ref() {
        if !explicit.is_empty() {
            return resolve_candidate(explicit);
        }
    }
    if let Ok(val) = std::env::var("DSH_DESKTOP_DSH_BIN") {
        if !val.is_empty() {
            return resolve_candidate(&val);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(h) = home() {
        if let Some(bin) = latest_nvm_bin() {
            candidates.push(bin.join("dsh"));
        }
        for rel in [".local/bin/dsh", ".bun/bin/dsh"] {
            candidates.push(h.join(rel));
        }
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/dsh"));
    candidates.push(PathBuf::from("/usr/local/bin/dsh"));

    for c in &candidates {
        if c.is_file() {
            return Ok(c.clone());
        }
    }

    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            if dir.is_empty() {
                continue;
            }
            let c = PathBuf::from(dir).join("dsh");
            if c.is_file() {
                return Ok(c);
            }
        }
    }

    Err("could not locate the `dsh` binary; set `dshBin` in config.json or DSH_DESKTOP_DSH_BIN".to_string())
}

/// Build the child PATH: the dsh bin dir, node/nvm/bin, tool dirs, and the
/// existing PATH (deduped, order-preserving).
fn build_path(bin: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(dir) = bin.parent() {
        parts.push(dir.to_string_lossy().to_string());
    }
    if let Some(h) = home() {
        if let Some(b) = latest_nvm_bin() {
            parts.push(b.to_string_lossy().to_string());
        }
        for rel in [".local/bin", ".bun/bin"] {
            parts.push(h.join(rel).to_string_lossy().to_string());
        }
    }
    parts.push("/opt/homebrew/bin".to_string());
    parts.push("/usr/local/bin".to_string());
    parts.push("/usr/bin".to_string());
    parts.push("/bin".to_string());
    parts.push("/usr/sbin".to_string());
    parts.push("/sbin".to_string());
    if let Ok(existing) = std::env::var("PATH") {
        parts.extend(existing.split(':').map(|s| s.to_string()));
    }
    let mut seen = std::collections::HashSet::new();
    parts.retain(|p| !p.is_empty() && seen.insert(p.clone()));
    parts.join(":")
}

/// Spawn dsh with the composed args and the controlled PATH.
#[cfg(unix)]
pub fn spawn(cfg: &Config, bin: &Path) -> Result<Child, String> {
    use std::os::unix::process::CommandExt;
    let path = build_path(bin);
    let mut cmd = Command::new(bin);
    cmd.args(cfg.cli_args());
    cmd.env("PATH", path);
    for k in ["HOME", "DSH_HOME", "DSH_TELEMETRY_DISABLED", "SHELL", "TERM", "LANG", "LC_ALL", "USER"] {
        if let Ok(v) = std::env::var(k) {
            cmd.env(k, v);
        }
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // Put the child at the head of its own process group so we can kill the
    // whole tree (dsh + any tools it spawns) later.
    cmd.process_group(0);
    cmd.spawn().map_err(|e| format!("failed to spawn {}: {e}", bin.display()))
}

#[cfg(not(unix))]
pub fn spawn(cfg: &Config, bin: &Path) -> Result<Child, String> {
    let path = build_path(bin);
    let mut cmd = Command::new(bin);
    cmd.args(cfg.cli_args());
    cmd.env("PATH", path);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.spawn().map_err(|e| format!("failed to spawn {}: {e}", bin.display()))
}

/// Wait until the loopback port accepts a TCP connection, within `timeout`.
/// Returns true once the listener is up.
pub fn probe_port(port: u32, timeout: Duration) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let start = std::time::Instant::now();
    loop {
        if TcpStream::connect(&addr).is_ok() {
            return true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}
