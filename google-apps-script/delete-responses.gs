// Apps Script bound to the D&D scheduling Google Form.
//
// Setup:
//   1. Open the form in Google Forms.
//   2. Menu: More (⋮) → Script editor.
//   3. Paste this file's contents into Code.gs (replace the default).
//   4. Set SHARED_SECRET below to a long random string; also put the same
//      value in config.googleForm.deleteWebhookSecret.
//   5. Deploy → New deployment → type "Web app"
//        - Execute as: Me (your Google account; must own / edit the form)
//        - Who has access: Anyone
//      Copy the deployment URL into config.googleForm.deleteWebhookUrl.
//
// The bot POSTs { secret } to this URL after announcing the week's winner,
// and this clears all responses so the next Sunday starts clean.

var SHARED_SECRET = 'REPLACE_WITH_LONG_RANDOM_STRING';

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json({ ok: false, error: 'bad-json' }, 400);
  }
  if (!body.secret || body.secret !== SHARED_SECRET) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  try {
    FormApp.getActiveForm().deleteAllResponses();
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
}

function json(obj, _status) {
  // Apps Script web apps can't set arbitrary HTTP status codes, but returning
  // JSON with { ok: false } is enough for the bot to log and move on.
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
