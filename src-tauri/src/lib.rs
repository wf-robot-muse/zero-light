// Rust side: the predictor's logic lives in the TypeScript frontend; this
// command simply reports app identity so the UI can confirm the IPC bridge.
#[tauri::command]
fn app_info() -> String {
    format!(
        "Zero Light {} — Tauri 2",
        env!("CARGO_PKG_VERSION")
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
