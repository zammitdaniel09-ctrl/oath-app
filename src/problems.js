// Problem reports: when the coach refuses something, the food chat cannot read something or anything
// else breaks, Daniel taps Report a problem. The report keeps what he wrote, where he was, what just went
// wrong on his phone and, for the coach, the recent conversation. It is stored here and written to the
// server log as one line starting [problem-report], which is where it is picked up and fixed (the Railway
// logs can be read without opening the app).
import { Hono } from 'hono';
import { db, logEvent } from './db.js';
import { RuleError } from './engine.js';

export const PROBLEMS_SCHEMA = `
create table if not exists problem_reports (
  id serial primary key,
  at timestamptz not null default now(),
  kind text not null,
  route text not null default '',
  note text not null default '',
  context jsonb not null default '{}',
  status text not null default 'open'
);
`;

export async function migrateProblems() {
  await db().unsafe(PROBLEMS_SCHEMA);
}

const KINDS = ['coach', 'food-chat', 'error', 'manual'];
const clip = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// The context as sent, cut to a safe size: plain JSON only, at most about 20 KB.
function cleanContext(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return {};
  let s;
  try {
    s = JSON.stringify(x);
  } catch {
    return {};
  }
  if (s.length <= 20000) return JSON.parse(s);
  return { cut: true, head: s.slice(0, 20000) };
}

export async function reportProblem(input = {}) {
  const kind = KINDS.includes(input.kind) ? input.kind : 'manual';
  const note = clip(input.note, 1000);
  const route = clip(input.route, 200);
  const context = cleanContext(input.context);
  // For the coach, the conversation that led here, from the server's own record.
  if (kind === 'coach') {
    const msgs = await db()`select id, role, text, failed, actions, at from coach_messages order by id desc limit 8`.catch(() => []);
    context.conversation = msgs.reverse().map((m) => ({
      id: m.id, role: m.role, failed: Boolean(m.failed), at: m.at, text: clip(m.text, 1500),
      actions: (m.actions || []).map((a) => `${a.ok ? 'ok' : 'NO'}: ${clip(a.text, 200)}`),
    }));
  }
  context.version = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || null;
  const [row] = await db()`insert into problem_reports (kind, route, note, context) values (${kind}, ${route}, ${note}, ${db().json(context)}) returning id, at`;
  // One line per report in the server log, so it can be read without the app.
  console.log(`[problem-report] #${row.id} ${kind} ${route} | ${note || '(no note)'} | ${JSON.stringify(context).slice(0, 8000)}`);
  await logEvent('problem_reported', { id: row.id, kind });
  return { id: row.id, at: row.at };
}

export async function listProblems(limit = 30) {
  return db()`select id, at, kind, route, note, status from problem_reports order by id desc limit ${Math.min(100, Number(limit) || 30)}`;
}

export async function setProblemStatus(id, status) {
  if (!['open', 'fixed', 'wontfix'].includes(status)) throw new RuleError('Status is open, fixed or wontfix.');
  const [r] = await db()`update problem_reports set status = ${status} where id = ${Number(id)} returning id, status`;
  if (!r) throw new RuleError('No such problem.', 404);
  return r;
}

const jsonBody = async (c) => {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
};

export const problemsApi = new Hono();
problemsApi.post('/problems', async (c) => c.json(await reportProblem(await jsonBody(c))));
problemsApi.get('/problems', async (c) => c.json({ problems: await listProblems(c.req.query('limit')) }));
problemsApi.post('/problems/:id/status', async (c) => c.json(await setProblemStatus(c.req.param('id'), (await jsonBody(c)).status)));
