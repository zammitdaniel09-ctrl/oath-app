// Telegram: the coach and the reminders, where Daniel already is.
import crypto from 'node:crypto';
import { db, getKV, setKV, logEvent } from './db.js';
import { buildToday } from './state.js';
import { completeHabit, completeTask, RuleError } from './engine.js';
import { reactionAfterDone, finishFocus, closeFocusFor } from './drive.js';
import { chat, chatWith, resolvePending } from './coach.js';
import { saveMedia } from './coach-media.js';
import { captureTask, doneByText } from './capture.js';
import { deadlineText } from './time.js';
import { telegramHtml } from '../public/rich.js';
import { photoIn, photoBytes, foodPhoto, foodCallback } from './food-telegram.js';

const token = () => process.env.TELEGRAM_BOT_TOKEN;
export const telegramEnabled = () => Boolean(token());

function publicUrl() {
  const d = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.PUBLIC_HOST;
  return d ? `https://${d}` : null;
}

async function call(method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(`telegram ${method} failed: ${data.description || res.status}`);
    err.description = data.description || '';
    throw err;
  }
  return data.result;
}

// Telegram says so when Daniel blocked the bot, deleted the chat or closed his account; every send
// after that fails the same way.
const chatGone = (err) => /blocked by the user|chat not found|user is deactivated/i.test(err?.description || '');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// The coach writes a little Markdown; Telegram gets it as its own small HTML set.
const md = (s) => telegramHtml(s);

async function tgState() {
  return (await getKV('telegram')) || {};
}

async function save(patch) {
  const next = { ...(await tgState()), ...patch };
  await setKV('telegram', next);
  return next;
}

export async function webhookSecret() {
  return (await tgState()).secret || null;
}

// Both sides are hashed first, so the comparison takes the same time whatever is sent and the length
// of the secret does not leak either.
const digest = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest();

// Whether a webhook call carries the secret token set when the webhook was registered.
export async function webhookAllowed(given) {
  const secret = await webhookSecret();
  return Boolean(secret) && crypto.timingSafeEqual(digest(given), digest(secret));
}

export async function initTelegram() {
  if (!telegramEnabled()) return;
  const url = publicUrl();
  if (!url) {
    console.warn('telegram: no public URL known, webhook not set');
    return;
  }
  const me = await call('getMe');
  const current = await tgState();
  const secret = current.secret || crypto.randomBytes(24).toString('hex');
  await save({ secret, botUsername: me.username });
  await call('setWebhook', { url: `${url}/telegram/webhook`, secret_token: secret, allowed_updates: ['message', 'callback_query'] });
  await call('setMyCommands', {
    commands: [
      { command: 'today', description: 'What is due today, with Done buttons' },
      { command: 'next', description: 'The one thing to do now' },
      { command: 'hp', description: 'HP, season and pardons' },
      { command: 'add', description: 'Add a task: /add call the bank friday 3pm' },
      { command: 'done', description: 'Mark something done: /done gym' },
    ],
  });
  console.log(`telegram ready as @${me.username}`);
  const w = await webhookInfo();
  if (w?.lastError) console.warn(`telegram webhook last error (${w.lastErrorAt}): ${w.lastError}`);
}

// What Telegram says about delivering to Oath: the webhook address and its last delivery error.
export async function webhookInfo() {
  if (!telegramEnabled()) return null;
  try {
    const w = await call('getWebhookInfo', {});
    return {
      url: w.url || '',
      pending: w.pending_update_count || 0,
      lastError: w.last_error_message || null,
      lastErrorAt: w.last_error_date ? new Date(w.last_error_date * 1000).toISOString() : null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

export async function telegramStatus() {
  const s = await tgState();
  return { enabled: telegramEnabled(), linked: Boolean(s.chatId), botUsername: s.botUsername || null };
}

export async function createLink() {
  if (!telegramEnabled()) throw new RuleError('Add TELEGRAM_BOT_TOKEN in Railway first.');
  let s = await tgState();
  if (!s.botUsername) {
    await initTelegram();
    s = await tgState();
  }
  if (!s.botUsername) throw new RuleError('The bot is not reachable yet. Check the token in Railway.');
  const code = crypto.randomBytes(9).toString('base64url');
  await save({ linkCode: code, linkExpires: Date.now() + 30 * 60 * 1000 });
  // The tg:// link jumps straight into the Telegram app; the t.me one is the fallback in a browser.
  return {
    url: `https://t.me/${s.botUsername}?start=${code}`,
    appUrl: `tg://resolve?domain=${s.botUsername}&start=${code}`,
    botUsername: s.botUsername,
  };
}

export async function unlink() {
  await save({ chatId: null });
  await logEvent('telegram_unlinked', {});
}

function openButton(path = '/#/today') {
  const url = publicUrl();
  return url ? { text: 'Open Oath', url: `${url}${path}` } : null;
}

export async function sendTelegram(note) {
  if (!telegramEnabled()) return false;
  const s = await tgState();
  if (!s.chatId) return false;
  const keyboard = [];
  if (note.item) keyboard.push([{ text: 'Done', callback_data: `done:${note.item.kind}:${note.item.id}:${note.focusId || ''}` }]);
  for (const it of note.items || []) {
    keyboard.push([{ text: `Done: ${it.title}`.slice(0, 60), callback_data: `done:${it.kind}:${it.id}:` }]);
  }
  const open = openButton(note.url);
  if (open) {
    if (keyboard.length === 1 && note.item) keyboard[0].push(open);
    else keyboard.push([open]);
  }
  try {
    await call('sendMessage', {
      chat_id: s.chatId,
      text: `<b>${esc(note.title)}</b>\n${md(note.fullText || note.body || '')}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined,
    });
  } catch (err) {
    if (!chatGone(err)) throw err;
    await dropChat(s.chatId, err.description);
    return false;
  }
  return true;
}

// Unlinks the chat, as Settings would, so a blocked bot stops failing on every brief. Logged once,
// however many messages were in flight when Telegram refused them.
let dropping = null;
function dropChat(chatId, why) {
  dropping ??= (async () => {
    if ((await tgState()).chatId !== chatId) return;
    await unlink();
    console.warn(`telegram: ${why}. Unlinked the chat; link it again in Settings to get messages there.`);
  })().finally(() => { dropping = null; });
  return dropping;
}

// ---------- Messages ----------

function todayMessage(t) {
  const g = t.game;
  const lines = [`<b>${esc(t.today)}. ${g.hp} HP.</b>`, `${t.progress.done} of ${t.progress.total} done, ${t.progress.atStake} HP at stake.`];
  if (!t.plan && t.progress.open) lines.push('You have not taken today\'s oath. Open the app and pick your one thing.');
  if (t.plan) lines.push(`One thing: ${esc(t.plan.focusTitle)}`);
  const open = t.openDue;
  const kept = t.items.filter((i) => i.status === 'kept').map((i) => i.title);
  const flexOpen = t.items.filter((i) => i.flexible && i.status === 'open' && !i.mustToday);
  const missed = [...t.items, ...t.tasks].filter((i) => i.status === 'missed').map((i) => i.title);
  if (open.length) {
    lines.push('', '<b>Open</b>');
    for (const i of open) lines.push(`${i.heavy ? '■' : '□'} ${esc(i.title)}, by ${deadlineText(i.deadline)}${i.heavy ? ` (${i.penalty} HP)` : ''}`);
  }
  if (flexOpen.length) {
    lines.push('', '<b>This week</b>');
    for (const i of flexOpen) lines.push(`□ ${esc(i.title)}, ${i.weekDone} of ${i.weekTarget}`);
  }
  if (kept.length) lines.push('', `<b>Kept</b>: ${esc(kept.join(', '))}`);
  if (missed.length) lines.push(`<b>Missed</b>: ${esc(missed.join(', '))}`);
  if (!open.length && !kept.length && !missed.length) lines.push('', 'Nothing scheduled today. Add habits in the app.');
  const keyboard = [...open, ...flexOpen].slice(0, 8).map((i) => [{ text: `Done: ${i.title}`.slice(0, 60), callback_data: `tdone:${i.kind}:${i.id}` }]);
  const btn = openButton();
  if (btn) keyboard.push([btn]);
  return { text: lines.join('\n'), keyboard };
}

async function sendToday(chatId) {
  const m = todayMessage(await buildToday());
  await call('sendMessage', { chat_id: chatId, text: m.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: m.keyboard } });
}

async function sendNext(chatId) {
  const t = await buildToday();
  if (!t.next) {
    await call('sendMessage', { chat_id: chatId, text: 'Nothing open. Close the day in the app, or add the next thing.' });
    return;
  }
  const n = t.next;
  await call('sendMessage', {
    chat_id: chatId,
    text: `<b>Do this now: ${esc(n.title)}</b>\n${n.deadline ? `Due ${n.deadline}. ` : ''}${n.heavy ? `${n.penalty} HP at stake.` : ''}${n.isFocus ? '\nThis is your one thing today.' : ''}`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: 'Done', callback_data: `done:${n.kind}:${n.id}:` }]] },
  });
}

async function sendHp(chatId) {
  const t = await buildToday();
  const g = t.game;
  await call('sendMessage', { chat_id: chatId, text: `${g.hp} HP. Season ${g.season}, ${g.deaths} ${g.deaths === 1 ? 'death' : 'deaths'}, ${g.pardonsLeft} pardons left this month.` });
}

// The coach's reply in the chat: its words, then what it did, with buttons for anything waiting for a yes.
async function sendReply(chatId, reply) {
  const done = (reply.actions || []).map((a) => `${a.ok ? '✓' : '✗'} ${a.text}`).join('\n');
  const keyboard = (reply.pending || []).map((p) => [
    { text: `Confirm: ${p.summary}`.slice(0, 60), callback_data: `cy:${p.id}` },
    { text: 'Cancel', callback_data: `cn:${p.id}` },
  ]);
  await call('sendMessage', {
    chat_id: chatId, text: done ? `${md(reply.text)}\n\n${esc(done)}` : md(reply.text), parse_mode: 'HTML',
    reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined,
  });
}

// Photos are read as food unless the caption plainly asks for something else: events, tasks, a
// timetable, a reminder. Any food word keeps it with the food reader.
const NOT_FOOD = /\b(calendar|events?|tasks?|to-?dos?|schedule|timetable|remind(ers?)?|meetings?|appointments?|deadlines?|exams?|lectures?|class(es)?|habits?|goals?)\b/i;
const FOOD = /\b(eat|ate|eaten|eating|food|meal|breakfast|lunch|dinner|snacks?|drink|drank|kcal|calories|protein|portion|label)\b/i;
export const forCoach = (caption) => NOT_FOOD.test(String(caption || '')) && !FOOD.test(String(caption || ''));

// A photo for the coach: uploaded as the app's coach chat uploads one and sent with its caption, so
// the coach sees it and can act on it with its tools.
async function coachPhoto(message, photo) {
  const chatId = message.chat.id;
  await call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  let reply;
  try {
    const { bytes, type } = await photoBytes(photo, { call, token: token() });
    const up = await saveMedia({ kind: 'photo', data: bytes.toString('base64'), mime: type });
    ({ reply } = await chatWith({ text: String(message.caption || ''), media: [up.id] }));
  } catch (err) {
    if (!(err instanceof RuleError)) console.error('telegram coach photo failed', err);
    await call('sendMessage', { chat_id: chatId, text: err instanceof RuleError ? err.message : 'That did not work. Try it in the app.' });
    return;
  }
  await sendReply(chatId, reply);
}

async function markDone(kind, id, focusId) {
  if (focusId) {
    try {
      return (await finishFocus(Number(focusId), 'done')).reaction.text;
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
    }
  }
  let res = {};
  if (kind === 'habit') res = await completeHabit(Number(id));
  else await completeTask(Number(id));
  await closeFocusFor(kind, Number(id));
  return (await reactionAfterDone(kind, Number(id), { comeback: res.comeback })).text;
}

export async function handleUpdate(u) {
  const fresh = await db()`insert into telegram_updates (update_id) values (${u.update_id}) on conflict do nothing returning update_id`;
  if (!fresh.length) return;
  const s = await tgState();

  if (u.message) {
    const chatId = u.message.chat.id;
    const text = (u.message.text || '').trim();
    if (text.startsWith('/start')) {
      const code = text.split(/\s+/)[1];
      if (code && s.linkCode && code === s.linkCode && Date.now() < (s.linkExpires || 0)) {
        await save({ chatId, linkCode: null, linkExpires: null });
        await logEvent('telegram_linked', {});
        await call('sendMessage', {
          chat_id: chatId,
          text: 'Linked. Reminders, misses and briefs now come here too, with Done buttons. Write anything to talk to the coach. /today shows the day.',
        });
        await sendToday(chatId);
        return;
      }
    }
    // Anything from a chat that is not the linked one gets the answer /start gets, never silence.
    if (!s.chatId || chatId !== s.chatId) {
      await call('sendMessage', {
        chat_id: chatId,
        text: 'This bot belongs to an Oath app and is not linked to this chat. To link it, open Oath, go to Settings, Telegram and tap Connect Telegram, then tap Start here. A link works for 30 minutes.',
      });
      return;
    }
    // A photo of food: read like the app's camera, logged only from the buttons under the answer. One
    // whose caption asks for something else (events, tasks) goes to the coach instead.
    const photo = photoIn(u.message);
    if (photo && forCoach(u.message.caption)) return coachPhoto(u.message, photo);
    if (photo) return foodPhoto(u.message, photo, { call, token: token(), open: openButton });
    if (text === '/today' || text === '/start') return sendToday(chatId);
    if (text === '/next') return sendNext(chatId);
    if (text === '/hp') return sendHp(chatId);
    if (/^\/add(@\w+)?\s+/i.test(text)) {
      try {
        const r = await captureTask(text.replace(/^\/add(@\w+)?\s+/i, ''), 'telegram');
        await call('sendMessage', { chat_id: chatId, text: r.say });
      } catch (err) {
        await call('sendMessage', { chat_id: chatId, text: err instanceof RuleError ? err.message : 'That did not work.' });
      }
      return;
    }
    if (/^\/done(@\w+)?\s+/i.test(text)) {
      try {
        const r = await doneByText(text.replace(/^\/done(@\w+)?\s+/i, ''));
        await call('sendMessage', { chat_id: chatId, text: r.say });
      } catch (err) {
        await call('sendMessage', { chat_id: chatId, text: err instanceof RuleError ? err.message : 'That did not work.' });
      }
      return;
    }
    if (!text) {
      await call('sendMessage', { chat_id: chatId, text: 'Text and photos only for now.' });
      return;
    }
    await call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    await sendReply(chatId, await chat(text));
    return;
  }

  if (u.callback_query) {
    const q = u.callback_query;
    const chatId = q.message?.chat?.id;
    if (!s.chatId || chatId !== s.chatId) {
      await call('answerCallbackQuery', { callback_query_id: q.id, text: 'This bot is private.' });
      return;
    }
    const [action, kind, id, focusId] = String(q.data || '').split(':');
    if (action === 'food') return foodCallback(q, { verb: kind, id, portion: focusId }, { call });
    if (action === 'cy' || action === 'cn') {
      let answer;
      try {
        answer = (await resolvePending(Number(kind), action === 'cy')).message.text;
      } catch (err) {
        answer = err instanceof RuleError ? err.message : 'That did not work. Try it in the app.';
      }
      await call('answerCallbackQuery', { callback_query_id: q.id, text: answer.slice(0, 190) });
      await call('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await call('sendMessage', { chat_id: chatId, text: answer });
      return;
    }
    if (action !== 'done' && action !== 'tdone') return;
    let text;
    try {
      text = await markDone(kind, id, focusId);
    } catch (err) {
      text = err instanceof RuleError ? err.message : 'That did not work. Try it in the app.';
      if (!(err instanceof RuleError)) console.error('telegram done failed', err);
    }
    await call('answerCallbackQuery', { callback_query_id: q.id, text: text.slice(0, 190) });
    if (action === 'tdone') {
      const m = todayMessage(await buildToday());
      await call('editMessageText', {
        chat_id: chatId, message_id: q.message.message_id, text: m.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: m.keyboard },
      }).catch(() => {});
    } else {
      await call('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    }
    await call('sendMessage', { chat_id: chatId, text });
  }
}
