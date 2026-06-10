use std::sync::Mutex;

/// Handle to the bundled agent sidecar so we can kill it on exit.
struct Sidecar(Mutex<Option<std::process::Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            // In dev, scripts/dev.mjs runs the sidecar. In the bundled app we
            // spawn it from resources via a login shell so node/claude are on PATH.
            #[cfg(not(debug_assertions))]
            {
                use tauri::Manager;
                let script = app
                    .path()
                    .resolve("resources/sidecar.cjs", tauri::path::BaseDirectory::Resource)?;
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
