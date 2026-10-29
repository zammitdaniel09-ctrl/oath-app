// The Coach page: the chat with its photos and voice notes, the briefs, what a reply did and what
// waits for a tap, and the quick line to the coach on Today and Plan.
import {
  icon, esc, fmtClock, state, emptyState, iconLink, api, toast, fx, $app, act, reportProblem, form2obj, haptic,
  redrawIfIdle,
} from './ui.js';
import {
  mediaHtml, draft as coachDraft, recording, recBarHtml, composerEmpty, stagedHtml, startRecording, cancelRecording,
  finishRecording, unstage, toggleVoice, takePhotos,
} from './coach-media.js';
import { richHtml } from './rich.js';
import * as motion from './motion.js';
import { loadFoodToday } from './food.js';

let ctx = { shell: () => {}, skeleton: () => {}, render: () => {}, fetchToday: () => {}, load: () => {} };
export function initCoach(c) {
  ctx = { ...ctx, ...c };
}

// One message: its words, what it did (receipts), and anything waiting for a Confirm tap.
const PENDING_DONE = { done: 'Confirmed', cancelled: 'Cancelled', expired: 'Expired. Ask again if you still want it.', failed: 'Did not go through' };
export function coachMessage(m, last = false) {
  const receipts = m.actions?.length
    ? `<ul class="receipts">${m.actions.map((a) => `<li class="${a.ok ? 'ok' : 'no'}">${icon(a.ok ? 'check' : 'close')}<span>${esc(a.text)}</span></li>`).join('')}</ul>`
    : '';
  const pending = (m.pending || []).map((p) => (p.status === 'open'
    ? `<div class="confirm-row"><span>${esc(p.summary)}?</span><span class="confirm-btns"><button class="btn chrome small" data-action="coach-confirm" data-id="${p.id}" data-yes="1">Confirm</button><button class="btn tinted small" data-action="coach-confirm" data-id="${p.id}" data-yes="0">Cancel</button></span></div>`
    : `<p class="confirm-done ${p.status}">${esc(p.summary)}: ${PENDING_DONE[p.status] || p.status}${p.status === 'failed' && p.outcome ? `, ${esc(p.outcome)}` : ''}</p>`)).join('');
  const media = m.role === 'user' ? mediaHtml(m) : '';
  const voice = (m.media || []).some((x) => x.kind === 'voice');
  const words = m.role === 'assistant' ? `<div class="msg-text rich">${richHtml(m.text)}</div>` : m.text ? `<span class="msg-text${voice ? ' cc-transcript' : ''}">${esc(m.text)}</span>` : '';
  const note = m.hearing ? '<span class="cc-note"><i class="cc-dots" aria-hidden="true"></i>Transcribing</span>'
    : m.unheard ? '<span class="cc-note bad">Nothing could be heard</span>' : m.notSent ? '<span class="cc-note bad">Not sent</span>' : '';
  const trouble = m.failed || (m.actions || []).some((a) => !a.ok) || (m.pending || []).some((p) => p.status === 'failed');
  const report = m.role === 'assistant' && (last || trouble)
    ? `<button type="button" class="msg-report" data-action="coach-report"${m.id ? ` data-id="${m.id}"` : ''}>Report a problem</button>` : '';
  const photos = (m.media || []).some((x) => x.kind === 'photo');
  return `<div class="msg ${m.role}${photos ? ' has-photos' : ''}${voice ? ' has-voice' : ''}">${media}${words}${note}${receipts}${pending}${m.at ? `<time>${fmtClock(m.at)}</time>` : ''}${report}</div>`;
}

// The coach thinking: three dots in a bubble of its own.
export const TYPING = '<div class="msg assistant typing" role="status"><span class="sr">The coach is writing</span><i></i><i></i><i></i></div>';

// One tap for the things most often asked.
const QUICK = ['What\'s next?', 'Plan my day', 'How am I doing?'];

// The briefs the coach writes on its own, on demand; they sit in a sheet behind one button.
export const BRIEFS = [['morning', 'sun', 'Morning brief'], ['midday', 'clock', 'Midday check'], ['evening', 'moon', 'Evening check']];

export function viewCoach() {
  const c = state.coach;
  if (!c) return ctx.shell(ctx.skeleton('Coach'));
  // A reply landing while he types a follow-up keeps the keyboard up and the caret where it was.
  const typing = document.activeElement?.id === 'coach-text' ? document.activeElement.selectionStart : null;
  const msgs = c.messages.map((m, i, all) => coachMessage(m, i === all.length - 1)).join('');
  const ask = state.query.get('ask') || '';
  const empty = emptyState({ icon: 'coach', title: 'Talk to your coach' });
  // Food has a chat of its own: the last chip opens it.
  const quick = `${QUICK.map((q) => `<button type="button" class="qchip" data-action="coach-quick" data-text="${esc(q)}"${state.sending ? ' disabled' : ''}>${esc(q)}</button>`).join('')}
    <label class="qchip">From photos<input class="vh" type="file" accept="image/*" multiple data-coach-photo></label>
    <a class="qchip qchip-food" href="#/food/chat">Log food</a>`;
  const d = coachDraft();
  if (ask && !d.text) d.text = ask;
  const composer = recording() ? recBarHtml() : `<form class="composer cc-composer${composerEmpty() ? ' empty' : ''}" data-form="coach">
          <label class="cc-cam" title="Take a photo">${icon('camera')}<span class="sr">Take a photo</span><input class="vh" type="file" accept="image/*" capture="environment" data-coach-photo></label>
          <label class="sr" for="coach-text">Message</label>
          <textarea id="coach-text" class="input" name="text" rows="1" maxlength="4000" placeholder="${d.photos.length ? 'Add a message (optional)' : 'Message the coach'}">${esc(d.text)}</textarea>
          <button type="button" class="cc-mic" data-action="coach-mic" aria-label="Record a voice note"${state.sending ? ' disabled' : ''}>${icon('mic')}</button>
          <button class="btn primary send" type="submit" aria-label="Send"${state.sending ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button>
        </form>`;
  const briefs = `<button class="btn tinted small briefs-btn" data-action="briefs-open"${state.sending ? ' disabled' : ''}>Briefs</button>`;
  // The coach has a face of its own in Merlot, as the food chat has its lime, so the two never look alike.
  const head = `<header class="chd-head"><span class="chd-av" aria-hidden="true">C</span>
    <div class="chd-head-text"><h1>Coach</h1><p>${c.aiEnabled ? (state.sending ? 'Writing…' : 'Your plans, nudges and honest takes') : 'Offline'}</p></div>
    <div class="chd-actions">${briefs}${iconLink('#/settings', 'settings', 'Settings')}</div></header>`;
  ctx.shell(`<div class="cchat-page">${head}
      ${c.aiEnabled ? '' : '<div class="banner warn">The coach is offline: no Anthropic API key in Railway.</div>'}
      <div class="chat cchat" id="chat" data-chat="coach">${msgs || empty}${state.sending ? TYPING : ''}</div>
      <div class="composer-dock">
        ${stagedHtml()}
        <div class="quick-replies" role="group" aria-label="Quick replies">${quick}</div>
        ${composer}
      </div></div>`);
  // The chat ends at the composer, so the newest message sits just above it.
  motion.chatToEnd();
  const box = typing !== null ? document.getElementById('coach-text') : null;
  if (box) {
    box.focus({ preventScroll: true });
    box.setSelectionRange(typing, typing);
    box.style.height = 'auto';
    box.style.height = `${Math.min(140, box.scrollHeight)}px`;
  }
}

// The coach may have changed tasks, habits or settings: reload what it touched, in the background.
// A message of his on screen at once, with the coach writing under it.
export function coachShow(msg) {
  state.coach?.messages.push(msg);
  state.sending = true;
  if (state.query.has('ask')) history.replaceState(null, '', '#/coach');
  state.query = new URLSearchParams();
  ctx.render();
}

// Sends a message already on screen (msg): its words and the ids of its uploaded photos or voice note.
// The kept copy replaces it, holding on to what this phone already shows (thumbnails, a local recording).
export async function sendCoach({ text = '', media = [], msg }) {
  state.sending = true;
  let r = null;
  let caught = false;
  try {
    r = await api('POST', '/api/coach', { text, media });
  } catch (err) {
    if (err.status === 0) caught = await coachCaughtUp(msg, text);
    else if (err.status !== 401) toast(err.message, true);
  }
  state.sending = false;
  if (r) {
    const mine = msg.media || [];
    Object.assign(msg, { id: r.sent.id, at: r.sent.at, text: r.sent.text, media: r.sent.media ? r.sent.media.map((x, i) => ({ ...mine[i], ...x })) : null });
    state.coach?.messages.push(r.reply);
  } else if (!caught) {
    msg.notSent = true;
  }
  ctx.render();
  if (r || caught) fx('receive');
  await coachChangedThings(r ? r.reply : caught ? { actions: [{ ok: true }] } : null);
}

// The connection dropped mid-send (the phone locked, the signal went). The server usually carries on and
// keeps the reply, so before calling it "Not sent" (and inviting a resend that would log or add twice),
// the chat asks the server a few times for what it has.
async function coachCaughtUp(msg, text) {
  toast('The connection dropped. Checking whether the coach got it.');
  const since = Date.parse(msg.at) - 120000;
  for (let i = 0; i < 6; i += 1) {
    await new Promise((done) => setTimeout(done, 5000));
    let c;
    try {
      c = await api('GET', '/api/coach');
    } catch {
      continue;
    }
    const mine = c.messages.findIndex((m) => m.role === 'user' && Date.parse(m.at) >= since && (!text || m.text === text));
    if (mine >= 0 && c.messages.slice(mine + 1).some((m) => m.role === 'assistant')) {
      state.coach = c;
      return true;
    }
  }
  return false;
}

async function coachChangedThings(reply) {
  if (!reply?.actions?.some((x) => x.ok)) return;
  state.plan = null;
  state.goals = null;
  state.dash = null;
  state.cal?.chunks.clear();
  // Food the coach logged shows in Today's ring and food tile too.
  loadFoodToday();
  await ctx.fetchToday().catch(() => { state.today = null; });
  if (!['today', 'coach'].includes(state.route)) await ctx.load(state.route).catch(() => {});
}

// Each line sent to the coach from a sheet gets a number, so its late reply can tell if its sheet is still up.
let askSeq = 0;

export async function coachClick(a, el) {
  const id = Number(el.dataset.id);
  if (a === 'coach-mic') {
    await startRecording();
  } else if (a === 'coach-rec-cancel') {
    await cancelRecording();
  } else if (a === 'coach-rec-send') {
    await finishRecording();
  } else if (a === 'coach-unstage') {
    unstage(el.dataset.key);
  } else if (a === 'coach-voice') {
    toggleVoice(el.dataset.key);
  } else if (a === 'coach-photo') {
    state.sheet = { kind: 'photo', src: el.dataset.src };
    ctx.render();
  } else if (a === 'coach-quick') {
    // A quick reply goes out as if typed.
    const form = $app.querySelector('form[data-form="coach"]');
    const box = form?.elements.namedItem('text');
    if (!box || state.sending) return true;
    box.value = el.dataset.text;
    form.requestSubmit();
  } else if (a === 'brief') {
    el.disabled = true;
    toast('Writing the brief');
    const r = await act(() => api('POST', `/api/briefs/${el.dataset.kind}`, {}));
    el.disabled = false;
    if (r) {
      // The brief as the server kept it in the chat, so it has an id (Report a problem) and matches a reload.
      if (state.coach) state.coach.messages.push(r.message || { role: 'assistant', text: r.text, at: new Date().toISOString() });
      ctx.render();
      fx('receive');
      state.today = null;
    }
  } else if (a === 'coach-report') {
    // What the coach said and what he asked go with the report; the server adds the recent conversation.
    const msgs = state.coach?.messages || [];
    const at = el.dataset.id ? msgs.findIndex((m) => String(m.id) === el.dataset.id) : msgs.length - 1;
    const reply = msgs[at];
    const asked = msgs.slice(0, Math.max(0, at)).reverse().find((m) => m.role === 'user');
    await reportProblem('coach', { message_id: reply?.id || null, reply: reply?.text?.slice(0, 2000) || '', asked: asked?.text?.slice(0, 1000) || '', actions: reply?.actions || [] });
  } else if (a === 'coach-confirm') {
    // Daniel's tap on something the coach asked to do: run it or cancel it, then show the outcome.
    el.disabled = true;
    const r = await act(() => api('POST', `/api/coach/pending/${id}`, { confirm: el.dataset.yes === '1' }));
    if (!r) { el.disabled = false; return true; }
    toast(r.status === 'done' ? r.text : r.status === 'cancelled' ? 'Cancelled.' : r.text, r.status === 'failed');
    const settle = (m) => (m?.pending || []).forEach((p) => { if (p.id === id) { p.status = r.status; p.outcome = r.text; } });
    if (state.sheet?.kind === 'coach') settle(state.sheet.reply);
    state.coach?.messages.forEach(settle);
    if (state.coach && r.message) state.coach.messages.push(r.message);
    await coachChangedThings({ actions: [{ ok: r.status === 'done' }] });
    ctx.render();
  } else return false;
  return true;
}

export async function coachSubmit(kind, form) {
  if (kind === 'coach') {
    const text = form2obj(form).text.trim();
    if ((!text && !coachDraft().photos.length) || state.sending) return true;
    const photos = takePhotos();
    const msg = { role: 'user', text, at: new Date().toISOString(), media: photos.shown.length ? photos.shown : null };
    coachDraft().text = '';
    coachShow(msg);
    haptic('send');
    const ids = await photos.ids;
    if (msg.media) msg.media = msg.media.filter((p) => ids.some((x) => x.key === p.key));
    if (!text && !ids.length) {
      msg.notSent = true;
      state.sending = false;
      ctx.render();
      return true;
    }
    await sendCoach({ text, media: ids.map((x) => x.id), msg });
  } else if (kind === 'ask-coach') {
    // The quick line on Today and Plan: the answer, and what the coach did, open in a sheet. A reply
    // lands there only if that same sheet is still up on the same screen; a late one waits in the chat.
    const text = form2obj(form).text.trim();
    if (!text) return true;
    form.reset();
    askSeq += 1;
    const req = askSeq;
    const route = state.route;
    const here = () => state.sheet?.kind === 'coach' && state.sheet.req === req && state.route === route;
    state.sheet = { kind: 'coach', text, req };
    ctx.render();
    haptic('send');
    const r = await act(() => api('POST', '/api/coach', { text }));
    if (!r) {
      if (here()) { state.sheet = null; ctx.render(); }
      // What he typed comes back, so a failed send costs nothing to try again.
      const box = $app.querySelector('form[data-form="ask-coach"] [name="text"]');
      if (box && !box.value) box.value = text;
      return true;
    }
    await coachChangedThings(r.reply);
    if (here()) {
      state.coach = null;
      state.sheet = { kind: 'coach', text, req, reply: r.reply };
      ctx.render();
      fx('receive');
    } else if (state.route === 'coach') {
      ctx.load('coach').then(() => redrawIfIdle('coach', ctx.render)).catch(() => {});
    } else {
      state.coach = null;
      toast('The coach replied', false, 7000, false, '#/coach');
    }
  } else return false;
  return true;
}
