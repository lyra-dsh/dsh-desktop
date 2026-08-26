//! Configuration for the dsh desktop wrapper.
//!
//! The file is a small JSON document read once at startup, and it lives at a
//! predictable, easy-to-edit location: `$XDG_CONFIG_HOME/lyra-dsh/config.json`
//! (defaulting to `~/.config/lyra-dsh/config.json`). It is **created with sane
//! defaults on first run** so you can find and edit it right away.
//!
//! `$DSH_DESKTOP_CONFIG` overrides the path entirely (handy for testing). A
//! missing file or missing keys fall back to the same defaults, so the app runs
//! with the `web` profile out of the box.

use serde::Deserialize;
use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    /// dsh profile to boot. Expected to serve a web UI (e.g. `web`).
    pub profile: String,
    /// Path (or command name) of the dsh binary. When `null` it is auto-discovered.
    pub dsh_bin: Option<String>,
    /// `--host` handed to the web surface. Defaults to the loopback interface.
    pub host: Option<String>,
    /// `--port` handed to the web surface. `null` uses dsh's default (3080),
    /// a number pins that port, and `0` lets the OS assign one.
    pub port: Option<u32>,
    /// When false (default) we append `--no-open` so dsh doesn't launch a browser.
    pub open_browser: bool,
    /// Extra dsh CLI arguments appended verbatim (e.g. `--trusted-host app.internal`).
    pub extra_args: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            profile: "web".to_string(),
            dsh_bin: None,
            host: Some("127.0.0.1".to_string()),
            port: None,
            open_browser: false,
            extra_args: Vec::new(),
        }
    }
}

impl Config {
    /// The argv passed to dsh: launcher flags first, then the web-surface flags
    /// and any user extras. e.g. `dsh --profile web --host 127.0.0.1 --no-open`.
    pub fn cli_args(&self) -> Vec<String> {
        let mut args = vec!["--profile".to_string(), self.profile.clone()];
        if let Some(host) = self.host.as_ref() {
            if !host.is_empty() {
                args.push("--host".to_string());
                args.push(host.clone());
            }
        }
        if let Some(port) = self.port {
            if port != 0 {
                args.push("--port".to_string());
                args.push(port.to_string());
            }
        }
        if !self.open_browser {
            args.push("--no-open".to_string());
        }
        args.extend(self.extra_args.iter().cloned());
        args
    }
}

/// The default config, as a pretty-printed JSON file the user edits.
fn default_config_json() -> String {
    serde_json::to_string_pretty(&Config::default()).unwrap_or_else(|_| String::from("{\n}\n"))
}

/// The directory holding this app's config: `$XDG_CONFIG_HOME/lyra-dsh` or
/// `~/.config/lyra-dsh`.
pub fn config_dir() -> Option<PathBuf> {
    if let Some(x) = std::env::var_os("XDG_CONFIG_HOME") {
        if !x.is_empty() {
            return Some(PathBuf::from(x).join("lyra-dsh"));
        }
    }
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".config").join("lyra-dsh"))
}

/// Resolve the config file path. `DSH_DESKTOP_CONFIG` overrides everything.
pub fn config_path() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("DSH_DESKTOP_CONFIG") {
        return Ok(PathBuf::from(p));
    }
    let dir = config_dir().ok_or_else(|| "cannot resolve HOME/XDG_CONFIG_HOME".to_string())?;
    Ok(dir.join("config.json"))
}

/// If the config file does not exist yet, create its directory and write a
/// default config so the user has something to edit. Idempotent.
pub fn ensure_default(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::write(path, default_config_json())
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    eprintln!("dsh-desktop: wrote default config to {path:?}");
    Ok(())
}

/// Parse a config file. Missing keys fall back to defaults (it does NOT create
/// the file; use `ensure_default` first).
pub fn load_from(path: &Path) -> Result<Config, String> {
    if !path.exists() {
        return Ok(Config::default());
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("read config {path:?}: {e}"))?;
    let cfg: Config = serde_json::from_str(&text).map_err(|e| format!("parse config {path:?}: {e}"))?;
    Ok(cfg)
}

/// Resolve the config path, ensure a default file exists on first run, then load it.
pub fn load_for_app() -> Result<Config, String> {
    let path = config_path()?;
    ensure_default(&path)?;
    load_from(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_json_parses_and_matches_defaults() {
        let json = default_config_json();
        let cfg: Config = serde_json::from_str(&json).expect("default json parses");
        assert_eq!(cfg.profile, "web");
        assert_eq!(cfg.dsh_bin, None);
        assert_eq!(cfg.host.as_deref(), Some("127.0.0.1"));
        assert_eq!(cfg.port, None);
        assert!(!cfg.open_browser);
        assert!(cfg.extra_args.is_empty());
    }

    #[test]
    fn cli_args_default() {
        let cfg = Config::default();
        assert_eq!(
            cfg.cli_args(),
            vec!["--profile", "web", "--host", "127.0.0.1", "--no-open"]
        );
    }

    #[test]
    fn cli_args_with_port_and_extra() {
        let cfg = Config {
            port: Some(8080),
            open_browser: true,
            extra_args: vec!["--trusted-host".into(), "app.internal".into()],
            ..Config::default()
        };
        assert_eq!(
            cfg.cli_args(),
            vec!["--profile", "web", "--host", "127.0.0.1", "--port", "8080", "--trusted-host", "app.internal"]
        );
    }

    #[test]
    fn config_dir_named_lyra_dsh() {
        // Only meaningful when HOME or XDG_CONFIG_HOME is set.
        if let Some(dir) = config_dir() {
            let name = dir.file_name().and_then(|s| s.to_str()).unwrap_or("");
            assert_eq!(name, "lyra-dsh");
        }
    }

    #[test]
    fn ensure_default_creates_parseable_file() {
        let dir = std::env::temp_dir().join(format!("dsh-desktop-test-{}", std::process::id()));
        let path = dir.join("config.json");
        ensure_default(&path).unwrap();
        assert!(path.exists());
        let cfg = load_from(&path).unwrap();
        assert_eq!(cfg.profile, "web");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
