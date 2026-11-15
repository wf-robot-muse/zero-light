// Rust side: the predictor's logic lives in the TypeScript frontend. The
// commands here bridge what a webview cannot do for itself: app identity
// and shell info, native printing on macOS (#48), and native geolocation
// on macOS (#47). The dialog/fs plugins (#49) give .ics exports a native
// Save As in the desktop apps.
//
// Item #62 added the phone shells (iOS, Android/Fire OS). Two more
// plugins register below: the official geolocation plugin (the phone
// route for "Use my location"; its permissions live in
// capabilities/mobile.json, so desktop builds never see them) and this
// project's own zlshare plugin (src-tauri/plugins/tauri-plugin-zlshare),
// which hands a finished file to the phone's share sheet — that is how
// exports, badges, and print PDFs leave the app on a phone, since a
// phone has no Save As dialog. print_page() is desktop-only because
// WebviewWindow::print does not exist on mobile; the mobile build gets
// a stub that errors, and the frontend never calls it there (phones
// print through the PDF share route instead).
//
// In plain words: this is the app's thin native shell. It exists so the
// same web interface can run inside a desktop or phone window and still
// reach the handful of operating-system abilities a web page is not
// allowed to touch. What the shell may do is deliberately narrow: the
// exact permissions are listed in src-tauri/capabilities/default.json
// for desktop (show a save dialog, write a file the user picked —
// nothing else) and capabilities/mobile.json for phones, and the
// frontend learns which OS it is running on from shell_info() and
// branches its behaviour accordingly.

#[tauri::command]
fn app_info() -> String {
    format!(
        "Zero Light {} — Tauri 2",
        env!("CARGO_PKG_VERSION")
    )
}

/// #47/#48/#49: the frontend branches shell behavior by OS — native
/// locate and native print on macOS, Save As in all desktop apps.
#[tauri::command]
fn shell_info() -> serde_json::Value {
    serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

/// #48: WKWebView silently drops `window.print()`; Tauri's native print
/// opens the real macOS print dialog for the webview contents (the
/// existing @media print sheet). The frontend calls this only on macOS;
/// Windows/Linux webviews handle window.print() themselves.
///
/// #62: `WebviewWindow::print` exists only on desktop targets, so the
/// mobile build gets a stub that errors — the frontend never calls it
/// there (mobile print is share-to-PDF, decision D1), but the command
/// must exist for the handler table to compile on iOS/Android.
#[cfg(desktop)]
#[tauri::command]
fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

#[cfg(mobile)]
#[tauri::command]
fn print_page() -> Result<(), String> {
    Err("unsupported".to_string())
}

/// #47 (macOS): one-shot location fix from CoreLocation. WKWebView
/// geolocation can never prompt inside Tauri (nothing requests the
/// system authorization), so the app asks CoreLocation directly. Error
/// strings are stable kinds the frontend maps to its message branches:
/// "denied" | "unavailable" | "timeout".
///
/// #55: this command MUST stay async with the wait on spawn_blocking.
/// A synchronous Tauri command runs on the main thread, and
/// mac_geo::locate blocks waiting for CoreLocation — whose setup,
/// permission prompt, and delegate callbacks are all delivered by the
/// main thread's run loop. Blocking the main thread deadlocks the
/// request until its own timeout (v0.4.6 shipped that bug: beach ball,
/// no prompt, approximate-area fallback on every Mac).
#[cfg(target_os = "macos")]
#[tauri::command]
async fn native_locate(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let fix = tauri::async_runtime::spawn_blocking(move || mac_geo::locate(&app))
        .await
        .map_err(|e| e.to_string())??;
    Ok(serde_json::json!({
        "lat": fix.lat,
        "lon": fix.lon,
        "accuracy": fix.accuracy,
    }))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn native_locate() -> Result<serde_json::Value, String> {
    Err("unsupported".to_string())
}

#[cfg(target_os = "macos")]
mod mac_geo {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, AnyThread, DefinedClass};
    use objc2_core_location::{
        CLAuthorizationStatus, CLLocation, CLLocationManager, CLLocationManagerDelegate,
    };
    use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
    use std::cell::RefCell;
    use std::sync::mpsc::Sender;

    pub struct Fix {
        pub lat: f64,
        pub lon: f64,
        pub accuracy: f64,
    }

    pub struct Ivars {
        tx: RefCell<Option<Sender<Result<Fix, String>>>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "ZLLocationDelegate"]
        #[ivars = Ivars]
        pub struct LocationDelegate;

        unsafe impl NSObjectProtocol for LocationDelegate {}

        unsafe impl CLLocationManagerDelegate for LocationDelegate {
            #[unsafe(method(locationManager:didUpdateLocations:))]
            unsafe fn locationManager_didUpdateLocations(
                &self,
                _manager: &CLLocationManager,
                locations: &NSArray<CLLocation>,
            ) {
                let n = locations.count();
                if n > 0 {
                    // The most recent fix is the last element.
                    let loc = locations.objectAtIndex(n - 1);
                    let c = loc.coordinate();
                    self.finish(Ok(Fix {
                        lat: c.latitude,
                        lon: c.longitude,
                        accuracy: loc.horizontalAccuracy(),
                    }));
                }
            }

            #[unsafe(method(locationManager:didFailWithError:))]
            unsafe fn locationManager_didFailWithError(
                &self,
                _manager: &CLLocationManager,
                error: &NSError,
            ) {
                // CLErrorDenied == 1; anything else is a lookup failure.
                let kind = if error.code() == 1 { "denied" } else { "unavailable" };
                self.finish(Err(kind.to_string()));
            }

            #[unsafe(method(locationManagerDidChangeAuthorization:))]
            unsafe fn locationManagerDidChangeAuthorization(
                &self,
                manager: &CLLocationManager,
            ) {
                match manager.authorizationStatus() {
                    CLAuthorizationStatus::AuthorizedWhenInUse
                    | CLAuthorizationStatus::AuthorizedAlways => {
                        manager.requestLocation();
                    }
                    CLAuthorizationStatus::Denied | CLAuthorizationStatus::Restricted => {
                        self.finish(Err("denied".to_string()));
                    }
                    _ => {}
                }
            }
        }
    );

    impl LocationDelegate {
        fn finish(&self, result: Result<Fix, String>) {
            if let Some(tx) = self.ivars().tx.borrow_mut().take() {
                let _ = tx.send(result);
            }
        }
    }

    /// Runs the CoreLocation request on the main thread (its run loop
    /// delivers the delegate callbacks) and waits for the one-shot fix.
    pub fn locate(app: &tauri::AppHandle) -> Result<Fix, String> {
        let (tx, rx) = std::sync::mpsc::channel::<Result<Fix, String>>();
        let tx_main = tx.clone();
        app.run_on_main_thread(move || {
            let manager = unsafe { CLLocationManager::new() };
            let delegate: Retained<LocationDelegate> = {
                let partial = LocationDelegate::alloc().set_ivars(Ivars {
                    tx: RefCell::new(Some(tx)),
                });
                unsafe { msg_send![super(partial), init] }
            };
            unsafe {
                manager.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            }
            match unsafe { manager.authorizationStatus() } {
                CLAuthorizationStatus::AuthorizedWhenInUse
                | CLAuthorizationStatus::AuthorizedAlways => unsafe {
                    manager.requestLocation();
                },
                CLAuthorizationStatus::NotDetermined => unsafe {
                    manager.requestWhenInUseAuthorization();
                },
                _ => {
                    let _ = tx_main.send(Err("denied".to_string()));
                }
            }
            // Manager and delegate must outlive the request; a locate
            // click is rare and both objects are tiny, so they are kept
            // for the life of the process.
            std::mem::forget(manager);
            std::mem::forget(delegate);
        })
        .map_err(|e| e.to_string())?;
        match rx.recv_timeout(std::time::Duration::from_secs(25)) {
            Ok(result) => result,
            Err(_) => Err("timeout".to_string()),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // #49: native Save As + file write for .ics exports.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // #62: location on iOS/Android goes through the official
        // geolocation plugin (its permissions are granted only by the
        // mobile capability file; on desktop the commands stay denied).
        .plugin(tauri_plugin_geolocation::init())
        // #62: the app's own share plugin (exports and print PDFs hand
        // files to the iOS/Android share sheet; mobile capability only).
        .plugin(tauri_plugin_zlshare::init())
        // #47: let the webview's geolocation through on the platforms
        // whose webview permission layer gates it (Windows/WebView2,
        // Linux/WebKitGTK). The OS-level location switch still governs
        // the actual fix; macOS uses the native CoreLocation route.
        .on_permission_request(|_, kind| match kind {
            tauri::webview::PermissionKind::Geolocation => {
                tauri::webview::PermissionResponse::Allow
            }
            _ => tauri::webview::PermissionResponse::Default,
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            shell_info,
            print_page,
            native_locate
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
