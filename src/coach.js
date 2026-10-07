// The AI accountability partner, powered by Claude.
import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.js';
import { validTime, validDate } from './time.js';
import { coachSnapshot, buildToday } from './state.js';
import { createTask, updateTask, createHabit, localNow, RuleError } from './engine.js';

const MODEL = () => process.env.COACH_MODEL || 'claude-sonnet-5-5';

let client = null;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

const PERSONA = `You are the accountability partner inside Oath, a personal habit and task app used by one person, Daniel.
Daniel asked for a ruthless partner. Your job is to make him do what he said he would do.

How you speak:
- Direct, short, specific. Plain sentences. No emojis, no em dashes, no hype, no therapy-speak.
- Always ground what you say in his actual data (HP, deadlines, streaks, misses, pardon reasons). Quote numbers.
- Call out excuses and patterns plainly. Praise only what was actually earned, in one line at most.
- End with the single next action he should take, with a time.

What you can do:
- Add tasks, add habits and reschedule normal tasks with your tools when he asks or when it clearly helps.
- You cannot mark anything as done, cannot pardon misses, and cannot move hard tasks. Never pretend you did.

Limits:
- The app punishes with HP, streak resets and seasons. Never suggest real self-punishment, sleep deprivation, skipping meals or anything harmful.
- If he says he is genuinely ill, injured, grieving or in a crisis, drop the drill-sergeant tone, tell him to use a pardon or rest, and if it sounds serious, tell him to talk to someone he trusts or a professional.`;

const TOOLS = [
  {
    name: 'add_task',
    description: 'Add a task to the list. Use hard=true only if Daniel wants it enforced with an HP penalty; hard tasks need a due_date.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        due_date: { type: 'string', description: 'YYYY-MM-DD, optional' },
        deadline: { type: 'string', description: 'HH:MM 24h local time, optional' },
        hard: { type: 'boolean' },
        notes: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'reschedule_task',
    description: 'Move a normal (not hard) task to another date or time.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer' },
        due_date: { type: 'string', description: 'YYYY-MM-DD or empty to clear' },
        deadline: { type: 'string', description: 'HH:MM or empty to clear' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'add_habit',
    description: 'Create a recurring habit. days uses ISO weekdays: 1=Mon ... 7=Sun.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        deadline: { type: 'string', description: 'HH:MM 24h local time' },
        days: { type: 'array', items: { type: 'integer' } },
        non_negotiable: { type: 'boolean' },
        penalty: { type: 'integer', description: 'HP lost on a miss, 1 to 100' },
      },
      required: ['name', 'deadline'],
    },
  },
];

async function runTool(name, input) {
  const v = { validTime, validDate };
  try {
    if (name === 'add_task') {
      const t = await createTask(input, v, 'coach');
      return `Added task #${t.id} "${t.title}"${t.due_date ? ` due ${t.due_date} ${t.deadline || ''}` : ''}${t.hard ? ' (hard)' : ''}.`;
    }
    if (name === 'reschedule_task') {
      await updateTask(input.task_id, { due_date: input.due_date ?? undefined, deadline: input.deadline ?? undefined }, v, 'coach');
      return `Task #${input.task_id} rescheduled.`;
    }
    if (name === 'add_habit') {
      const { habit, startsToday } = await createHabit(input, v);
      return `Created habit "${habit.name}" due ${habit.deadline}, starting ${startsToday ? 'today' : 'tomorrow'}.`;
    }
    return `Unknown tool ${name}.`;
  } catch (err) {
    return `Failed: ${err instanceof RuleError ? err.message : 'unexpected error'}`;
  }
}

async function complete({ system, messages, maxTokens = 900, tools = TOOLS }) {
  const c = anthropic();
  let convo = [...messages];
  for (let i = 0; i < 6; i += 1) {
    const params = { model: MODEL(), max_tokens: maxTokens, system, messages: convo };
    if (tools.length) params.tools = tools;
    const res = await c.messages.create(params);
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const calls = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !calls.length) return text;
    convo.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const call of calls) {
      results.push({ type: 'tool_result', tool_use_id: call.id, content: await runTool(call.name, call.input || {}) });
    }
    convo.push({ role: 'user', content: results });
  }
  return 'I ran out of steps on that one. Ask again more specifically.';
}

export async function coachHistory(limit = 60) {
  const rows = await db()`select id, role, text, at from coach_messages order by id desc limit ${limit}`;
  return rows.reverse();
}

export async function chat(userText) {
  const text = String(userText || '').trim().slice(0, 4000);
  if (!text) throw new RuleError('Write something first.');
  await db()`insert into coach_messages (role, text) values ('user', ${text})`;
  let reply;
  if (!aiEnabled()) {
    reply = 'The coach is offline. Add ANTHROPIC_API_KEY to the app\'s variables on Railway and it comes alive.';
  } else {
    try {
      const history = (await coachHistory(20)).map((m) => ({ role: m.role, content: m.text }));
      // The API needs alternating turns starting with the user.
      while (history.length && history[0].role !== 'user') history.shift();
      const system = `${PERSONA}\n\nCurrent data:\n${await coachSnapshot()}`;
      reply = (await complete({ system, messages: history })) || 'No answer came back. Try again.';
    } catch (err) {
      console.error('coach error', err.status || '', err.message);
      reply = `The coach could not answer (${err.status ? `API error ${err.status}` : 'connection problem'}). Check the API key and credit on your Anthropic account.`;
    }
  }
  const [row] = await db()`insert into coach_messages (role, text) values ('assistant', ${reply}) returning id, role, text, at`;
  return row;
}

// ---------- Scheduled briefs ----------

function fallbackMorning(t) {
  const open = t.items.filter((i) => i.status === 'open');
  const first = [...open].sort((a, b) => a.deadline.localeCompare(b.deadline))[0];
  const yesterday = t.recentDays.length ? t.recentDays[t.recentDays.length - 1] : null;
  const parts = [];
  if (yesterday) {
    parts.push(yesterday.clean ? `Yesterday was clean. HP ${t.game.hp}.` : `Yesterday you missed ${yesterday.missed}. HP ${t.game.hp}.`);
  } else {
    parts.push(`HP ${t.game.hp}.`);
  }
  parts.push(`${open.length} habit${open.length === 1 ? '' : 's'} today.`);
  if (first) parts.push(`First deadline: ${first.title} at ${first.deadline}.`);
  return parts.join(' ');
}

function fallbackEvening(t) {
  const open = t.items.filter((i) => i.status === 'open');
  const hard = t.tasks.filter((k) => k.heavy && k.status === 'open');
  const atStake = open.reduce((n, i) => n + i.penalty, 0) + hard.reduce((n, k) => n + k.penalty, 0);
  if (!open.length && !hard.length) return 'Everything is kept. Protect tomorrow: sleep on time.';
  const names = [...open.map((i) => `${i.title} (${i.deadline})`), ...hard.map((k) => k.title)].join(', ');
  return `Still open: ${names}. ${atStake} HP at stake. You have ${t.game.hp}.`;
}

export async function generateBrief(kind) {
  const { today } = await localNow();
  const t = await buildToday();
  let text;
  if (aiEnabled()) {
    try {
      const ask = kind === 'morning'
        ? 'Write the morning brief. First, a blunt verdict on yesterday in two sentences using the numbers. Then today: list what is due in deadline order and name the one item that matters most. Under 120 words. No headings.'
        : 'Write the evening check. Say exactly what is still open today, the deadlines, and how much HP is at stake. If everything is kept, say so in one line and tell him to protect tomorrow. Under 60 words.';
      const system = `${PERSONA}\n\nCurrent data:\n${await coachSnapshot()}`;
      text = await complete({ system, messages: [{ role: 'user', content: ask }], maxTokens: 400, tools: [] });
    } catch (err) {
      console.error('brief error', err.status || '', err.message);
    }
  }
  if (!text) text = kind === 'morning' ? fallbackMorning(t) : fallbackEvening(t);
  await db()`insert into briefs (date, kind, text) values (${today}, ${kind}, ${text})
             on conflict (date, kind) do update set text = excluded.text, at = now()`;
  return { text, openCount: t.items.filter((i) => i.status === 'open').length };
}
