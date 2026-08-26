//! dsh desktop (Tauri v2): wrap the `dsh` CLI so its web UI runs in a native
//! macOS window instead of a browser tab.
//!
//! At startup we read an optional JSON config, spawn `dsh --profile <profile>
//! --no-open` with a controlled environment, wait until the web server answers,
//! then create a WebView window pointed at the loopback URL. Closing the window
//! (X) hides it while the app keeps running behind a menu-bar (tray) icon; dsh
//! keeps serving. Quitting is done via the tray menu or Cmd+Q, which then kills
//! the whole dsh process group.

pub mod config;
pub mod dsh;
pub mod state;
pub mod tray;

use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;
use tauri::RunEvent;
use tauri::webview::NewWindowResponse;
use tauri::WebviewUrl;
use tauri::WebviewWindowBuilder;
use tauri::WindowEvent;

use state::DshState;

/// Convert a plain string into the boxed error the Tauri `setup` closure needs.
fn setup_err(msg: String) -> Box<dyn std::error::Error> {
    Box::new(std::io::Error::other(msg))
}

/// Hand a URL to the OS, which opens it with the default browser / app
/// (cross-platform via `tauri-plugin-opener`).
fn open_in_browser(app: &tauri::AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        eprintln!("dsh-desktop: open {url}: {e}");
    }
}

/// Injected into the dsh web page (runs before its own scripts) to route
/// "open a new tab" style links to the system browser via the opener plugin,
/// without touching in-app (same-origin) navigation or iframe loads.
const EXTERNAL_LINKS_SCRIPT: &str = r#"
(function () {
  function openInBrowser(url) {
    try {
      window.__TAURI_INTERNALS__.invoke('plugin:opener|open_url', { url: url }).catch(function (e) {
        console.error('[dsh-desktop] open_url failed:', e);
      });
    } catch (e) {
      console.error('[dsh-desktop] open_url failed:', e);
    }
  }

  // window.open -> system browser
  try {
    var nativeOpen = window.open;
    window.open = function (url) {
      if (typeof url === 'string' && url.length > 0) {
        openInBrowser(url);
        return null;
      }
      return nativeOpen.apply(window, arguments);
    };
  } catch (e) {}

  // Clicks: target="_blank" / modifier clicks are left to the native
  // on_new_window handler; plain external-origin links are sent to the browser
  // here so same-origin (SPA) navigation is never disturbed.
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!el) return;
    var href = el.getAttribute('href');
    if (!href) return;
    var url;
    try { url = new URL(href, window.location.href); } catch (err) { return; }
    if (el.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (url.origin !== window.location.origin) {
      e.preventDefault();
      openInBrowser(url.href);
    }
  }, true);
})();
"#;

/// Build the main window pointed at the resolved loopback URL. Must run on the
/// main thread (enforced by the caller via `run_on_main_thread`).
fn build_webview(app: &tauri::AppHandle, url: String) {
    let parsed = match tauri::Url::parse(&url) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("dsh-desktop: invalid url {url:?}: {e}");
            return;
        }
    };
    let handle_new_window = app.clone();
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title("dsh")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .initialization_script(EXTERNAL_LINKS_SCRIPT)
        .on_new_window(move |url, _features| {
            // target="_blank" / window.open (incl. inside iframes): open in the
            // system browser instead of trying to spawn a WebView "tab".
            open_in_browser(&handle_new_window, url.as_str());
            NewWindowResponse::Deny
        });
    if let Err(e) = window.build() {
        eprintln!("dsh-desktop: failed to build main window: {e}");
    }
}

/// Show a native error dialog with the child's captured output, then exit.
fn show_error(app: &tauri::AppHandle, detail: String) {
    use tauri_plugin_dialog::DialogExt;
    let trimmed: String = detail.chars().take(4000).collect();
    let text = format!("dsh failed to start.\n\n{trimmed}");
    app.dialog()
        .message(text)
        .title("dsh Desktop")
        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
        .blocking_show();
    app.exit(1);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let cfg = config::load_for_app().map_err(setup_err)?;

            let bin = dsh::resolve_bin(&cfg).map_err(setup_err)?;

            let mut child = dsh::spawn(&cfg, &bin).map_err(setup_err)?;
            let pid = child.id();
            app.manage(DshState::new(pid));

            // System tray: keep the app alive behind the menu-bar icon, and let
            // the user restore or quit from there.
            tray::setup(app)?;

            let handle = app.handle().clone();

            // Take the streams so the reader threads own them while the Child
            // stays managed here for cleanup.
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            // Keep stderr so we can explain a failed start.
            let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
            if let Some(mut err) = stderr {
                use std::io::Read;
                let buf = stderr_buf.clone();
                std::thread::spawn(move || {
                    let mut data = String::new();
                    let _ = err.read_to_string(&mut data);
                    *buf.lock().unwrap() = data;
                });
            }

            // stdout publisher: streams the resolved URL down a channel (the
            // reader keeps reading so the child never gets a SIGPIPE).
            let (ready_tx, ready_rx) = mpsc::channel::<Option<String>>();
            if let Some(out) = stdout {
                use std::io::BufRead;
                let tx = ready_tx.clone();
                std::thread::spawn(move || {
                    let re = regex::Regex::new(r"http://127\.0\.0\.1:\d+").unwrap();
                    let reader = std::io::BufReader::new(out);
                    let mut sent = false;
                    for line in reader.lines() {
                        let line = match line {
                            Ok(l) => l,
                            Err(_) => break,
                        };
                        if !sent {
                            if let Some(m) = re.find(&line) {
                                sent = true;
                                let _ = tx.send(Some(m.as_str().to_string()));
                            }
                        }
                    }
                    if !sent {
                        let _ = tx.send(None); // stdout closed before a URL appeared
                    }
                });
            } else {
                let _ = ready_tx.send(None);
            }

            let handle_win = handle.clone();
            let stderr_for_win = stderr_buf.clone();

            let web_port_threshold = resolve_fallback_port(&cfg);

            // Coordinator: wait for the URL (with a port-poll fallback), then
            // hand off window creation to the main thread and reap the child.
            std::thread::spawn(move || {
                match ready_rx.recv_timeout(Duration::from_secs(60)) {
                    Ok(Some(url)) => {
                        let h = handle_win.clone();
                        let _ = h.run_on_main_thread(move || build_webview(&handle_win, url));
                    }
                    Ok(None) => {
                        let detail = stderr_for_win.lock().unwrap().clone();
                        let detail = if detail.trim().is_empty() {
                            "dsh exited before serving a URL.".to_string()
                        } else {
                            detail
                        };
                        let h = handle_win.clone();
                        let _ = h.run_on_main_thread(move || show_error(&handle_win, detail));
                    }
                    Err(_) => {
                        // Timed out waiting for the stdout line; fall back to
                        // probing the known/default port.
                        if let Some(port) = web_port_threshold {
                            if dsh::probe_port(port, Duration::from_secs(20)) {
                                let url = format!("http://127.0.0.1:{port}");
                                let h = handle_win.clone();
                                let _ = h.run_on_main_thread(move || build_webview(&handle_win, url));
                            } else {
                                let detail = stderr_for_win.lock().unwrap().clone();
                                let detail = if detail.trim().is_empty() {
                                    format!("dsh did not serve on port {port} within the timeout.")
                                } else {
                                    detail
                                };
                                let h = handle_win.clone();
                                let _ = h.run_on_main_thread(move || show_error(&handle_win, detail));
                            }
                        } else {
                            let detail = stderr_for_win.lock().unwrap().clone();
                            let detail = if detail.trim().is_empty() {
                                "dsh did not report a URL within the timeout.".to_string()
                            } else {
                                detail
                            };
                            let h = handle_win.clone();
                            let _ = h.run_on_main_thread(move || show_error(&handle_win, detail));
                        }
                    }
                }
                // Keep the child reaped once it exits (after a kill or on its own).
                let _ = child.wait();
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                // Close (X) hides the window instead of quitting: the app keeps
                // running behind the tray icon. Quit via the tray menu or Cmd+Q,
                // which exits the app and then kills the dsh process group.
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<DshState>() {
                    state.kill();
                }
            }
        });
}

/// The port we may probe if stdout doesn't reveal the URL soon enough.
/// Returns Some(port) when there is a concrete, known port (`null` → 3080, or
/// an explicit non-zero port). Returns None for `port: 0` (OS-assigned), where
/// we must rely on the URL dsh prints to stdout.
fn resolve_fallback_port(cfg: &config::Config) -> Option<u32> {
    match cfg.port {
        None => Some(3080), // dsh default when no --port is given
        Some(0) => None,    // OS-assigned; rely on the stdout URL
        Some(p) => Some(p),
    }
}
