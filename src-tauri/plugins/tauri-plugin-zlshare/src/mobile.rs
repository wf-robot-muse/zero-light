use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_zlshare);

// Initializes the Kotlin or Swift plugin class.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<ZlShare<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(
        "com.wf.robot.muse.zerolight.zlshare",
        "ZlSharePlugin",
    )?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_zlshare)?;
    Ok(ZlShare(handle))
}

/// Access to the share APIs.
pub struct ZlShare<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> ZlShare<R> {
    pub fn share_file(&self, payload: ShareRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("share_file", payload)
            .map_err(Into::into)
    }
}
