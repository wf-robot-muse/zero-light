use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

// Desktop stub: the plugin is registered so the app builds the same
// everywhere, but the frontend never calls it on desktop (exports use
// the Save As dialog there). Any call answers with an error.
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<ZlShare<R>> {
    Ok(ZlShare(app.clone()))
}

/// Access to the share APIs.
pub struct ZlShare<R: Runtime>(AppHandle<R>);

impl<R: Runtime> ZlShare<R> {
    pub fn share_file(&self, _payload: ShareRequest) -> crate::Result<()> {
        Err(crate::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "share sheet is mobile-only",
        )))
    }
}
