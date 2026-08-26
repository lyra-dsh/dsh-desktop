//! System-tray (menu bar) icon and its menu, plus the app's state holder that
//! keeps the tray alive for the lifetime of the app.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager};

/// Managed state that owns the tray icon so it is not dropped (and thus hidden).
pub struct TrayState {
    _tray: TrayIcon,
}

/// Show and focus the main window (created lazily by the boot flow).
fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Reload the dsh web UI in the main window without restarting dsh.
fn reload_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval("window.location.reload()");
    }
}

/// Build the tray icon + menu and register it in the app's managed state.
pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "Show dsh Window", true, None::<&str>)?;
    let reload = MenuItem::with_id(app, "reload", "Reload Page", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit dsh Desktop", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&show, &reload, &restart, &sep, &quit])?;

    let icon = app.default_window_icon().map(|i| i.clone());

    let mut builder = TrayIconBuilder::with_id("dsh-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app_handle, event| match event.id().as_ref() {
            "show" => show_main(app_handle),
            "reload" => reload_main(app_handle),
            "restart" => app_handle.request_restart(),
            "quit" => app_handle.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }

    let tray = builder.build(app)?;
    app.manage(TrayState { _tray: tray });
    Ok(())
}
