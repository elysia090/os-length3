// The shell grants the webview no host access yet. Filesystem, terminal and
// root launch arrive as explicit commands when each surface becomes real.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Length³ OS shell failed to start");
}
