// Item #62: Zero Light's first-party share plugin. One job: take a
// file the app has written into its own cache folder and hand it to
// the system share sheet (decisions D1/D2 — exports and print PDFs on
// iOS/Android). The frontend calls it as
// invoke('plugin:zlshare|share_file', { path, mime }); the Rust side
// only registers the native implementations. Desktop builds get a
// stub that errors, because desktop exports use the Save As dialog.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use error::{Error, Result};
pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod error;
mod models;

#[cfg(desktop)]
use desktop::ZlShare;
#[cfg(mobile)]
use mobile::ZlShare;

/// Access to the share API for Rust callers (the app itself calls it
/// from the frontend; this is here for completeness).
pub trait ZlShareExt<R: Runtime> {
    fn zl_share(&self) -> &ZlShare<R>;
}

impl<R: Runtime, T: Manager<R>> ZlShareExt<R> for T {
    fn zl_share(&self) -> &ZlShare<R> {
        self.state::<ZlShare<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("zlshare")
        .setup(|app, api| {
            #[cfg(mobile)]
            let share = mobile::init(app, api)?;
            #[cfg(desktop)]
            let share = desktop::init(app, api)?;
            app.manage(share);
            Ok(())
        })
        .build()
}
