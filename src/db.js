import postgres from 'postgres';

let sql = null;

export function connect(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  sql = postgres(url, {
    max: 5,
    idle_timeout: 30,
    onnotice: () => {},
    ssl: url.includes('localhost') || url.includes('127.0.0.1') || url.includes('.railway.internal') ? false : 'prefer',
  });
  return sql;
}

export function db() {
  if (!sql) throw new Error('Database not connected');
  return sql;
}

export async function close() {
  if (sql) await sql.end({ timeout: 5 });
  sql = null;
}

const SCHEMA = `
create table if not exists owner (
  id int primary key default 1,
  password_hash text not null,
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  token_hash text primary key,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create table if not exists kv (
  key text primary key,
  value jsonb not null
);
create table if not exists habits (
  id serial primary key,
  name text not null,
  notes text not null default '',
  days int[] not null default '{1,2,3,4,5,6,7}',
  deadline text not null default '23:59',
  non_negotiable boolean not null default false,
  penalty int not null default 10,
  next_rules jsonb,
  next_rules_from text,
  start_date text not null,
  archived_from text,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists completions (
  id serial primary key,
  habit_id int not null references habits(id),
  date text not null,
  note text not null default '',
  completed_at timestamptz not null default now(),
  unique (habit_id, date)
);
create table if not exists tasks (
  id serial primary key,
  title text not null,
  notes text not null default '',
  due_date text,
  deadline text,
  hard boolean not null default false,
  done_at timestamptz,
  deleted_at timestamptz,
  created_by text not null default 'you',
  created_at timestamptz not null default now()
);
create table if not exists misses (
  id serial primary key,
  kind text not null,
  ref_id int not null,
  date text not null,
  title text not null,
  hp_lost int not null,
  pardoned_at timestamptz,
  pardon_reason text,
  created_at timestamptz not null default now(),
  unique (kind, ref_id, date)
);
create table if not exists days (
  date text primary key,
  hp_end int not null,
  kept int not null,
  missed int not null,
  pardoned int not null,
  clean boolean not null,
  bonus int not null,
  judged_at timestamptz not null default now()
);
create table if not exists events (
  id bigserial primary key,
  type text not null,
  data jsonb not null default '{}',
  at timestamptz not null default now()
);
create table if not exists push_subs (
  endpoint text primary key,
  sub jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists reminders_sent (
  key text primary key,
  at timestamptz not null default now()
);
create table if not exists coach_messages (
  id bigserial primary key,
  role text not null,
  text text not null,
  at timestamptz not null default now()
);
create table if not exists briefs (
  id bigserial primary key,
  date text not null,
  kind text not null,
  text text not null,
  at timestamptz not null default now(),
  unique (date, kind)
);
create table if not exists day_plans (
  date text primary key,
  focus_kind text,
  focus_id int,
  focus_title text,
  intention text not null default '',
  coach_plan text,
  committed_at timestamptz not null
);
create table if not exists focus_sessions (
  id serial primary key,
  kind text not null,
  ref_id int not null,
  title text not null,
  date text not null,
  minutes int not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  outcome text,
  notified boolean not null default false
);
create table if not exists deferrals (
  id serial primary key,
  kind text not null,
  ref_id int not null,
  title text not null,
  date text not null,
  reason text not null,
  moved_to text,
  at timestamptz not null
);
create table if not exists reflections (
  date text primary key,
  rating int not null,
  blocker text not null default '',
  win text not null default '',
  coach_reply text,
  at timestamptz not null
);
create table if not exists telegram_updates (
  update_id bigint primary key,
  at timestamptz not null default now()
);
create index if not exists completions_date_idx on completions (date);
create index if not exists deferrals_date_idx on deferrals (date);

-- Research-driven additions (Oct 2026): cues, minimum versions, weekly targets, goals, maps, rest days.
alter table habits add column if not exists cue text not null default '';
alter table habits add column if not exists if_then text not null default '';
alter table habits add column if not exists minimum text not null default '';
alter table habits add column if not exists weekly_target int;
alter table habits add column if not exists remind_at text;
alter table habits add column if not exists goal_id int;
alter table completions add column if not exists minimum boolean not null default false;
alter table completions add column if not exists comeback boolean not null default false;
alter table tasks add column if not exists goal_id int;
alter table tasks add column if not exists node_id int;
alter table tasks add column if not exists first_step text not null default '';
alter table tasks add column if not exists estimate_min int;
alter table misses add column if not exists pardon_plan text;
alter table misses add column if not exists repeat boolean not null default false;
alter table days add column if not exists rest boolean not null default false;
alter table reflections add column if not exists tomorrow text not null default '';

create table if not exists goals (
  id serial primary key,
  title text not null,
  why text not null default '',
  obstacle text not null default '',
  plan text not null default '',
  measure text not null default 'steps',
  unit text not null default '',
  start_value double precision,
  target_value double precision,
  current_value double precision,
  target_date text,
  status text not null default 'active',
  sort int not null default 0,
  created_at timestamptz not null,
  done_at timestamptz
);
create table if not exists goal_logs (
  id serial primary key,
  goal_id int not null references goals(id),
  value double precision not null,
  note text not null default '',
  at timestamptz not null
);
create table if not exists nodes (
  id serial primary key,
  goal_id int not null references goals(id),
  parent_id int,
  text text not null,
  sort double precision not null default 0,
  kind text not null default 'idea',
  ref_id int,
  created_at timestamptz not null
);
create table if not exists rest_days (
  date text primary key,
  reason text not null default '',
  booked_at timestamptz not null
);
create table if not exists api_tokens (
  token_hash text primary key,
  label text not null default '',
  created_at timestamptz not null,
  last_used timestamptz
);
create table if not exists weekly_reviews (
  week_start text primary key,
  coach_text text,
  focus text not null default '',
  obstacle_plan text not null default '',
  decisions jsonb,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists nodes_goal_idx on nodes (goal_id);
create index if not exists tasks_goal_idx on tasks (goal_id);
create index if not exists misses_date_idx on misses (date);
create index if not exists events_at_idx on events (at);
`;

export async function migrate() {
  await db().unsafe(SCHEMA);
}

export async function getKV(key, fallback = null) {
  const rows = await db()`select value from kv where key = ${key}`;
  return rows.length ? rows[0].value : fallback;
}

export async function setKV(key, value, tx = db()) {
  await tx`insert into kv (key, value) values (${key}, ${tx.json(value)})
           on conflict (key) do update set value = excluded.value`;
}

export async function logEvent(type, data = {}, tx = db()) {
  await tx`insert into events (type, data) values (${type}, ${tx.json(data)})`;
}
