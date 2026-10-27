// Food by photo in Telegram: Daniel sends the bot a photo of a plate, a product or a label, the same
// reading as the app's camera (food-photo.js) works it out, and buttons log it. Nothing is logged until
// he taps. Each result waits in kv under a random id for two hours, and its diary entries have ids fixed
// with it, so a tap that arrives twice still logs once.
import crypto from 'node:crypto';
import { db, getKV, setKV, logEvent } from './db.js';
import { RuleError } from './engine.js';
import { readFoodPhoto } from './food-photo.js';
import { logFood, quickAdd } from './food.js';
import { line, round, amountText, unitsFor } from '../public/nutrition.js';

const MAX_BYTES = 10 * 1024 * 1024;
const TTL = 2 * 3600 * 1000;
const keyOf = (id) => `tgfood:${id}`;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const kcalText = (v) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(round(v, 0));
const SLOT = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snacks: 'a snack', drinks: 'drinks' };

// The photo in a message: the largest size Telegram made of a photo, or an image sent as a file.
export function photoIn(m) {
  if (Array.isArray(m?.photo) && m.photo.length) {
    const best = [...m.photo].sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0) || (b.file_size || 0) - (a.file_size || 0))[0];
    return { fileId: best.file_id, size: Number(best.file_size) || 0 };
  }
  const d = m?.document;
  if (d?.file_id && /^image\//i.test(d.mime_type || '')) return { fileId: d.file_id, size: Number(d.file_size) || 0 };
  return null;
}

const tooBig = () => new RuleError('That photo is too big. Send one under 10 MB.');

// The file's bytes from Telegram, 10 MB at most however the size is reported.
async function download(token, path, size) {
  if (size > MAX_BYTES) throw tooBig();
  if (!/^[\w\-./]+$/.test(path) || path.includes('..')) throw new Error(`telegram gave an odd file path: ${path}`);
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw tooBig();
  const chunks = [];
  let n = 0;
  for await (const chunk of res.body) {
    n += chunk.length;
    if (n > MAX_BYTES) throw tooBig();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// What the bytes are, from their first few: the reading takes JPEG, PNG and WebP.
function mediaType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// One result waiting for a tap; expired ones are cleared as new ones arrive.
async function hold(value) {
  const id = crypto.randomBytes(8).toString('hex');
  await db()`delete from kv where key like 'tgfood:%' and (value->>'expires')::bigint < ${Date.now()}`;
  return { id, save: (v) => setKV(keyOf(id), { ...value, ...v, expires: Date.now() + TTL }) };
}

const shortAmount = (qty, unit, item) => amountText(qty, unit, item).replace(/\s*\([^)]*\)\s*$/, '');

// A meal: each item as the app's review would log it, matched to a record or as an estimated quick add,
// with the bodies the app would send. Items with neither are left out and named.
function mealPlan(result) {
  const rows = [];
  const left = [];
  for (const it of result.items || []) {
    const name = it.match?.name || cap(it.name) || 'Food';
    if (it.match && Number(it.qty) > 0) {
      const l = line(it.match, it.qty, it.unit);
      if (!l.error && num(l.nutrients.kcal) !== null) {
        const grams = !['g', 'ml'].includes(it.unit) && num(l.g) ? ` (${round(l.g, 0)} g)` : '';
        rows.push({
          text: `${name}, ${shortAmount(it.qty, it.unit, it.match)}${grams}`, kcal: l.nutrients.kcal,
          op: 'log', data: { key: it.match.key, qty: Number(it.qty), unit: it.unit, estimate: true, ...(it.fill ? { fill: it.fill } : {}) },
        });
        continue;
      }
    }
    const g = it.guess;
    if (num(g?.kcal) !== null) {
      // Not in the catalogue: the estimate per 100 and its weight, as a quick add marked as an estimate.
      const amount = num(g.amount) > 0 ? `about ${round(g.amount, g.unit === 'piece' ? 1 : 0)} ${g.unit === 'piece' ? (round(g.amount, 1) === 1 ? 'piece' : 'pieces') : g.unit}` : '';
      const drink = it.fill?.basis === 'ml' || g.unit === 'ml';
      const weight = num(g.weight) ?? (['g', 'ml'].includes(g.unit) ? num(g.amount) : null);
      const data = { name: cap(it.name), amount, estimate: true, ...(drink ? { ml: weight } : { grams: weight }) };
      if (it.fill && weight) data.fill = it.fill;
      else Object.assign(data, { kcal: round(g.kcal, 0), protein: g.protein, carbs: g.carbs, sugars: g.sugars, fat: g.fat, fibre: g.fibre, salt: g.salt });
      rows.push({ text: [cap(it.name), amount].filter(Boolean).join(', '), kcal: g.kcal, op: 'quick', data });
      continue;
    }
    left.push(name);
  }
  return { rows, left };
}

const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// Up to three of a product's own portions, each with a weight from its source: the pack, one of a
// multipack, the serving, the record's portions. With none, 100 g or ml.
export function portionsOf(item) {
  const out = [];
  const units = new Set(unitsFor(item).map((u) => u.unit));
  const add = (unit, label) => {
    if (out.length >= 3 || !units.has(unit) || out.some((p) => p.unit === unit)) return;
    const l = line(item, 1, unit);
    if (!l.error) out.push({ qty: 1, unit, label: label.slice(0, 40), kcal: l.nutrients.kcal });
  };
  const size = (x) => `${round(x.size, 0)} ${x.unit}`;
  // A label that already says its weight ("1 can (330 ml)") is shown as it is; others get it added.
  const weighed = (label) => /\d\s*(g|ml)\b/i.test(label);
  if (item.pack?.size) add('pack', item.pack.count > 1 ? `Whole pack, ${item.pack.count} × ${round(item.pack.size / item.pack.count, 0)} ${item.pack.unit}` : `1 pack, ${size(item.pack)}`);
  if (item.pack?.count > 1) add('each', `1 of ${item.pack.count}, ${round(item.pack.size / item.pack.count, 0)} ${item.pack.unit}`);
  if (item.serving?.size) {
    const label = item.serving.label || '1 serving';
    add('serving', weighed(label) ? label : `${label}, ${size(item.serving)}`);
  }
  for (const p of item.portions || []) {
    const w = p.g ? `${round(p.g, 0)} g` : p.ml ? `${round(p.ml, 0)} ml` : '';
    add(`p:${p.label}`, weighed(p.label) ? p.label : `${p.label.replace(/\s*\([^)]*\)\s*$/, '')}, ${w}`);
  }
  if (!out.length) {
    const basis = item.basis === 'ml' ? 'ml' : 'g';
    const l = line(item, 100, basis);
    if (!l.error) out.push({ qty: 100, unit: basis, label: `100 ${basis}`, kcal: l.nutrients.kcal });
  }
  return out;
}

const kcalOf = (v) => (num(v) === null ? 'energy unknown' : `${kcalText(v)} kcal`);

// A photo from the linked chat: read it, answer with what it shows and, for a meal or a product, the
// buttons that log it. `h` carries telegram.js's call, the bot token and an "Open Oath" button maker.
export async function foodPhoto(message, photo, h) {
  const chatId = message.chat.id;
  const send = (text, keyboard) => h.call('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard?.length ? { inline_keyboard: keyboard } : undefined,
  });
  await h.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  let result;
  try {
    const file = await h.call('getFile', { file_id: photo.fileId });
    const bytes = await download(h.token, String(file?.file_path || ''), Math.max(photo.size, Number(file?.file_size) || 0));
    const type = mediaType(bytes);
    if (!type) throw new RuleError('I can read JPEG, PNG and WebP photos. Send it as a photo rather than a file and it will work.');
    if (bytes.length > 4.5 * 1024 * 1024) throw new RuleError('That image is too big for me to read. Send it as a photo rather than a file and Telegram will shrink it.');
    // The caption is the typed hint, as "What did you eat?" would give it.
    result = await readFoodPhoto({ image: bytes.toString('base64'), media_type: type, note: String(message.caption || '').trim() });
  } catch (err) {
    if (!(err instanceof RuleError)) console.error('telegram food photo failed', err);
    await send(esc(err instanceof RuleError ? err.message : 'That did not work. Try it in the app.'));
    return;
  }
  await logEvent('telegram_food_photo', { kind: result.kind });

  if (result.kind === 'meal') {
    const { rows, left } = mealPlan(result);
    if (!rows.length) {
      await send(`I can see food, but I could not work out ${left.length ? esc(listed(left)) : 'what it is'} well enough to log. What is it, and roughly how much?`);
      return;
    }
    const pending = await hold({ kind: 'meal' });
    const ops = rows.map((r, i) => ({ op: r.op, data: { ...r.data, id: `tg-${pending.id}-${i}` } }));
    const sum = rows.reduce((a, r) => a + r.kcal, 0);
    await pending.save({ ops, kcal: sum });
    const text = [
      `<b>${esc(result.summary || 'Here is what I can see')}</b>`,
      ...rows.map((r) => `• ${esc(r.text)}: ~${kcalText(r.kcal)} kcal`),
      `Total <b>~${kcalText(sum)} kcal</b>`,
      left.length ? `I could not size up ${esc(listed(left))}, so ${left.length === 1 ? 'it is' : 'they are'} left out.` : null,
      'All estimates from the photo. Log it as it is, or change it in Oath afterwards.',
    ].filter(Boolean).join('\n');
    await send(text, [[{ text: 'Log it', callback_data: `food:log:${pending.id}` }, { text: 'Cancel', callback_data: `food:cancel:${pending.id}` }]]);
    return;
  }

  if (result.kind === 'product') {
    const it = result.item;
    const portions = portionsOf(it);
    const pending = await hold({ kind: 'product' });
    await pending.save({ key: it.key, name: it.name, portions, id: `tg-${pending.id}-0` });
    const text = [
      `Found <b>${esc(it.name)}</b>${it.brand ? ` (${esc(it.brand)})` : ''}.`,
      ...portions.map((p) => `• ${esc(p.label)}: ${kcalOf(p.kcal)}`),
      'How much did you have?',
    ].join('\n');
    const keyboard = portions.map((p, i) => [{ text: p.label, callback_data: `food:log:${pending.id}:${i}` }]);
    keyboard.push([{ text: 'Cancel', callback_data: `food:cancel:${pending.id}` }]);
    await send(text, keyboard);
    return;
  }

  if (result.kind === 'label') {
    const name = [result.draft?.brand, result.draft?.name].filter(Boolean).join(' ');
    const open = h.open?.('/#/food');
    await send(`That's a nutrition label${name ? ` for <b>${esc(name)}</b>` : ''}. Open Oath to check and save it.`, open ? [[open]] : null);
    return;
  }

  if (result.kind === 'product-unknown') {
    const what = [result.read?.brand, result.read?.name].filter(Boolean).join(' ');
    await send(`I could not find ${what ? `<b>${esc(what)}</b>` : 'that product'} in Oath or Open Food Facts${result.barcode ? ` (barcode ${esc(result.barcode)})` : ''}. Send a photo of its nutrition label and I will read that instead.`);
    return;
  }

  await send(esc(result.question || 'What is it?'));
}

// "Log it", a portion, or "Cancel" under a photo's answer. The buttons go once it is handled.
export async function foodCallback(q, { verb, id, portion }, h) {
  const chatId = q.message?.chat?.id;
  const say = async (text) => {
    await h.call('answerCallbackQuery', { callback_query_id: q.id, text: text.slice(0, 190) });
    await h.call('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await h.call('sendMessage', { chat_id: chatId, text });
  };
  const p = /^[a-f0-9]{16}$/.test(String(id || '')) ? await getKV(keyOf(id)) : null;
  if (!p || !(p.expires > Date.now())) return say('That one expired, send it again.');
  if (verb === 'cancel') {
    await db()`delete from kv where key = ${keyOf(id)}`;
    return say('Okay, not logged.');
  }
  if (verb !== 'log') return null;
  let text;
  try {
    if (p.kind === 'meal') {
      const out = [];
      for (const op of p.ops) out.push(op.op === 'quick' ? await quickAdd(op.data) : await logFood(op.data));
      const fresh = out.filter((o) => !o.duplicate);
      const slot = SLOT[out[0]?.entry?.slot] || 'today';
      text = fresh.length
        ? `Logged ${out.length} ${out.length === 1 ? 'item' : 'items'} for ${slot}, ~${kcalText(p.kcal)} kcal.`
        : 'Already logged.';
    } else {
      const pick = p.portions[Number(portion)] || p.portions[0];
      const out = await logFood({ id: p.id, key: p.key, qty: pick.qty, unit: pick.unit });
      text = out.duplicate ? 'Already logged.' : `Logged ${p.name} (${pick.label}) for ${SLOT[out.entry.slot] || 'today'}: ${kcalOf(out.entry.nutrients.kcal)}.`;
    }
  } catch (err) {
    if (!(err instanceof RuleError)) console.error('telegram food log failed', err);
    text = err instanceof RuleError ? err.message : 'That did not work. Try it in the app.';
  }
  return say(text);
}
