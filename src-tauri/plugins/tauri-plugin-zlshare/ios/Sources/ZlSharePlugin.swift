import SwiftRs
import Tauri
import UIKit

class ZlShareArgs: Decodable {
    let path: String
    let mime: String?
}

// Item #62: hand one of the app's own files to the iOS share sheet.
// The path comes from the app's cache folder (written by the frontend
// through the fs plugin), so it is already an absolute path inside the
// app sandbox — no path rewriting is needed.
class ZlSharePlugin: Plugin {
    @objc public func shareFile(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ZlShareArgs.self)
        let url = URL(fileURLWithPath: args.path)
        guard FileManager.default.fileExists(atPath: url.path) else {
            invoke.reject("File to share does not exist: \(args.path)")
            return
        }
        DispatchQueue.main.async {
            let activityVC = UIActivityViewController(
                activityItems: [url],
                applicationActivities: nil
            )
            if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
               let rootVC = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController {
                // iPad presents the sheet as a popover and requires an
                // anchor; a zero-size rect at the center satisfies it.
                if let pop = activityVC.popoverPresentationController {
                    pop.sourceView = rootVC.view
                    pop.sourceRect = CGRect(
                        x: rootVC.view.bounds.midX,
                        y: rootVC.view.bounds.midY,
                        width: 0,
                        height: 0
                    )
                    pop.permittedArrowDirections = []
                }
                rootVC.present(activityVC, animated: true, completion: nil)
            }
        }
        invoke.resolve()
    }
}

@_cdecl("init_plugin_zlshare")
func initPlugin() -> Plugin {
    return ZlSharePlugin()
}
