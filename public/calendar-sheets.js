// The Calendar's sheets (calendar.js): an event, a habit or task due, the event form, the Apple Calendar
// link and the calendars' sync status. Plain strings; the taps on them are calendar.js's.
import { esc, icon, shortDay, addDays, localToday, localNowHM, state, safeColor, ago } from './ui.js';
import { longDay, atMidnight, findEvent, findMark } from './calendar-days.js';
import { cVar, syncState } from './calendar-draw.js';

function sheetWrap(title, body, cls = '') {
  return `<div class="sheet-backdrop" data-action="cal-close"></div>
  <div class="sheet cal-sheet ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-action="cal-close" aria-label="Close">${icon('close')}</button></div>
    ${body}
  </div>`;
}

function whenLine(e) {
  if (e.allDay) return e.end > e.start ? `${shortDay(e.start)} to ${shortDay(e.end)}` : longDay(e.start);
  const sd = e.start.slice(0, 10);
  // A deadline is a moment, and one at 00:00 is the end of the day before, as its task has it.
  if (e.deadline) return atMidnight(e) ? `${longDay(addDays(sd, -1))}<br>Due by midnight` : `${longDay(sd)}<br>Due by ${e.time}`;
  const ed = e.end.slice(0, 10);
  return `${longDay(sd)}<br>${e.time} to ${ed === sd ? '' : `${shortDay(ed)} `}${e.endTime}`;
}

function eventSheet(s) {
  const e = findEvent(s.id);
  if (!e) return '';
  const feed = `<span class="cal-d-feed"${cVar(e.color)}><i></i>${esc(e.feed)}${e.deadline ? ', deadline' : ''}</span>`;
  const lines = [
    `<p class="cal-d-when">${whenLine(e)}</p>`,
    e.location ? `<p class="cal-d-row"><span>Where</span>${esc(e.location)}</p>` : '',
    e.notes ? `<p class="cal-d-row"><span>Notes</span><span class="cal-d-notes">${esc(e.notes)}</span></p>` : '',
    e.own && e.by === 'coach' ? '<p class="cal-d-row"><span>Added by</span>The coach</p>' : '',
    e.done ? '<p class="cal-d-row"><span>Status</span>Done</p>' : '',
    !e.own ? '<p class="note">From a subscribed calendar</p>' : '',
  ].join('');
  const doneBtn = `<button class="btn ${e.done ? 'tinted' : 'primary'}" data-action="cal-done" aria-pressed="${e.done ? 'true' : 'false'}">${e.done ? 'Not done' : 'Mark done'}</button>`;
  let actions = `<div class="sheet-actions">${doneBtn}</div>`;
  if (e.own && s.confirmDelete) {
    actions = `<div class="confirm-row"><span>Delete this event?</span><span class="confirm-btns"><button class="btn danger small" data-action="cal-del-yes">Delete</button><button class="btn tinted small" data-action="cal-del-no">Keep</button></span></div>`;
  } else if (e.own) {
    actions = `<div class="sheet-actions">${doneBtn}<button class="btn tinted" data-action="cal-edit">Edit</button><button class="btn tinted danger-text" data-action="cal-del">${icon('trash')}Delete</button></div>`;
  }
  return sheetWrap('Event', `<div class="cal-d"><div class="cal-d-top">${feed}<h3 class="cal-d-title">${esc(e.title)}</h3></div>${lines}${actions}</div>`);
}

function markSheet(s) {
  const m = findMark(s.key);
  if (!m) return '';
  const today = localToday();
  const habit = m.kind === 'habit';
  const what = habit ? 'Habit' : 'Task';
  // Without a time it is due that whole day, which is only "today" when it is today.
  let due = m.date === today ? 'today' : shortDay(m.date);
  if (m.time) due = m.midnight ? 'by midnight' : `by ${m.time}`;
  // A day gone by is settled: a habit not kept then was missed, a task not done is overdue.
  const overdue = !habit && m.date === today && m.time && !m.midnight && localNowHM() >= m.time;
  let status = 'Still open';
  if (m.done) status = habit ? 'Kept' : 'Done';
  else if (m.date < today) status = habit ? 'Missed' : 'Overdue';
  else if (overdue) status = 'Overdue';
  return sheetWrap(what, `<div class="cal-d"><div class="cal-d-top"><span class="cal-d-feed mark ${m.kind}${m.hard ? ' hard' : ''}"><i></i>${what} due ${due}</span><h3 class="cal-d-title">${esc(m.title)}</h3></div>
    <p class="cal-d-when">${longDay(m.date)}</p><p class="cal-d-row"><span>Status</span>${status}</p>
    <div class="sheet-actions"><a class="btn tinted" href="#/${habit ? 'plan' : 'today'}">${icon('chevron')}Open ${habit ? 'Plan' : 'Today'}</a></div></div>`);
}

function formSheet(s) {
  const f = s.draft;
  return sheetWrap(s.id ? 'Edit event' : 'New event', `<form class="sheet-form cal-form" data-form="cal-event" data-id="${s.id ?? ''}">
    <label class="field"><span>Title</span><input class="input" name="title" value="${esc(f.title)}" required maxlength="200" autocomplete="off" enterkeyhint="done"></label>
    <label class="check"><input type="checkbox" name="all_day"${f.all_day ? ' checked' : ''}><span>All day</span></label>
    <div class="grid2">
      <label class="field"><span>Date</span><input class="input" type="date" name="date" value="${f.date}" required></label>
      <label class="field allday-only"><span>Last day</span><input class="input" type="date" name="end_date" value="${f.end_date}"></label>
    </div>
    <div class="grid2 timed-only">
      <label class="field"><span>Starts</span><input class="input" type="time" name="start" value="${f.start}"></label>
      <label class="field"><span>Ends</span><input class="input" type="time" name="end" value="${f.end}"></label>
    </div>
    <div class="cal-durs timed-only" role="group" aria-label="Length">${[[30, '30 min'], [60, '1 h'], [90, '1.5 h'], [120, '2 h']].map(([m, t]) => `<button type="button" class="btn tinted small" data-action="cal-dur" data-min="${m}">${t}</button>`).join('')}</div>
    <label class="field"><span>Location</span><input class="input" name="location" value="${esc(f.location)}" maxlength="200" autocomplete="off"></label>
    <label class="field"><span>Notes</span><textarea class="input" name="notes" rows="3" maxlength="1000">${esc(f.notes)}</textarea></label>
    <div class="form-actions"><button class="btn chrome" type="submit">Save</button><button class="btn tinted" type="button" data-action="cal-close">Cancel</button></div>
  </form>`);
}

function subSheet(s) {
  const info = s.info;
  let body;
  if (!info) body = '<p class="muted">Loading</p>';
  else if (!info.on) {
    body = `<div class="sheet-actions"><button class="btn primary" data-action="cal-sub-make"${s.busy ? ' disabled' : ''}>${icon('calendar')}Turn on</button></div>`;
  } else {
    body = `<div class="sheet-actions"><a class="btn primary" href="${esc(info.webcal)}">${icon('calendar')}Subscribe in Apple Calendar</a></div>
      <label class="field"><span>Link</span><span class="copy-row"><input class="input mono" id="cal-sub-url" readonly value="${esc(info.url)}"><button type="button" class="btn tinted small" data-action="copy" data-target="cal-sub-url">Copy</button></span></label>
      <div class="sheet-actions"><button class="btn tinted danger-text" data-action="cal-sub-new"${s.busy ? ' disabled' : ''}>Make a new link</button></div>`;
  }
  return sheetWrap('Apple Calendar', `<div class="cal-sub">${body}</div>`);
}

export function sheetHtml(c) {
  const s = state.calSheet;
  if (!s) return '';
  if (s.kind === 'event') return eventSheet(s);
  if (s.kind === 'mark') return markSheet(s);
  if (s.kind === 'form') return formSheet(s);
  if (s.kind === 'sub') return subSheet(s);
  if (s.kind === 'sync') return syncSheet(c);
  return '';
}

function syncSheet(c) {
  const s = syncState(c);
  const rows = (s?.feeds || []).map((f) => `<div class="cal-feed${f.lastError ? ' bad' : ''}"><i style="--c:${safeColor(f.color) || '#8a909c'}"></i>
    <span class="cal-feed-body"><b>${esc(f.name)}</b><small>${f.lastError ? esc(f.lastError) : f.lastSync ? `Synced ${esc(ago(f.lastSync))} · ${f.eventCount} ${f.eventCount === 1 ? 'event' : 'events'}` : 'Not synced yet'}</small></span></div>`).join('');
  return sheetWrap('Calendars', `<div class="cal-feeds">${rows || '<p class="note">No calendars connected.</p>'}</div>
    <p class="note">Oath checks every calendar every 15 minutes.</p>
    <div class="sheet-actions"><button type="button" class="btn primary" data-action="cal-sync-now"${c.syncing ? ' disabled' : ''}>${c.syncing ? 'Syncing…' : 'Sync now'}</button>
      <a class="btn tinted" href="#/health?section=calendars">Manage calendars</a></div>`);
}
