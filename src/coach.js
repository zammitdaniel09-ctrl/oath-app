// The AI accountability partner, powered by Claude.
import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.js';
import { validTime, validDate } from './time.js';
import { coachSnapshot, buildToday } from './state.js';
import { createTask, updateTask, createHabit, localNow, RuleError } from './engine.js';
import { addNode } from './goals.js';

const MODEL = () => process.env.COACH_MODEL || 'claude-sonnet-5-5';

let client = null;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

// Run once at boot: confirms the key works and the model name exists, without spending tokens.
export async function checkCoach() {
  const c = anthropic();
  if (!c) {
    console.log('coach: no ANTHROPIC_API_KEY, running on plain-number briefs');
    return;
  }
  try {
    const info = await c.models.retrieve(MODEL());
    console.log(`coach ready: ${info.id}`);
  } catch (err) {
    console.error(`coach check failed: ${err.status || ''} ${err.message}`);
  }
}

const PERSONA = `You are the accountability partner inside Oath, a personal habit and task app used by one person, Daniel.
Daniel asked for a ruthless partner. Your job is to make him do what he said he would do.

How you speak:
- Direct, short, specific. Plain sentences. No emojis, no em dashes, no hype, no therapy-speak.
- Always ground what you say in his actual data (HP, deadlines, habit strength, streaks, misses, pardon reasons, dodges). Quote numbers.
- Call out excuses and patterns plainly. Praise only what was actually earned, in one line, and frame it as commitment ("you are someone who trains"), never as permission to ease off.
- End with the single next action he should take, with a time and a place.

How Oath works (so you explain it correctly):
- Habit strength (0 to 100) grows with repetition and survives misses and deaths. Streaks reset on a miss. Treat strength as the real measure of a habit.
- One miss is an accident; the danger is the second in a row, which costs 1.5x. Keeping a habit right after a miss earns a +5 HP comeback bonus. Push the comeback hard after any miss.
- Some habits are "X times a week", settled on Sunday night. Some habits have a minimum version that saves the HP but not the clean-day bonus.
- Pardons need what got in the way plus an if-then plan. Rest days are booked in advance.

Protocols:
- Goals: when he sets or discusses a goal, walk him through WOOP one step at a time: the specific wish (with a number and a date), the best outcome, the main obstacle inside himself, and an if-then plan ("If [obstacle], then I will [action]"). Then break it into the next 3 concrete steps and offer to add them.
- After a death: no lecture. Ask what pattern caused it, agree one if-then plan, and cut the load if he took on too much.
- Weekly review: per habit say keep, adjust or drop with the reason from the numbers, name the dodge pattern, and ask for one or two focus items for the week.
- New habits: anchor them to an existing routine ("After I pour coffee") and keep them small enough to do on a bad day.

Never claim (no evidence): habits take 21 days (the median is about 66 days, anywhere from 2 weeks to 8 months), willpower is a battery that runs out, decision fatigue, leaving tasks unfinished helps you remember them, or "95% success with an accountability partner".

What you can do:
- Add tasks, add habits, add steps under a goal and reschedule normal tasks with your tools when he asks or when it clearly helps.
- You cannot mark anything as done, cannot pardon misses, and cannot move hard tasks or deadlines. Never pretend you did.

Limits:
- The app punishes with HP, streak resets and seasons. Never suggest real self-punishment, sleep deprivation, skipping meals or anything harmful.
- If he says he is genuinely ill, injured, grieving or in a crisis, drop the drill-sergeant tone, tell him to use a pardon or rest, and if it sounds serious, tell him to talk to someone he trusts or a professional.`;

const TOOLS = [
  {
    name: 'add_task',
    description: 'Add a task. Use hard=true only if Daniel wants it enforced with an HP penalty; hard tasks need a due_date and a first_step (the first physical action).',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        due_date: { type: 'string', description: 'YYYY-MM-DD, optional' },
        deadline: { type: 'string', description: 'HH:MM 24h local time, optional' },
        hard: { type: 'boolean' },
        first_step: { type: 'string' },
        estimate_min: { type: 'integer', description: 'Estimated minutes, optional' },
        goal: { type: 'string', description: 'Title of the goal this task serves, optional' },
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
    description: 'Create a habit. Either fixed days (ISO weekdays 1=Mon ... 7=Sun) with a deadline, or weekly_target for "X times a week".',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        deadline: { type: 'string', description: 'HH:MM 24h local time' },
        days: { type: 'array', items: { type: 'integer' } },
        weekly_target: { type: 'integer', description: '1 to 7, for X-times-a-week habits' },
        cue: { type: 'string', description: 'The existing routine it follows, e.g. "after I pour coffee"' },
        minimum: { type: 'string', description: 'The smallest version that still counts on a bad day' },
        non_negotiable: { type: 'boolean' },
        penalty: { type: 'integer', description: 'HP lost on a miss, 1 to 100' },
        goal: { type: 'string', description: 'Title of the goal this habit serves, optional' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_goal_step',
    description: 'Add a step (a branch in the goal\'s mind map) under one of his goals.',
    input_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Title of the goal' },
        text: { type: 'string' },
      },
      required: ['goal', 'text'],
    },
  },
];

async function goalByTitle(title) {
  if (!title) return null;
  const goals = await db()`select id, title from goals where status = 'active'`;
  const t = String(title).toLowerCase();
  return goals.find((g) => g.title.toLowerCase() === t) || goals.find((g) => g.title.toLowerCase().includes(t) || t.includes(g.title.toLowerCase())) || null;
}

async function runTool(name, input) {
  const v = { validTime, validDate };
  try {
    if (name === 'add_task') {
      const goal = await goalByTitle(input.goal);
      const t = await createTask({ ...input, goal_id: goal?.id }, v, 'coach');
      return `Added task #${t.id} "${t.title}"${t.due_date ? ` due ${t.due_date} ${t.deadline || ''}` : ''}${t.hard ? ' (hard)' : ''}${goal ? ` under "${goal.title}"` : ''}.`;
    }
    if (name === 'reschedule_task') {
      await updateTask(input.task_id, { due_date: input.due_date ?? undefined, deadline: input.deadline ?? undefined }, v, 'coach');
      return `Task #${input.task_id} rescheduled.`;
    }
    if (name === 'add_habit') {
      const goal = await goalByTitle(input.goal);
      const { habit, startsToday } = await createHabit({ ...input, goal_id: goal?.id }, v);
      return `Created habit "${habit.name}"${habit.weekly_target ? ` ${habit.weekly_target} times a week` : ` due ${habit.deadline}`}, starting ${startsToday ? 'today' : 'tomorrow'}.`;
    }
    if (name === 'add_goal_step') {
      const goal = await goalByTitle(input.goal);
      if (!goal) return 'Failed: no active goal with that title.';
      await addNode(goal.id, { text: input.text });
      return `Added "${input.text}" under "${goal.title}".`;
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

const byDeadline = (a, b) => (a.dueAt || '9').localeCompare(b.dueAt || '9');

function openDue(t) {
  return [...t.openDue].sort(byDeadline);
}

function fallbackMorning(t) {
  const open = openDue(t);
  if (!t.progress.total) return `HP ${t.game.hp}. Nothing is scheduled today. Add the habits you swear to in Plan.`;
  const yesterday = t.recentDays.length ? t.recentDays[t.recentDays.length - 1] : null;
  const parts = [];
  if (yesterday) {
    parts.push(yesterday.clean ? `Yesterday was clean. HP ${t.game.hp}.` : `Yesterday you missed ${yesterday.missed}. HP ${t.game.hp}.`);
  } else {
    parts.push(`HP ${t.game.hp}.`);
  }
  parts.push(`${open.length} ${open.length === 1 ? 'thing' : 'things'} due today, ${t.progress.atStake} HP at stake.`);
  if (open[0]) parts.push(`First deadline: ${open[0].title} at ${open[0].deadline || '23:59'}.`);
  parts.push('Open Oath and take today\'s oath.');
  return parts.join(' ');
}

function fallbackMidday(t) {
  const open = openDue(t);
  if (!t.progress.total) return 'Nothing is scheduled today yet. Add your habits in Plan so the afternoon counts.';
  if (!open.length) return `Everything due today is done by midday. ${t.game.hp} HP. Do not get lazy now.`;
  return `${t.progress.done} of ${t.progress.total} done. Next: ${open[0].title} by ${open[0].deadline || '23:59'}. ${t.progress.atStake} HP still at stake.`;
}

function fallbackEvening(t) {
  const open = openDue(t);
  if (!t.progress.total) return 'Nothing was scheduled today. Add your habits in Plan so tomorrow counts.';
  if (!open.length) return 'Everything is kept. Close the day in Oath and protect tomorrow: sleep on time.';
  const names = open.map((i) => `${i.title} (${i.deadline || '23:59'})`).join(', ');
  return `Still open: ${names}. ${t.progress.atStake} HP at stake. You have ${t.game.hp}.`;
}

const BRIEF_ASKS = {
  morning: 'Write the morning brief. First, a blunt verdict on yesterday in two sentences using the numbers. If anything was missed yesterday, name the comeback: keeping it today earns +5 HP and avoids the 1.5x second miss. Then today: list what is due in deadline order and name the one item that matters most. If he planned today\'s one thing last night, hold him to it. If it is Monday, tell him the weekly review is waiting. Tell him to take the oath with a when and a where. Under 130 words. No headings.',
  midday: 'Write the midday check-in. Say what is done, what is still open, and the one thing he must do in the next hour, with its deadline. If he has dodged something today, name it. Under 50 words.',
  evening: 'Write the evening check. Say exactly what is still open today, the deadlines, and how much HP is at stake. If everything is kept, say so in one line and tell him to close the day in the app. Under 60 words.',
};
const FALLBACKS = { morning: fallbackMorning, midday: fallbackMidday, evening: fallbackEvening };

export async function generateBrief(kind) {
  const { today } = await localNow();
  const t = await buildToday();
  let text;
  if (aiEnabled()) {
    try {
      const system = `${PERSONA}\n\nCurrent data:\n${await coachSnapshot()}`;
      text = await complete({ system, messages: [{ role: 'user', content: BRIEF_ASKS[kind] }], maxTokens: 400, tools: [] });
    } catch (err) {
      console.error('brief error', err.status || '', err.message);
    }
  }
  if (!text) text = FALLBACKS[kind](t);
  await db()`insert into briefs (date, kind, text) values (${today}, ${kind}, ${text})
             on conflict (date, kind) do update set text = excluded.text, at = now()`;
  return { text, openCount: openDue(t).length };
}

// ---------- The oath and the end of the day ----------

function fallbackPlan(t) {
  const open = openDue(t);
  const lines = [];
  if (t.plan) lines.push(`Your one thing: ${t.plan.focusTitle}.${t.plan.intention ? ` You said: "${t.plan.intention}".` : ''}`);
  if (open.length) {
    lines.push('Order of battle:');
    open.forEach((i, n) => lines.push(`${n + 1}. ${i.title}, by ${i.deadline || '23:59'}`));
  }
  lines.push('Start the first one now. Not after coffee, not after messages. Now.');
  return lines.join('\n');
}

async function writePlan(today) {
  const t = await buildToday();
  let text = null;
  if (aiEnabled()) {
    try {
      const system = `${PERSONA}\n\nCurrent data:\n${await coachSnapshot()}`;
      const ask = 'He just took today\'s oath. Write his battle plan for the rest of today: a numbered order of attack with a start time for each open item, built around his one thing and the deadlines. Then one blunt line holding him to his own words. Under 110 words. No headings.';
      text = await complete({ system, messages: [{ role: 'user', content: ask }], maxTokens: 450, tools: [] });
    } catch (err) {
      console.error('plan error', err.status || '', err.message);
    }
  }
  if (text) await db()`update day_plans set coach_plan = ${text} where date = ${today}`;
}

// Writes a plain plan immediately; when the coach is on, its own plan replaces it a few seconds later.
export async function battlePlan(today, { background = false } = {}) {
  const t = await buildToday();
  await db()`update day_plans set coach_plan = ${fallbackPlan(t)} where date = ${today}`;
  if (!aiEnabled()) return;
  const job = writePlan(today);
  if (!background) await job;
  else job.catch((err) => console.error('plan error', err.message));
}

function fallbackReflection(r, t) {
  const parts = [];
  if (r.rating <= 2) parts.push(`A ${r.rating} out of 5. Own it.`);
  else if (r.rating >= 4) parts.push(`A ${r.rating} out of 5. Good. Now repeat it tomorrow.`);
  else parts.push('A middling day. Middling days compound into a middling year.');
  if (r.blocker) parts.push(`You named "${r.blocker}" as the problem. Write down one thing that removes it before tomorrow starts.`);
  parts.push(`${t.progress.done} of ${t.progress.total} done today, ${t.game.hp} HP.`);
  return parts.join(' ');
}

export async function reflectionReply(today) {
  const [r] = await db()`select * from reflections where date = ${today}`;
  const t = await buildToday();
  let text = null;
  if (aiEnabled()) {
    try {
      const system = `${PERSONA}\n\nCurrent data:\n${await coachSnapshot()}`;
      const ask = `He just closed the day. Rating ${r.rating}/5. What got in the way: "${r.blocker || 'nothing given'}". Win: "${r.win || 'nothing given'}". Reply in under 70 words: an honest verdict on today using the numbers, the pattern you see across recent days if there is one, and exactly one change for tomorrow.`;
      text = await complete({ system, messages: [{ role: 'user', content: ask }], maxTokens: 300, tools: [] });
    } catch (err) {
      console.error('reflection error', err.status || '', err.message);
    }
  }
  if (!text) text = fallbackReflection(r, t);
  await db()`update reflections set coach_reply = ${text} where date = ${today}`;
  return text;
}

// ---------- Weekly review ----------

function fallbackWeekly(w) {
  const parts = [];
  parts.push(`Last week: ${w.cleanDays} clean ${w.cleanDays === 1 ? 'day' : 'days'} of ${w.judgedDays}${w.restDays ? ` (${w.restDays} rest)` : ''}.`);
  if (w.hpStart !== null && w.hpEnd !== null) parts.push(`HP ${w.hpStart} to ${w.hpEnd}.`);
  if (w.misses.length) parts.push(`${w.misses.length} ${w.misses.length === 1 ? 'miss' : 'misses'}${w.misses.some((m) => m.repeat) ? ', including a second miss in a row' : ''}.`);
  const sorted = [...w.habits].sort((a, b) => b.strength - a.strength);
  if (sorted.length) {
    parts.push(`Strongest: ${sorted[0].name} at ${sorted[0].strength}%.`);
    const weak = sorted[sorted.length - 1];
    if (sorted.length > 1) parts.push(`Weakest: ${weak.name} at ${weak.strength}% (${weak.trend >= 0 ? '+' : ''}${weak.trend} this week).`);
  }
  if (w.dodges.length) parts.push(`Most common reason for "Not now": "${w.dodges[0].reason}" (${w.dodges[0].n}).`);
  if (w.focusMin) parts.push(`Focus time: ${Math.floor(w.focusMin / 60)} h ${w.focusMin % 60} min.`);
  const adjust = w.habits.filter((h) => h.target && h.done / h.target < 0.5).map((h) => h.name);
  parts.push(adjust.length ? `Adjust: ${adjust.join(', ')}. Make it smaller or move its deadline, then keep it.` : 'Keep every habit as it is.');
  parts.push('Pick one or two things that matter most this week.');
  return parts.join(' ');
}

export async function writeWeeklyReview(weekStart, summary) {
  let text = null;
  if (aiEnabled()) {
    try {
      const system = `${PERSONA}\n\nCurrent data:\n${await coachSnapshot()}`;
      const ask = `Write his weekly review for the week starting ${weekStart}. Here is the week as JSON: ${JSON.stringify(summary)}. Follow the weekly review protocol. Use the numbers. For each habit give keep, adjust or drop in one short line. Name the dodge pattern if there is one. End by asking for one or two focus items for this week. Under 170 words. No headings.`;
      text = await complete({ system, messages: [{ role: 'user', content: ask }], maxTokens: 600, tools: [] });
    } catch (err) {
      console.error('weekly review error', err.status || '', err.message);
    }
  }
  if (!text) text = fallbackWeekly(summary);
  await db()`insert into weekly_reviews (week_start, coach_text) values (${weekStart}, ${text})
             on conflict (week_start) do update set coach_text = excluded.coach_text`;
  return text;
}
