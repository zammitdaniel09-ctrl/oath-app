// Quick capture from the app, Siri and the Shortcuts app.
// Shortcuts call these endpoints with a personal token: "Get Contents of URL", method POST,
// header "Authorization: Bearer <token>", JSON body {"text": "..."}. Every reply carries a
// "say" field the shortcut can speak or show.
import crypto from 'node:crypto';
import { db, logEvent } from './db.js';
import { nowUTC, validTime, validDate } from './time.js';
import { parseCapture } from '../public/parse.js';
import { localNow, createTask, completeHabit, completeTask, RuleError } from './engine.js';
import { closeFocusFor, reactionAfterDone } from './drive.js';
import { buildToday } from './state.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const v = { validTime, validDate };

function fmtDue(due, deadline, today) {
  if (!due) return '';
  const day = due === today ? 'today' : new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${due}T12:00:00Z`));
  return `, ${day}${deadline ? ` at ${deadline}` : ''}`;
}

async function matchGoal(tag) {
  if (!tag) return null;
  const goals = await db()`select id, title from goals where status = 'active'`;
  const norm = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const t = norm(tag);
  const hit = goals.find((g) => norm(g.title).startsWith(t)) || goals.find((g) => norm(g.title).includes(t));
  return hit || null;
}

export async function captureTask(raw, createdBy = 'you') {
  const { local, today } = await localNow();
  const p = parseCapture(raw, { today, now: local.toFormat('HH:mm') });
  if (!p.title) throw new RuleError('Say what the task is.');
  const goal = await matchGoal(p.goalTag);
  const title = !goal && p.goalTag ? `${p.title} #${p.goalTag}` : p.title;
  const task = await createTask({ title, due_date: p.due_date, deadline: p.deadline, estimate_min: p.estimate_min, goal_id: goal?.id }, v, createdBy);
  const say = `Added: ${task.title}${fmtDue(task.due_date, task.deadline, today)}${goal ? `, under ${goal.title}` : ''}.`;
  return { task, parsed: p, goal: goal ? { id: goal.id, title: goal.title } : null, say };
}

// ---------- Tokens ----------

export async function createToken(label = 'Shortcuts') {
  const token = `oath_${crypto.randomBytes(24).toString('base64url')}`;
  await db()`insert into api_tokens (token_hash, label, created_at) values (${sha256(token)}, ${String(label).slice(0, 60)}, ${nowUTC().toJSDate()})`;
  await logEvent('token_created', { label });
  return { token };
}

export async function revokeTokens() {
  await db()`delete from api_tokens`;
  await logEvent('tokens_revoked', {});
  return { ok: true };
}

export async function tokenCount() {
  const [{ n }] = await db()`select count(*)::int as n from api_tokens`;
  return n;
}

export async function tokenValid(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(header || '');
  if (!m) return false;
  const rows = await db()`update api_tokens set last_used = ${nowUTC().toJSDate()} where token_hash = ${sha256(m[1])} returning 1`;
  return rows.length > 0;
}

// ---------- Siri phrases ----------

const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1);

export async function doneByText(raw) {
  const t = await buildToday();
  const open = [
    ...t.items.filter((i) => i.status === 'open'),
    ...t.tasks.filter((k) => k.status === 'open' || k.status === 'missed'),
  ];
  if (!open.length) return { say: 'Nothing is open right now.' };
  const want = words(raw);
  let best = null;
  let bestScore = 0;
  for (const it of open) {
    const have = words(it.title);
    const score = want.filter((w) => have.some((h) => h.startsWith(w) || w.startsWith(h))).length / Math.max(1, want.length);
    if (score > bestScore) {
      best = it;
      bestScore = score;
    }
  }
  if (!best || bestScore < 0.5) {
    return { say: `I could not match that. Open right now: ${open.slice(0, 4).map((i) => i.title).join(', ')}.` };
  }
  if (best.kind === 'habit') await completeHabit(best.id);
  else await completeTask(best.id);
  await closeFocusFor(best.kind, best.id);
  const r = await reactionAfterDone(best.kind, best.id);
  return { say: r.text, done: { kind: best.kind, id: best.id, title: best.title } };
}

export async function nextSay() {
  const t = await buildToday();
  const g = t.game;
  if (!t.next) return { say: `Nothing open. ${g.hp} HP.` };
  const n = t.next;
  const parts = [`Next: ${n.title}`];
  if (n.deadline) parts.push(`due ${n.deadline}`);
  if (n.heavy) parts.push(`${n.penalty} HP at stake`);
  return { say: `${parts.join(', ')}. ${t.progress.done} of ${t.progress.total} done today.` };
}
