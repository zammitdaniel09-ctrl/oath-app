// Telegram: the coach and the reminders, where Daniel already is.
import crypto from 'node:crypto';
import { db, getKV, setKV, logEvent } from './db.js';
import { buildToday } from './state.js';
import { completeHabit, completeTask, RuleError } from './engine.js';
import { reactionAfterDone, finishFocus, closeFocusFor } from './drive.js';
import { chat } from './coach.js';

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
  if (!data.ok) throw new Error(`telegram ${method} failed: ${data.description || res.status}`);
  return data.result;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
    ],
  });
  console.log(`telegram ready as @${me.username}`);
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
  return { url: `https://t.me/${s.botUsername}?start=${code}`, botUsername: s.botUsername };
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
  const row = [];
  if (note.item) row.push({ text: 'Done', callback_data: `done:${note.item.kind}:${note.item.id}:${note.focusId || ''}` });
  const open = openButton(note.url);
  if (open) row.push(open);
  await call('sendMessage', {
    chat_id: s.chatId,
    text: `<b>${esc(note.title)}</b>\n${esc(note.fullText || note.body || '')}`,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: row.length ? { inline_keyboard: [row] } : undefined,
  });
  return true;
}

// ---------- Messages ----------

function todayMessage(t) {
  const g = t.game;
  const lines = [`<b>${esc(t.today)}. ${g.hp} HP.</b>`, `${t.progress.done} of ${t.progress.total} done, ${t.progress.atStake} HP at stake.`];
  if (!t.plan && t.progress.open) lines.push('You have not taken today\'s oath. Open the app and pick your one thing.');
  if (t.plan) lines.push(`One thing: ${esc(t.plan.focusTitle)}`);
  const open = [
    ...t.items.filter((i) => i.status === 'open'),
    ...t.tasks.filter((k) => k.status === 'open' && k.dueDate && k.dueDate <= t.today),
  ];
  const kept = t.items.filter((i) => i.status === 'kept').map((i) => i.title);
  const missed = [...t.items, ...t.tasks].filter((i) => i.status === 'missed').map((i) => i.title);
  if (open.length) {
    lines.push('', '<b>Open</b>');
    for (const i of open) lines.push(`${i.heavy ? '■' : '□'} ${esc(i.title)}, by ${i.deadline || '23:59'}${i.heavy ? ` (${i.penalty} HP)` : ''}`);
  }
  if (kept.length) lines.push('', `<b>Kept</b>: ${esc(kept.join(', '))}`);
  if (missed.length) lines.push(`<b>Missed</b>: ${esc(missed.join(', '))}`);
  if (!open.length && !kept.length && !missed.length) lines.push('', 'Nothing scheduled today. Add habits in the app.');
  const keyboard = open.slice(0, 8).map((i) => [{ text: `Done: ${i.title}`.slice(0, 60), callback_data: `tdone:${i.kind}:${i.id}` }]);
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

async function markDone(kind, id, focusId) {
  if (focusId) {
    try {
      return (await finishFocus(Number(focusId), 'done')).reaction.text;
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
    }
  }
  if (kind === 'habit') await completeHabit(Number(id));
  else await completeTask(Number(id));
  await closeFocusFor(kind, Number(id));
  return (await reactionAfterDone(kind, Number(id))).text;
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
      if (s.chatId !== chatId) {
        await call('sendMessage', { chat_id: chatId, text: 'This bot is private.' });
        return;
      }
    }
    if (!s.chatId || chatId !== s.chatId) return;
    if (text === '/today' || text === '/start') return sendToday(chatId);
    if (text === '/next') return sendNext(chatId);
    if (text === '/hp') return sendHp(chatId);
    if (!text) {
      await call('sendMessage', { chat_id: chatId, text: 'Text only for now.' });
      return;
    }
    await call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const reply = await chat(text);
    await call('sendMessage', { chat_id: chatId, text: reply.text });
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
