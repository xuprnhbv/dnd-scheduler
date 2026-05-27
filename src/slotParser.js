'use strict';

// Maps Hebrew day name → English lowercase key matching DAY_OFFSETS in sessionTime.js.
const HEBREW_DAYS = {
  'ראשון': 'sunday',
  'שני': 'monday',
  'שלישי': 'tuesday',
  'רביעי': 'wednesday',
  'חמישי': 'thursday',
  'שישי': 'friday',
  'שבת': 'saturday',
};

const DEFAULT_TIME_KEYWORDS = {
  'בוקר': '10:00',
  'צהריים': '13:00',
  'ערב': '20:00',
};

// Parse a slot label formatted as "<day> <time-keyword>" (Hebrew). Optional
// leading "יום " prefix is stripped. Returns { dayOfWeek, time } where dayOfWeek
// is the lowercase English name and time is "HH:mm". Returns null if the label
// doesn't match the expected shape — caller treats null as "unparsed".
//
// timeKeywords overrides the default { בוקר: '10:00', צהריים: '13:00', ערב: '20:00' }
// map; pass an empty object to disable keyword resolution.
function parseSlotLabel(label, timeKeywords) {
  if (typeof label !== 'string') return null;
  const keywords = (timeKeywords && typeof timeKeywords === 'object' && Object.keys(timeKeywords).length)
    ? timeKeywords
    : DEFAULT_TIME_KEYWORDS;

  let normalized = label.trim().replace(/\s+/g, ' ');
  if (normalized.startsWith('יום ')) normalized = normalized.slice(4).trim();

  const parts = normalized.split(' ');
  if (parts.length !== 2) return null;

  const [dayWord, timeWord] = parts;
  const dayOfWeek = HEBREW_DAYS[dayWord];
  if (!dayOfWeek) return null;

  const time = keywords[timeWord];
  if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return null;

  return { dayOfWeek, time };
}

module.exports = { parseSlotLabel, DEFAULT_TIME_KEYWORDS, HEBREW_DAYS };
