use std::sync::Mutex;

/// Handle to the bundled agent sidecar so we can kill it on exit.
struct Sidecar(Mutex<Option<std::process::Child>>);

const MENU_CLOSE_TAB: &str = "moobot-close-tab";
const MENU_NEW_TAB: &str = "moobot-new-tab";
const MENU_RUN_ACTIVE: &str = "moobot-run-active";
const MENU_RUN_ALL: &str = "moobot-run-all";
const MENU_NEXT_TAB: &str = "moobot-next-tab";
const MENU_PREVIOUS_TAB: &str = "moobot-previous-tab";
const MENU_TAB_PREFIX: &str = "moobot-tab-";

fn shortcut_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{
        AboutMetadata, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID,
    };

    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let new_tab = MenuItemBuilder::with_id(MENU_NEW_TAB, "New Lens Tab")
        .accelerator("CmdOrCtrl+KeyT")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id(MENU_CLOSE_TAB, "Close Lens Tab")
        .accelerator("CmdOrCtrl+KeyW")
        .build(app)?;
    let run_active = MenuItemBuilder::with_id(MENU_RUN_ACTIVE, "Run Active Lens")
        .accelerator("CmdOrCtrl+KeyR")
        .build(app)?;
    let run_all = MenuItemBuilder::with_id(MENU_RUN_ALL, "Run All Lenses")
        .accelerator("CmdOrCtrl+Shift+KeyR")
        .build(app)?;

    let mut tab_items = Vec::new();
    for i in 1..=9 {
        let label = if i == 9 {
            "Select Last Tab".to_string()
        } else {
            format!("Select Tab {i}")
        };
        tab_items.push(
            MenuItemBuilder::with_id(format!("{MENU_TAB_PREFIX}{i}"), label)
                .accelerator(format!("CmdOrCtrl+Digit{i}"))
                .build(app)?,
        );
    }
    let previous_tab = MenuItemBuilder::with_id(MENU_PREVIOUS_TAB, "Previous Tab")
        .accelerator("CmdOrCtrl+BracketLeft")
        .build(app)?;
    let next_tab = MenuItemBuilder::with_id(MENU_NEXT_TAB, "Next Tab")
        .accelerator("CmdOrCtrl+BracketRight")
        .build(app)?;

    let app_menu = Submenu::with_items(
        app,
        pkg_info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_tab,
            &close_tab,
            &PredefinedMenuItem::separator(app)?,
            &run_active,
            &run_all,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    let tabs_menu = Submenu::with_items(
        app,
        "Tabs",
        true,
        &[
            &tab_items[0],
            &tab_items[1],
            &tab_items[2],
            &tab_items[3],
            &tab_items[4],
            &tab_items[5],
            &tab_items[6],
            &tab_items[7],
            &tab_items[8],
            &PredefinedMenuItem::separator(app)?,
            &previous_tab,
            &next_tab,
        ],
    )?;
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;
    let help_menu = Submenu::with_items(app, "Help", true, &[])?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &tabs_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

fn emit_shortcut<R: tauri::Runtime>(app: &tauri::AppHandle<R>, command: &str) {
    use tauri::Emitter;
    let _ = app.emit("moobot://shortcut", command);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .menu(shortcut_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_CLOSE_TAB => emit_shortcut(app, "close-tab"),
            MENU_NEW_TAB => emit_shortcut(app, "new-tab"),
            MENU_RUN_ACTIVE => emit_shortcut(app, "run-active"),
            MENU_RUN_ALL => emit_shortcut(app, "run-all"),
            MENU_NEXT_TAB => emit_shortcut(app, "next-tab"),
            MENU_PREVIOUS_TAB => emit_shortcut(app, "previous-tab"),
            id if id.starts_with(MENU_TAB_PREFIX) => {
                let n = id.trim_start_matches(MENU_TAB_PREFIX);
                if n == "9" {
                    emit_shortcut(app, "tab-last");
                } else {
                    emit_shortcut(app, &format!("tab-{n}"));
                }
            }
            _ => {}
        })
        .plugin(tauri_plugin_opener::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            // In dev, scripts/dev.mjs runs the sidecar. In the bundled app we
            // spawn it from resources via a login shell so node/claude are on PATH.
            #[cfg(not(debug_assertions))]
            {
                use tauri::Manager;
                let script = app.path().resolve(
                    "resources/sidecar.cjs",
                    tauri::path::BaseDirectory::Resource,
                )?;
                let child = std::process::Command::new("/bin/zsh")
                    .args(["-lc", &format!("exec node '{}'", script.display())])
                    .spawn();
                match child {
                    Ok(c) => {
                        *app.state::<Sidecar>().0.lock().unwrap() = Some(c);
                    }
                    Err(e) => eprintln!("failed to start sidecar: {e}"),
                }
            }
            #[cfg(debug_assertions)]
            let _ = app;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                if let Some(mut child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
