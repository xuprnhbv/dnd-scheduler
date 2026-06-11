'use strict';

/**
 * Schema metadata for every config.json field.
 *
 * type values:
 *   string      — <input type="text">
 *   number      — <input type="number">
 *   url         — <input type="url">
 *   password    — <input type="password"> with show-toggle; value preserved opaquely on save
 *   checkbox    — <input type="checkbox">; stored as a boolean
 *   textarea    — <textarea>
 *   slotMap     — { questionId: slotLabel } table (2-col repeating rows)
 *   slotTimesMap— { slotLabel: { dayOfWeek, time } } table (3-col repeating rows)
 *
 * special flags:
 *   optional: true  — whole top-level block is optional; fields only validated when any sibling is non-empty
 *   omitOnSave: true — field is never written back (handled by dedicated sub-form)
 */

const SCHEMA = [
  // ── Bot ─────────────────────────────────────────────────────────────────────
  {
    path: 'timezone',
    section: 'bot',
    label: 'Timezone',
    help: 'IANA timezone name, e.g. "Asia/Jerusalem" or "Europe/London".',
    type: 'string',
    required: true,
    placeholder: 'Asia/Jerusalem',
  },
  {
    path: 'groupId',
    section: 'bot',
    label: 'WhatsApp Group ID',
    help: 'The @g.us ID of your D&D WhatsApp group. Start the bot without this set and it will log the ID when any message arrives.',
    type: 'string',
    required: true,
    placeholder: '1234567890-1234567890@g.us',
  },
  {
    path: 'playerCount',
    section: 'bot',
    label: 'Player count',
    help: 'Number of players (excluding DM). Used to show "X / Y filled" in the admin panel.',
    type: 'number',
    required: true,
    placeholder: '5',
  },

  // ── Google Form ──────────────────────────────────────────────────────────────
  {
    path: 'googleForm.formId',
    section: 'googleForm',
    label: 'Form ID',
    help: 'The ID in the form edit URL: /forms/d/<formId>/edit',
    type: 'string',
    required: true,
    placeholder: '1XdA7YL6TEPM7Rbj…',
  },
  {
    path: 'googleForm.publicUrl',
    section: 'googleForm',
    label: 'Public URL',
    help: 'The link posted to the WhatsApp group. Use the "Send" link, not the edit URL.',
    type: 'url',
    required: true,
    placeholder: 'https://docs.google.com/forms/d/e/…/viewform',
  },
  {
    path: 'googleForm.serviceAccountKeyPath',
    section: 'googleForm',
    label: 'Service account key path',
    help: 'Path to the Google service-account JSON file (relative to the bot directory or absolute).',
    type: 'string',
    required: true,
    placeholder: './service-account.json',
  },
  {
    path: 'googleForm.unavailableAnswer',
    section: 'googleForm',
    label: '"Cannot play" answer text',
    help: 'Exact text of the "I cannot play this week" option in the form. Must match the form exactly.',
    type: 'string',
    required: true,
    placeholder: 'לא יכול/ה',
  },
  {
    path: 'googleForm.maybeAnswer',
    section: 'googleForm',
    label: '"Might come" answer text',
    help: 'Exact text of the "might come" option in the form. Used as a secondary tiebreaker before sending a WhatsApp poll. Leave blank if your form has no such option.',
    type: 'string',
    required: false,
    placeholder: 'אולי',
  },
  {
    path: 'googleForm.deleteWebhookUrl',
    section: 'googleForm',
    label: 'Delete-webhook URL',
    help: 'Apps Script web app URL that deletes a form response. Leave blank to disable auto-delete.',
    type: 'url',
    required: false,
    placeholder: 'https://script.google.com/macros/s/…/exec',
  },
  {
    path: 'googleForm.deleteWebhookSecret',
    section: 'googleForm',
    label: 'Delete-webhook secret',
    help: 'Shared secret sent with delete requests. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    type: 'password',
    required: false,
    placeholder: '(random hex string)',
  },
  {
    path: 'googleForm.playerSlotItemId',
    section: 'googleForm',
    label: 'Player slot grid item ID',
    help: 'Item ID of the player-availability grid question in Google Forms. When set, the bot auto-discovers grid rows on every run — no per-row mapping needed. Find it via the Forms API or the form\'s JSON export (items[].itemId).',
    type: 'string',
    required: false,
    placeholder: '12345678',
  },
  {
    path: 'googleForm.dmSlotItemId',
    section: 'googleForm',
    label: 'DM slot grid item ID',
    help: 'Item ID of the DM-availability grid question. Same as above but for the DM\'s grid.',
    type: 'string',
    required: false,
    placeholder: '87654321',
  },
  {
    path: 'googleForm.attendanceItemId',
    section: 'googleForm',
    label: 'Attendance question item ID',
    help: 'Item ID of the "can I meet this week?" yes/no question. When set, the reminder counts everyone who answered it (yes or no), not just those who filled the availability grid. Leave empty to count grid responses only.',
    type: 'string',
    required: false,
    placeholder: '24681012',
  },
  {
    path: 'googleForm.playerSlotQuestions',
    section: 'googleForm',
    label: 'Player slot questions (legacy)',
    help: 'Legacy: maps each form question ID to its slot label. Only used when playerSlotItemId is not set.',
    type: 'slotMap',
    required: false,
    keyHeader: 'Question ID',
    valueHeader: 'Slot label',
    keyPlaceholder: '12345678',
    valuePlaceholder: 'שלישי ערב',
  },
  {
    path: 'googleForm.dmSlotQuestions',
    section: 'googleForm',
    label: 'DM slot questions (legacy)',
    help: 'Legacy: same mapping but for the DM\'s availability question. Only used when dmSlotItemId is not set.',
    type: 'slotMap',
    required: false,
    keyHeader: 'Question ID',
    valueHeader: 'Slot label',
    keyPlaceholder: '87654321',
    valuePlaceholder: 'שלישי ערב',
  },

  // ── Session times (used to build the WhatsApp Event message) ───────────────
  {
    path: 'sessionTimes.eventDurationHours',
    section: 'sessionTimes',
    label: 'Session duration (hours)',
    help: 'How long the WhatsApp Event spans when announcing the winning slot. Defaults to 5.',
    type: 'number',
    required: false,
    optional: true,
    placeholder: '5',
  },
  {
    path: 'sessionTimes.slotTimeKeywords',
    section: 'sessionTimes',
    label: 'Slot time keywords',
    help: 'Maps each Hebrew time-of-day keyword to its HH:mm start time. Used by the auto-parser to resolve slot labels like "שלישי ערב". Defaults to בוקר=10:00 / צהריים=13:00 / ערב=20:00 if left empty.',
    type: 'slotMap',
    required: false,
    optional: true,
    keyHeader: 'Keyword',
    valueHeader: 'Time (HH:mm)',
    keyPlaceholder: 'ערב',
    valuePlaceholder: '20:00',
  },
  {
    path: 'sessionTimes.slotTimes',
    section: 'sessionTimes',
    label: 'Slot time overrides',
    help: 'Optional overrides per slot label. Hebrew "<day> <time-keyword>" labels are derived automatically via Slot time keywords; add entries here for non-conforming labels or one-off overrides (e.g. "שבת ערב" → saturday / 18:00).',
    type: 'slotTimesMap',
    required: false,
    optional: true,
    keyPlaceholder: 'שבת ערב',
  },

  // ── Notifications ──────────────────────────────────────────────────────────
  {
    path: 'notifications.ntfy.enabled',
    section: 'notifications',
    label: 'Enable push notifications',
    help: 'Master switch for ntfy push notifications (alerts you when the WhatsApp session needs re-linking). Use the Register button on the dashboard for first-time setup.',
    type: 'checkbox',
    required: false,
    default: false,
  },
  {
    path: 'notifications.ntfy.server',
    section: 'notifications',
    label: 'ntfy server',
    help: 'Base URL of the ntfy server. Defaults to the public https://ntfy.sh.',
    type: 'url',
    required: false,
    placeholder: 'https://ntfy.sh',
  },
  {
    path: 'notifications.ntfy.topic',
    section: 'notifications',
    label: 'ntfy topic',
    help: 'Secret topic to publish to. Subscribe to this exact topic in the ntfy phone app. Anyone who knows it can read your alerts, so keep it secret — the Register button generates a long random one.',
    type: 'string',
    required: false,
    placeholder: 'dnd-bot-xxxxxxxx',
  },
  {
    path: 'notifications.ntfy.authToken',
    section: 'notifications',
    label: 'ntfy auth token',
    help: 'Optional bearer token for protected or self-hosted ntfy servers. Leave blank for the public server.',
    type: 'password',
    required: false,
    omitOnSave: false,
  },

  // ── Admin panel ──────────────────────────────────────────────────────────────
  {
    path: 'adminPanel.port',
    section: 'adminPanel',
    label: 'Port',
    help: 'HTTP port the admin panel listens on. Default: 3000.',
    type: 'number',
    required: false,
    placeholder: '3000',
  },
  {
    path: 'adminPanel.tls.enabled',
    section: 'adminPanel',
    label: 'Serve over HTTPS',
    help: 'Serve the admin panel over HTTPS with a self-signed certificate (auto-generated on first run). Disable only if a reverse proxy terminates TLS in front of the bot.',
    type: 'checkbox',
    required: false,
    default: true,
  },
  {
    path: 'adminPanel.tls.certPath',
    section: 'adminPanel',
    label: 'TLS certificate path',
    help: 'TLS certificate file (PEM). Auto-generated self-signed if missing. Drop your own cert here to override. Default: .tls/cert.pem',
    type: 'string',
    required: false,
    placeholder: '.tls/cert.pem',
  },
  {
    path: 'adminPanel.tls.keyPath',
    section: 'adminPanel',
    label: 'TLS private key path',
    help: 'TLS private key file (PEM). Auto-generated alongside the cert if missing. Default: .tls/key.pem',
    type: 'string',
    required: false,
    placeholder: '.tls/key.pem',
  },
  // passwordHash and sessionSecret are handled by dedicated sub-forms — not rendered as regular fields
  {
    path: 'adminPanel.passwordHash',
    section: 'adminPanel',
    label: 'Password hash',
    help: 'bcrypt hash of the admin password. Use the change-password form below instead of editing this directly.',
    type: 'password',
    required: true,
    omitOnSave: false, // written back as-is unless the change-password sub-form ran
  },
  {
    path: 'adminPanel.sessionSecret',
    section: 'adminPanel',
    label: 'Session secret',
    help: 'Secret used to sign session cookies. Changing this logs everyone out.',
    type: 'password',
    required: true,
    omitOnSave: false,
  },

  // ── Messages ─────────────────────────────────────────────────────────────────
  {
    path: 'messages.formAnnouncement',
    section: 'messages',
    label: 'Form announcement',
    help: 'Sent to the group when the form opens. Placeholders: {weekStart} {formUrl}',
    type: 'textarea',
    required: true,
  },
  {
    path: 'messages.reminder',
    section: 'messages',
    label: 'Reminder',
    help: 'Sent mid-week if not everyone has filled the form. Placeholders: {filledCount} {playerCount} {formUrl}',
    type: 'textarea',
    required: true,
  },
  {
    path: 'messages.winner',
    section: 'messages',
    label: 'Winner announcement',
    help: 'Sent when a session slot is decided. Placeholders: {slot}',
    type: 'textarea',
    required: true,
  },
  {
    path: 'messages.tiebreakerIntro',
    section: 'messages',
    label: 'Tiebreaker intro',
    help: 'Sent when opening a tiebreaker poll. Placeholders: {slots}',
    type: 'textarea',
    required: true,
  },
  {
    path: 'messages.tiebreakerWinner',
    section: 'messages',
    label: 'Tiebreaker winner',
    help: 'Sent when the tiebreaker is resolved. Placeholders: {slot}',
    type: 'textarea',
    required: true,
  },
  {
    path: 'messages.noResponses',
    section: 'messages',
    label: 'No responses',
    help: 'Sent when nobody fills the form by the deadline.',
    type: 'textarea',
    required: true,
  },
  {
    path: 'messages.dmUnavailable',
    section: 'messages',
    label: 'DM unavailable',
    help: 'Sent when the DM has no available slots.',
    type: 'textarea',
    required: true,
  },
  {
    path: 'messages.dmNoResponse',
    section: 'messages',
    label: 'DM no response',
    help: 'Sent when the DM has not filled the form yet at announcement time.',
    type: 'textarea',
    required: true,
  },
];

/** All unique section keys in display order. */
const SECTIONS = [...new Set(SCHEMA.map((f) => f.section))];

/** Human-readable title for each section card. */
const SECTION_TITLES = {
  bot: 'Bot',
  googleForm: 'Google Form',
  sessionTimes: 'Session times (optional)',
  notifications: 'Notifications',
  adminPanel: 'Admin panel',
  messages: 'Messages',
};

module.exports = { SCHEMA, SECTIONS, SECTION_TITLES };
