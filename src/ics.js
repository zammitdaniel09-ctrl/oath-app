// iCalendar (RFC 5545) for the calendar feeds: unfolding and parsing content lines, VTIMEZONE and Windows
// time zone names, dates, durations, and RRULE, RDATE and EXDATE expansion into the occurrences inside a
// window. Pure: no database, no network.
import crypto from 'node:crypto';
import { DateTime, IANAZone, Zone } from 'luxon';
import { RuleError } from './engine.js';

const MAX_PER_EVENT = 400; // occurrences of one recurring event inside the window
const MAX_PER_FEED = 5000;
const MAX_PERIODS = 50000; // hard stop for RRULE iteration (COUNT rules walk from DTSTART)

export const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const unescapeText = (s) => String(s ?? '').replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

// Split a TEXT list on commas that are not escaped, then unescape each part.
function splitTextList(s) {
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i += 1;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => unescapeText(x).trim()).filter(Boolean);
}

// Calendar dates as day numbers (days since 1970-01-01), so RRULE arithmetic never trips over DST.
const DAY_MS = 86400000;
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
const ymd = (dn) => {
  const dt = new Date(dn * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
const isoWd = (dn) => ((new Date(dn * DAY_MS).getUTCDay() + 6) % 7) + 1; // 1 = Monday .. 7 = Sunday
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dnOf = (dt) => dayNum(dt.year, dt.month, dt.day);

// The n-th (or n-th from last, when negative) weekday of a month, as a day of the month.
function nthWeekday(y, m, n, wd) {
  const len = daysIn(y, m);
  if (n > 0) {
    const d = 1 + ((wd - isoWd(dayNum(y, m, 1)) + 7) % 7) + (n - 1) * 7;
    return d <= len ? d : null;
  }
  const d = len - ((isoWd(dayNum(y, m, len)) - wd + 7) % 7) + (n + 1) * 7;
  return d >= 1 ? d : null;
}

// ---------- Content lines ----------

// "NAME;PARAM=a;PARAM2="quoted:value":value" -> { name, params, value }
function parseLine(raw) {
  const parts = [];
  let cur = '';
  let inQuotes = false;
  let valueStart = -1;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (!inQuotes && ch === ';') {
      parts.push(cur);
      cur = '';
    } else if (!inQuotes && ch === ':') {
      parts.push(cur);
      valueStart = i + 1;
      break;
    } else cur += ch;
  }
  if (valueStart < 0) return null;
  const name = parts[0].trim().toUpperCase().replace(/^[^.]*\./, ''); // drop vCard-style group prefixes
  if (!name) return null;
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    let val = p.slice(eq + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[p.slice(0, eq).trim().toUpperCase()] = val;
  }
  return { name, params, value: raw.slice(valueStart) };
}

function notCalendarError(body) {
  if (/^\s*</.test(body)) {
    return new RuleError('That link opened a web page, not a calendar file. Copy the iCal (ICS) address instead.');
  }
  return new RuleError('That link did not return a calendar. Copy the iCal (ICS) address of the calendar.');
}

// Parse an iCalendar file (Buffer or string) into its components. Throws a RuleError when the
// content is not a calendar.
export function parseICS(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
  // Unfold on raw bytes before decoding, so a fold in the middle of a multi-byte UTF-8 character
  // (which some servers produce) still decodes cleanly.
  let body = Buffer.from(buf.toString('latin1').replace(/\r?\n[ \t]/g, ''), 'latin1').toString('utf8');
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
  if (!/^\s*BEGIN:VCALENDAR/i.test(body)) throw notCalendarError(body);

  const root = { name: 'ROOT', props: [], children: [] };
  const stack = [root];
  for (const raw of body.split(/\r?\n|\r/)) {
    if (!raw.trim()) continue;
    const line = parseLine(raw);
    if (!line) continue;
    if (line.name === 'BEGIN') {
      const comp = { name: line.value.trim().toUpperCase(), props: [], children: [] };
      stack[stack.length - 1].children.push(comp);
      stack.push(comp);
    } else if (line.name === 'END') {
      const name = line.value.trim().toUpperCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
    } else {
      stack[stack.length - 1].props.push(line);
    }
  }

  const cals = root.children.filter((c) => c.name === 'VCALENDAR');
  const calProp = (n) => cals.map((c) => c.props.find((p) => p.name === n)).find(Boolean);
  const timezones = new Map();
  const events = [];
  for (const c of cals) {
    for (const child of c.children) {
      if (child.name === 'VEVENT') events.push(child);
      if (child.name === 'VTIMEZONE') {
        const id = child.props.find((p) => p.name === 'TZID')?.value.trim();
        if (id) timezones.set(id, child);
      }
    }
  }
  return {
    name: text(unescapeText(calProp('X-WR-CALNAME')?.value), 80),
    prodid: calProp('PRODID')?.value || '',
    timezones,
    events,
  };
}

// ---------- Time zones ----------

// Windows time zone IDs (as Outlook and Exchange write them in TZID) to IANA, after the CLDR
// windowsZones table, plus a few older Exchange names.
export const WINDOWS_ZONES = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'UTC-11': 'Etc/GMT+11',
  'Aleutian Standard Time': 'America/Adak',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Marquesas Standard Time': 'Pacific/Marquesas',
  'Alaskan Standard Time': 'America/Anchorage',
  'UTC-09': 'Etc/GMT+9',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'UTC-08': 'Etc/GMT+8',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time (Mexico)': 'America/Mazatlan',
  'Mountain Standard Time': 'America/Denver',
  'Yukon Standard Time': 'America/Whitehorse',
  'Central America Standard Time': 'America/Guatemala',
  'Central Standard Time': 'America/Chicago',
  'Easter Island Standard Time': 'Pacific/Easter',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'SA Pacific Standard Time': 'America/Bogota',
  'Eastern Standard Time (Mexico)': 'America/Cancun',
  'Eastern Standard Time': 'America/New_York',
  'Haiti Standard Time': 'America/Port-au-Prince',
  'Cuba Standard Time': 'America/Havana',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'Turks And Caicos Standard Time': 'America/Grand_Turk',
  'Paraguay Standard Time': 'America/Asuncion',
  'Atlantic Standard Time': 'America/Halifax',
  'Venezuela Standard Time': 'America/Caracas',
  'Central Brazilian Standard Time': 'America/Cuiaba',
  'SA Western Standard Time': 'America/La_Paz',
  'Pacific SA Standard Time': 'America/Santiago',
  'Newfoundland Standard Time': 'America/St_Johns',
  'Tocantins Standard Time': 'America/Araguaina',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'SA Eastern Standard Time': 'America/Cayenne',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'Greenland Standard Time': 'America/Godthab',
  'Montevideo Standard Time': 'America/Montevideo',
  'Magallanes Standard Time': 'America/Punta_Arenas',
  'Saint Pierre Standard Time': 'America/Miquelon',
  'Bahia Standard Time': 'America/Bahia',
  'UTC-02': 'Etc/GMT+2',
  'Mid-Atlantic Standard Time': 'Etc/GMT+2',
  'Azores Standard Time': 'Atlantic/Azores',
  'Cape Verde Standard Time': 'Atlantic/Cape_Verde',
  UTC: 'Etc/UTC',
  'Coordinated Universal Time': 'Etc/UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'Sao Tome Standard Time': 'Africa/Sao_Tome',
  'Morocco Standard Time': 'Africa/Casablanca',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'Jordan Standard Time': 'Asia/Amman',
  'GTB Standard Time': 'Europe/Bucharest',
  'Middle East Standard Time': 'Asia/Beirut',
  'Egypt Standard Time': 'Africa/Cairo',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Syria Standard Time': 'Asia/Damascus',
  'West Bank Standard Time': 'Asia/Hebron',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'FLE Standard Time': 'Europe/Kiev',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Jerusalem Standard Time': 'Asia/Jerusalem',
  'South Sudan Standard Time': 'Africa/Juba',
  'Kaliningrad Standard Time': 'Europe/Kaliningrad',
  'Sudan Standard Time': 'Africa/Khartoum',
  'Libya Standard Time': 'Africa/Tripoli',
  'Namibia Standard Time': 'Africa/Windhoek',
  'Arabic Standard Time': 'Asia/Baghdad',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Arab Standard Time': 'Asia/Riyadh',
  'Belarus Standard Time': 'Europe/Minsk',
  'Russian Standard Time': 'Europe/Moscow',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Volgograd Standard Time': 'Europe/Volgograd',
  'Iran Standard Time': 'Asia/Tehran',
  'Arabian Standard Time': 'Asia/Dubai',
  'Astrakhan Standard Time': 'Europe/Astrakhan',
  'Azerbaijan Standard Time': 'Asia/Baku',
  'Russia Time Zone 3': 'Europe/Samara',
  'Mauritius Standard Time': 'Indian/Mauritius',
  'Saratov Standard Time': 'Europe/Saratov',
  'Georgian Standard Time': 'Asia/Tbilisi',
  'Caucasus Standard Time': 'Asia/Yerevan',
  'Armenian Standard Time': 'Asia/Yerevan',
  'Afghanistan Standard Time': 'Asia/Kabul',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
  'Pakistan Standard Time': 'Asia/Karachi',
  'Qyzylorda Standard Time': 'Asia/Qyzylorda',
  'India Standard Time': 'Asia/Kolkata',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Kathmandu',
  'Central Asia Standard Time': 'Asia/Almaty',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'Omsk Standard Time': 'Asia/Omsk',
  'Myanmar Standard Time': 'Asia/Yangon',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Altai Standard Time': 'Asia/Barnaul',
  'W. Mongolia Standard Time': 'Asia/Hovd',
  'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'N. Central Asia Standard Time': 'Asia/Novosibirsk',
  'Tomsk Standard Time': 'Asia/Tomsk',
  'China Standard Time': 'Asia/Shanghai',
  'North Asia East Standard Time': 'Asia/Irkutsk',
  'Singapore Standard Time': 'Asia/Singapore',
  'Malay Peninsula Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth',
  'Taipei Standard Time': 'Asia/Taipei',
  'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar',
  'Aus Central W. Standard Time': 'Australia/Eucla',
  'Transbaikal Standard Time': 'Asia/Chita',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'North Korea Standard Time': 'Asia/Pyongyang',
  'Korea Standard Time': 'Asia/Seoul',
  'Yakutsk Standard Time': 'Asia/Yakutsk',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'Tasmania Standard Time': 'Australia/Hobart',
  'Vladivostok Standard Time': 'Asia/Vladivostok',
  'Lord Howe Standard Time': 'Australia/Lord_Howe',
  'Bougainville Standard Time': 'Pacific/Bougainville',
  'Russia Time Zone 10': 'Asia/Srednekolymsk',
  'Magadan Standard Time': 'Asia/Magadan',
  'Norfolk Standard Time': 'Pacific/Norfolk',
  'Sakhalin Standard Time': 'Asia/Sakhalin',
  'Central Pacific Standard Time': 'Pacific/Guadalcanal',
  'Russia Time Zone 11': 'Asia/Kamchatka',
  'Kamchatka Standard Time': 'Asia/Kamchatka',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'UTC+12': 'Etc/GMT-12',
  'Fiji Standard Time': 'Pacific/Fiji',
  'Chatham Islands Standard Time': 'Pacific/Chatham',
  'UTC+13': 'Etc/GMT-13',
  'Tonga Standard Time': 'Pacific/Tongatapu',
  'Samoa Standard Time': 'Pacific/Apia',
  'Line Islands Standard Time': 'Pacific/Kiritimati',
};
const WINDOWS_LOWER = new Map(Object.entries(WINDOWS_ZONES).map(([k, z]) => [k.toLowerCase(), z]));

// Older Exchange exports name zones by their display text, e.g. "(UTC+01:00) Amsterdam, Berlin, ...".
const DISPLAY_CITIES = [
  ['Amsterdam', 'Europe/Berlin'], ['Belgrade', 'Europe/Budapest'], ['Brussels', 'Europe/Paris'],
  ['Sarajevo', 'Europe/Warsaw'], ['Dublin', 'Europe/London'], ['London', 'Europe/London'],
  ['Athens', 'Europe/Bucharest'], ['Helsinki', 'Europe/Kiev'], ['Istanbul', 'Europe/Istanbul'],
  ['Jerusalem', 'Asia/Jerusalem'], ['Cairo', 'Africa/Cairo'], ['Moscow', 'Europe/Moscow'],
  ['Abu Dhabi', 'Asia/Dubai'], ['Chennai', 'Asia/Kolkata'], ['Beijing', 'Asia/Shanghai'],
  ['Kuala Lumpur', 'Asia/Singapore'], ['Osaka', 'Asia/Tokyo'], ['Seoul', 'Asia/Seoul'],
  ['Canberra', 'Australia/Sydney'], ['Eastern Time', 'America/New_York'], ['Central Time', 'America/Chicago'],
  ['Mountain Time', 'America/Denver'], ['Pacific Time', 'America/Los_Angeles'], ['Arizona', 'America/Phoenix'],
  ['Atlantic Time', 'America/Halifax'], ['Hawaii', 'Pacific/Honolulu'], ['Alaska', 'America/Anchorage'],
  ['Coordinated Universal Time', 'Etc/UTC'], ['Reykjavik', 'Atlantic/Reykjavik'],
];

function parseParts(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/.exec(String(value || '').trim());
  return m ? { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) } : null;
}

function parseOffset(value) {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(String(value || '').trim());
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
}

function formatOffset(off, format) {
  const sign = off < 0 ? '-' : '+';
  const h = Math.floor(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  if (format === 'narrow') return `${sign}${h}${m ? `:${mm}` : ''}`;
  if (format === 'techie') return `${sign}${hh}${mm}`;
  return `${sign}${hh}:${mm}`;
}

// A zone defined only by the feed's own VTIMEZONE block (Outlook's "Customized Time Zone", for
// instance). Offsets come from its STANDARD and DAYLIGHT observances and their yearly rules.
class VTimezoneZone extends Zone {
  constructor(id, comp) {
    super();
    this.id = id;
    this.recurring = [];
    this.fixed = [];
    for (const sub of comp.children) {
      if (sub.name !== 'STANDARD' && sub.name !== 'DAYLIGHT') continue;
      const get = (n) => sub.props.find((p) => p.name === n)?.value;
      const to = parseOffset(get('TZOFFSETTO'));
      const from = parseOffset(get('TZOFFSETFROM')) ?? to;
      const st = parseParts(get('DTSTART'));
      if (to === null || !st) continue;
      const atUtc = (o) => Date.UTC(o.y, o.m - 1, o.d, o.h, o.mi, o.s) - from * 60000;
      const rr = get('RRULE');
      const rule = rr ? parseRRule(rr) : null;
      if (rule && rule.freq === 'YEARLY') {
        const u = parseParts(rule.until);
        this.recurring.push({ to, from, st, rule, untilMs: u ? Date.UTC(u.y, u.m - 1, u.d, u.h, u.mi, u.s) : null });
      } else {
        this.fixed.push({ at: atUtc(st), to });
      }
      for (const p of sub.props.filter((x) => x.name === 'RDATE')) {
        for (const val of p.value.split(',')) {
          const o = parseParts(val);
          if (o) this.fixed.push({ at: atUtc({ ...st, ...o, h: o.h, mi: o.mi, s: o.s }), to });
        }
      }
    }
    this.fixed.sort((a, b) => a.at - b.at);
    this.byYear = new Map();
  }

  get type() { return 'vtimezone'; }

  get name() { return this.id; }

  get isUniversal() { return false; }

  get isValid() { return this.recurring.length + this.fixed.length > 0; }

  offsetName() { return this.id; }

  formatOffset(tsMs, format) { return formatOffset(this.offset(tsMs), format); }

  equals(other) { return other === this; }

  transitions(year) {
    if (this.byYear.has(year)) return this.byYear.get(year);
    const list = [];
    for (const r of this.recurring) {
      if (r.st.y > year) continue;
      for (const m of r.rule.bymonth || [r.st.m]) {
        let d = null;
        const b = r.rule.byday?.[0];
        if (b && b.n) d = nthWeekday(year, m, b.n, b.wd);
        else if (b && r.rule.bymonthday) {
          d = r.rule.bymonthday.find((x) => x > 0 && x <= daysIn(year, m) && isoWd(dayNum(year, m, x)) === b.wd) ?? null;
        } else d = r.rule.bymonthday?.[0] ?? r.st.d;
        if (!d) continue;
        const at = Date.UTC(year, m - 1, d, r.st.h, r.st.mi, r.st.s) - r.from * 60000;
        if (r.untilMs !== null && at > r.untilMs) continue;
        list.push({ at, to: r.to });
      }
    }
    list.sort((a, b) => a.at - b.at);
    this.byYear.set(year, list);
    return list;
  }

  offset(tsMs) {
    const y = new Date(tsMs).getUTCFullYear();
    let cur = null;
    for (const t of [...this.fixed, ...this.transitions(y - 1), ...this.transitions(y)]) {
      if (t.at <= tsMs && (!cur || t.at >= cur.at)) cur = t;
    }
    if (cur) return cur.to;
    const first = this.recurring[0] || this.fixed[0];
    return first.from ?? first.to;
  }
}

function ianaFrom(id) {
  if (!id) return null;
  if (IANAZone.isValidZone(id)) return id;
  // Mozilla and Evolution style: "/mozilla.org/20050126_1/Europe/Malta"
  const segs = id.split('/').filter(Boolean);
  for (let n = Math.min(3, segs.length); n >= 2; n -= 1) {
    const c = segs.slice(-n).join('/');
    if (IANAZone.isValidZone(c)) return c;
  }
  return null;
}

// TZID -> a luxon zone: IANA, then Windows names, then Exchange display names, then the feed's own
// VTIMEZONE definition, and finally the user's time zone.
function makeZoneResolver(vtimezones, userZone) {
  const cache = new Map();
  return (rawId) => {
    const id = String(rawId || '').replace(/^"+|"+$/g, '').trim();
    if (cache.has(id)) return cache.get(id);
    let zone = ianaFrom(id) || WINDOWS_LOWER.get(id.toLowerCase()) || null;
    if (!zone && /^\((UTC|GMT)/i.test(id)) zone = DISPLAY_CITIES.find(([city]) => id.includes(city))?.[1] || null;
    if (!zone && vtimezones.has(id)) {
      const comp = vtimezones.get(id);
      zone = ianaFrom(comp.props.find((p) => p.name === 'X-LIC-LOCATION')?.value?.trim());
      if (!zone) {
        const custom = new VTimezoneZone(id, comp);
        if (custom.isValid) zone = custom;
      }
    }
    zone = zone || userZone;
    cache.set(id, zone);
    return zone;
  };
}

// ---------- Values ----------

const DT_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i;

// A DATE or DATE-TIME property value -> { dt, allDay }. All-day dates live at UTC midnight, so
// they keep their calendar date whatever the user's time zone.
function readDate(prop, zoneOf, userZone) {
  const m = DT_RE.exec(String(prop.value || '').trim());
  if (!m) return null;
  const isDate = !m[4] || String(prop.params.VALUE || '').toUpperCase() === 'DATE';
  if (isDate) {
    const dt = DateTime.fromObject({ year: +m[1], month: +m[2], day: +m[3] }, { zone: 'utc' });
    return dt.isValid ? { dt, allDay: true } : null;
  }
  const zone = m[7] ? 'utc' : prop.params.TZID ? zoneOf(prop.params.TZID) : userZone;
  const dt = DateTime.fromObject(
    { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: +(m[6] || 0) },
    { zone },
  );
  return dt.isValid ? { dt, allDay: false } : null;
}

function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(value || '').trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return {
    weeks: sign * +(m[2] || 0), days: sign * +(m[3] || 0),
    hours: sign * +(m[4] || 0), minutes: sign * +(m[5] || 0), seconds: sign * +(m[6] || 0),
  };
}

const WD = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };
const FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

function parseRRule(value) {
  const r = {};
  for (const part of String(value || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) r[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim();
  }
  const ints = (s) => s.split(',').map((x) => Number.parseInt(x, 10)).filter(Number.isFinite);
  const rule = {
    freq: (r.FREQ || '').toUpperCase(),
    interval: Math.max(1, Number.parseInt(r.INTERVAL || '1', 10) || 1),
    wkst: WD[(r.WKST || 'MO').toUpperCase()] || 1,
  };
  if (r.COUNT) rule.count = Math.max(1, Number.parseInt(r.COUNT, 10) || 1);
  if (r.UNTIL) rule.until = r.UNTIL;
  if (r.BYDAY) {
    const list = r.BYDAY.split(',').map((s) => {
      const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(s.trim());
      return m ? { n: m[1] ? Number.parseInt(m[1], 10) : 0, wd: WD[m[2].toUpperCase()] } : null;
    }).filter(Boolean);
    if (list.length) rule.byday = list;
  }
  if (r.BYMONTHDAY) {
    const list = ints(r.BYMONTHDAY).filter((n) => n && Math.abs(n) <= 31);
    if (list.length) rule.bymonthday = list;
  }
  if (r.BYMONTH) {
    const list = ints(r.BYMONTH).filter((n) => n >= 1 && n <= 12);
    if (list.length) rule.bymonth = list;
  }
  if (r.BYSETPOS) {
    const list = ints(r.BYSETPOS).filter((n) => n);
    if (list.length) rule.bysetpos = list;
  }
  return rule;
}

// ---------- RRULE expansion ----------

function applySetPos(rule, days) {
  if (!rule.bysetpos || !days.length) return days;
  const picked = rule.bysetpos.map((p) => (p > 0 ? days[p - 1] : days[days.length + p])).filter((x) => x !== undefined);
  return [...new Set(picked)].sort((a, b) => a - b);
}

function monthDays(rule, y, m, defaultDay) {
  const len = daysIn(y, m);
  let days = null;
  if (rule.bymonthday) days = rule.bymonthday.map((d) => (d > 0 ? d : len + d + 1)).filter((d) => d >= 1 && d <= len);
  if (rule.byday) {
    const fromByday = [];
    for (const { n, wd } of rule.byday) {
      if (n) {
        const d = nthWeekday(y, m, n, wd);
        if (d) fromByday.push(d);
      } else {
        for (let d = 1 + ((wd - isoWd(dayNum(y, m, 1)) + 7) % 7); d <= len; d += 7) fromByday.push(d);
      }
    }
    days = days ? days.filter((d) => fromByday.includes(d)) : fromByday;
  }
  if (!days) days = defaultDay <= len ? [defaultDay] : []; // e.g. the 31st skips short months
  return [...new Set(days)].sort((a, b) => a - b).map((d) => dayNum(y, m, d));
}

function yearDays(rule, y, s) {
  if (rule.byday && !rule.bymonth && !rule.bymonthday) {
    // e.g. 20MO: the 20th Monday of the year.
    const first = dayNum(y, 1, 1);
    const last = dayNum(y, 12, 31);
    const out = [];
    for (const { n, wd } of rule.byday) {
      if (n > 0) {
        const d = first + ((wd - isoWd(first) + 7) % 7) + (n - 1) * 7;
        if (d <= last) out.push(d);
      } else if (n < 0) {
        const d = last - ((isoWd(last) - wd + 7) % 7) + (n + 1) * 7;
        if (d >= first) out.push(d);
      } else {
        for (let d = first + ((wd - isoWd(first) + 7) % 7); d <= last; d += 7) out.push(d);
      }
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }
  const out = [];
  for (const m of [...(rule.bymonth || [s.m])].sort((a, b) => a - b)) out.push(...monthDays(rule, y, m, s.d));
  return out;
}

function dailyMatch(rule, dn) {
  const { y, m, d } = ymd(dn);
  if (rule.bymonth && !rule.bymonth.includes(m)) return false;
  if (rule.bymonthday && !rule.bymonthday.some((x) => (x > 0 ? x : daysIn(y, m) + x + 1) === d)) return false;
  if (rule.byday && !rule.byday.some((b) => b.wd === isoWd(dn))) return false;
  return true;
}

// Yields one period (day, week, month or year) at a time: { at: first day number, days: [...] }.
// skipDn fast-forwards close to the window when there is no COUNT to keep.
function* rulePeriods(rule, s, startDn, skipDn) {
  const { interval } = rule;
  if (rule.freq === 'DAILY') {
    let k = skipDn !== null ? Math.max(0, Math.floor((skipDn - startDn) / interval) - 1) : 0;
    for (;; k += 1) {
      const dn = startDn + k * interval;
      yield { at: dn, days: dailyMatch(rule, dn) ? [dn] : [] };
    }
  }
  if (rule.freq === 'WEEKLY') {
    const ws0 = startDn - ((isoWd(startDn) - rule.wkst + 7) % 7);
    const wds = rule.byday ? [...new Set(rule.byday.map((b) => b.wd))] : [isoWd(startDn)];
    const offsets = wds.map((wd) => (wd - rule.wkst + 7) % 7).sort((a, b) => a - b);
    let k = skipDn !== null ? Math.max(0, Math.floor((skipDn - ws0) / (7 * interval)) - 1) : 0;
    for (;; k += 1) {
      const ws = ws0 + k * 7 * interval;
      let days = offsets.map((o) => ws + o);
      if (rule.bymonth) days = days.filter((dn) => rule.bymonth.includes(ymd(dn).m));
      yield { at: ws, days: applySetPos(rule, days) };
    }
  }
  if (rule.freq === 'MONTHLY') {
    const m0 = s.y * 12 + (s.m - 1);
    let k = 0;
    if (skipDn !== null) {
      const p = ymd(skipDn);
      k = Math.max(0, Math.floor((p.y * 12 + (p.m - 1) - m0) / interval) - 1);
    }
    for (;; k += 1) {
      const mi = m0 + k * interval;
      const y = Math.floor(mi / 12);
      const m = (mi % 12) + 1;
      const days = rule.bymonth && !rule.bymonth.includes(m) ? [] : monthDays(rule, y, m, s.d);
      yield { at: dayNum(y, m, 1), days: applySetPos(rule, days) };
    }
  }
  if (rule.freq === 'YEARLY') {
    let k = skipDn !== null ? Math.max(0, Math.floor((ymd(skipDn).y - s.y) / interval) - 1) : 0;
    for (;; k += 1) {
      const y = s.y + k * interval;
      yield { at: dayNum(y, 1, 1), days: applySetPos(rule, yearDays(rule, y, s)) };
    }
  }
}

// Occurrence starts of one event (series master) that can touch [from, to).
function expandEvent(ev, from, to) {
  const zone = ev.start.zone;
  const s = { y: ev.start.year, m: ev.start.month, d: ev.start.day };
  const startDn = dayNum(s.y, s.m, s.d);
  const startMs = ev.start.toMillis();
  const fromMs = from.toMillis();
  const toMs = to.toMillis();
  const span = ev.allDay ? ev.durDays * DAY_MS : ev.durMs;
  const out = [];
  const seen = new Set();
  const excluded = (dt) => ev.exMs.has(dt.toMillis()) || ev.exDays.has(dnOf(dt));
  const add = (dt) => {
    const ms = dt.toMillis();
    if (seen.has(ms)) return;
    seen.add(ms);
    if (!excluded(dt)) out.push(dt);
  };
  add(ev.start); // DTSTART is always the first occurrence
  for (const r of ev.rdates) add(r);

  const rule = ev.rrule;
  if (!rule || !FREQS.has(rule.freq) || rule.count === 1) return out;
  const at = (dn) => {
    const p = ymd(dn);
    return DateTime.fromObject(
      { year: p.y, month: p.m, day: p.d, hour: ev.start.hour, minute: ev.start.minute, second: ev.start.second },
      { zone },
    );
  };
  const skipDn = rule.count ? null : dnOf(DateTime.fromMillis(fromMs - span - DAY_MS, { zone }));
  const toDn = dnOf(DateTime.fromMillis(toMs, { zone }));
  let emitted = 1;
  let inWindow = 0;
  let periods = 0;
  outer: for (const p of rulePeriods(rule, s, startDn, skipDn)) {
    if (p.at > toDn || (periods += 1) > MAX_PERIODS) break;
    for (const dn of p.days) {
      if (dn < startDn) continue;
      const dt = at(dn);
      const ms = dt.toMillis();
      if (ms <= startMs) continue;
      if (ev.untilMs !== null && ms > ev.untilMs) break outer;
      if (ms >= toMs) break outer;
      emitted += 1; // COUNT counts occurrences before EXDATE removes any
      if (ms + span >= fromMs) {
        add(dt);
        inWindow += 1;
        if (inWindow >= MAX_PER_EVENT) break outer;
      }
      if (rule.count && emitted >= rule.count) break outer;
    }
  }
  return out;
}

function readEvent(comp, zoneOf, userZone) {
  const one = (n) => comp.props.find((p) => p.name === n);
  const all = (n) => comp.props.filter((p) => p.name === n);
  const ds = one('DTSTART');
  const start = ds && readDate(ds, zoneOf, userZone);
  if (!start) return null;
  const { allDay } = start;

  let end = null;
  let hasEnd = false;
  const de = one('DTEND');
  const du = one('DURATION');
  if (de) end = readDate(de, zoneOf, userZone)?.dt || null;
  else if (du) {
    const d = parseDuration(du.value);
    if (d) end = start.dt.plus(d);
  }
  if (end) hasEnd = true;
  if (allDay) {
    if (end) end = DateTime.utc(end.year, end.month, end.day);
    if (!end || end <= start.dt) end = start.dt.plus({ days: 1 });
  } else if (!end || end < start.dt) end = start.dt;

  const rr = one('RRULE');
  const rrule = rr ? parseRRule(rr.value) : null;
  let untilMs = null;
  if (rrule?.until) {
    const m = DT_RE.exec(rrule.until);
    if (m) {
      const parts = { year: +m[1], month: +m[2], day: +m[3] };
      if (!m[4]) {
        untilMs = allDay ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : DateTime.fromObject(parts, { zone: start.dt.zone }).endOf('day').toMillis();
      } else {
        const t = { ...parts, hour: +m[4], minute: +m[5], second: +(m[6] || 0) };
        untilMs = DateTime.fromObject(t, { zone: m[7] ? 'utc' : start.dt.zone }).toMillis();
      }
    }
  }

  const exMs = new Set();
  const exDays = new Set();
  for (const p of all('EXDATE')) {
    for (const val of p.value.split(',')) {
      const r = readDate({ params: p.params, value: val }, zoneOf, userZone);
      if (!r) continue;
      if (r.allDay) exDays.add(dnOf(r.dt));
      else {
        exMs.add(r.dt.toMillis());
        if (allDay) exDays.add(dnOf(r.dt));
      }
    }
  }
  const rdates = [];
  for (const p of all('RDATE')) {
    if (String(p.params.VALUE || '').toUpperCase() === 'PERIOD') continue;
    for (const val of p.value.split(',')) {
      const r = readDate({ params: p.params, value: val.split('/')[0] }, zoneOf, userZone);
      if (r) rdates.push(allDay ? DateTime.utc(r.dt.year, r.dt.month, r.dt.day) : r.dt);
    }
  }

  let recur = null;
  const rid = one('RECURRENCE-ID');
  if (rid) {
    const r = readDate(rid, zoneOf, userZone);
    if (r) recur = { ms: r.dt.toMillis(), dn: dnOf(r.dt), dateOnly: r.allDay, iso: r.dt.toUTC().toISO() };
  }

  const summary = unescapeText(one('SUMMARY')?.value).replace(/\s+/g, ' ').trim().slice(0, 300);
  let uid = String(one('UID')?.value || '').trim().slice(0, 300);
  if (!uid) uid = `nouid-${crypto.createHash('sha1').update(`${ds.value}|${summary}`).digest('hex').slice(0, 16)}`;
  const transp = String(one('TRANSP')?.value || '').trim().toUpperCase();
  const msBusy = String(one('X-MICROSOFT-CDO-BUSYSTATUS')?.value || '').trim().toUpperCase();

  return {
    uid,
    allDay,
    start: start.dt,
    end,
    hasEnd,
    durMs: end.toMillis() - start.dt.toMillis(),
    durDays: allDay ? Math.max(1, Math.round((end.toMillis() - start.dt.toMillis()) / DAY_MS)) : 0,
    rrule,
    untilMs,
    exMs,
    exDays,
    rdates,
    recur,
    cancelled: String(one('STATUS')?.value || '').trim().toUpperCase() === 'CANCELLED',
    busy: transp !== 'TRANSPARENT' && msBusy !== 'FREE',
    title: summary,
    location: unescapeText(one('LOCATION')?.value).replace(/\s+/g, ' ').trim().slice(0, 300),
    description: unescapeText(one('DESCRIPTION')?.value).trim().slice(0, 2000),
    categories: all('CATEGORIES').flatMap((p) => splitTextList(p.value)),
    sequence: Number.parseInt(one('SEQUENCE')?.value, 10) || 0,
  };
}

function occurrence(ev, startDt, { recurring, origStart, master = null }) {
  let end;
  if (ev.allDay) end = startDt.plus({ days: ev.durDays });
  else end = DateTime.fromMillis(startDt.toMillis() + ev.durMs, { zone: startDt.zone });
  return {
    uid: ev.uid,
    start: startDt,
    end,
    allDay: ev.allDay,
    title: ev.title || master?.title || '',
    location: ev.location || master?.location || '',
    description: ev.description || master?.description || '',
    categories: ev.categories.length ? ev.categories : master?.categories || [],
    busy: ev.busy,
    recurring,
    origStart,
  };
}

function fromOverride(ov, master) {
  // An override without its own end keeps the series' length.
  const base = !ov.hasEnd && master && master.allDay === ov.allDay ? { ...ov, durMs: master.durMs, durDays: master.durDays } : ov;
  return occurrence(base, ov.start, { recurring: true, origStart: ov.recur.iso, master });
}

// Every occurrence of every event in the calendar that touches [from, to), sorted by start.
// Each has { uid, start, end (luxon), allDay, title, location, description, categories, busy,
// recurring, origStart (ISO of the occurrence's original start, stable across moves of one
// occurrence of a series) }.
export function expandCalendar(cal, { zone, from, to }) {
  const zoneOf = makeZoneResolver(cal.timezones, zone);
  const masters = new Map();
  const overrides = new Map();
  for (const comp of cal.events) {
    let ev = null;
    try {
      ev = readEvent(comp, zoneOf, zone);
    } catch {
      ev = null; // one malformed event never sinks the whole feed
    }
    if (!ev) continue;
    if (ev.recur) {
      if (!overrides.has(ev.uid)) overrides.set(ev.uid, new Map());
      const key = ev.recur.dateOnly ? `d${ev.recur.dn}` : `t${ev.recur.ms}`;
      const prev = overrides.get(ev.uid).get(key);
      if (!prev || ev.sequence >= prev.sequence) overrides.get(ev.uid).set(key, ev);
    } else {
      const prev = masters.get(ev.uid);
      if (!prev || ev.sequence >= prev.sequence) masters.set(ev.uid, ev);
    }
  }

  const fromMs = from.toMillis();
  const toMs = to.toMillis();
  const out = [];
  const keep = (o) => {
    const s = o.start.toMillis();
    const e = o.end.toMillis();
    if (s < toMs && (e > fromMs || s >= fromMs)) out.push(o);
  };
  for (const [uid, ev] of masters) {
    const ovs = overrides.get(uid) || new Map();
    overrides.delete(uid);
    if (ev.cancelled) continue;
    const recurring = Boolean(ev.rrule || ev.rdates.length || ovs.size);
    const used = new Set();
    for (const dt of expandEvent(ev, from, to)) {
      const tKey = `t${dt.toMillis()}`;
      const dKey = `d${dnOf(dt)}`;
      const key = ovs.has(tKey) ? tKey : ovs.has(dKey) ? dKey : null;
      if (key) {
        used.add(key);
        if (!ovs.get(key).cancelled) keep(fromOverride(ovs.get(key), ev));
      } else {
        keep(occurrence(ev, dt, { recurring, origStart: dt.toUTC().toISO() }));
      }
    }
    // Occurrences moved into the window from outside it.
    for (const [key, ov] of ovs) if (!used.has(key) && !ov.cancelled) keep(fromOverride(ov, ev));
  }
  // Overrides whose series is missing from the feed still stand on their own.
  for (const ovs of overrides.values()) for (const ov of ovs.values()) if (!ov.cancelled) keep(fromOverride(ov, null));
  out.sort((a, b) => a.start.toMillis() - b.start.toMillis() || a.title.localeCompare(b.title));
  return out.slice(0, MAX_PER_FEED);
}
