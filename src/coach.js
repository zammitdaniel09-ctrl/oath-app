// The AI accountability partner, powered by Claude.
import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.js';
import { deadlineText } from './time.js';
import { coachSnapshot, buildToday } from './state.js';
import { localNow, RuleError } from './engine.js';
import { TOOL_DEFS, runTool, resolvePendingAction } from './coach-tools.js';

const MODEL = () => process.env.COACH_MODEL || 'claude-sonnet-5-5';

let client = null;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

// Lets tests stand in for the API with a scripted client.
export function setCoachClient(c) {
  client = c;
}

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
- One day can cost at most 50 HP, however much is missed, so a single bad day hurts but two in a row can end the season. Once a day has ended a season, the rest of that day costs nothing.
- Some habits are "X times a week", settled on Sunday night. Some habits have a minimum version that saves the HP but not the clean-day bonus.
- Pardons need what got in the way plus an if-then plan. Rest days are booked in advance.

Protocols:
- Goals: when he sets or discusses a goal, walk him through WOOP one step at a time: the specific wish (with a number and a date), the best outcome, the main obstacle inside himself, and an if-then plan ("If [obstacle], then I will [action]"). Then break it into the next 3 concrete steps and offer to add them.
- After a death: no lecture. Ask what pattern caused it, agree one if-then plan, and cut the load if he took on too much.
- Weekly review: per habit say keep, adjust or drop with the reason from the numbers, name the dodge pattern, and ask for one or two focus items for the week.
- New habits: anchor them to an existing routine ("After I pour coffee") and keep them small enough to do on a bad day.

Never claim (no evidence): habits take 21 days (the median is about 66 days, anywhere from 2 weeks to 8 months), willpower is a battery that runs out, decision fatigue, leaving tasks unfinished helps you remember them, or "95% success with an accountability partner".

What you can do (your tools run the app for him):
- Tasks: add, edit, move, finish, reopen, triage. Habits: add, edit, tick off (or the minimum), untick, link to Apple Health. The day: take the oath, start and stop focus blocks, log a "Not now" with its reason, close the day, pardon a miss, book or cancel rest days. Goals: create, edit, log progress, build out the map, turn steps into tasks or habits, tick steps. Settings: brief times, day end, alerts, time zone, Health targets, the game rules. The weekly review. Food: search the catalogue, log what he says he ate or drank (foods, drinks, saved meals, recipes), quick add calories, remove a diary entry.
- Food is a diary, not a game: it never touches HP, and you never invent targets, judge meals or call food good or bad. Pick the record whose state matches what he ate (cooked or dry, drained or not). If the exact branded product is not in the catalogue, say so and ask for a label photo instead of using a similar one.
- Act when he tells you to, then say what you did in one short line per action and get back to coaching. When it is unclear which item or which day he means, use find_items or ask one short question.
- Tick something done only when he says he did it. A pardon needs his own words for what got in the way and his if-then plan; never invent them.
- Deleting a task, archiving a habit, dropping a goal, deleting a goal step, changing the game rules, or dropping habits in a review wait for him to tap Confirm under your reply. Say what will happen and that it needs his tap. Never say it is done.
- Every tool follows the app's rules. If one refuses (a locked deadline, the undo window, no pardons left, the non-negotiable limit), tell him why in one line. Do not try to get around it.
- Ids are per kind: task #12, habit #3, goal #2, step #40, miss #7. The current data below shows most of them; find_items finds the rest.

Limits:
- The app punishes with HP, streak resets and seasons. Never suggest real self-punishment, sleep deprivation, skipping meals or anything harmful.
- If he says he is genuinely ill, injured, grieving or in a crisis, drop the drill-sergeant tone, tell him to use a pardon or rest, and if it sounds serious, tell him to talk to someone he trusts or a professional.`;

// Thinking counts toward max_tokens, so budgets leave room for it as well as the reply.
const CHAT_TOKENS = 16000;
const WRITING_TOKENS = 4000;

// Server-side fallback reruns a request the model declines on another model, inside the same call.
const ask = (c, params) => c.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });

// Runs the tool loop and returns { text, refused }. Text is gathered from every round, because the
// model may speak before a tool call. A reply cut off by the token limit is never returned: briefs
// fall back to plain numbers instead of sending half a sentence.
async function complete({ system, messages, maxTokens = CHAT_TOKENS, effort = 'medium', tools = TOOL_DEFS, ctx = { actions: [], pending: [] } }) {
  const c = anthropic();
  const convo = [...messages];
  const said = [];
  let budget = maxTokens;
  let retried = false;
  for (let i = 0; i < 12; i += 1) {
    const params = { model: MODEL(), max_tokens: budget, system, messages: convo, output_config: { effort } };
    if (tools.length) params.tools = tools;
    const res = await ask(c, params);
    if (res.stop_reason === 'refusal') {
      console.warn('coach declined', res.stop_details?.category || 'no category');
      return { text: said.join('\n\n'), refused: true };
    }
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const calls = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason === 'max_tokens' || (res.stop_reason === 'end_turn' && !text && !calls.length)) {
      console.warn('coach reply incomplete', res.stop_reason, `max_tokens=${budget}`);
      if (retried) return { text: said.join('\n\n'), refused: false };
      // One more try: more room after a cut-off, a fresh attempt after an empty reply.
      retried = true;
      if (res.stop_reason === 'max_tokens') budget *= 2;
      i -= 1;
      continue;
    }
    if (text) said.push(text);
    if (res.stop_reason !== 'tool_use' || !calls.length) return { text: said.join('\n\n'), refused: false };
    convo.push({ role: 'assistant', content: res.content });
    // Every result of a round goes back in one message; a failed tool is reported, never dropped.
    const results = [];
    for (const call of calls) {
      const r = await runTool(call.name, call.input || {}, ctx);
      results.push({ type: 'tool_result', tool_use_id: call.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
    }
    convo.push({ role: 'user', content: results });
  }
  return { text: said.join('\n\n') || 'I ran out of steps on that one. Ask again more specifically.', refused: false };
}

// One structured reading of an image (food photos): the coach's client, model and refusal fallback,
// with the answer held to a JSON schema. Returns the parsed object, or { refused: true }.
export async function readStructured({ system, content, schema, maxTokens = 6000 }) {
  const c = anthropic();
  if (!c) throw new RuleError('Reading photos needs the AI key, which is not set on the server.', 503);
  const res = await ask(c, {
    model: MODEL(), max_tokens: maxTokens, system, messages: [{ role: 'user', content }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
  });
  if (res.stop_reason === 'refusal') return { refused: true };
  if (res.stop_reason === 'max_tokens') throw new RuleError('The photo reading was cut off. Try a closer photo.', 502);
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new RuleError('The photo reading came back unreadable. Try again.', 502);
  }
}

// Short scheduled writing (briefs, plans, replies): low effort, plain text, no tools.
async function write(system, prompt) {
  const r = await complete({ system, messages: [{ role: 'user', content: prompt }], maxTokens: WRITING_TOKENS, effort: 'low', tools: [] });
  return r.text;
}

export async function coachHistory(limit = 60) {
  const rows = await db()`
    select m.id, m.role, m.text, m.failed, m.at, m.actions,
      (select json_agg(json_build_object('id', p.id, 'summary', p.summary, 'outcome', p.outcome,
                                         'status', case when p.status = 'open' and p.created_at < now() - interval '30 minutes' then 'expired' else p.status end)
                       order by p.id)
         from coach_pending p where p.message_id = m.id) as pending
    from coach_messages m order by m.id desc limit ${limit}`;
  return rows.reverse();
}

// What a reply did is part of what it said, so the coach remembers its own actions.
const spoken = (m) => (m.actions?.length ? `${m.text}\n[${m.actions.map((a) => (a.ok ? a.text : `failed: ${a.text}`)).join('; ')}]` : m.text);

export async function chat(userText) {
  const text = String(userText || '').trim().slice(0, 4000);
  if (!text) throw new RuleError('Write something first.');
  await db()`insert into coach_messages (role, text) values ('user', ${text})`;
  let reply;
  let failed = false;
  const ctx = { actions: [], pending: [] };
  if (!aiEnabled()) {
    reply = 'The coach is offline. Add ANTHROPIC_API_KEY to the app\'s variables on Railway and it comes alive.';
    failed = true;
  } else {
    try {
      // Failed replies stay visible in the chat but are never fed back to the model as its own words.
      const history = (await coachHistory(20)).filter((m) => !m.failed).map((m) => ({ role: m.role, content: spoken(m) }));
      // The API needs the conversation to start with the user.
      while (history.length && history[0].role !== 'user') history.shift();
      const system = `${PERSONA}\n\nCurrent data:\n${await coachSnapshot()}`;
      const r = await complete({ system, messages: history, ctx });
      // Actions taken count as an answer even if no words came back with them.
      reply = r.text || (r.refused ? 'I can\'t help with that one. Ask it another way.' : ctx.actions.length || ctx.pending.length ? 'Done.' : 'No answer came back. Try again.');
      failed = !r.text && !ctx.actions.length && !ctx.pending.length;
    } catch (err) {
      console.error('coach error', err.status || '', err.message);
      reply = `The coach could not answer (${err.status ? `API error ${err.status}` : 'connection problem'}). Check the API key and credit on your Anthropic account.`;
      failed = true;
    }
  }
  const actions = ctx.actions.length ? db().json(ctx.actions) : null;
  const [row] = await db()`insert into coach_messages (role, text, failed, actions) values ('assistant', ${reply}, ${failed}, ${actions})
                           returning id, role, text, failed, at, actions`;
  if (ctx.pending.length) await db()`update coach_pending set message_id = ${row.id} where id in ${db()(ctx.pending.map((p) => p.id))}`;
  return { ...row, pending: ctx.pending.map((p) => ({ ...p, status: 'open' })) };
}

// Daniel tapped Confirm or Cancel under a reply. The outcome joins the conversation, so the coach
// knows next time what happened.
export async function resolvePending(id, confirm) {
  const r = await resolvePendingAction(id, confirm);
  const text = r.status === 'done' ? `Done: ${r.text}.` : r.status === 'failed' ? `That did not go through: ${r.text}` : r.text;
  const actions = r.status === 'cancelled' ? null : db().json([{ ok: r.status === 'done', text: r.text }]);
  const [row] = await db()`insert into coach_messages (role, text, failed, actions) values ('assistant', ${text}, false, ${actions})
                           returning id, role, text, failed, at, actions`;
  return { ...r, message: row };
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
  if (open[0]) parts.push(`First deadline: ${open[0].title} at ${deadlineText(open[0].deadline)}.`);
  parts.push('Open Oath and take today\'s oath.');
  return parts.join(' ');
}

function fallbackMidday(t) {
  const open = openDue(t);
  if (!t.progress.total) return 'Nothing is scheduled today yet. Add your habits in Plan so the afternoon counts.';
  if (!open.length) return `Everything due today is done by midday. ${t.game.hp} HP. Do not get lazy now.`;
  return `${t.progress.done} of ${t.progress.total} done. Next: ${open[0].title} by ${deadlineText(open[0].deadline)}. ${t.progress.atStake} HP still at stake.`;
}

function fallbackEvening(t) {
  const open = openDue(t);
  if (!t.progress.total) return 'Nothing was scheduled today. Add your habits in Plan so tomorrow counts.';
  if (!open.length) return 'Everything is kept. Close the day in Oath and protect tomorrow: sleep on time.';
  const names = open.map((i) => `${i.title} (${deadlineText(i.deadline)})`).join(', ');
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
      text = await write(system, BRIEF_ASKS[kind]);
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
    open.forEach((i, n) => lines.push(`${n + 1}. ${i.title}, by ${deadlineText(i.deadline)}`));
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
      text = await write(system, ask);
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
      text = await write(system, ask);
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
  const weak = sorted[sorted.length - 1];
  // Name a strongest and weakest habit only when the numbers actually separate them.
  if (sorted.length > 1 && sorted[0].strength > weak.strength) {
    parts.push(`Strongest: ${sorted[0].name} at ${sorted[0].strength}%.`);
    parts.push(`Weakest: ${weak.name} at ${weak.strength}% (${weak.trend >= 0 ? '+' : ''}${weak.trend} this week).`);
  } else if (sorted.length > 1) {
    parts.push('Too early to rank the habits against each other.');
  }
  if (w.dodges.length) parts.push(`Most common reason for "Not now": "${w.dodges[0].reason}" (${w.dodges[0].n}).`);
  if (w.focusMin) parts.push(`Focus time: ${Math.floor(w.focusMin / 60)} h ${w.focusMin % 60} min.`);
  // A habit needs at least 3 chances in the week before it is judged.
  const adjust = w.habits.filter((h) => h.target >= 3 && h.done / h.target < 0.5).map((h) => h.name);
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
      text = await write(system, ask);
    } catch (err) {
      console.error('weekly review error', err.status || '', err.message);
    }
  }
  if (!text) text = fallbackWeekly(summary);
  await db()`insert into weekly_reviews (week_start, coach_text) values (${weekStart}, ${text})
             on conflict (week_start) do update set coach_text = excluded.coach_text`;
  return text;
}
