// Plain-language capture: "call the bank friday 3pm #ea ~20m" becomes a dated task.
// Shared by the app (live preview) and the server (quick add and Siri).

const DAYS = {
  monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6, sunday: 7, sun: 7,
};
const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

const pad = (n) => String(n).padStart(2, '0');
const toDate = (iso) => new Date(`${iso}T12:00:00Z`);
const toIso = (d) => d.toISOString().slice(0, 10);
const add = (iso, n) => {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
};
const isoWeekday = (iso) => ((toDate(iso).getUTCDay() + 6) % 7) + 1;
const validDay = (y, m, d) => {
  const x = new Date(Date.UTC(y, m - 1, d, 12));
  return x.getUTCMonth() === m - 1 && x.getUTCDate() === d;
};

const DAY_WORDS = Object.keys(DAYS).join('|');
const MONTH_WORDS = Object.keys(MONTHS).join('|');

export function parseCapture(input, { today, now = '00:00' } = {}) {
  let s = ` ${String(input || '').replace(/\s+/g, ' ').trim()} `;
  const found = [];
  let date = null;
  let time = null;
  let estimate = null;
  let goalTag = null;

  const take = (re, fn) => {
    const m = s.match(re);
    if (!m) return false;
    const ok = fn(m);
    if (ok === false) return false;
    found.push(m[0].trim());
    s = s.replace(m[0], ' ');
    return true;
  };

  take(/\s#([\p{L}\p{N}_-]+)/u, (m) => { goalTag = m[1]; });
  take(/\s(?:~|for\s+)(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\b/i, (m) => {
    const n = Number(m[1]);
    estimate = Math.round(/^h/i.test(m[2]) ? n * 60 : n);
  });

  // Time: 15:00, 3pm, 3:30pm, noon, "at 15". A dot means a date (12.10), never a time.
  take(/\s(?:at\s+|by\s+|@\s*)?(\d{1,2}):(\d{2})\s*(am|pm)?(?=\s)/i, (m) => {
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
    if (h > 23 || min > 59) return false;
    time = `${pad(h)}:${pad(min)}`;
    return true;
  })
    || take(/\s(?:at\s+|by\s+|@\s*)?(\d{1,2})\s*(am|pm)(?=\s)/i, (m) => {
      const h = (Number(m[1]) % 12) + (/pm/i.test(m[2]) ? 12 : 0);
      if (h > 23) return false;
      time = `${pad(h)}:00`;
      return true;
    })
    || take(/\s(?:at\s+|by\s+)?noon(?=\s)/i, () => { time = '12:00'; })
    || take(/\s(?:at|by)\s+(\d{1,2})(?=\s)/i, (m) => {
      const h = Number(m[1]);
      if (h > 23) return false;
      time = `${pad(h)}:00`;
      return true;
    });

  if (today) {
    take(/\s(?:on\s+|by\s+|due\s+)?(today|tonight)(?=\s)/i, (m) => {
      date = today;
      if (/tonight/i.test(m[1]) && !time) time = '20:00';
    })
      || take(/\s(?:on\s+|by\s+|due\s+)?(?:the\s+)?day\s+after\s+tomorrow(?=\s)/i, () => { date = add(today, 2); })
      || take(/\s(?:on\s+|by\s+|due\s+)?(tomorrow|tmrw|tmr|tmw)(?=\s)/i, () => { date = add(today, 1); })
      || take(/\s(?:in)\s+(\d{1,3})\s*(days?|weeks?)(?=\s)/i, (m) => { date = add(today, Number(m[1]) * (/^w/i.test(m[2]) ? 7 : 1)); })
      || take(/\s(?:by\s+)?next\s+week(?=\s)/i, () => { date = add(today, 8 - isoWeekday(today)); })
      || take(/\s(?:this\s+)?weekend(?=\s)/i, () => {
        const wd = isoWeekday(today);
        date = wd >= 6 ? today : add(today, 6 - wd);
      })
      || take(new RegExp(`\\s(?:on\\s+|by\\s+|due\\s+)?(next\\s+|this\\s+)?(${DAY_WORDS})\\b\\.?(?=\\s)`, 'i'), (m) => {
        const target = DAYS[m[2].toLowerCase()];
        const wd = isoWeekday(today);
        let diff = (target - wd + 7) % 7;
        if (m[1] && /next/i.test(m[1])) diff += 7;
        date = add(today, diff);
      })
      || take(/\s(?:on\s+|by\s+|due\s+)?(\d{4})-(\d{2})-(\d{2})(?=\s)/, (m) => {
        if (!validDay(+m[1], +m[2], +m[3])) return false;
        date = `${m[1]}-${m[2]}-${m[3]}`;
        return true;
      })
      || take(new RegExp(`\\s(?:on\\s+|by\\s+|due\\s+)?(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_WORDS})|(${MONTH_WORDS})\\s+(\\d{1,2})(?:st|nd|rd|th)?)\\b\\.?(?=\\s)`, 'i'), (m) => {
        const d = Number(m[1] || m[4]);
        const mo = MONTHS[(m[2] || m[3]).toLowerCase()];
        let y = Number(today.slice(0, 4));
        if (!validDay(y, mo, d)) return false;
        if (`${y}-${pad(mo)}-${pad(d)}` < today) y += 1;
        date = `${y}-${pad(mo)}-${pad(d)}`;
        return true;
      })
      || take(/\s(?:on\s+|by\s+|due\s+)?(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?(?=\s)/, (m) => {
        const d = Number(m[1]);
        const mo = Number(m[2]);
        let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(today.slice(0, 4));
        if (!validDay(y, mo, d)) return false;
        if (!m[3] && `${y}-${pad(mo)}-${pad(d)}` < today) y += 1;
        date = `${y}-${pad(mo)}-${pad(d)}`;
        return true;
      });

    // A time with no day means the next time that clock time comes round.
    if (time && !date) date = time > now ? today : add(today, 1);
  }

  const title = s.replace(/\s+/g, ' ').replace(/\s(on|by|at|due)\s*$/i, '').trim().replace(/[,;]+$/, '');
  return { title, due_date: date, deadline: time, estimate_min: estimate, goalTag, found };
}
