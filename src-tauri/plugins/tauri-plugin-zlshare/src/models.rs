use serde::{Deserialize, Serialize};

/// What the frontend hands over: an absolute path to a file inside the
/// app's own folders, plus the MIME type the receiving apps should be
/// told about ("text/calendar" for .ics, "image/png" for badges,
/// "application/pdf" for print PDFs).
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareRequest {
    pub path: String,
    pub mime: String,
}
