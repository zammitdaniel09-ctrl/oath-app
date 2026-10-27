// The tag database on the server. The rules live in public/food-tags.js and are shared with the phone;
// here every catalogue record keeps its tags (food_items.tags, worked out again whenever the rules'
// version changes), the catalogue can be browsed by tag, the diary adds his own habits, and products he
// eats are filled in from Open Food Facts (labels, allergens, additives) a few at a time.
import { Hono } from 'hono';
import { db, logEvent } from './db.js';
import { RuleError } from './engine.js';
import { shapeItem, habitStats } from './food.js';
import { productByBarcode } from './off.js';
import { TAGS, TAG, TAG_GROUPS, TAGS_VERSION } from '../public/food-tags.js';
import { KEYS, NUTRIENT } from '../public/nutrition.js';

// Works the stored tags out again for every record tagged under older rules, a thousand at a time.
// Records saved since the rules changed already carry the new ones (food.js prepareItem).
export async function retagCatalogue({ batch = 1000, log = () => {} } = {}) {
  const sql = db();
  let done = 0;
  for (;;) {
    const rows = await sql`select * from food_items where tags_v < ${TAGS_VERSION} order by id limit ${batch}`;
    if (!rows.length) break;
    const out = rows.map((r) => ({ id: r.id, tags: shapeItem(r).tags.map((t) => t.key) }));
    await sql`update food_items f set tags = array(select jsonb_array_elements_text(t.tags)), tags_v = ${TAGS_VERSION}
      from jsonb_to_recordset(${sql.json(out)}) as t(id int, tags jsonb) where f.id = t.id`;
    done += rows.length;
  }
  if (done) log(`food tags: ${done} records tagged (rules v${TAGS_VERSION})`);
  return done;
}

// Products he has logged or starred, with no facts yet from Open Food Facts (saved before Oath asked for
// labels, allergens and additives): fetched again a few at a time, inside the published rate limits
// (off.js queues every call). One that Open Food Facts no longer has is marked so it is not asked again.
export async function collectFacts({ max = 3 } = {}) {
  const rows = await db()`select key, barcode from food_items where source = 'off' and facts_at is null and barcode is not null
    and (uses > 0 or favourite) and hidden = false order by last_used desc nulls last limit ${max}`;
  let filled = 0;
  for (const r of rows) {
    const fresh = await productByBarcode(r.barcode, { refresh: true });
    if (fresh && Object.keys(fresh.facts || {}).length) filled += 1;
    await db()`update food_items set facts_at = coalesce(facts_at, now()) where key = ${r.key}`;
  }
  if (filled) await logEvent('food_facts_collected', { filled });
  return { asked: rows.length, filled };
}

// The foods that are his: every catalogue record he has logged, and his favourites, with his habits.
async function myFoods() {
  const habits = await habitStats();
  const keys = [...habits.keys()];
  if (!keys.length) return [];
  const rows = await db()`select * from food_items where key = any(${keys}) and hidden = false`;
  return rows.map((r) => shapeItem(r, habits.get(r.key) || null));
}

// Every tag, grouped, with how many of his foods and of the whole catalogue carry it.
export async function tagIndex() {
  const counts = await db()`select t as key, count(*)::int as n from food_items, unnest(tags) as t where hidden = false group by t`;
  const all = new Map(counts.map((r) => [r.key, r.n]));
  const mine = await myFoods();
  const own = new Map();
  for (const it of mine) for (const t of it.tags) own.set(t.key, (own.get(t.key) || 0) + 1);
  const [{ n }] = await db()`select count(*)::int as n from food_items where hidden = false`;
  return {
    version: TAGS_VERSION,
    total: TAGS.length,
    foods: { mine: mine.length, all: n },
    groups: TAG_GROUPS.map((g) => ({
      ...g,
      tags: TAGS.filter((t) => t.group === g.key).map((t) => ({
        key: t.key, label: t.label, tone: t.tone, about: t.about, mine: own.get(t.key) || 0, all: t.group === 'habits' ? own.get(t.key) || 0 : all.get(t.key) || 0,
      })),
    })),
  };
}

// The order a list of foods with a tag comes in: by the nutrient the tag is about ("High in iron":
// most iron first; "Low salt": least salt first), by the best share of the reference value for a
// health-claim tag, otherwise the foods he uses most. Keys and numbers come from the catalogue above,
// never from the request.
function orderOf(tag) {
  const sql = db();
  if (tag.shares?.length) {
    const parts = tag.shares.filter((k) => KEYS.includes(k) && NUTRIENT[k].ri > 0)
      .map((k) => `coalesce((nutrients->>'${k}')::float / ${Number(NUTRIENT[k].ri)}, 0)`);
    return sql.unsafe(`greatest(${parts.join(', ')}) desc, uses desc, name`);
  }
  const s = String(tag.sort || '');
  const k = s.replace(/^-/, '');
  if (KEYS.includes(k)) return sql.unsafe(`(nutrients->>'${k}')::float ${s.startsWith('-') ? 'asc' : 'desc'} nulls last, uses desc, name`);
  return sql.unsafe('uses desc, favourite desc, (kind = \'generic\') desc, length(name), name');
}

// A food as a row in a tag's list.
function row(it, tag) {
  const k = String(tag.sort || '').replace(/^-/, '');
  const share = tag.shares?.length ? Math.max(...tag.shares.map((m) => (typeof it.nutrients?.[m] === 'number' ? it.nutrients[m] / NUTRIENT[m].ri : 0))) : null;
  return {
    key: it.key, name: it.name, brand: it.brand, kind: it.kind, liquid: it.liquid, grade: it.nutriscore, uses: it.uses, favourite: it.favourite,
    kcal: it.nutrients?.kcal ?? null,
    value: KEYS.includes(k) && typeof it.nutrients?.[k] === 'number' ? { key: k, amount: it.nutrients[k], unit: NUTRIENT[k].unit } : null,
    share: share && share > 0 ? Math.round(share * 100) : null,
    why: it.tags.find((t) => t.key === tag.key)?.why || null,
  };
}

// One tag: the rule, his foods that carry it, then the best of the catalogue.
export async function tagFoods(key, { limit = 40 } = {}) {
  const tag = TAG[String(key || '')];
  if (!tag) throw new RuleError('There is no such tag.', 404);
  const mine = (await myFoods()).filter((it) => it.tags.some((t) => t.key === tag.key))
    .sort((a, b) => (b.uses || 0) - (a.uses || 0) || a.name.localeCompare(b.name));
  let all = [];
  let total = mine.length;
  if (tag.group !== 'habits') {
    const lim = Math.max(1, Math.min(100, Number(limit) || 40));
    const rows = await db()`select * from food_items where tags @> ${[tag.key]}::text[] and hidden = false order by ${orderOf(tag)} limit ${lim}`;
    const [{ n }] = await db()`select count(*)::int as n from food_items where tags @> ${[tag.key]}::text[] and hidden = false`;
    total = n;
    const own = new Set(mine.map((m) => m.key));
    all = rows.map((r) => shapeItem(r)).filter((it) => !own.has(it.key));
  }
  return {
    tag: { key: tag.key, label: tag.label, tone: tag.tone, group: tag.group, about: tag.about, groupLabel: TAG_GROUPS.find((g) => g.key === tag.group)?.label },
    total,
    mine: mine.map((it) => row(it, tag)),
    all: all.map((it) => row(it, tag)),
  };
}

export const tagApi = new Hono();
tagApi.get('/food/tags', async (c) => c.json(await tagIndex()));
tagApi.get('/food/tags/:key', async (c) => c.json(await tagFoods(c.req.param('key'), { limit: c.req.query('limit') })));
