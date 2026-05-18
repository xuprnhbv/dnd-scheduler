'use strict';

/**
 * Schema metadata for every config.json field.
 *
 * type values:
 *   string      — <input type="text">
 *   number      — <input type="number">
 *   url         — <input type="url">
 *   password    — <input type="password"> with show-toggle; value preserved opaquely on save
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

  // ── Google Calendar (optional block) ────────────────────────────────────────
  {
    path: 'googleCalendar.calendarId',
    section: 'googleCalendar',
    label: 'Calendar ID',
    help: 'Google Calendar ID (usually an email address). Share the calendar with the service account first.',
    type: 'string',
    required: false,
    optional: true,
    placeholder: 'your-calendar-id@group.calendar.google.com',
  },
  {
    path: 'googleCalendar.serviceAccountKeyPath',
    section: 'googleCalendar',
    label: 'Service account key path',
    help: 'Path to the service-account JSON file. Can be the same file as the form integration.',
    type: 'string',
    required: false,
    optional: true,
    placeholder: './service-account.json',
  },
  {
    path: 'googleCalendar.eventTitle',
    section: 'googleCalendar',
    label: 'Event title',
    help: 'Title of the calendar event created when a session is announced.',
    type: 'string',
    required: false,
    optional: true,
    placeholder: 'D&D Session',
  },
  {
    path: 'googleCalendar.eventDurationHours',
    section: 'googleCalendar',
    label: 'Event duration (hours)',
    help: 'How many hours the calendar event spans.',
    type: 'number',
    required: false,
    optional: true,
    placeholder: '5',
  },
  {
    path: 'googleCalendar.slotTimeKeywords',
    section: 'googleCalendar',
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
    path: 'googleCalendar.slotTimes',
    section: 'googleCalendar',
    label: 'Slot time overrides',
    help: 'Optional overrides per slot label. Hebrew "<day> <time-keyword>" labels are derived automatically via Slot time keywords; add entries here for non-conforming labels or one-off overrides (e.g. "שבת ערב" → saturday / 18:00).',
    type: 'slotTimesMap',
    required: false,
    optional: true,
    keyPlaceholder: 'שבת ערב',
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
    help: 'Sent when a session slot is decided. Placeholders: {slot} — optionally add {calendarLink} for the Google Calendar link.',
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
    help: 'Sent when the tiebreaker is resolved. Placeholders: {slot} — optionally add {calendarLink}.',
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
  {
    path: 'messages.unparsedWinner',
    section: 'messages',
    label: 'Unparsed slot warning',
    help: 'Sent after the winner/tiebreaker message when the winning slot label has no slotTimes entry and could not be auto-parsed. Placeholders: {slot}',
    type: 'textarea',
    required: false,
  },
];

/** All unique section keys in display order. */
const SECTIONS = [...new Set(SCHEMA.map((f) => f.section))];

/** Human-readable title for each section card. */
const SECTION_TITLES = {
  bot: 'Bot',
  googleForm: 'Google Form',
  googleCalendar: 'Google Calendar (optional)',
  adminPanel: 'Admin panel',
  messages: 'Messages',
};

module.exports = { SCHEMA, SECTIONS, SECTION_TITLES };
