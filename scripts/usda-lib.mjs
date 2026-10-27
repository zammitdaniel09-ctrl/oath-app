// Shared by the two USDA builders (build-usda.mjs and build-usda-all.mjs): turning one indexed USDA food
// into Oath's nutrient set, and working out densities from USDA's own volume portions.
//
// Conversions, all deterministic and noted on the record:
// - Energy: kcal (1008), else Atwater specific (2048), else Atwater general (2047). The indexer picks it.
// - Carbs are "available carbohydrate" as on EU labels: USDA's carbohydrate by difference (1005) minus
//   fibre. Foundation Foods without a by-difference value use carbohydrate by summation (1050), which
//   already leaves fibre out.
// - Sugars are 2000, or the older total-sugars id (1063) where a food has only that.
// - Salt is sodium × 2.5, in grams.
// - Folate is the dietary folate equivalent (1190), else total folate (1177).
// - Unknown stays null. A value USDA measured as zero stays zero.
export const ML = { 'fl oz': 29.5735, cup: 236.588, tbsp: 14.7868, tsp: 4.92892 };

export const round = (v, d = 3) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

// Rounded to what the source can support, to keep the files compact: three significant figures, and
// whole numbers from 1000 up (358 mg of potassium stays 358; 12.23 g of sugars becomes 12.2).
export const sig = (v) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v);
  if (a === 0) return 0;
  const d = 2 - Math.floor(Math.log10(a));
  return Math.round(v * 10 ** d) / 10 ** d;
};

const pick = (...xs) => {
  for (const x of xs) if (x !== undefined && x !== null) return x;
  return null;
};

// The index's nutrient bag (keys like protein_g) → Oath's NUTRIENTS keys. `rounded` applies sig() to
// the nutrients added in v6 and to everything else when asked (the big file).
export function nutrientsOf(n, { rounded = false } = {}) {
  const r = rounded ? sig : (x) => x;
  const fibre = pick(n.fibre_g);
  const carbsBd = pick(n.carbs_g);
  const carbsSum = pick(n.carbs_sum_g);
  let carbs = null;
  let carbsNote = '';
  if (carbsBd !== null) {
    // By difference can come out slightly below zero for meat and fish; the honest value is zero.
    carbs = fibre === null ? Math.max(0, carbsBd) : Math.max(0, round(carbsBd - fibre));
    if (fibre === null) carbsNote = 'Carbs include fibre here (USDA has no fibre value for this food).';
  } else if (carbsSum !== null) {
    carbs = carbsSum;
  }
  const sodium = pick(n.sodium_mg);
  const folate = pick(n.folate_dfe_ug, n.folate_total_ug);
  return {
    nutrients: {
      kcal: r(pick(n.energy_kcal)),
      protein: r(pick(n.protein_g)),
      carbs: r(carbs),
      sugars: r(pick(n.sugars_g, n.sugars_old_g)),
      fat: r(pick(n.fat_g)),
      satfat: r(pick(n.sat_fat_g)),
      fibre: r(fibre),
      salt: sodium === null ? null : round((sodium * 2.5) / 1000, 4),
      caffeine: r(pick(n.caffeine_mg)),
      alcohol: r(pick(n.alcohol_g)),
      addsugars: sig(pick(n.added_sugars_g)),
      mufa: sig(pick(n.mufa_g)),
      pufa: sig(pick(n.pufa_g)),
      transfat: sig(pick(n.trans_fat_g)),
      chol: sig(pick(n.cholesterol_mg)),
      potassium: sig(pick(n.potassium_mg)),
      calcium: sig(pick(n.calcium_mg)),
      iron: sig(pick(n.iron_mg)),
      magnesium: sig(pick(n.magnesium_mg)),
      zinc: sig(pick(n.zinc_mg)),
      phosphorus: sig(pick(n.phosphorus_mg)),
      selenium: sig(pick(n.selenium_ug)),
      vita: sig(pick(n.vitamin_a_rae_ug)),
      vitc: sig(pick(n.vitamin_c_mg)),
      vitd: sig(pick(n.vitamin_d_ug)),
      vite: sig(pick(n.vitamin_e_mg)),
      vitk: sig(pick(n.vitamin_k_ug)),
      b1: sig(pick(n.thiamin_mg)),
      b2: sig(pick(n.riboflavin_mg)),
      b3: sig(pick(n.niacin_mg)),
      b6: sig(pick(n.vitamin_b6_mg)),
      folate: sig(folate),
      b12: sig(pick(n.vitamin_b12_ug)),
    },
    carbsNote,
  };
}

// The limits cleanNutrients (src/food.js) enforces per 100 g: kcal 950, caffeine 6000, g ≤ 100, mg ≤ 100000.
export function nutrientProblems(nutrients) {
  const out = [];
  const g = ['protein', 'carbs', 'sugars', 'fat', 'satfat', 'fibre', 'salt', 'alcohol', 'addsugars', 'mufa', 'pufa', 'transfat'];
  for (const [k, v] of Object.entries(nutrients)) {
    if (v === null) continue;
    if (!(v >= 0)) out.push(`${k} is ${v}`);
    else if (k === 'kcal' && v > 950) out.push(`kcal ${v} is over 950`);
    else if (g.includes(k) && v > 100) out.push(`${k} ${v} is over 100 g`);
  }
  return out;
}

// Density (g per ml) only from USDA's own volume portions, so drinks can be logged in ml without
// inventing a figure. `units` is the order of measures to try; `ml: false` leaves out containers that are
// labelled in ml (the big file uses only fl oz and cup portions).
export function densityOf(food, liquid, name, { units = null, pourable = null, ml: useMl = true } = {}) {
  if (!liquid && !(pourable && pourable.test(name))) return null;
  const order = units || (liquid ? ['fl oz', 'cup', 'tbsp', 'tsp'] : ['tbsp', 'tsp']);
  for (const unit of order) {
    for (const p of food.portions) {
      const m = p.label.match(/^(\d+(?:\.\d+)?)\s*(fl oz|cup|tbsp|tsp)\b(.*)$/i);
      if (!m || m[2].toLowerCase() !== unit) continue;
      // A glass with ice in it is not a measure of the drink.
      if (/\bwith ice\b/i.test(m[3])) continue;
      // A cup of something chopped or packed is not a measure of liquid.
      if (/chopped|sliced|diced|packed|pieces|whole|mashed|crushed|cubes|shredded|grated/i.test(m[3])) continue;
      const d = p.grams / (Number(m[1]) * ML[unit]);
      if (d > 0.5 && d < 2) return { density: Math.round(d * 10000) / 10000, from: `${p.label} = ${p.grams} g` };
    }
  }
  // One container described by its volume: "1 can 8.4 fl oz", "1 serving 12 fl oz", "240 ml".
  if (liquid) {
    for (const p of food.portions) {
      if (/\bwith ice\b/i.test(p.label)) continue;
      const oz = p.label.match(/^1\s+(?:can|bottle|serving|drink|glass|pouch|carton)\b[^\d]*(\d+(?:\.\d+)?)\s*fl oz\b/i);
      const ml = useMl ? p.label.match(/^(?:1\s+\w+\s*)?\(?(\d+(?:\.\d+)?)\s*ml\b/i) : null;
      const vol = oz ? Number(oz[1]) * ML['fl oz'] : ml ? Number(ml[1]) : null;
      if (!vol) continue;
      const d = p.grams / vol;
      if (d > 0.5 && d < 2) return { density: Math.round(d * 10000) / 10000, from: `${p.label} = ${p.grams} g` };
    }
  }
  return null;
}

// SR28's refuse table: NDB number → { pct, desc }. The inedible share (banana skin, bones, stones).
export function readRefuse(file, fs) {
  const refuse = new Map();
  const desc = fs.readFileSync(file, 'latin1');
  for (const line of desc.split(/\r?\n/)) {
    const f = line.split('^').map((x) => x.replace(/^~|~$/g, ''));
    if (f.length > 9 && Number(f[8]) > 0) refuse.set(f[0], { pct: Number(f[8]), desc: f[7] });
  }
  return refuse;
}
