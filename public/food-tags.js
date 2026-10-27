// Oath's tag database: every tag is one published rule applied to a food's own data, shared by the phone
// and the server the same way nutrition.js is. A tag never comes from a value that is unknown, and each
// one says why it is there: the number it read and the rule it met.
//
// Where the rules come from:
//  - EU nutrition claims, Regulation (EC) 1924/2006 annex: energy, fat, saturates, sugars, salt, fibre and
//    protein, the fat-quality claims, and "source of" and "high in" for each vitamin and mineral (15% and
//    30% of the nutrient reference value per 100 g, half that per 100 ml for drinks; the values are those
//    of Regulation (EU) 1169/2011 annex XIII, which nutrition.js holds as `ri`).
//  - EU-authorised health claims, Regulation (EU) 432/2012: a food that is at least a source of a nutrient
//    may say what that nutrient does ("zinc contributes to normal fertility and reproduction").
//  - UK Food Standards Agency front-of-pack traffic lights (2016), with their portion rules.
//  - The 14 allergens of Regulation (EU) 1169/2011 annex II, from the label (Open Food Facts) or, for a
//    plain food, from what its name says it is.
//  - Open Food Facts: NOVA group, Nutri-Score, Green-Score, labels, ingredients analysis and additives.
//  - Named sources for the rest: WHO (free sugars, sodium and potassium), IARC (processed meat), NHS
//    (5 A Day, oily fish, juice), UK guidance on alcohol, EFSA (caffeine), the US National Academies
//    (macronutrient ranges), the CDC (energy density) and the UK Soft Drinks Industry Levy.
//  - Oath's own rules are marked as such in their reason.
// Energy from a nutrient uses the EU factors of Regulation 1169/2011 annex XIV (kJ per g).
import { NUTRIENT, round, norm } from './nutrition.js';

// Raised whenever a rule changes, so the server works the stored tags out again (src/food-tags.js).
export const TAGS_VERSION = 1;

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const KJ_PER_KCAL = 4.184;
const KJ = { protein: 17, carbs: 17, fat: 37, fibre: 8, alcohol: 29 };
const f1 = (x, d = 1) => String(round(x, d));

// ---------- The catalogue ----------

export const TAG_GROUPS = [
  ['verdict', 'Verdict'],
  ['lights', 'Traffic lights'],
  ['claims', 'Nutrition claims'],
  ['vitamins', 'Vitamins and minerals'],
  ['body', 'What it does for you'],
  ['profile', 'Profile'],
  ['drinks', 'Drinks, caffeine and alcohol'],
  ['portion', 'Per portion'],
  ['allergens', 'Allergens'],
  ['diet', 'Diet and labels'],
  ['additives', 'Additives'],
  ['kind', 'Food group'],
  ['habits', 'Your habits'],
].map(([key, label]) => ({ key, label }));

const CATALOGUE = [];
// group, key, label, tone ('good' | 'neutral' | 'warn'), the rule in words, and the nutrient a list of
// foods with this tag is best sorted by (most first).
const def = (group, key, label, tone, about, sort = null) => CATALOGUE.push({ key, label, group, tone, about, sort });

// Verdict
def('verdict', 'good-choice', 'Good choice', 'good', 'Nutri-Score A or B (2023 algorithm, Santé publique France).');
def('verdict', 'eat-less', 'Eat less often', 'warn', 'Nutri-Score D or E (2023 algorithm, Santé publique France).');
def('verdict', 'whole-food', 'Whole food', 'good', 'NOVA group 1: unprocessed or minimally processed. A plain raw fruit, vegetable, pulse, nut or egg counts by definition.');
def('verdict', 'culinary-ingredient', 'Culinary ingredient', 'neutral', 'NOVA group 2: a processed culinary ingredient such as oil, butter, sugar or salt.');
def('verdict', 'processed', 'Processed', 'neutral', 'NOVA group 3: a processed food, such as cheese, canned fish or fresh bread.');
def('verdict', 'ultra-processed', 'Ultra-processed', 'warn', 'NOVA group 4: ultra-processed food.');
def('verdict', 'eco-low', 'Low climate impact', 'good', 'Green-Score A+, A or B (Open Food Facts, from Agribalyse life-cycle data).');
def('verdict', 'eco-mid', 'Medium climate impact', 'neutral', 'Green-Score C or D (Open Food Facts, from Agribalyse life-cycle data).');
def('verdict', 'eco-high', 'High climate impact', 'warn', 'Green-Score E or F (Open Food Facts, from Agribalyse life-cycle data).');

// Traffic lights (FSA). Green fat and green sugars are also the EU "low" claims, so they live here once.
def('lights', 'all-green', 'All green', 'good', 'Fat, saturates, sugars and salt are all green on the UK FSA front-of-pack traffic lights.');
def('lights', 'red-lights', 'Two or more reds', 'warn', 'Two or more of fat, saturates, sugars and salt are red on the UK FSA traffic lights.');
def('lights', 'fat-free', 'Fat free', 'good', 'No more than 0.5 g of fat per 100 g or 100 ml: the EU "fat-free" claim.', '-fat');
def('lights', 'low-fat', 'Low fat', 'good', 'At most 3 g of fat per 100 g, 1.5 g per 100 ml: the EU "low fat" claim and green on the FSA lights.', '-fat');
def('lights', 'medium-fat', 'Medium fat', 'neutral', 'Amber for fat on the UK FSA traffic lights: over 3 g and up to 17.5 g per 100 g (1.5 to 8.75 g per 100 ml).');
def('lights', 'high-fat', 'High fat', 'warn', 'Red for fat on the UK FSA traffic lights: over 17.5 g per 100 g (8.75 g per 100 ml), or over 30% of the reference intake in a large portion.', 'fat');
def('lights', 'saturates-free', 'Saturates free', 'good', 'No more than 0.1 g of saturates per 100 g or 100 ml: the EU "saturated fat-free" claim.', '-satfat');
def('lights', 'low-saturates', 'Low saturates', 'good', 'At most 1.5 g of saturates per 100 g (0.75 g per 100 ml): green on the UK FSA traffic lights.', '-satfat');
def('lights', 'medium-saturates', 'Medium saturates', 'neutral', 'Amber for saturates on the UK FSA traffic lights: over 1.5 g and up to 5 g per 100 g (0.75 to 2.5 g per 100 ml).');
def('lights', 'high-saturates', 'High saturates', 'warn', 'Red for saturates on the UK FSA traffic lights: over 5 g per 100 g (2.5 g per 100 ml), or over 30% of the reference intake in a large portion.', 'satfat');
def('lights', 'sugar-free', 'Sugar free', 'good', 'No more than 0.5 g of sugars per 100 g or 100 ml: the EU "sugars-free" claim. Not given to foods with no carbohydrate to speak of.', '-sugars');
def('lights', 'low-sugar', 'Low sugar', 'good', 'At most 5 g of sugars per 100 g (2.5 g per 100 ml): the EU "low sugars" claim and green on the FSA lights.', '-sugars');
def('lights', 'medium-sugar', 'Medium sugar', 'neutral', 'Amber for sugars on the UK FSA traffic lights: over 5 g and up to 22.5 g per 100 g (2.5 to 11.25 g per 100 ml).');
def('lights', 'sugar-rush', 'Sugar rush', 'warn', 'Red for sugars on the UK FSA traffic lights: over 22.5 g per 100 g (11.25 g per 100 ml), or too much in one large portion (a can of cola).', 'sugars');
def('lights', 'salt-free', 'Salt free', 'good', 'No more than 0.0125 g of salt (0.005 g of sodium) per 100 g or 100 ml: the EU "sodium-free" claim.', '-salt');
def('lights', 'very-low-salt', 'Very low salt', 'good', 'No more than 0.1 g of salt (0.04 g of sodium) per 100 g or 100 ml: the EU "very low sodium" claim.', '-salt');
def('lights', 'low-salt', 'Low salt', 'good', 'At most 0.3 g of salt per 100 g or 100 ml: the EU "low sodium" claim and green on the FSA lights.', '-salt');
def('lights', 'medium-salt', 'Medium salt', 'neutral', 'Amber for salt on the UK FSA traffic lights: over 0.3 g and up to 1.5 g per 100 g (0.75 g per 100 ml).');
def('lights', 'salty', 'Salty', 'warn', 'Red for salt on the UK FSA traffic lights: over 1.5 g per 100 g (0.75 g per 100 ml), or over 30% of the reference intake in a large portion.', 'salt');

// Nutrition claims (EU 1924/2006) beyond the lights.
def('claims', 'protein-packed', 'Protein packed', 'good', 'At least 20% of the energy comes from protein, and at least 5 g per 100 g: the EU "high protein" claim (the 5 g floor is Oath\'s, so watery vegetables do not count).', 'protein');
def('claims', 'protein-source', 'Source of protein', 'good', 'At least 12% of the energy comes from protein, and at least 3 g per 100 g: the EU "source of protein" claim (the floor is Oath\'s).', 'protein');
def('claims', 'high-fibre', 'High fibre', 'good', 'At least 6 g of fibre per 100 g: the EU "high fibre" claim.', 'fibre');
def('claims', 'source-fibre', 'Source of fibre', 'good', 'At least 3 g of fibre per 100 g: the EU "source of fibre" claim.', 'fibre');
def('claims', 'energy-free', 'Energy free', 'good', 'A drink with no more than 4 kcal per 100 ml: the EU "energy-free" claim.', '-kcal');
def('claims', 'low-energy', 'Low energy', 'good', 'At most 40 kcal per 100 g, or 20 kcal per 100 ml: the EU "low energy" claim.', '-kcal');
def('claims', 'no-added-sugar', 'No added sugar', 'good', 'No sugars added, as the record or its label says: the EU "with no added sugars" claim.');
def('claims', 'high-mufa', 'High in monounsaturated fat', 'good', 'At least 45% of the fatty acids are monounsaturated and they give over 20% of the energy: the EU claim.', 'mufa');
def('claims', 'high-pufa', 'High in polyunsaturated fat', 'good', 'At least 45% of the fatty acids are polyunsaturated and they give over 20% of the energy: the EU claim.', 'pufa');
def('claims', 'high-unsaturated', 'High in unsaturated fat', 'good', 'At least 70% of the fatty acids are unsaturated and they give over 20% of the energy: the EU claim.');

// Vitamins and minerals: "source of" and "high in", one pair per nutrient Oath tracks.
const MICRO_NAMES = {
  potassium: 'potassium', calcium: 'calcium', iron: 'iron', magnesium: 'magnesium', zinc: 'zinc', phosphorus: 'phosphorus', selenium: 'selenium',
  vita: 'vitamin A', vitc: 'vitamin C', vitd: 'vitamin D', vite: 'vitamin E', vitk: 'vitamin K', b1: 'thiamin (B1)', b2: 'riboflavin (B2)',
  b3: 'niacin (B3)', b6: 'vitamin B6', folate: 'folate', b12: 'vitamin B12',
};
export const MICRO_KEYS = Object.keys(MICRO_NAMES);
const nrvText = (k) => `${NUTRIENT[k].ri} ${NUTRIENT[k].unit}`;
for (const k of MICRO_KEYS) {
  def('vitamins', `source-${k}`, `Source of ${MICRO_NAMES[k]}`, 'good', `At least 15% of the EU reference value for ${MICRO_NAMES[k]} (${nrvText(k)}) per 100 g, or 7.5% per 100 ml in a drink: the EU "source of" claim.`, k);
  def('vitamins', `high-${k}`, `High in ${MICRO_NAMES[k]}`, 'good', `At least 30% of the EU reference value for ${MICRO_NAMES[k]} (${nrvText(k)}) per 100 g, or 15% per 100 ml in a drink: the EU "high in" claim.`, k);
}

// What it does: the EU-authorised health claims (Regulation 432/2012) a food may make once it is at least
// a source of the nutrient. Oath asks more, "high in", or nearly every food would carry them all. 'protein' means a source of protein, 'lowsodium' a low-salt food and 'unsat'
// a food high in unsaturated fat; those three claims are worded differently and are written out below.
const BODY = [
  ['immune', 'Immune system', ['vitc', 'vitd', 'vita', 'b6', 'b12', 'folate', 'zinc', 'selenium', 'iron'], 'the normal function of the immune system'],
  ['energy', 'Energy release', ['b1', 'b2', 'b3', 'b6', 'b12', 'vitc', 'iron', 'magnesium', 'phosphorus', 'calcium'], 'normal energy-yielding metabolism'],
  ['tiredness', 'Less tiredness', ['b2', 'b3', 'b6', 'b12', 'folate', 'vitc', 'iron', 'magnesium'], 'the reduction of tiredness and fatigue'],
  ['muscle-function', 'Muscle function', ['calcium', 'magnesium', 'potassium', 'vitd'], 'normal muscle function'],
  ['muscle-mass', 'Muscle mass', ['protein'], 'a growth in muscle mass and its maintenance'],
  ['bones', 'Bones', ['calcium', 'magnesium', 'phosphorus', 'vitd', 'vitk', 'zinc', 'protein'], 'the maintenance of normal bones'],
  ['teeth', 'Teeth', ['calcium', 'magnesium', 'phosphorus', 'vitd'], 'the maintenance of normal teeth'],
  ['skin', 'Skin', ['vita', 'b2', 'b3', 'zinc'], 'the maintenance of normal skin'],
  ['vision', 'Vision', ['vita', 'b2', 'zinc'], 'the maintenance of normal vision'],
  ['nerves', 'Nervous system', ['b1', 'b2', 'b3', 'b6', 'b12', 'vitc', 'potassium', 'magnesium'], 'the normal functioning of the nervous system'],
  ['mind', 'Mind', ['b1', 'b3', 'b6', 'b12', 'folate', 'vitc', 'magnesium'], 'normal psychological function'],
  ['blood', 'Red blood cells', ['iron', 'b12', 'b6', 'folate', 'b2'], 'normal red blood cells and blood formation'],
  ['heart', 'Heart', ['b1'], 'the normal function of the heart'],
  ['blood-pressure', 'Blood pressure', ['potassium', 'lowsodium'], 'the maintenance of normal blood pressure'],
  ['collagen', 'Collagen', ['vitc'], 'normal collagen formation for blood vessels, bones, cartilage, gums, skin and teeth'],
  ['cells', 'Cell protection', ['vitc', 'vite', 'b2', 'zinc', 'selenium'], 'the protection of cells from oxidative stress'],
  ['hair-nails', 'Hair and nails', ['selenium', 'zinc'], 'the maintenance of normal hair and nails'],
  ['thyroid', 'Thyroid', ['selenium'], 'normal thyroid function'],
  ['clotting', 'Blood clotting', ['vitk', 'calcium'], 'normal blood clotting'],
  ['iron-uptake', 'Iron absorption', ['vitc'], 'increases iron absorption'],
  ['cell-division', 'Cell division', ['b12', 'folate', 'iron', 'vitd', 'zinc', 'calcium', 'magnesium'], 'has a role in the process of cell division'],
  ['homocysteine', 'Homocysteine', ['b6', 'b12', 'folate'], 'normal homocysteine metabolism'],
  ['testosterone', 'Testosterone', ['zinc'], 'the maintenance of normal testosterone levels in the blood'],
  ['cognition', 'Cognitive function', ['zinc', 'iron'], 'normal cognitive function'],
  ['oxygen', 'Oxygen transport', ['iron'], 'normal oxygen transport in the body'],
  ['electrolytes', 'Electrolyte balance', ['magnesium'], 'electrolyte balance'],
  ['protein-synthesis', 'Protein synthesis', ['magnesium', 'zinc'], 'normal protein synthesis'],
  ['fertility', 'Fertility', ['zinc', 'selenium'], 'normal fertility, reproduction and spermatogenesis'],
  ['digestion', 'Digestive enzymes', ['calcium'], 'the normal function of digestive enzymes'],
  ['calcium-use', 'Calcium uptake', ['vitd'], 'the normal absorption and use of calcium and phosphorus'],
  ['membranes', 'Mucous membranes', ['vita', 'b2', 'b3'], 'the maintenance of normal mucous membranes'],
  ['cholesterol', 'Blood cholesterol', ['unsat'], 'the maintenance of normal blood cholesterol levels'],
];
// The claim as the register words it: most nutrients "contribute to" something; two are worded otherwise.
const said = (claim) => (/^(increases|has a role)/.test(claim) ? claim : `contributes to ${claim}`);
const bodyWord = (k) => (k === 'protein' ? 'protein' : k === 'lowsodium' ? 'low salt' : k === 'unsat' ? 'unsaturated fat' : MICRO_NAMES[k]);
for (const [id, label, from, claim] of BODY) {
  // A list of foods with this tag is ranked by the best of its vitamins and minerals (or by protein).
  const micros = from.filter((k) => MICRO_NAMES[k]);
  const what = from.map(bodyWord);
  const list = what.length > 1 ? `${what.slice(0, -1).join(', ')} or ${what[what.length - 1]}` : what[0];
  def('body', `helps-${id}`, label, 'good', `High in ${list}${from.includes('protein') ? ' (for protein, a source)' : ''}. EU-authorised health claims (Regulation 432/2012) say ${what.length > 1 ? 'each' : 'it'} ${said(claim)}. The law allows the claim from "source of"; Oath asks for "high in", so the tag means something.`, micros.length ? null : from.includes('protein') ? 'protein' : null);
  if (micros.length) CATALOGUE[CATALOGUE.length - 1].shares = micros;
}

// Profile
def('profile', 'very-low-density', 'Very low energy density', 'good', 'Under 0.6 kcal per gram: the "very low" energy-density band (CDC, after Rolls). Lots of food for few calories.', '-kcal');
def('profile', 'low-density', 'Low energy density', 'good', '0.6 to 1.5 kcal per gram: the "low" energy-density band (CDC, after Rolls).', '-kcal');
def('profile', 'medium-density', 'Medium energy density', 'neutral', '1.5 to 4 kcal per gram: the "medium" energy-density band (CDC, after Rolls).');
def('profile', 'energy-dense', 'Energy dense', 'neutral', 'Over 4 kcal per gram: the "high" energy-density band (CDC, after Rolls). A small amount carries a lot of energy.', 'kcal');
def('profile', 'protein-dense', 'Protein dense', 'good', 'At least 20 g of protein per 100 g (Oath\'s rule).', 'protein');
def('profile', 'lean-protein', 'Lean protein', 'good', 'At least 40% of the energy from protein and at least 10 g per 100 g (Oath\'s rule): protein without much else.', 'protein');
def('profile', 'carb-heavy', 'Carb heavy', 'neutral', 'At least 55% of the energy from carbs and at least 30 g per 100 g (Oath\'s rule).', 'carbs');
def('profile', 'no-carb', 'Zero carb', 'neutral', 'No more than 0.5 g of carbohydrate per 100 g, in a food with real energy (Oath\'s rule).');
def('profile', 'keto-friendly', 'Keto friendly', 'neutral', 'At most 5 g of net carbs (carbohydrate without fibre) per 100 g, in a food with real energy (Oath\'s rule): a normal portion stays well inside a ketogenic day.', '-carbs');
def('profile', 'quality-carb', 'Quality carbs', 'good', 'At least 1 g of fibre for every 10 g of total carbohydrate: the 10:1 ratio (Mozaffarian et al., Public Health Nutrition 2013).', 'fibre');
def('profile', 'low-fibre-carb', 'Low-fibre carbs', 'neutral', 'At least 20 g of carbs per 100 g with less than 1 g of fibre for every 10 g: misses the 10:1 ratio (Mozaffarian et al. 2013).');
def('profile', 'added-sugar-high', 'Lots of added sugar', 'warn', 'Added sugars give over 10% of the energy: the WHO free-sugars limit for a whole diet, reached by this food on its own.', 'addsugars');
def('profile', 'balanced-macros', 'Balanced macros', 'neutral', 'Protein 10 to 35%, carbs 45 to 65% and fat 20 to 35% of the energy: inside all three Acceptable Macronutrient Distribution Ranges (US National Academies).');
def('profile', 'fat-led', 'Mostly fat', 'neutral', 'At least 60% of the energy comes from fat (Oath\'s rule).', 'fat');
def('profile', 'trans-fat', 'Trans fat', 'warn', 'Over 2 g of trans fat per 100 g of fat, the EU limit for industrial trans fat (Regulation 2019/649). Not given to meat and dairy, whose trans fat is natural and exempt.', 'transfat');
def('profile', 'nutrient-dense', 'Nutrient dense', 'good', 'At least 6 of the 18 vitamins and minerals Oath tracks give 10% of their EU reference value per 100 kcal (Oath\'s rule, after Drewnowski\'s Nutrient Rich Foods index, which also counts per 100 kcal).');
def('profile', 'b-vitamins', 'B-vitamin rich', 'good', 'At least 4 of the 6 B vitamins Oath tracks reach the EU "source of" level (Oath\'s rule).');
def('profile', 'empty-calories', 'Empty calories', 'warn', 'Energy dense (200 kcal per 100 g, 30 per 100 ml) with no protein, no fibre and none of the 18 vitamins and minerals at a "source of" level, when at least 12 of them are known (Oath\'s rule).', 'kcal');
def('profile', 'potassium-sodium', 'More potassium than sodium', 'good', 'At least as much potassium as sodium, counted as the WHO counts it (molar ratio, sodium to potassium at most 1).', 'potassium');
def('profile', 'iron-vitamin-c', 'Iron with vitamin C', 'good', 'A source of iron and of vitamin C together: vitamin C increases iron absorption (EU-authorised claim, Regulation 432/2012).', 'iron');

// Drinks, caffeine and alcohol
def('drinks', 'high-caffeine', 'High caffeine', 'warn', 'Over 150 mg of caffeine per litre: the level at which EU rules (Regulation 1169/2011, annex III) require a high-caffeine warning.', 'caffeine');
def('drinks', 'caffeinated', 'Has caffeine', 'neutral', 'Has caffeine, under the EU high-caffeine level for a drink (or at least 10 mg per 100 g in a food).', 'caffeine');
def('drinks', 'caffeine-free', 'Caffeine free', 'neutral', 'A coffee, tea, cola or energy drink with no caffeine, as its record says.');
def('drinks', 'caffeine-hit', '200 mg+ caffeine a portion', 'warn', 'One portion has at least 200 mg of caffeine: the most EFSA (2015) considers safe in one go for an adult, half of the 400 mg a day.', 'caffeine');
def('drinks', 'alcohol-free', 'Alcohol free', 'good', 'A beer, wine, cider or spirit with no more than 0.05% alcohol: "alcohol-free" in UK guidance.');
def('drinks', 'low-alcohol', 'Low alcohol', 'neutral', 'Over 0.05% and no more than 1.2% alcohol by volume: "low alcohol" in UK and EU usage.');
def('drinks', 'alcoholic', 'Alcohol', 'warn', 'Over 1.2% alcohol by volume, the level from which EU rules require the strength on the label (Regulation 1169/2011).', 'alcohol');
def('drinks', 'strong-alcohol', 'Strong: 15%+', 'warn', 'At least 15% alcohol by volume: spirit and fortified-wine strength (EU Regulation 2019/787).', 'alcohol');
def('drinks', 'two-units', '2+ units a portion', 'warn', 'One portion has at least 2 UK units (16 g of alcohol). The UK Chief Medical Officers\' low-risk limit is 14 units a week.', 'alcohol');
def('drinks', 'sdil-lower', 'Sugar levy: lower band', 'warn', '5 to 8 g of sugar per 100 ml: the lower band of the UK Soft Drinks Industry Levy, for drinks with added sugar.', 'sugars');
def('drinks', 'sdil-higher', 'Sugar levy: higher band', 'warn', 'At least 8 g of sugar per 100 ml: the higher band of the UK Soft Drinks Industry Levy, for drinks with added sugar.', 'sugars');
def('drinks', 'sports-drink', 'Sports drink', 'neutral', '8 to 35 kcal per 100 ml, mostly from carbs, with 20 to 150 mg of sodium per 100 ml: the make-up of a carbohydrate-electrolyte drink in the EU-authorised claim (Regulation 432/2012).');

// Per portion
def('portion', 'portion-meal', 'A meal in one portion', 'neutral', 'One portion has at least 400 kcal: as much as a whole meal in the UK\'s 400-600-600 guide (Public Health England).');
def('portion', 'portion-100kcal', '100 kcal snack', 'good', 'One portion has no more than 100 kcal: the Change4Life "100 calorie snack" (Public Health England).');
def('portion', 'portion-protein', '20 g protein a portion', 'good', 'One portion has at least 20 g of protein, the amount studies use for a full muscle-building response at one meal (ISSN position stand, 2017).');

// Allergens: the 14 of Regulation 1169/2011 annex II.
export const ALLERGENS = [
  ['gluten', 'gluten', 'en:gluten'], ['crustaceans', 'crustaceans', 'en:crustaceans'], ['eggs', 'egg', 'en:eggs'], ['fish', 'fish', 'en:fish'],
  ['peanuts', 'peanuts', 'en:peanuts'], ['soy', 'soya', 'en:soybeans'], ['milk', 'milk', 'en:milk'], ['nuts', 'nuts', 'en:nuts'],
  ['celery', 'celery', 'en:celery'], ['mustard', 'mustard', 'en:mustard'], ['sesame', 'sesame', 'en:sesame-seeds'],
  ['sulphites', 'sulphites', 'en:sulphur-dioxide-and-sulphites'], ['lupin', 'lupin', 'en:lupin'], ['molluscs', 'molluscs', 'en:molluscs'],
];
for (const [k, word] of ALLERGENS) {
  def('allergens', `contains-${k}`, `Contains ${word}`, 'neutral', `${word[0].toUpperCase()}${word.slice(1)} is one of the 14 allergens EU labels must show (Regulation 1169/2011, annex II). From the label, or for a plain food from what it is.`);
  def('allergens', `may-contain-${k}`, `May contain ${word}`, 'neutral', `The label warns of possible traces of ${word}.`);
}

// Diet and labels
def('diet', 'vegan', 'Vegan', 'good', 'No animal ingredients: from the label, Open Food Facts\' ingredients analysis, or for a plain food its food group.');
def('diet', 'vegetarian', 'Vegetarian', 'good', 'No meat or fish: from the label, Open Food Facts\' ingredients analysis, or for a plain food its food group.');
def('diet', 'not-vegetarian', 'Meat or fish', 'neutral', 'Has meat or fish in it.');
def('diet', 'palm-oil-free', 'Palm oil free', 'good', 'No palm oil in the ingredients (Open Food Facts).');
def('diet', 'palm-oil', 'Palm oil', 'neutral', 'Palm oil is in the ingredients (Open Food Facts).');
const LABELS = [
  ['organic', 'Organic', /organic|(^|-)bio($|-)|agriculture-biologique/, 'Certified organic (the EU leaf or a national organic mark).'],
  ['fair-trade', 'Fairtrade', /fair-?trade/, 'Carries a fair-trade mark.'],
  ['rainforest-alliance', 'Rainforest Alliance', /rainforest-alliance/, 'Rainforest Alliance certified.'],
  ['sustainable-fish', 'Sustainable seafood', /msc|asc|sustainable-(seafood|fish)|dolphin-safe/, 'Carries an MSC or ASC sustainable seafood mark.'],
  ['gluten-free', 'Gluten free', /no-gluten|gluten-free/, 'Labelled gluten free: under 20 mg of gluten per kg (Regulation (EU) 828/2014).'],
  ['lactose-free', 'Lactose free', /no-lactose|lactose-free/, 'Labelled lactose free.'],
  ['halal', 'Halal', /halal/, 'Halal certified.'],
  ['kosher', 'Kosher', /kosher/, 'Kosher certified.'],
  ['no-preservatives', 'No preservatives', /no-preservatives/, 'Labelled without preservatives.'],
  ['no-colourings', 'No colourings', /no-colou?rings?|no-artificial-colou?rs?/, 'Labelled without colourings.'],
  ['no-artificial-flavours', 'No artificial flavours', /no-artificial-flavou?rs?/, 'Labelled without artificial flavourings.'],
  ['free-range', 'Free range', /free-range/, 'Labelled free range.'],
  ['non-gmo', 'GMO free', /no-gmos?|non-gmo|gmo-free/, 'Labelled free of genetically modified ingredients.'],
];
for (const [key, label, , about] of LABELS) def('diet', key, label, 'good', about);
def('diet', 'maltese', 'Maltese', 'good', 'A Maltese food: it has a Maltese name in the catalogue, is a known Maltese dish or product, or its label says it was made in Malta.');
def('diet', 'sold-in-malta', 'Sold in Malta', 'neutral', 'Open Food Facts lists it as sold in Malta.');

// Additives, from the E numbers on the label (Open Food Facts, or a label photo).
def('additives', 'no-additives', 'No additives', 'good', 'The ingredient list has no E-numbered additives.');
def('additives', 'many-additives', '5+ additives', 'warn', 'Five or more E-numbered additives in the ingredient list.');
def('additives', 'sweeteners', 'Sweeteners', 'neutral', 'Sweetened with intense sweeteners or polyols (E950 to E969, E420, E421).');
def('additives', 'aspartame', 'Aspartame', 'neutral', 'Contains aspartame (E951), a source of phenylalanine, which EU labels must say. IARC (2023): "possibly carcinogenic", group 2B; JECFA kept the acceptable intake at 40 mg per kg a day.');
def('additives', 'acesulfame-k', 'Acesulfame K', 'neutral', 'Contains acesulfame K (E950), an intense sweetener.');
def('additives', 'sucralose', 'Sucralose', 'neutral', 'Contains sucralose (E955), an intense sweetener.');
def('additives', 'stevia', 'Stevia', 'neutral', 'Contains steviol glycosides (E960), a sweetener from the stevia plant.');
def('additives', 'saccharin', 'Saccharin', 'neutral', 'Contains saccharin (E954), an intense sweetener.');
def('additives', 'cyclamate', 'Cyclamate', 'neutral', 'Contains cyclamate (E952), an intense sweetener.');
def('additives', 'polyols', 'Polyols', 'warn', 'Contains polyols (sorbitol, maltitol, xylitol, erythritol and others). Above 10% EU labels must warn that too much may have a laxative effect.');
def('additives', 'colourings', 'Colourings', 'neutral', 'Contains added colours (E100 to E199).');
def('additives', 'southampton-colours', 'Colours with a warning', 'warn', 'Contains one of the six "Southampton" colours (E102, E104, E110, E122, E124, E129). EU labels must say they may have an adverse effect on activity and attention in children (Regulation 1333/2008, annex V).');
def('additives', 'titanium-dioxide', 'Titanium dioxide', 'warn', 'Contains titanium dioxide (E171), no longer allowed in EU food since 2022 (Regulation 2022/63).');
def('additives', 'preservatives', 'Preservatives', 'neutral', 'Contains preservatives (E200 to E299).');
def('additives', 'nitrites', 'Nitrites', 'warn', 'Contains nitrites or nitrates (E249 to E252), the curing salts of processed meat.');
def('additives', 'emulsifiers', 'Emulsifiers and thickeners', 'neutral', 'Contains emulsifiers, stabilisers or thickeners (E400 to E499).');
def('additives', 'flavour-enhancers', 'Flavour enhancers', 'neutral', 'Contains flavour enhancers such as MSG (E620 to E640).');
def('additives', 'phosphates', 'Phosphates', 'neutral', 'Contains phosphoric acid or phosphates (E338 to E341, E450 to E452).');
def('additives', 'short-ingredients', '5 ingredients or fewer', 'good', 'The ingredient list has five ingredients or fewer.');
def('additives', 'long-ingredients', '20+ ingredients', 'neutral', 'The ingredient list has twenty ingredients or more.');

// Food group: from the catalogue's food group, Open Food Facts' categories, or the name.
const KIND = [
  ['fruit', 'Fruit', 'good'], ['vegetables', 'Vegetables', 'good'], ['legumes', 'Pulses', 'good'], ['five-a-day', 'Counts to 5 A Day', 'good'],
  ['leafy-greens', 'Leafy greens', 'good'], ['cruciferous', 'Cruciferous veg', 'good'], ['alliums', 'Onion family', 'good'], ['berries', 'Berries', 'good'],
  ['citrus', 'Citrus', 'good'], ['dried-fruit', 'Dried fruit', 'neutral'], ['potatoes', 'Potatoes', 'neutral'], ['wholegrain', 'Wholegrain', 'good'],
  ['bread', 'Bread', 'neutral'], ['pasta-rice', 'Pasta, rice and grains', 'neutral'], ['breakfast-cereal', 'Breakfast cereal', 'neutral'],
  ['nuts-seeds', 'Nuts and seeds', 'good'], ['dairy', 'Dairy', 'neutral'], ['cheese', 'Cheese', 'neutral'], ['eggs', 'Eggs', 'neutral'],
  ['fermented', 'Fermented', 'good'], ['red-meat', 'Red meat', 'neutral'], ['processed-meat', 'Processed meat', 'warn'], ['poultry', 'Poultry', 'neutral'],
  ['fish', 'Fish', 'good'], ['oily-fish', 'Oily fish', 'good'], ['shellfish', 'Shellfish', 'neutral'], ['complete-protein', 'Complete protein', 'good'],
  ['plant-protein', 'Plant protein', 'good'], ['protein-supplement', 'Protein supplement', 'neutral'], ['chocolate', 'Chocolate', 'neutral'],
  ['sweets', 'Sweets', 'neutral'], ['snack', 'Snack', 'neutral'], ['biscuits', 'Biscuits', 'neutral'], ['cakes-pastries', 'Cakes and pastries', 'neutral'],
  ['dessert', 'Dessert', 'neutral'], ['pizza', 'Pizza', 'neutral'], ['sandwich-burger', 'Sandwich or burger', 'neutral'], ['fast-food', 'Fast food', 'neutral'],
  ['ready-meal', 'Ready meal', 'neutral'], ['soup', 'Soup', 'neutral'], ['sauce', 'Sauce or condiment', 'neutral'], ['oils-fats', 'Oil or fat', 'neutral'],
  ['sugar-syrup', 'Sugar, syrup or spread', 'neutral'], ['herbs-spices', 'Herbs and spices', 'good'], ['water', 'Water', 'good'], ['soft-drink', 'Soft drink', 'neutral'],
  ['energy-drink', 'Energy drink', 'warn'], ['juice', 'Juice or smoothie', 'neutral'], ['coffee', 'Coffee', 'neutral'], ['tea', 'Tea', 'neutral'],
  ['plant-milk', 'Plant milk', 'neutral'], ['beer', 'Beer', 'neutral'], ['wine', 'Wine', 'neutral'], ['spirits', 'Spirit', 'neutral'],
];
const KIND_ABOUT = {
  'five-a-day': 'Fruit, vegetables or pulses that count to the NHS 5 A Day: 80 g is a portion (30 g dried fruit; 150 ml of juice, once a day; pulses once a day; potatoes do not count).',
  'red-meat': 'Beef, pork, lamb, veal, goat or game. The World Cancer Research Fund advises no more than about 350 to 500 g cooked a week.',
  'processed-meat': 'Ham, bacon, sausages, salami and other cured, salted or smoked meat. IARC (2015) classes processed meat as carcinogenic to humans, group 1.',
  'oily-fish': 'Salmon, mackerel, sardines, herring, trout, anchovies, pilchards, sprats or similar. The NHS advises a portion of oily fish a week.',
  'complete-protein': 'A source of protein that has all nine essential amino acids in useful amounts: meat, fish, eggs, dairy, soya, quinoa or buckwheat.',
  'plant-protein': 'A source of protein from plants: pulses, soya, nuts, seeds or grains.',
  juice: 'Fruit juice or a smoothie. The NHS advises no more than 150 ml a day, as the sugar in juice is free sugar.',
  'energy-drink': 'An energy drink: high caffeine, usually with sugar or sweeteners.',
  fermented: 'A fermented food, such as yoghurt, kefir, miso, kimchi, sauerkraut, kombucha or sourdough.',
  potatoes: 'Potatoes and other starchy roots: a starchy food, which the NHS does not count towards 5 A Day.',
};
for (const [key, label, tone] of KIND) def('kind', key, label, tone, KIND_ABOUT[key] || `${label}: from the food's group in the catalogue, its Open Food Facts category, or its name.`);

// Your habits: from the diary, worked out on the server (src/food-tags.js) and passed in as `habits`.
def('habits', 'my-favourite', 'Favourite', 'good', 'You starred it as a favourite.');
def('habits', 'my-staple', 'Staple', 'neutral', 'Logged on at least 15 of the last 30 days.');
def('habits', 'my-regular', 'Your regular', 'neutral', 'Logged on 4 to 14 of the last 30 days.');
for (const [slot, word] of [['breakfast', 'breakfast'], ['lunch', 'lunch'], ['dinner', 'dinner'], ['snacks', 'snack'], ['drinks', 'drink']]) {
  def('habits', `my-${slot}`, `Usual ${word}`, 'neutral', `At least 3 logs in 90 days, 60% or more of them as ${slot === 'snacks' ? 'a snack' : slot === 'drinks' ? 'a drink' : slot}.`);
}
def('habits', 'my-late-night', 'Late-night pick', 'neutral', 'At least 3 logs in 90 days, half or more of them after 21:00.');
def('habits', 'my-early', 'Early-morning pick', 'neutral', 'At least 3 logs in 90 days, half or more of them before 08:00.');
def('habits', 'my-weekend', 'Weekend food', 'neutral', 'At least 4 logs in 90 days, three quarters or more of them on a Saturday or Sunday.');
def('habits', 'my-new', 'New to you', 'neutral', 'First logged in the last 7 days.');
def('habits', 'my-not-lately', 'Not lately', 'neutral', 'Logged at least 3 times, but not in the last 30 days.');
def('habits', 'my-top-protein', 'Top protein source', 'good', 'One of the five foods that gave you the most protein in the last 30 days.');
def('habits', 'my-top-energy', 'Top energy source', 'neutral', 'One of the five foods that gave you the most energy in the last 30 days.');
def('habits', 'my-top-sugar', 'Top sugar source', 'warn', 'One of the five foods that gave you the most sugar in the last 30 days.');

export const TAGS = CATALOGUE;
export const TAG = Object.fromEntries(CATALOGUE.map((t) => [t.key, t]));
export const GROUP = Object.fromEntries(TAG_GROUPS.map((g) => [g.key, g]));

// The order tags come out in, for a row that shows only the first few: the verdict, then warnings, then
// what is good about it. Anything not listed follows by group and catalogue order.
const PRIORITY = [
  'good-choice', 'eat-less', 'ultra-processed', 'whole-food', 'processed-meat', 'alcoholic', 'strong-alcohol', 'energy-drink',
  'sugar-rush', 'salty', 'high-saturates', 'high-fat', 'high-caffeine', 'southampton-colours', 'titanium-dioxide', 'trans-fat', 'added-sugar-high', 'empty-calories',
  'protein-packed', 'protein-source', 'high-fibre', 'source-fibre', 'oily-fish', 'nutrient-dense',
  'sugar-free', 'low-sugar', 'fat-free', 'low-fat', 'saturates-free', 'low-saturates', 'salt-free', 'very-low-salt', 'low-salt', 'carb-heavy',
];
const GROUP_ORDER = Object.fromEntries(TAG_GROUPS.map((g, i) => [g.key, i]));
const RANK = Object.fromEntries(CATALOGUE.map((t, i) => [t.key, PRIORITY.includes(t.key) ? PRIORITY.indexOf(t.key) : 1000 + GROUP_ORDER[t.group] * 1000 + i]));

// ---------- Facts kept beside the nutrients ----------

// What a record knows besides its numbers, from Open Food Facts or a label photo: lists of Open Food Facts
// tags ("en:milk", "en:e951", "en:vegan"), the number of ingredients and the Green-Score. Anything else is
// dropped, so a stored record only ever holds these.
const FACT_LISTS = ['labels', 'allergens', 'traces', 'additives', 'analysis', 'categories', 'origins', 'countries'];
export function cleanFacts(x) {
  const out = {};
  if (!x || typeof x !== 'object') return out;
  for (const k of FACT_LISTS) {
    if (!Array.isArray(x[k])) continue;
    const list = [...new Set(x[k].map((s) => String(s || '').trim().toLowerCase().slice(0, 80)).filter(Boolean))].slice(0, 80);
    out[k] = list;
  }
  const n = Number(x.ingredients);
  if (Number.isInteger(n) && n >= 0 && n < 400) out.ingredients = n;
  const eco = String(x.eco || '').trim().toLowerCase();
  if (['a-plus', 'a', 'b', 'c', 'd', 'e', 'f'].includes(eco)) out.eco = eco;
  if (x.from) out.from = String(x.from).slice(0, 20);
  return out;
}

// ---------- Helpers ----------

const letter = (x) => {
  const g = String((typeof x === 'string' ? x : x?.grade) || '').toLowerCase();
  return g.length === 1 && 'abcde'.includes(g) ? g : null;
};

// The portion a drink is usually had in, in ml: the label's serving, else one of a multipack, else a can,
// bottle, glass or serving portion. Null when the record has none.
export function drinkPortionMl(it) {
  const dens = num(it.density) || 1;
  const toMl = (size, unit) => (unit === 'ml' ? size : size / dens);
  if (num(it.serving?.size) > 0) return toMl(it.serving.size, it.serving.unit);
  if (num(it.pack?.size) > 0) return toMl(it.pack.size / (num(it.pack.count) > 1 ? it.pack.count : 1), it.pack.unit);
  for (const p of it.portions || []) {
    if (!/\b(can|bottle|glass|carton|pouch|serving)\b/i.test(p?.label || '')) continue;
    const ml = num(p.ml) ?? (num(p.g) ? p.g / dens : null);
    if (ml) return ml;
  }
  return null;
}

// One portion of a food or drink as { size, label } in g (food) or ml (drink): the label's serving, one
// item of a multipack, else the first "1 something" portion that is not a measure (cup, tablespoon, ounce).
function portionOf(it, drink) {
  if (drink) {
    const ml = drinkPortionMl(it);
    return ml ? { size: ml, label: `${round(ml, 0)} ml` } : null;
  }
  const dens = num(it.density) || 1;
  const grams = (size, unit) => (unit === 'ml' ? size * dens : size);
  if (num(it.serving?.size) > 0) return { size: grams(it.serving.size, it.serving.unit), label: it.serving.label || `${round(grams(it.serving.size, it.serving.unit), 0)} g` };
  if (num(it.pack?.size) > 0 && num(it.pack.count) > 1) return { size: grams(it.pack.size / it.pack.count, it.pack.unit), label: 'one of the pack' };
  for (const p of it.portions || []) {
    const lab = String(p?.label || '');
    if (!/^(1|one|a)\b/i.test(lab) || /\b(cup|cups|tbsp|tablespoons?|tsp|teaspoons?|oz|ounces?|lb|pounds?|g|grams?|ml|fl|kg)\b/i.test(lab)) continue;
    const g = num(p.g) ?? (num(p.ml) ? p.ml * dens : null);
    if (g) return { size: g, label: lab };
  }
  return null;
}

// Names, folded by norm() to plain a-z, that say what a food is.
const RX = {
  maltese: /\b(pastizz\w*|ftira|ftajjar|qassat\w*|imqaret|mqaret|gbejn\w*|hobz|kinnie|cisk|hopleaf|lampuk\w*|timpana|bigilla|kapunata|stuffat|fenek|aljotta|kwarezimal|figoll\w*|helwa tat tork|twistees|bajtra|zeppol\w*|ravjul\w*|pudina tal hobz|soppa tal armla|bragjol\w*|kusksu|minestra|qaghaq|kannoli|galletti|zalzett\w*|imqarrun\w*|ross il forn|sfineg|maqrut|qubbajt|kwarezimal)\b/,
  milk: /\b(milk\w*|cheese\w*|cheddar|mozzarella|parmesan|parmigiano|ricotta|gbejn\w*|yogh?o?urts?|kefir|butter|buttermilk|cream|creamer|ice ?cream|custard|whey|casein|ghee|feta|halloumi|brie|camembert|gouda|edam|mascarpone|paneer|lactose|latte|cappuccino|flat white|gelato|skyr|labneh|lassi|quark|fromage)\b/,
  plantDairy: /\b(almond|oat|soy|soya|rice|coconut|cashew|hazelnut|pea|plant|peanut|nut|cocoa|shea|apple|seed|sunflower|macadamia|vegan|dairy free|non dairy)\s+(milk|butter|cream|creamer|yogh?o?urt|drink|cheese|spread)\b|\bbutter beans?\b|\bbutternut\b|\bcream of tartar\b|\bcream soda\b|\bcream crackers?\b|\bmilk thistle\b/g,
  eggs: /\b(eggs?|omelett?e|mayonnaise|mayo|meringues?|frittata|quiche|custard|egg noodles?|brioche|carbonara|hollandaise|aioli)\b/,
  eggFree: /\b(egg ?free|eggless|no egg|vegan)\b/,
  gluten: /\b(wheat|barley|rye|spelt|kamut|triticale|oats?|oatmeal|porridge|bread\w*|pasta|spaghetti|macaroni|penne|fusilli|linguine|tagliatelle|lasagne|lasagna|ravioli|ravjul\w*|tortellini|gnocchi|noodles?|couscous|kusksu|bulgh?ur|semolina|flour|biscuits?|crackers?|cakes?|pastry|pastries|pastizz\w*|qassat\w*|ftira|ftajjar|hobz|croissants?|bagels?|pizza|pitt?a|muffins?|crumpets?|pancakes?|waffles?|buns?|rolls?|beers?|lager|ale|stout|malt|seitan|breadcrumbs?|cookies?|doughnuts?|donuts?|pies?|baguettes?|ciabatta|focaccia|wafers?|pretzels?|dumplings?|farro|freekeh|bran|cereal bars?|imqarrun\w*|timpana|kannoli|galletti|twistees|qaghaq|imqaret|mqaret|figoll\w*)\b/,
  glutenFree: /\b(gluten ?free|buckwheat|rice (noodles?|flour|cakes?|paper|crackers?)|corn (tortillas?|flour|cakes?)|almond flour|coconut flour|chickpea flour|gram flour|potato flour|tapioca|cassava|rice pasta|corn pasta|maize)\b/,
  peanuts: /\b(peanuts?|groundnuts?|satay)\b/,
  nuts: /\b(almonds?|hazelnuts?|walnuts?|cashews?|pecans?|pistachios?|brazil nuts?|macadamias?|praline|marzipan|nutella|frangipane|gianduja|nougat|mixed nuts|nut butter|nut mix|qubbajt)\b/,
  soy: /\b(soy|soya|soybeans?|tofu|tempeh|edamame|miso|tamari|shoyu|natto)\b/,
  fish: /\b(fish\w*|salmon|tuna|cod|haddock|mackerel|sardines?|anchov\w*|herrings?|trout|sea ?bass|bream|swordfish|halibut|plaice|sole|pollock|hake|tilapia|catfish|carp|perch|snapper|grouper|lampuk\w*|dorado|mullet|whiting|skate|monkfish|kippers?|pilchards?|sprats?|whitebait|caviar|roe|surimi|worcestershire|caesar|aljotta)\b/,
  crustaceans: /\b(shrimps?|prawns?|crabs?|lobsters?|crayfish|langoustines?|scampi|krill)\b/,
  molluscs: /\b(mussels?|clams?|oysters?|scallops?|squid|calamari|klamari|octopus|qarnit|cuttlefish|snails?|bebbux|escargots?|whelks?|cockles?|abalone|sea urchin)\b/,
  celery: /\b(celery|celeriac)\b/,
  mustard: /\bmustard\b/,
  sesame: /\b(sesame|tahini|tahina|halva|halvah|helwa tat tork|hummus|houmous)\b/,
  sulphites: /\b(wines?|prosecco|champagne|cava|dried apricots?)\b/,
  lupin: /\blupin[es]*\b/,
  meatFish: /\b(beef|pork|lamb|veal|mutton|goat|chicken|turkey|duck|goose|quail|ham|bacon|sausages?|salami|chorizo|pepperoni|meat\w*|liver|kidney|tripe|gelatine?|lard|suet|tallow|dripping|venison|rabbit|fenek|horse|anchov\w*|fish\w*|tuna|salmon|cod|shrimps?|prawns?|crabs?|lobsters?|clams?|mussels?|oysters?|squid|octopus|broth|stock|bouillon|zalzett\w*|bragjol\w*|timpana|lampuk\w*)\b/,
  vegStock: /\b(vegetable|veggie|vegan|mushroom) (broth|stock|bouillon)\b|\bmeat ?free\b|\bmeatless\b|\bplant based\b|\bvegetarian\b|\bvegan\b/g,
  notPlain: /\b(fresh|noodles?|fried|pudding|risotto|carbonara|alfredo|lasagn\w*|pies?|cakes?|custard|sauce|prepared|with|salad|au gratin|scalloped|mashed|hash|pancakes?|fritters?|chowder|soup|creamed|glazed|breaded|battered|baked)\b/,
  animalOther: /\b(eggs?|honey|milk\w*|cheese\w*|butter|cream|yogh?o?urt|whey|casein|ghee|mayonnaise|gelatine?|lard|custard)\b/,
  processedMeat: /\b(ham|bacon|salami|sausages?|hot ?dogs?|frankfurters?|chorizo|pepperoni|corned beef|pastrami|prosciutto|mortadella|luncheon meat|spam|jerky|biltong|nduja|bresaola|kabanos|pancetta|speck|bologna|liverwurst|pate|zalzett\w*|cured meat|smoked meat)\b/,
  poultry: /\b(chicken|turkey|duck|goose|quail|poultry)\b/,
  redMeat: /\b(beef|steak|pork|lamb|veal|mutton|goat|venison|mince|burger|hamburger)\b/,
  oilyFish: /\b(salmon|mackerel|sardines?|herrings?|trout|anchov\w*|pilchards?|kippers?|sprats?|whitebait|swordfish|carp|eel)\b/,
  shellfish: /\b(shrimps?|prawns?|crabs?|lobsters?|crayfish|langoustines?|scampi|mussels?|clams?|oysters?|scallops?|squid|calamari|octopus|cuttlefish|cockles?|whelks?)\b/,
  leafy: /\b(spinach|kale|lettuce|rocket|arugula|chard|collards?|watercress|cress|endive|radicchio|bok choy|pak choi|spring greens|mustard greens|beet greens|turnip greens|dandelion|romaine|iceberg|lambs lettuce|sorrel|purslane|cabbage)\b/,
  cruciferous: /\b(broccoli|cauliflower|cabbage|kale|brussels sprouts?|bok choy|pak choi|rocket|arugula|watercress|radish\w*|turnips?|swede|rutabaga|kohlrabi|collards?|mustard greens|horseradish|wasabi)\b/,
  alliums: /\b(onions?|garlic|leeks?|shallots?|chives|spring onions?|scallions?)\b/,
  berries: /\b(strawberr\w*|blueberr\w*|raspberr\w*|blackberr\w*|cranberr\w*|gooseberr\w*|currants?|mulberr\w*|elderberr\w*|goji|acai|boysenberr\w*|lingonberr\w*)\b/,
  citrus: /\b(oranges?|lemons?|limes?|grapefruits?|mandarins?|clementines?|tangerines?|satsumas?|pomelos?|kumquats?|yuzu|bergamot)\b/,
  dried: /\b(dried|raisins?|sultanas?|prunes?|dates)\b/,
  wholegrain: /\b(whole ?grain|wholemeal|whole ?wheat|brown rice|wild rice|oats?|oatmeal|porridge|quinoa|buckwheat|bulgh?ur|barley|rye|millet|spelt|farro|freekeh|teff|amaranth|sorghum|bran)\b/,
  pulses: /\b(lentils?|chickpeas?|kidney beans?|black beans?|butter beans?|cannellini|borlotti|pinto beans?|haricot|baked beans|broad beans?|fava|split peas?|bigilla|hummus|houmous|falafel|mung beans?|adzuki|black eyed peas?)\b/,
  completePlant: /\b(soy|soya|tofu|tempeh|edamame|quinoa|buckwheat|amaranth)\b/,
  plantProtein: /\b(tofu|tempeh|seitan|pea protein|soy|soya|edamame|lentils?|chickpeas?|peanuts?|almonds?|seeds?)\b/,
  fermented: /\b(yogh?o?urt\w*|kefir|kimchi|sauerkraut|miso|tempeh|kombucha|natto|skyr|labneh|lassi|sourdough|buttermilk)\b/,
  chocolate: /\b(chocolate\w*|cocoa|nutella)\b/,
  snack: /\b(crisps|twistees|popcorn|pretzels?|nachos|tortilla chips|corn chips|potato chips)\b/,
  bread: /\b(bread\w*|hobz|ftira|ftajjar|bagels?|baguettes?|ciabatta|pitt?a|focaccia|sourdough|brioche|naan|chapati|tortillas?|wraps?)\b/,
  pizza: /\bpizza\w*\b/,
  sandwich: /\b(sandwich\w*|burgers?|hamburgers?|cheeseburgers?|panini|toastie|sub|wraps?)\b/,
  soup: /\b(soups?|broth|soppa|minestra|aljotta|chowder|bisque|gazpacho|ramen)\b/,
  dessert: /\b(ice ?cream|puddings?|pudina|tiramisu|mousse|panna cotta|custard|jelly|gelato|sorbet|trifle|cheesecake|imbuljuta)\b/,
  softDrink: /\b(cola|coke|lemonade|soda|tonic|kinnie|fanta|sprite|7 ?up|pepsi|ginger ale|squash|cordial|iced tea|ice tea|orangeade|cream soda|root beer|dr pepper|mountain dew|schweppes)\b/,
  energyDrink: /\b(red bull|monster|energy drinks?|rockstar|relentless|celsius|reign|prime energy|bang|burn|lucozade energy|v energy|nos energy|boost energy|energy shot)\b/,
  juice: /\b(juice\w*|smoothie\w*|nectar)\b/,
  coffee: /\b(coffee|espresso|latte|cappuccino|americano|macchiato|mocha|flat white|cortado|frappuccino|frappe)\b/,
  tea: /\b(tea|teas|matcha|chai|rooibos|herbal infusion)\b/,
  plantMilk: /\b(almond|oat|soy|soya|rice|coconut|cashew|hazelnut|pea) (milk|drink|beverage)\b/,
  beer: /\b(beers?|lager|ales?|stout|porter|ipa|pilsner|pils|cisk|hopleaf|shandy)\b/,
  wine: /\b(wines?|prosecco|champagne|cava|sangria|rose|merlot|chardonnay|sauvignon|pinot|shiraz)\b/,
  spirits: /\b(vodka|gin|rum|whisk(e)?y|brandy|tequila|liqueurs?|cognac|limoncello|ouzo|sambuca|absinthe|schnapps|bourbon|mezcal|grappa|aperol|campari)\b/,
  alcoholDrink: /\b(beers?|lager|ales?|stout|cider|wines?|prosecco|champagne|spritz|spirits?|vodka|gin|rum|whisk(e)?y|cocktail|cisk|0 0)\b/,
  caffeineDrink: /\b(coffee|espresso|tea|cola|coke|pepsi|energy|decaf\w*|mate|guarana|red bull|monster)\b/,
  supplement: /\b(whey|protein (powder|shake|bar|drink)s?|casein|mass gainer|isolate|creatine|pre ?workout)\b/,
  fastFood: /\b(mcdonald\w*|burger king|kfc|subway|domino\w*|pizza hut|wendy\w*|taco bell|five guys|popeyes|starbucks|costa)\b/,
};

// ---------- The rules ----------

// An ordered list of { key, label, tone, group, why } for a record ({ nutrients, basis, liquid, density,
// category, state, name, name_mt, brand, kind, source, nutriscore, nova, serving, pack, portions, facts,
// habits }). `habits` comes from the diary (src/food-tags.js) and only adds the "Your habits" tags.
export function foodTags(item) {
  const it = item || {};
  const raw = it.nutrients || {};
  const drink = Boolean(it.liquid) || it.basis === 'ml';
  // A drink held per 100 g is looked at per 100 ml, through its density (water-like when it has none).
  const k = it.basis === 'ml' || !drink ? 1 : num(it.density) || 1;
  const v = (key) => {
    const x = num(raw[key]);
    return x === null ? null : x * k;
  };
  const per = drink ? '100 ml' : '100 g';
  const facts = cleanFacts(it.facts);
  const tagsOf = (list) => new Set(facts[list] || []);
  const text = norm([it.name, it.name_mt].filter(Boolean).join(' '));
  const brand = norm(it.brand);
  const group = String(it.category || '').toLowerCase();
  const cats = tagsOf('categories');
  const offCat = (...c) => c.some((x) => cats.has(x));
  const generic = it.kind !== 'product' && it.source !== 'off';

  const out = new Map();
  const add = (key, why) => {
    if (!TAG[key]) throw new Error(`Unknown tag ${key}`);
    if (!out.has(key)) out.set(key, why);
  };

  // --- Verdict ---
  const grade = letter(it.nutriscore);
  if (grade === 'a' || grade === 'b') add('good-choice', `Nutri-Score ${grade.toUpperCase()} (2023 algorithm, Santé publique France).`);
  else if (grade === 'd' || grade === 'e') add('eat-less', `Nutri-Score ${grade.toUpperCase()} (2023 algorithm, Santé publique France).`);

  const nova = it.nova === null || it.nova === undefined ? NaN : Number(it.nova);
  if (nova === 4) add('ultra-processed', 'NOVA group 4: ultra-processed food.');
  if (nova === 3) add('processed', 'NOVA group 3: a processed food.');
  if (nova === 2) add('culinary-ingredient', 'NOVA group 2: a processed culinary ingredient.');
  if (nova === 1) add('whole-food', 'NOVA group 1: unprocessed or minimally processed.');
  else if (!Number.isFinite(nova) && ['fruit', 'vegetables', 'legumes', 'nuts and seeds', 'eggs'].includes(group) && it.state === 'raw' && !/substitute|powder|dried|flour|butter|oil/i.test(String(it.name || ''))) {
    add('whole-food', 'A plain raw fruit, vegetable, legume, nut or egg: NOVA group 1 by definition.');
  }
  if (facts.eco) {
    const e = facts.eco === 'a-plus' ? 'A+' : facts.eco.toUpperCase();
    add(['a-plus', 'a', 'b'].includes(facts.eco) ? 'eco-low' : ['c', 'd'].includes(facts.eco) ? 'eco-mid' : 'eco-high', `Green-Score ${e} (Open Food Facts).`);
  }

  // --- Energy shares ---
  const kcal = v('kcal');
  const kj = kcal !== null && kcal > 0 ? kcal * KJ_PER_KCAL : null;
  const shareOf = (g, nutrient) => (kj && g !== null ? (g * KJ[nutrient]) / kj : null);
  const pct = (x) => `${Math.round(x * 100)}%`;
  const protein = v('protein');
  const carbs = v('carbs');
  const fat = v('fat');
  const fibre = v('fibre');
  const sugars = v('sugars');
  const satfat = v('satfat');
  const salt = v('salt');
  const pShare = shareOf(protein, 'protein');
  const cShare = shareOf(carbs, 'carbs');
  const fShare = shareOf(fat, 'fat');

  // --- Protein and fibre claims ---
  let proteinSource = false;
  if (pShare !== null) {
    if (pShare >= 0.2 && protein >= 5) add('protein-packed', `At least 20% of the energy is protein (${pct(pShare)}): the EU "high protein" claim, Regulation 1924/2006.`);
    else if (pShare >= 0.12 && protein >= 3) add('protein-source', `At least 12% of the energy is protein (${pct(pShare)}): the EU "source of protein" claim, Regulation 1924/2006.`);
    proteinSource = pShare >= 0.12 && protein >= 3;
  }
  if (fibre !== null) {
    if (fibre >= 6) add('high-fibre', `${f1(fibre)} g of fibre per ${per}, at least 6 g: the EU "high fibre" claim, Regulation 1924/2006.`);
    else if (fibre >= 3) add('source-fibre', `${f1(fibre)} g of fibre per ${per}, at least 3 g: the EU "source of fibre" claim, Regulation 1924/2006.`);
  }

  // --- Traffic lights (FSA 2016), with their portion rules: a food portion over 100 g is red over 30% of
  // the reference intake, a drink portion over 150 ml over 15%. Sugars on drinks keep the old wording. ---
  const portion = portionOf(it, drink);
  const bigPortion = portion && portion.size > (drink ? 150 : 100) && (drink || num(it.serving?.size) > 0) ? portion : null;
  const LIGHTS = {
    fat: { lim: drink ? [1.5, 8.75] : [3, 17.5], ri: 70, word: 'fat' },
    satfat: { lim: drink ? [0.75, 2.5] : [1.5, 5], ri: 20, word: 'saturates' },
    sugars: { lim: drink ? [2.5, 11.25] : [5, 22.5], ri: 90, word: 'sugars' },
    salt: { lim: drink ? [0.3, 0.75] : [0.3, 1.5], ri: 6, word: 'salt' },
  };
  const light = {};
  const redWhy = {};
  for (const [key, L] of Object.entries(LIGHTS)) {
    const x = v(key);
    if (x === null) continue;
    const [lo, hi] = L.lim;
    light[key] = x <= lo ? 'green' : x > hi ? 'red' : 'amber';
    if (light[key] === 'red') redWhy[key] = `${f1(x, key === 'salt' ? 2 : 1)} g of ${L.word} per ${per}, over ${hi} g: red on the UK FSA front-of-pack traffic lights.`;
    else if (bigPortion) {
      const inPortion = (x * bigPortion.size) / 100;
      const cap = L.ri * (drink ? 0.15 : 0.3);
      if (inPortion > cap) {
        light[key] = 'red';
        redWhy[key] = `${f1(inPortion, key === 'salt' ? 2 : 1)} g of ${L.word} in a ${drink ? `${round(bigPortion.size, 0)} ml` : `${round(bigPortion.size, 0)} g`} portion, over ${f1(cap, key === 'salt' ? 2 : 1)} g: red on the UK FSA front-of-pack traffic lights (the portion rule for ${drink ? 'drinks over 150 ml' : 'portions over 100 g'}).`;
      }
    }
  }
  if (sugars !== null) {
    // Meat, fish and oils have no carbohydrate to speak of: "sugar free" says nothing about them.
    const sweetPossible = drink || carbs === null || carbs >= 1;
    const [low] = LIGHTS.sugars.lim;
    if (light.sugars === 'red') add('sugar-rush', redWhy.sugars);
    else if (sugars <= 0.5 && sweetPossible) add('sugar-free', `No more than 0.5 g of sugars per ${per}: the EU "sugars-free" claim, Regulation 1924/2006.`);
    else if (sugars <= low && sweetPossible) add('low-sugar', `${f1(sugars)} g of sugars per ${per}, at most ${low} g: green on the UK FSA front-of-pack traffic lights.`);
    else if (light.sugars === 'amber') add('medium-sugar', `${f1(sugars)} g of sugars per ${per}: amber on the UK FSA front-of-pack traffic lights.`);
  }
  if (fat !== null) {
    const [low] = LIGHTS.fat.lim;
    if (light.fat === 'red') add('high-fat', redWhy.fat);
    else if (fat <= 0.5) add('fat-free', `${f1(fat)} g of fat per ${per}, no more than 0.5 g: the EU "fat-free" claim, Regulation 1924/2006.`);
    else if (fat <= low) add('low-fat', `${f1(fat)} g of fat per ${per}, at most ${low} g: the EU "low fat" claim, Regulation 1924/2006.`);
    else add('medium-fat', `${f1(fat)} g of fat per ${per}: amber on the UK FSA front-of-pack traffic lights.`);
  }
  if (satfat !== null) {
    const [low] = LIGHTS.satfat.lim;
    if (light.satfat === 'red') add('high-saturates', redWhy.satfat);
    else if (satfat <= 0.1 && fat !== null && fat > 0.5) add('saturates-free', `${f1(satfat, 2)} g of saturates per ${per}, no more than 0.1 g: the EU "saturated fat-free" claim, Regulation 1924/2006.`);
    else if (satfat <= low) add('low-saturates', `${f1(satfat)} g of saturates per ${per}, at most ${low} g: green on the UK FSA front-of-pack traffic lights.`);
    else add('medium-saturates', `${f1(satfat)} g of saturates per ${per}: amber on the UK FSA front-of-pack traffic lights.`);
  }
  if (salt !== null) {
    if (light.salt === 'red') add('salty', redWhy.salt);
    else if (salt <= 0.0125) add('salt-free', `${f1(salt, 3)} g of salt per ${per}: the EU "sodium-free" claim (0.005 g of sodium), Regulation 1924/2006.`);
    else if (salt <= 0.1) add('very-low-salt', `${f1(salt, 2)} g of salt per ${per}, at most 0.1 g: the EU "very low sodium" claim, Regulation 1924/2006.`);
    else if (salt <= 0.3) add('low-salt', `${f1(salt, 2)} g of salt per ${per}, at most 0.3 g: green on the UK FSA traffic lights and the EU "low sodium" level.`);
    else add('medium-salt', `${f1(salt, 2)} g of salt per ${per}: amber on the UK FSA front-of-pack traffic lights.`);
  }
  const lit = Object.values(light);
  if (lit.length === 4 && lit.every((x) => x === 'green')) add('all-green', 'Fat, saturates, sugars and salt are all green on the UK FSA front-of-pack traffic lights.');
  const reds = Object.keys(light).filter((x) => light[x] === 'red');
  if (reds.length >= 2) add('red-lights', `${reds.map((x) => LIGHTS[x].word).join(', ')} are red on the UK FSA front-of-pack traffic lights.`);

  // --- Energy claims ---
  if (kcal !== null) {
    if (drink && kcal <= 4) add('energy-free', `${f1(kcal, 0)} kcal per 100 ml, no more than 4: the EU "energy-free" claim, Regulation 1924/2006.`);
    else if (kcal <= (drink ? 20 : 40) && (drink || kcal > 0)) add('low-energy', `${f1(kcal, 0)} kcal per ${per}, at most ${drink ? 20 : 40}: the EU "low energy" claim, Regulation 1924/2006.`);
  }

  // --- Added sugar ---
  const addsugars = v('addsugars');
  const noAddedLabel = tagsOf('labels').has('en:no-added-sugar') || tagsOf('labels').has('en:no-added-sugars');
  if ((addsugars === 0 && (drink || carbs === null || carbs >= 1)) || noAddedLabel) add('no-added-sugar', noAddedLabel ? 'The label says no added sugars: the EU "with no added sugars" claim, Regulation 1924/2006.' : 'The record has 0 g of added sugars: the EU "with no added sugars" claim, Regulation 1924/2006.');
  const aShare = shareOf(addsugars, 'carbs');
  if (aShare !== null && aShare > 0.1) add('added-sugar-high', `Added sugars give ${pct(aShare)} of the energy, over the 10% WHO limit for free sugars in a whole diet (2015).`);

  // --- Fat quality: share of the fatty acids (saturates + mono + poly) and of the energy ---
  const mufa = v('mufa');
  const pufa = v('pufa');
  if (satfat !== null && mufa !== null && pufa !== null && kj) {
    const fa = satfat + mufa + pufa;
    if (fa > 0) {
      const mE = shareOf(mufa, 'fat');
      const pE = shareOf(pufa, 'fat');
      if (mufa / fa >= 0.45 && mE > 0.2) add('high-mufa', `${pct(mufa / fa)} of the fatty acids are monounsaturated and they give ${pct(mE)} of the energy: the EU claim (45% and 20%), Regulation 1924/2006.`);
      if (pufa / fa >= 0.45 && pE > 0.2) add('high-pufa', `${pct(pufa / fa)} of the fatty acids are polyunsaturated and they give ${pct(pE)} of the energy: the EU claim (45% and 20%), Regulation 1924/2006.`);
      if ((mufa + pufa) / fa >= 0.7 && mE + pE > 0.2) add('high-unsaturated', `${pct((mufa + pufa) / fa)} of the fatty acids are unsaturated and they give ${pct(mE + pE)} of the energy: the EU claim (70% and 20%), Regulation 1924/2006.`);
    }
  }

  // --- Vitamins and minerals ---
  const level = drink ? 0.075 : 0.15;
  const sources = new Map();
  let microKnown = 0;
  for (const m of MICRO_KEYS) {
    const x = v(m);
    if (x === null) continue;
    microKnown += 1;
    const share = x / NUTRIENT[m].ri;
    if (share < level) continue;
    sources.set(m, share);
    const amount = `${f1(x, NUTRIENT[m].dec)} ${NUTRIENT[m].unit} of ${MICRO_NAMES[m]} per ${per}, ${pct(share)} of the EU reference value`;
    if (share >= level * 2) add(`high-${m}`, `${amount}: the EU "high in" claim (${pct(level * 2)}), Regulation 1924/2006.`);
    else add(`source-${m}`, `${amount}: the EU "source of" claim (${pct(level)}), Regulation 1924/2006.`);
  }

  // --- What it does: EU-authorised health claims ---
  const lowSodium = salt !== null && salt <= 0.3;
  const highUnsat = out.has('high-unsaturated');
  for (const [id, , from, claim] of BODY) {
    const met = from.filter((m) => (m === 'protein' ? proteinSource : m === 'lowsodium' ? lowSodium : m === 'unsat' ? highUnsat : (sources.get(m) ?? 0) >= level * 2));
    if (!met.length) continue;
    if (id === 'cholesterol') {
      add('helps-cholesterol', 'High in unsaturated fat. EU-authorised health claim (Regulation 432/2012): replacing saturated fats with unsaturated fats in the diet contributes to the maintenance of normal blood cholesterol levels.');
      continue;
    }
    const parts = met.filter((m) => !['protein', 'lowsodium'].includes(m)).sort((a, b) => sources.get(b) - sources.get(a)).slice(0, 3)
      .map((m) => `${MICRO_NAMES[m]} (${pct(sources.get(m))})`);
    if (met.includes('protein')) parts.unshift(`protein (${pct(pShare)} of the energy)`);
    const lines = [];
    const micro = met.some((m) => MICRO_NAMES[m]);
    if (parts.length) lines.push(`${micro ? 'High in' : 'A source of'} ${parts.join(', ')}${micro ? `, as shares of the EU reference values per ${per}` : ''}. EU-authorised health claim${parts.length > 1 ? 's' : ''} (Regulation 432/2012): ${parts.length > 1 ? 'each' : 'it'} ${said(claim)}.`);
    if (met.includes('lowsodium')) lines.push(`Low in salt (${f1(salt, 2)} g per ${per}). EU-authorised health claim (Regulation 432/2012): reducing the consumption of sodium ${said(claim)}.`);
    add(`helps-${id}`, lines.join(' '));
  }

  // --- Profile ---
  if (kcal !== null && !drink) {
    const d = kcal / 100;
    const dens = `${f1(d, 2)} kcal per gram`;
    if (d < 0.6) add('very-low-density', `${dens}: the "very low" energy-density band, under 0.6 (CDC, after Rolls).`);
    else if (d < 1.5) add('low-density', `${dens}: the "low" energy-density band, 0.6 to 1.5 (CDC, after Rolls).`);
    else if (d <= 4) add('medium-density', `${dens}: the "medium" energy-density band, 1.5 to 4 (CDC, after Rolls).`);
    else add('energy-dense', `${dens}: the "high" energy-density band, over 4 (CDC, after Rolls).`);
  }
  if (protein !== null && !drink && protein >= 20) add('protein-dense', `${f1(protein)} g of protein per 100 g, at least 20 g (Oath's rule).`);
  if (pShare !== null && pShare >= 0.4 && protein >= 10) add('lean-protein', `${pct(pShare)} of the energy is protein, with ${f1(protein)} g per ${per} (Oath's rule: 40% and 10 g).`);
  if (cShare !== null && carbs >= 30 && cShare >= 0.55) add('carb-heavy', `Carbs give ${pct(cShare)} of the energy and there are ${f1(carbs, 0)} g per ${per}: Oath's rule is at least 55% and 30 g.`);
  if (carbs !== null && kcal !== null && kcal >= 20) {
    if (carbs <= 0.5) add('no-carb', `${f1(carbs)} g of carbohydrate per ${per} (Oath's rule: 0.5 g or less).`);
    else if (carbs <= 5 && !drink) add('keto-friendly', `${f1(carbs)} g of net carbs per 100 g (Oath's rule: 5 g or less).`);
  }
  if (carbs !== null && fibre !== null) {
    const totalCarb = carbs + fibre;
    if (totalCarb >= 10 && fibre > 0 && totalCarb / fibre <= 10) add('quality-carb', `${f1(totalCarb)} g of total carbohydrate with ${f1(fibre)} g of fibre, a ratio of ${f1(totalCarb / fibre)} to 1: inside the 10:1 rule (Mozaffarian et al. 2013).`);
    else if (carbs >= 20 && (fibre === 0 || totalCarb / fibre > 10)) add('low-fibre-carb', `${f1(totalCarb)} g of total carbohydrate with ${f1(fibre)} g of fibre${fibre > 0 ? `, ${f1(totalCarb / fibre)} to 1` : ''}: outside the 10:1 rule (Mozaffarian et al. 2013).`);
  }
  if (pShare !== null && cShare !== null && fShare !== null && kcal >= 50) {
    if (pShare >= 0.1 && pShare <= 0.35 && cShare >= 0.45 && cShare <= 0.65 && fShare >= 0.2 && fShare <= 0.35) add('balanced-macros', `Protein ${pct(pShare)}, carbs ${pct(cShare)}, fat ${pct(fShare)} of the energy: inside the US National Academies' ranges (10–35%, 45–65%, 20–35%).`);
  }
  if (fShare !== null && fShare >= 0.6) add('fat-led', `${pct(fShare)} of the energy comes from fat (Oath's rule: 60% or more).`);
  const trans = v('transfat');
  const ruminant = ['beef', 'lamb, veal and game', 'milk', 'dairy', 'cheese'].includes(group) || offCat('en:dairies', 'en:meats', 'en:cheeses', 'en:butters');
  if (trans !== null && fat !== null && fat >= 1 && trans / fat > 0.02 && !ruminant) add('trans-fat', `${f1(trans, 2)} g of trans fat per ${per}, ${f1((trans / fat) * 100)} g per 100 g of fat: over the EU limit of 2 g (Regulation 2019/649).`);
  if (kcal !== null && kcal >= 10) {
    const rich = MICRO_KEYS.filter((m) => v(m) !== null && (v(m) / NUTRIENT[m].ri) * (100 / kcal) >= 0.1);
    if (rich.length >= 6) add('nutrient-dense', `${rich.length} of the 18 vitamins and minerals give 10% or more of their EU reference value per 100 kcal (Oath's rule: 6 or more).`);
  }
  const bCount = ['b1', 'b2', 'b3', 'b6', 'folate', 'b12'].filter((m) => sources.has(m)).length;
  if (bCount >= 4) add('b-vitamins', `${bCount} of the 6 B vitamins reach the EU "source of" level (Oath's rule: 4 or more).`);
  if (kcal !== null && kcal >= (drink ? 30 : 200) && microKnown >= 12 && sources.size === 0 && !proteinSource && (fibre === null || fibre < 3)) {
    add('empty-calories', `${f1(kcal, 0)} kcal per ${per}, but no protein, no fibre and none of the ${microKnown} known vitamins and minerals at a "source of" level (Oath's rule).`);
  }
  const potassium = v('potassium');
  if (potassium !== null && salt !== null && potassium >= 100) {
    const sodiumMg = salt * 400;
    const molar = sodiumMg / 23 / (potassium / 39.1);
    if (molar <= 1) add('potassium-sodium', `${f1(potassium, 0)} mg of potassium and ${f1(sodiumMg, 0)} mg of sodium per ${per}: a sodium-to-potassium molar ratio of ${f1(molar, 2)}, at most 1 as the WHO advises.`);
  }
  if (sources.has('iron') && sources.has('vitc')) add('iron-vitamin-c', `A source of iron (${pct(sources.get('iron'))}) and vitamin C (${pct(sources.get('vitc'))}): vitamin C increases iron absorption (EU-authorised claim, Regulation 432/2012).`);

  // --- Caffeine and alcohol ---
  const caffeine = v('caffeine');
  const isCoffeeTea = RX.coffee.test(text) || RX.tea.test(text) || group === 'coffee and tea';
  if (caffeine !== null) {
    if (drink && caffeine * 10 > 150) add('high-caffeine', `${f1(caffeine * 10, 0)} mg of caffeine per litre, over 150 mg: the level at which EU rules (Regulation 1169/2011, annex III) require a high-caffeine warning on drinks${isCoffeeTea ? ' (coffee and tea named as such are exempt from the warning, not from the caffeine)' : ''}.`);
    else if ((drink && caffeine > 0) || (!drink && caffeine >= 10)) add('caffeinated', `${f1(caffeine, 0)} mg of caffeine per ${per}.`);
    else if (caffeine === 0 && RX.caffeineDrink.test(text)) add('caffeine-free', `The record has 0 mg of caffeine per ${per}.`);
    if (drink && portion && (caffeine * portion.size) / 100 >= 200) add('caffeine-hit', `${f1((caffeine * portion.size) / 100, 0)} mg of caffeine in a ${round(portion.size, 0)} ml portion: at least 200 mg, the most EFSA (2015) considers safe in one go.`);
  }
  const alcohol = v('alcohol');
  if (alcohol !== null && drink) {
    const abv = alcohol / 0.789;
    if (abv <= 0.05) {
      if (RX.alcoholDrink.test(text) || group === 'alcoholic drinks') add('alcohol-free', `${f1(abv, 2)}% alcohol by volume: "alcohol-free" in UK guidance (0.05% or less).`);
    } else if (abv <= 1.2) add('low-alcohol', `${f1(abv)}% alcohol by volume: "low alcohol" (1.2% or less).`);
    else {
      add('alcoholic', `${f1(abv)}% alcohol by volume (${f1(alcohol)} g per 100 ml).`);
      if (abv >= 15) add('strong-alcohol', `${f1(abv)}% alcohol by volume: spirit or fortified-wine strength (15% or more).`);
    }
    if (portion && (alcohol * portion.size) / 100 >= 16) add('two-units', `${f1((alcohol * portion.size) / 100 / 8)} UK units (${f1((alcohol * portion.size) / 100, 0)} g of alcohol) in a ${round(portion.size, 0)} ml portion.`);
  }

  // --- Drinks ---
  const abvNow = alcohol !== null ? alcohol / 0.789 : 0;
  const levyExempt = ['milk', 'plant milks', 'dairy', 'fruit juice', 'alcoholic drinks'].includes(group) || /\b(juice|milk|smoothie|yogh?o?urt|kefir|latte|shake|lassi)\b/.test(text) || abvNow > 1.2 || RX.alcoholDrink.test(text);
  if (drink && sugars !== null && !levyExempt) {
    if (sugars >= 8) add('sdil-higher', `${f1(sugars)} g of sugar per 100 ml: the higher band of the UK Soft Drinks Industry Levy (8 g or more), if the sugar is added.`);
    else if (sugars >= 5) add('sdil-lower', `${f1(sugars)} g of sugar per 100 ml: the lower band of the UK Soft Drinks Industry Levy (5 to 8 g), if the sugar is added.`);
  }
  if (drink && kcal !== null && carbs !== null && salt !== null && kcal >= 8 && kcal <= 35) {
    const sodiumMg = salt * 400;
    const cs = cShare ?? 0;
    if (cs >= 0.75 && sodiumMg >= 20 && sodiumMg <= 150) add('sports-drink', `${f1(kcal, 0)} kcal per 100 ml, ${pct(cs)} of it from carbs, with ${f1(sodiumMg, 0)} mg of sodium: the make-up of a carbohydrate-electrolyte drink in the EU-authorised claim (Regulation 432/2012). Osmolality is not on the record.`);
  }

  // --- Per portion ---
  if (portion && kcal !== null) {
    const pk = (kcal * portion.size) / 100;
    if (pk >= 400) add('portion-meal', `${f1(pk, 0)} kcal in ${portion.label}: a meal's worth in the UK's 400-600-600 guide.`);
    else if (pk > 0 && pk <= 100 && !drink) add('portion-100kcal', `${f1(pk, 0)} kcal in ${portion.label}: a "100 calorie snack" (Change4Life).`);
  }
  if (portion && protein !== null && (protein * portion.size) / 100 >= 20) add('portion-protein', `${f1((protein * portion.size) / 100, 0)} g of protein in ${portion.label}: at least 20 g.`);

  // --- Allergens ---
  const allergens = tagsOf('allergens');
  const traces = tagsOf('traces');
  const additives = [...tagsOf('additives')].map((a) => a.replace(/^en:/, '')).filter((a) => /^e\d{3}/.test(a));
  const eNum = (a) => Number(a.slice(1, 4));
  const fromLabel = Boolean(facts.allergens);
  for (const [key, word, off] of ALLERGENS) {
    if (allergens.has(off)) add(`contains-${key}`, `The label lists ${word} as an allergen.`);
    else if (traces.has(off)) add(`may-contain-${key}`, `The label warns it may contain traces of ${word}.`);
  }
  if (additives.some((a) => eNum(a) >= 220 && eNum(a) <= 228)) add('contains-sulphites', `Sulphites are in the ingredients (${additives.filter((a) => eNum(a) >= 220 && eNum(a) <= 228).map((a) => a.toUpperCase()).join(', ')}).`);
  // A plain food: what its name says it is. Only "contains", never "free of", and never for a product,
  // whose label is the only source that counts.
  if (generic && !fromLabel && text) {
    const plain = text.replace(RX.plantDairy, (m, first) => (first ? `${first} ` : ' '));
    const named = (re) => re.test(plain);
    const fromName = (key, what) => add(`contains-${key}`, `From the name: ${what}. Not checked against a label.`);
    if (['milk', 'dairy', 'cheese'].includes(group) || named(RX.milk)) fromName('milk', 'it is or has milk, butter, cream, cheese or yoghurt');
    if ((group === 'eggs' || named(RX.eggs)) && !named(RX.eggFree)) fromName('eggs', 'it is or has egg');
    if ((named(RX.gluten) || ['bread and rolls', 'biscuits and crackers', 'cakes and pastries', 'pizza'].includes(group)) && !named(RX.glutenFree)) fromName('gluten', 'it is or has wheat, barley, rye or oats');
    if (named(RX.peanuts)) fromName('peanuts', 'it is or has peanuts');
    if (named(RX.nuts)) fromName('nuts', 'it is or has nuts such as almonds, hazelnuts, walnuts, cashews or pistachios');
    if (named(RX.soy)) fromName('soy', 'it is or has soya');
    if (named(RX.crustaceans)) fromName('crustaceans', 'it is or has prawns, shrimp, crab or lobster');
    if (named(RX.molluscs)) fromName('molluscs', 'it is or has mussels, clams, squid or octopus');
    if (named(RX.fish) || (group === 'fish and shellfish' && !named(RX.shellfish))) fromName('fish', 'it is or has fish');
    if (named(RX.celery)) fromName('celery', 'it is or has celery');
    if (named(RX.mustard)) fromName('mustard', 'it is or has mustard');
    if (named(RX.sesame)) fromName('sesame', 'it is or has sesame or tahini');
    if (named(RX.sulphites) && !named(/\bvinegar\b/)) fromName('sulphites', 'wine and dried apricots almost always carry sulphites');
    if (named(RX.lupin)) fromName('lupin', 'it is or has lupin');
  }

  // --- Diet ---
  const analysis = tagsOf('analysis');
  const labels = tagsOf('labels');
  const labelled = (re) => [...labels].some((l) => re.test(l));
  const strippedVeg = text.replace(RX.vegStock, ' ');
  const meatOrFish = ['beef', 'pork', 'poultry', 'lamb, veal and game', 'fish and shellfish', 'sausages and cold cuts'].includes(group) || RX.meatFish.test(strippedVeg);
  if (labels.has('en:vegan') || analysis.has('en:vegan')) add('vegan', labels.has('en:vegan') ? 'Labelled vegan.' : 'Open Food Facts\' ingredients analysis finds no animal ingredients.');
  else if (labels.has('en:vegetarian') || analysis.has('en:vegetarian')) add('vegetarian', labels.has('en:vegetarian') ? 'Labelled vegetarian.' : 'Open Food Facts\' ingredients analysis finds no meat or fish.');
  else if (analysis.has('en:non-vegetarian')) add('not-vegetarian', 'Open Food Facts\' ingredients analysis finds meat or fish.');
  else if (generic && text) {
    const plain = text.replace(RX.plantDairy, (m, first) => (first ? `${first} ` : ' '));
    if (meatOrFish) add('not-vegetarian', 'It is meat or fish, or has some in it (from its name and food group).');
    else if (['fruit', 'vegetables', 'legumes', 'nuts and seeds', 'potatoes', 'herbs and spices', 'plant milks', 'rice, pasta and grains', 'fruit juice', 'water'].includes(group) && !RX.animalOther.test(plain) && !RX.notPlain.test(plain)) {
      add('vegan', 'A plain plant food (from its food group and name).');
    } else if (['eggs', 'milk', 'dairy'].includes(group)) add('vegetarian', 'Egg or dairy with no meat or fish (from its food group and name).');
  }
  if (analysis.has('en:palm-oil-free') || labelled(/palm-oil-free|no-palm-oil/)) add('palm-oil-free', 'No palm oil in the ingredients (Open Food Facts).');
  else if (analysis.has('en:palm-oil')) add('palm-oil', 'Palm oil is in the ingredients (Open Food Facts).');
  for (const [key, label, re] of LABELS) {
    if (labelled(re)) add(key, `The label says ${label.toLowerCase() === 'fairtrade' ? 'Fairtrade' : label.toLowerCase()}.`);
  }
  const maltaMade = tagsOf('origins').has('en:malta');
  if (it.name_mt || RX.maltese.test(text) || maltaMade) add('maltese', it.name_mt ? `Its Maltese name is ${it.name_mt}.` : maltaMade ? 'Its label says it comes from Malta.' : 'A known Maltese dish or product.');
  if (tagsOf('countries').has('en:malta') || String(it.market || '').toLowerCase() === 'malta') add('sold-in-malta', 'Open Food Facts lists it as sold in Malta.');

  // --- Additives ---
  if (facts.additives) {
    const codes = (test) => additives.filter(test).map((a) => a.toUpperCase());
    const has = (test, key, what) => {
      const c = codes(test);
      if (c.length) add(key, `${what}: ${c.join(', ')}.`);
    };
    if (!additives.length && num(facts.ingredients) > 0) add('no-additives', 'The ingredient list has no E-numbered additives (Open Food Facts).');
    if (additives.length >= 5) add('many-additives', `${additives.length} additives: ${additives.slice(0, 8).map((a) => a.toUpperCase()).join(', ')}${additives.length > 8 ? '…' : ''}.`);
    const polyol = (a) => [420, 421, 953, 965, 966, 967, 968].includes(eNum(a));
    has((a) => (eNum(a) >= 950 && eNum(a) <= 969) || polyol(a), 'sweeteners', 'Sweeteners in the ingredients');
    has((a) => eNum(a) === 951, 'aspartame', 'Aspartame, a source of phenylalanine');
    has((a) => eNum(a) === 950, 'acesulfame-k', 'Acesulfame K');
    has((a) => eNum(a) === 955, 'sucralose', 'Sucralose');
    has((a) => eNum(a) === 960, 'stevia', 'Steviol glycosides');
    has((a) => eNum(a) === 954, 'saccharin', 'Saccharin');
    has((a) => eNum(a) === 952, 'cyclamate', 'Cyclamate');
    has(polyol, 'polyols', 'Polyols, which may have a laxative effect in large amounts');
    has((a) => eNum(a) >= 100 && eNum(a) <= 199 && eNum(a) !== 171, 'colourings', 'Colours');
    has((a) => [102, 104, 110, 122, 124, 129].includes(eNum(a)), 'southampton-colours', 'May have an adverse effect on activity and attention in children');
    has((a) => eNum(a) === 171, 'titanium-dioxide', 'Titanium dioxide, banned in EU food since 2022');
    has((a) => eNum(a) >= 200 && eNum(a) <= 299, 'preservatives', 'Preservatives');
    has((a) => eNum(a) >= 249 && eNum(a) <= 252, 'nitrites', 'Nitrites or nitrates');
    has((a) => eNum(a) >= 400 && eNum(a) <= 499, 'emulsifiers', 'Emulsifiers, stabilisers or thickeners');
    has((a) => eNum(a) >= 620 && eNum(a) <= 640, 'flavour-enhancers', 'Flavour enhancers');
    has((a) => (eNum(a) >= 338 && eNum(a) <= 341) || (eNum(a) >= 450 && eNum(a) <= 452), 'phosphates', 'Phosphoric acid or phosphates');
  }
  if (num(facts.ingredients) > 0) {
    if (facts.ingredients <= 5) add('short-ingredients', `${facts.ingredients} ingredient${facts.ingredients === 1 ? '' : 's'}.`);
    else if (facts.ingredients >= 20) add('long-ingredients', `${facts.ingredients} ingredients.`);
  }

  // --- Food group ---
  const from = (why) => why;
  const isFruit = group === 'fruit' || offCat('en:fruits', 'en:fresh-fruits', 'en:dried-fruits');
  const isVeg = group === 'vegetables' || offCat('en:vegetables', 'en:fresh-vegetables');
  const isPulse = group === 'legumes' || offCat('en:legumes', 'en:pulses') || (generic && RX.pulses.test(text));
  const isJuice = drink && (group === 'fruit juice' || offCat('en:fruit-juices', 'en:juices-and-nectars', 'en:smoothies') || RX.juice.test(text));
  const isMilk = ['milk', 'dairy', 'cheese'].includes(group) || offCat('en:dairies', 'en:milks', 'en:cheeses', 'en:yogurts');
  const isPlantMilk = group === 'plant milks' || offCat('en:plant-milks', 'en:plant-based-milk-alternatives') || RX.plantMilk.test(text);
  if (isFruit && !isJuice) add('fruit', from('Fruit.'));
  if (isVeg && !isJuice) add('vegetables', from('Vegetables.'));
  if (isPulse) add('legumes', 'Beans, lentils, chickpeas or peas.');
  const juiceDrink = isJuice && /\b(drink|nectar|cordial|squash|punch|ade|cocktail|flavou?red)\b/.test(text);
  if ((isFruit || isVeg || isPulse || (isJuice && !juiceDrink)) && group !== 'potatoes' && (generic || offCat('en:fresh-fruits', 'en:fresh-vegetables', 'en:fruit-juices', 'en:legumes'))) {
    add('five-a-day', isJuice ? 'Juice counts as one of your 5 A Day, once a day, up to 150 ml (NHS).' : isPulse ? 'Pulses count as one of your 5 A Day, once a day: 80 g is a portion (NHS).' : RX.dried.test(text) || it.state === 'dried' ? 'Dried fruit counts to your 5 A Day: 30 g is a portion (NHS).' : 'Fruit and vegetables count to your 5 A Day: 80 g is a portion (NHS).');
  }
  if ((isVeg || isFruit) && RX.leafy.test(text)) add('leafy-greens', 'A leafy green.');
  if (isVeg && RX.cruciferous.test(text)) add('cruciferous', 'A cruciferous vegetable (the cabbage family).');
  if ((isVeg || generic) && RX.alliums.test(text) && (isVeg || group === 'herbs and spices')) add('alliums', 'From the onion family.');
  if (isFruit && RX.berries.test(text)) add('berries', 'Berries.');
  if ((isFruit || isJuice) && RX.citrus.test(text)) add('citrus', 'Citrus fruit.');
  if (isFruit && (RX.dried.test(text) || it.state === 'dried' || offCat('en:dried-fruits'))) add('dried-fruit', 'Dried fruit: the sugar of fresh fruit in a smaller weight.');
  if (group === 'potatoes' || (generic && !isFruit && /\b(potato\w*|fries|hash browns?)\b/.test(text) && !/\bsweet potato/.test(text) && group !== 'snacks')) add('potatoes', 'Potatoes: a starchy food that does not count to 5 A Day (NHS).');
  if (RX.wholegrain.test(text) && !/\bwhite\b/.test(text) && (['rice, pasta and grains', 'bread and rolls', 'breakfast cereals', 'flour and baking', 'biscuits and crackers'].includes(group) || offCat('en:whole-grain-breads', 'en:wholemeal-breads', 'en:cereals-and-their-products') || !generic)) add('wholegrain', 'A wholegrain food.');
  if (group === 'bread and rolls' || offCat('en:breads') || (RX.bread.test(text) && ['product'].includes(group))) add('bread', 'Bread.');
  if (group === 'rice, pasta and grains' || offCat('en:pastas', 'en:rices', 'en:cereal-grains')) add('pasta-rice', 'Pasta, rice or a grain.');
  if (group === 'breakfast cereals' || offCat('en:breakfast-cereals')) add('breakfast-cereal', 'A breakfast cereal.');
  if (group === 'nuts and seeds' || offCat('en:nuts', 'en:seeds')) add('nuts-seeds', 'Nuts or seeds.');
  if (isMilk && !isPlantMilk) add('dairy', 'Dairy.');
  if (group === 'cheese' || offCat('en:cheeses')) add('cheese', 'Cheese.');
  if (group === 'eggs' || offCat('en:eggs')) add('eggs', 'Eggs.');
  if (RX.fermented.test(text) && !/\bfrozen\b/.test(text)) add('fermented', 'A fermented food.');
  const vegMeat = /\b(vegetarian|vegan|plant based|meat ?free|meatless|tofu|soy|soya|quorn|seitan)\b/.test(text);
  const meatGroup = ['beef', 'pork', 'poultry', 'lamb, veal and game'].includes(group);
  const processedMeat = !vegMeat && (group === 'sausages and cold cuts' || offCat('en:prepared-meats', 'en:sausages', 'en:hams', 'en:salamis', 'en:bacon', 'en:cured-meats')
    || (meatGroup && (RX.processedMeat.test(text) || /\b(cured|corned|smoked)\b/.test(text)))
    || ((!generic || ['fast food', 'sandwiches and burgers', 'mixed dishes', 'ready meals'].includes(group)) && RX.processedMeat.test(text)));
  if (processedMeat) add('processed-meat', 'Processed meat: IARC (2015) classes it as carcinogenic to humans, group 1.');
  const redMeat = !vegMeat && !processedMeat && (['beef', 'pork', 'lamb, veal and game'].includes(group) || offCat('en:beef', 'en:pork', 'en:lamb-meat', 'en:veal')) && !/\b(rabbit|fenek|chicken|turkey|duck|pheasant|quail|pigeon|goose)\b/.test(text);
  if (redMeat) add('red-meat', 'Red meat: the World Cancer Research Fund advises no more than about 350 to 500 g cooked a week.');
  if (!vegMeat && (group === 'poultry' || offCat('en:poultries', 'en:chickens') || (['ready meals', 'fast food', 'sandwiches and burgers', 'mixed dishes', 'soups'].includes(group) && RX.poultry.test(text)))) add('poultry', 'Poultry.');
  const fishGroup = group === 'fish and shellfish' || offCat('en:fishes', 'en:seafood', 'en:canned-fishes');
  if (fishGroup && !RX.shellfish.test(text)) add('fish', 'Fish.');
  if ((fishGroup || !generic) && RX.oilyFish.test(text)) add('oily-fish', 'Oily fish: the NHS advises a portion a week.');
  if (fishGroup && RX.shellfish.test(text)) add('shellfish', 'Shellfish.');
  const animalProtein = ['beef', 'pork', 'poultry', 'lamb, veal and game', 'fish and shellfish', 'sausages and cold cuts', 'eggs', 'milk', 'dairy', 'cheese'].includes(group) || offCat('en:meats', 'en:fishes', 'en:dairies', 'en:eggs');
  if (proteinSource && (animalProtein || RX.completePlant.test(text) || /\b(whey|casein|egg white)\b/.test(text))) add('complete-protein', 'A source of protein with all nine essential amino acids (from what it is).');
  if (proteinSource && !animalProtein && !RX.supplement.test(text) && (['legumes', 'nuts and seeds'].includes(group) || isPulse || (generic && RX.plantProtein.test(text) && !meatOrFish && !RX.animalOther.test(text)))) add('plant-protein', 'A source of protein from plants.');
  if (group === 'supplements and powders' || offCat('en:protein-powders', 'en:bodybuilding-supplements', 'en:protein-bars') || RX.supplement.test(text)) add('protein-supplement', 'A protein powder, shake or bar.');
  if (RX.chocolate.test(text) && !drink) add('chocolate', 'Chocolate.');
  if (group === 'sweets and chocolate' || offCat('en:confectioneries', 'en:candies', 'en:sweets')) add('sweets', 'Sweets or confectionery.');
  if (group === 'snacks' || offCat('en:salty-snacks', 'en:crisps', 'en:chips-and-fries', 'en:appetizers') || RX.snack.test(text)) add('snack', 'A snack: crisps, popcorn, pretzels or similar.');
  if (group === 'biscuits and crackers' || offCat('en:biscuits', 'en:cookies', 'en:crackers')) add('biscuits', 'Biscuits or crackers.');
  if (group === 'cakes and pastries' || offCat('en:cakes', 'en:pastries', 'en:viennoiseries')) add('cakes-pastries', 'Cakes or pastries.');
  if (group === 'desserts' || offCat('en:desserts', 'en:ice-creams', 'en:frozen-desserts') || (RX.dessert.test(text) && !drink)) add('dessert', 'A dessert.');
  if (group === 'pizza' || offCat('en:pizzas') || RX.pizza.test(text)) add('pizza', 'Pizza.');
  if (group === 'sandwiches and burgers' || offCat('en:sandwiches', 'en:burgers') || (RX.sandwich.test(text) && !generic)) add('sandwich-burger', 'A sandwich or burger.');
  if (['fast food', 'restaurant meals'].includes(group) || RX.fastFood.test(`${text} ${brand}`)) add('fast-food', 'Fast food or a restaurant meal.');
  if (group === 'ready meals' || offCat('en:meals', 'en:prepared-meals', 'en:microwave-meals')) add('ready-meal', 'A ready meal.');
  if (group === 'soups' || offCat('en:soups') || (RX.soup.test(text) && !generic)) add('soup', 'Soup.');
  if (group === 'sauces and condiments' || offCat('en:sauces', 'en:condiments', 'en:dressings', 'en:groceries-sauces')) add('sauce', 'A sauce or condiment.');
  if (group === 'fats and oils' || offCat('en:fats', 'en:vegetable-oils', 'en:olive-oils', 'en:butters', 'en:margarines')) add('oils-fats', 'An oil or fat.');
  if (group === 'sugar, syrups and spreads' || offCat('en:sweeteners', 'en:honeys', 'en:jams', 'en:sweet-spreads', 'en:syrups', 'en:sugars')) add('sugar-syrup', 'Sugar, a syrup, honey, jam or a sweet spread.');
  if (group === 'herbs and spices' || offCat('en:herbs', 'en:spices', 'en:condiments-spices')) add('herbs-spices', 'A herb or spice.');
  if (drink && (group === 'water' || offCat('en:waters', 'en:mineral-waters', 'en:spring-waters'))) add('water', 'Water.');
  const energyDrink = drink && (offCat('en:energy-drinks') || RX.energyDrink.test(`${text} ${brand}`) || (caffeine !== null && caffeine * 10 > 150 && !isCoffeeTea));
  if (energyDrink) add('energy-drink', 'An energy drink.');
  if (drink && !energyDrink && !isJuice && !isMilk && !isPlantMilk && abvNow <= 1.2 && !isCoffeeTea && group !== 'water'
    && (offCat('en:sodas', 'en:carbonated-drinks', 'en:soft-drinks', 'en:iced-teas', 'en:lemonades', 'en:colas') || RX.softDrink.test(text))) add('soft-drink', 'A soft drink.');
  if (isJuice) add('juice', 'Fruit juice or a smoothie: the NHS advises no more than 150 ml a day.');
  if ((RX.coffee.test(text) || offCat('en:coffees', 'en:coffee-drinks')) && !RX.energyDrink.test(text)) add('coffee', 'Coffee.');
  if (RX.tea.test(text) || offCat('en:teas', 'en:tea-based-beverages')) add('tea', 'Tea.');
  if (isPlantMilk) add('plant-milk', 'A plant milk.');
  if (drink && (RX.beer.test(text) || offCat('en:beers'))) add('beer', 'Beer.');
  if (drink && (RX.wine.test(text) || offCat('en:wines')) && !/\bvinegar\b/.test(text)) add('wine', 'Wine.');
  if (drink && (RX.spirits.test(text) || offCat('en:spirits', 'en:liqueurs'))) add('spirits', 'A spirit or liqueur.');

  // --- Your habits ---
  const h = it.habits;
  if (h && typeof h === 'object') {
    const n = (x) => (num(x) === null ? 0 : x);
    if (h.favourite) add('my-favourite', 'You starred it.');
    if (n(h.days30) >= 15) add('my-staple', `Logged on ${h.days30} of the last 30 days.`);
    else if (n(h.days30) >= 4) add('my-regular', `Logged on ${h.days30} of the last 30 days.`);
    const logs = n(h.logs90);
    if (logs >= 3) {
      for (const slot of ['breakfast', 'lunch', 'dinner', 'snacks', 'drinks']) {
        const s = n(h.slots?.[slot]);
        if (s / logs >= 0.6) add(`my-${slot}`, `${s} of your ${logs} logs in the last 90 days were ${slot === 'snacks' ? 'snacks' : slot === 'drinks' ? 'drinks' : `at ${slot}`}.`);
      }
      if (n(h.late) / logs >= 0.5) add('my-late-night', `${h.late} of your ${logs} logs in the last 90 days were after 21:00.`);
      if (n(h.early) / logs >= 0.5) add('my-early', `${h.early} of your ${logs} logs in the last 90 days were before 08:00.`);
    }
    if (logs >= 4 && n(h.weekend) / logs >= 0.75) add('my-weekend', `${h.weekend} of your ${logs} logs in the last 90 days were on a weekend.`);
    if (num(h.firstDays) !== null && h.firstDays <= 7) add('my-new', h.firstDays === 0 ? 'First logged today.' : `First logged ${h.firstDays} day${h.firstDays === 1 ? '' : 's'} ago.`);
    if (n(h.total) >= 3 && num(h.lastDays) !== null && h.lastDays > 30) add('my-not-lately', `Logged ${h.total} times, last ${h.lastDays} days ago.`);
    const top = h.top || {};
    if (num(top.protein) && top.protein <= 5) add('my-top-protein', `Number ${top.protein} for protein in your last 30 days.`);
    if (num(top.kcal) && top.kcal <= 5) add('my-top-energy', `Number ${top.kcal} for energy in your last 30 days.`);
    if (num(top.sugars) && top.sugars <= 5) add('my-top-sugar', `Number ${top.sugars} for sugar in your last 30 days.`);
  }

  return [...out].map(([key, why]) => {
    const t = TAG[key];
    return { key, label: t.label, tone: t.tone, group: t.group, why };
  }).sort((a, b) => RANK[a.key] - RANK[b.key]);
}

// Just the keys, without the diary's habits: what the server stores on a catalogue record.
export const tagKeys = (item) => foodTags({ ...item, habits: null }).map((t) => t.key);

// Tags grouped for a screen: [{ key, label, tags: [...] }] in the catalogue's group order.
export function groupTags(tags) {
  const by = new Map(TAG_GROUPS.map((g) => [g.key, { ...g, tags: [] }]));
  for (const t of tags || []) by.get(t.group || TAG[t.key]?.group)?.tags.push(t);
  return [...by.values()].filter((g) => g.tags.length);
}
