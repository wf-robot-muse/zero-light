package com.wf.robot.muse.zerolight.zlshare

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class ShareArgs {
    var path: String = ""
    var mime: String = "application/octet-stream"
}

// Item #62: hand one of the app's own files to the Android share
// sheet. The file is referenced through the app's FileProvider (the
// provider the Tauri template already declares in the app manifest),
// and the intent carries FLAG_GRANT_READ_URI_PERMISSION — without it
// the receiving app gets a content URI it is not allowed to open.
@TauriPlugin
class ZlSharePlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun shareFile(invoke: Invoke) {
        val args = invoke.parseArgs(ShareArgs::class.java)
        val context = activity.applicationContext
        val file = File(args.path)
        if (!file.exists()) {
            invoke.reject("File to share does not exist: ${args.path}")
            return
        }
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file
        )
        val send = Intent(Intent.ACTION_SEND).apply {
            type = args.mime
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newRawUri("", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(send, null).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            if (activity !== context) {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        }
        context.startActivity(chooser)
        invoke.resolve()
    }
}
