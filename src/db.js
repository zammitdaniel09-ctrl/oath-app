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
create index if not exists completions_date_idx on completions (date);
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
