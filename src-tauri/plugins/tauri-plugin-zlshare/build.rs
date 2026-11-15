// The plugin exposes exactly one command; the build script generates
// its allow/deny permission entries (zlshare:allow-share-file) from it.
const COMMANDS: &[&str] = &["share_file"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
