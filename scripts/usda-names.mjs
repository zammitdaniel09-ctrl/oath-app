// Turns a raw USDA description into what the catalogue shows: a clean UK English name in sentence case and a
// readable order, a brand for chain and packaged products, aliases that keep the US terms searchable, a
// readable category group, a state (raw, boiled, fried, canned ...), whether it is a liquid, and portion
// labels that keep their size words. Pure functions over strings: no files are read here.
//
//   "BURGER KING, french fries"                     → French fries, brand Burger King, product, US
//   "Cheese, cheddar"                                → Cheddar cheese
//   "Chicken, broilers or fryers, breast, meat only, cooked, roasted"   → Chicken breast, meat only, cooked, roasted
//   "Whopper (Burger King)" (FNDDS)                  → Whopper, brand Burger King

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------- Chains and brands ----------

const CHAINS = [
  [/^BURGER KING\b/i, 'Burger King'],
  [/^McDONALD'?S\b/i, "McDonald's"],
  [/^WEND(?:Y'S|'YS)\b/i, "Wendy's"],
  [/^KFC\b/i, 'KFC'],
  [/^TACO BELL\b/i, 'Taco Bell'],
  [/^SUBWAY\b/i, 'Subway'],
  [/^ARBY'S\b/i, "Arby's"],
  [/^CHICK-FIL-A\b/i, 'Chick-fil-A'],
  [/^DOMINO'S\b/i, "Domino's"],
  [/^PIZZA HUT\b/i, 'Pizza Hut'],
  [/^PAPA JOHN'S\b/i, "Papa John's"],
  [/^LITTLE CAESARS\b/i, 'Little Caesars'],
  [/^POPEYES\b/i, 'Popeyes'],
  [/^APPLEBEE'S\b/i, "Applebee's"],
  [/^CARRABBA'S ITALIAN GRILL\b/i, "Carrabba's Italian Grill"],
  [/^CRACKER BARREL\b/i, 'Cracker Barrel'],
  [/^DENNY'S\b/i, "Denny's"],
  [/^OLIVE GARDEN\b/i, 'Olive Garden'],
  [/^ON THE BORDER\b/i, 'On The Border'],
  [/^T\.G\.I\. FRIDAY'S\b/i, "TGI Friday's"],
  [/^DIGIORNO\b/i, 'DiGiorno'],
];
// The FNDDS way: "Whopper (Burger King)".
const CHAIN_TAIL = { 'burger king': 'Burger King', mcdonalds: "McDonald's", "mcdonald's": "McDonald's", wendys: "Wendy's", kfc: 'KFC', 'taco bell': 'Taco Bell', subway: 'Subway' };

// Capitals that stay capitals, and small words that are not brand words.
const ACRONYMS = new Set(['USDA', 'BBQ', 'USA', 'US', 'UK', 'NFS', 'NS', 'DHA', 'ARA', 'UHT', 'II', 'III', 'IV', 'NFSMI', 'PB', 'RTD', 'IQF', 'FD&C', 'RTE', 'GMO', 'KFC', 'TGI', 'BLT', 'B.L.T.', 'EAS', 'XS', 'NOS']);
const STOP_CAPS = new Set(['AND', 'OF', 'THE', 'WITH', 'FOR', 'IN', 'N', "'N"]);

const wordsOf = (s) => s.split(/\s+/).filter(Boolean);
const bareCaps = (w) => w.replace(/[.,]/g, '');
const isCapsWord = (w) => /^[A-Z0-9'’&.\-/"]+$/.test(w) && /[A-Z]{2}/.test(w) && !ACRONYMS.has(bareCaps(w)) && !STOP_CAPS.has(bareCaps(w));
const allCaps = (s) => {
  const ws = wordsOf(s);
  return ws.length > 0 && ws.every((w) => /^[A-Z0-9'’&.\-/",()]+$/.test(w)) && ws.some((w) => isCapsWord(w) && w.replace(/[^A-Z]/g, '').length >= 3);
};
// KELLOGG'S → Kellogg's; SNICKERS MARATHON → Snickers Marathon.
const titleWord = (w) => w.toLowerCase().replace(/(^|[-/( ])([a-z])/g, (m, p, c) => p + c.toUpperCase()).replace(/'S\b/g, "'s").replace(/^Mc([a-z])/, (m, c) => `Mc${c.toUpperCase()}`);
const titleCase = (s) => wordsOf(s).map((w, i) => (ACRONYMS.has(bareCaps(w)) ? w : STOP_CAPS.has(w) && i > 0 ? w.toLowerCase() : titleWord(w))).join(' ');

function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  // A bare "(sweetsop)" belongs to the word before it.
  const merged = [];
  for (const seg of out.filter(Boolean)) {
    if (/^\(/.test(seg) && merged.length) merged[merged.length - 1] += ` ${seg}`;
    else merged.push(seg);
  }
  return merged;
}

// ---------- UK English ----------

// [US pattern, UK text]. Applied to the readable name.
const UK = [
  [/\beggplants?\b/gi, 'aubergine'], [/\bzucchini\b/gi, 'courgette'], [/\bcilantro\b/gi, 'coriander'], [/\barugula\b/gi, 'rocket'],
  [/\bscallions?\b/gi, 'spring onions'], [/\bgreen onions?\b/gi, 'spring onions'], [/\brutabagas?\b/gi, 'swede'], [/\bgarbanzo beans?\b/gi, 'chickpeas'],
  [/\bsnap beans\b/gi, 'green beans'], [/\bbroadbeans\b/gi, 'broad beans'], [/\bfava beans\b/gi, 'broad beans'], [/\bbell peppers?\b/gi, 'peppers'],
  [/\bbeets\b/gi, 'beetroot'], [/\bbeet\b/gi, 'beetroot'], [/\bcornstarch\b/gi, 'cornflour'], [/\bshrimps?\b/gi, 'prawns'],
  [/\bcookies\b/gi, 'biscuits'], [/\bcookie\b/gi, 'biscuit'], [/\bcandy bars?\b/gi, 'chocolate bar'], [/\bcandies\b/gi, 'sweets'], [/\bcandy\b/gi, 'sweets'],
  [/\bpotato chips\b/gi, 'potato crisps'], [/\bfrostings?\b/gi, 'icing'], [/\bpowdered sugar\b/gi, 'icing sugar'], [/\bconfectioners'? sugar\b/gi, 'icing sugar'],
  [/\ball-purpose flour\b/gi, 'plain flour'], [/\bwhole[- ]wheat\b/gi, 'wholemeal'], [/\bskim milk\b/gi, 'skimmed milk'], [/\bnonfat\b/gi, 'fat-free'],
  [/\blowfat\b/gi, 'low-fat'], [/\bflavors?\b/gi, 'flavour'], [/\bflavored\b/gi, 'flavoured'], [/\bcolors?\b/gi, 'colour'], [/\bfibers?\b/gi, 'fibre'],
  [/\bliters?\b/gi, 'litre'], [/\bcatsup\b/gi, 'tomato ketchup'], [/(?<!tomato )\bketchup\b/gi, 'tomato ketchup'], [/\bchili\b/gi, 'chilli'], [/\bchile peppers?\b/gi, 'chilli peppers'],
  [/\bpopsicles?\b/gi, 'ice lollies'], [/\bfilberts\b/gi, 'hazelnuts'], [/\bhazelnuts or hazelnuts\b/gi, 'hazelnuts'], [/\bsweet corn\b/gi, 'sweetcorn'],
  [/^corn, sweet\b/i, 'Sweetcorn'], [/\breduced fat milk\b/gi, 'semi-skimmed milk'], [/\bfat-free milk\b/gi, 'skimmed milk'],
  [/\bgelatin desserts?\b/gi, 'jelly'], [/\bvariety meats and by-products\b/gi, 'offal'], [/\bground beef\b/gi, 'beef mince'],
  [/\bsoda pop\b/gi, 'fizzy drink'], [/\bturnip greens\b/gi, 'turnip tops'], [/\bhalf and half\b/gi, 'half-and-half cream'],
  [/\bjellies\b/gi, 'jelly spreads'], [/\bsherbet\b/gi, 'sherbet (sorbet)'], [/\bmolasses\b/gi, 'molasses (treacle)'], [/\bgrilled cheese\b/gi, 'toasted cheese'],
  [/^distilled\b/i, 'Spirits'],
];
const ALIAS_EXTRA = [
  [/\bfrench fries\b/i, 'chips'], [/^oatmeal\b/i, 'porridge'], [/\bpotato crisps\b/i, 'crisps'], [/\baubergine\b/i, 'eggplant'], [/\bcourgette\b/i, 'zucchini'],
  [/\byogurt\b/i, 'yoghurt'], [/\bsweetcorn\b/i, 'corn'], [/\bprawns\b/i, 'shrimp'], [/\bbiscuits?\b/i, 'cookies', /cookie/i], [/\bmince\b/i, 'ground'],
];

// ---------- Names ----------

const NOISE_SEG = /^(NFS|NS|NS as to .*|all commercial varieties|all varieties|all types|includes .*|raw|uncooked|fresh)$/i;
const PARENS_DROP = /\s*\([^)]*\b(USDA|Distribution|commodity)\b[^)]*\)/gi;

// Capitalised words that stay capitalised when a Title Case run is brought down.
const PROPER = new Set(['Atlantic', 'Pacific', 'Alaska', 'Alaskan', 'Native', 'American', 'Italian', 'French', 'Greek', 'Mexican', 'Chinese', 'Indian', 'Japanese', 'Korean', 'Thai',
  'Spanish', 'Swiss', 'German', 'Dutch', 'English', 'Irish', 'Scottish', 'Canadian', 'Danish', 'Belgian', 'Cuban', 'Hawaiian', 'Jamaican', 'Cajun', 'Creole', 'Puerto', 'Rican', 'Latino',
  'New', 'Zealand', 'Australian', 'Hass', 'Fuji', 'Gala', 'Granny', 'Smith', 'Delicious', 'Cheddar', 'Parmesan', 'Mozzarella', 'Brie', 'Gouda', 'Edam', 'Feta',
  'Monterey', 'Jack', 'Colby', 'Muenster', 'Romano', 'Roquefort', 'Gruyere', 'Camembert', 'Provolone', 'Brussels', 'Worcestershire', 'Dijon', 'Tabasco', 'Concord', 'Bing', 'Bartlett',
  'Anjou', 'Bosc', 'Medjool', 'Deglet', 'Noor', 'Thompson', 'Navel', 'Valencia', 'Roma', 'Vidalia', 'Idaho', 'Russet', 'Yukon', 'Boston', 'Kentucky', 'Bourbon', 'Scotch',
  'Southern', 'Texas', 'Florida', 'California', 'Georgia', 'Maine', 'Kobe', 'Wagyu', 'Angus', 'Caesar', 'Waldorf', 'Alfredo', 'Marsala', 'Parmigiana', 'Bolognese', 'Marinara',
  'Florentine', 'Hollandaise', 'Béarnaise', 'Béchamel', 'Tzatziki', 'Hummus', 'Tahini', 'Sriracha', 'Teriyaki', 'Tandoori', 'Tikka', 'Masala', 'Kung', 'Pao', "Tso's", 'General',
  'Szechuan', 'Sichuan', 'Hunan', 'Pekin', 'Oregon', 'Plains', 'Indians', 'Southwest', 'Northern', 'Navajo', 'Hopi', 'Klamath', 'Apache', 'Zuni', 'Inuit', 'Yupik', 'Pueblo', 'Brazil', 'Mediterranean', 'Asian', 'Oriental', 'Cuisine', 'Pacific', 'Gulf', 'Chesapeake', 'Dungeness', 'Maryland', 'Virginia', 'Carolina',
  'Salisbury', 'Swedish', 'Hungarian', 'Polish', 'Russian', 'Turkish', 'Lebanese', 'Moroccan', 'Vietnamese', 'Filipino', 'Hawaiian', 'Portuguese', 'Peruvian', 'Brazilian',
  'England', 'Manhattan', 'Whopper', 'Mac', 'Big', 'Frosty', 'Pounder', 'Quarter', 'McNuggets', "Croissan'wich", 'Jr', 'Junior', 'Grande', 'Supreme', 'Crunchwrap', 'Chalupa', 'Gordita', 'Baja', 'Philly', 'Hershey\'s']);

// A run of two or more Capitalised words is Title Case, not names: bring it down unless it is a proper name.
function sentence(s, { runs = true } = {}) {
  const lowerWord = (w) => w.split('-').map((p, i) => (i === 0 || !/^[A-Z][a-z]/.test(p) ? p : p[0].toLowerCase() + p.slice(1))).join('-');
  const isCap = (w) => /^[A-Z][a-z]/.test(w.replace(/^[^A-Za-z]+/, ''));
  // Words that arrived in capitals are product and brand names: they are written plainly and never brought down.
  const fromCaps = new Set();
  const segs = splitTop(s).map((seg) => wordsOf(seg).map((w) => {
    if (isCapsWord(w)) { const t = titleWord(w); fromCaps.add(t); return t; }
    // McNUGGETS, mcGRIDDLES
    if (/^[Mm]c[A-Z]{3,}$/.test(w)) { const t = `Mc${w[2]}${w.slice(3).toLowerCase()}`; fromCaps.add(t); return t; }
    return w;
  }));
  // Title Case ("Beans, Dry, Dark Red Kidney") has several capitalised words that are not names; one is a name.
  const plain = (w) => isCap(w) && !fromCaps.has(w) && !PROPER.has(w.replace(/[^A-Za-z'’]/g, ''));
  let count = 0;
  segs.forEach((ws, si) => ws.forEach((w, i) => { if ((si > 0 || i > 0) && plain(w)) count += 1; }));
  const lower = runs && count >= 2;
  return segs.map((ws, si) => ws.map((w, i) => ((lower && (si > 0 || i > 0) && plain(w)) ? w[0].toLowerCase() + lowerWord(w.slice(1)) : w)).join(' ')).join(', ');
}

// ---------- Readable order ----------

const MOD = /^(separable lean|lean only|lean and fat|lean|fat|trimmed|all grades|choice|select|prime|cooked|raw|boneless|bone-in|with|without|braised|broiled|roasted|grilled|fried|stewed|boiled|baked|simmered|pan-broil|pan-fried|microwaved|heated|frozen|imported|grass-fed|grain-fed|New Zealand|Australian|domestic|retail|meat only|meat and skin|skin only|skin|giblets?|drained|dry heat|moist heat|cured|fresh|whole|unheated|unprepared|prepared|canned|smoked|\d|all |not |no |low |reduced|extra|regular|water pack|solids|commercial|composite|rotisserie|oven-roasted|salted|unsalted|offal|natural|full|enhanced|processed|restructured|pre-cooked|precooked|ready|enriched|unenriched|bone in|bone and|roasting|stewing|capons?|cornish game hens?|young hens?|young toms?|mechanically)/i;
const MEAT_HEADS = new Set(['Beef', 'Pork', 'Lamb', 'Veal', 'Chicken', 'Turkey']);
// Marketing classes that say nothing a reader needs; "roasting" and "stewing" birds are different foods and stay.
const CLASS_SEG = /^(broilers? or fryers?|broilers?|fryers?|all classes|retail cuts|variety meats and by-products)$/i;

function meat(segs) {
  const head = segs[0];
  let rest = segs.slice(1).filter((x) => !CLASS_SEG.test(x));
  let mince = false;
  rest = rest.filter((x) => { if (/^ground$/i.test(x)) { mince = true; return false; } return true; });
  const cuts = [];
  while (rest.length && cuts.length < 2 && !MOD.test(rest[0]) && wordsOf(rest[0]).length <= 4) cuts.push(rest.shift());
  const h = mince ? `${head} mince` : head;
  return [[h, ...cuts].join(' '), ...rest];
}

// Heads where "Head, kind" reads better as "kind head".
const INVERT = new Set(['cheese', 'bread', 'rolls', 'cake', 'cakes', 'cookies', 'crackers', 'pie', 'pies', 'beans', 'soup', 'sauce', 'syrups', 'sugars', 'vinegar', 'oil', 'butter', 'milk', 'yogurt',
  'ice creams', 'ice cream', 'pasta', 'noodles', 'puddings', 'pudding', 'frostings', 'muffins', 'pancakes', 'waffles', 'doughnuts', 'pastries', 'spreads', 'juice', 'bagels', 'tortillas',
  'seasoning mix', 'sausage', 'peas', 'lentils', 'rice', 'wine', 'shortening', 'margarine', 'jams', 'toppings', 'salad dressing', 'candies', 'gum', 'pizza', 'cereal', 'flour', 'egg substitute']);
const NOT_KIND = /^(raw|cooked|canned|frozen|dried|dry|prepared|ready|fluid|with|without|made|unprepared|fresh|dehydrated|instant|mix|no|all|not|enriched|unenriched|commercially|as purchased|home|from|baked|boiled|fried|roasted|steamed|homemade|retail|NS|NFS|includes|excludes)\b/i;
const DROP_HEAD = new Set(['snacks', 'nuts', 'seeds', 'fish', 'mollusks', 'crustaceans', 'game meat', 'beverages', 'alcoholic beverage', 'cereals', 'spices', 'candies', 'frozen novelties', 'leavening agents']);
const ADJ = new Set(['hard', 'soft', 'sour', 'sweet', 'plain', 'regular', 'dark', 'milk', 'white']);

function reorder(segs, { brand = false } = {}) {
  if (segs.length === 0) return segs;
  const head = segs[0];
  const h = head.toLowerCase();
  if (!brand && MEAT_HEADS.has(cap(head))) return meat(segs);
  if (h === 'cereals ready-to-eat') return ['Breakfast cereal', ...segs.slice(1)];
  if (h === 'babyfood') return ['Baby food', ...segs.slice(1)];
  if (segs.length > 1 && DROP_HEAD.has(h) && !NOT_KIND.test(segs[1]) && !MOD.test(segs[1])) {
    const rest = segs.slice(1);
    if (h === 'candies' && wordsOf(rest[0]).length === 1 && (ADJ.has(rest[0].toLowerCase()) || /(ed|y)$/i.test(rest[0]))) return [`${rest[0]} ${h}`, ...rest.slice(1)];
    if (!brand && MEAT_HEADS.has(cap(rest[0]))) return meat(rest);
    return rest;
  }
  if (segs.length > 1 && INVERT.has(h) && !brand) {
    const kind = segs[1];
    const last = h.split(' ').pop().replace(/s$/, '');
    // "Salad dressing, italian dressing" is already named; "Soup, soup mix" too.
    if (kind.toLowerCase().includes(last)) return segs.slice(1);
    if (wordsOf(kind).length <= 3 && !/\d/.test(kind) && !NOT_KIND.test(kind)) {
      // "Sugars, granulated" reads "Granulated sugar"; "Cookies, oatmeal" keeps its plural.
      const single = { sugars: 'sugar', syrups: 'syrup', puddings: 'pudding', frostings: 'frosting', jams: 'jam', toppings: 'topping', 'ice creams': 'ice cream' }[h] || h;
      return [`${kind} ${single}`, ...segs.slice(2)];
    }
  }
  return segs;
}

// ---------- Fast food and restaurants ----------

function placeOf(desc) {
  const m = desc.match(/^(Fast foods?|Restaurant),\s*(.*)$/i);
  if (!m) return null;
  if (/^fast food/i.test(m[1])) return { kind: 'fast food', rest: m[2] };
  const r = m[2].match(/^(Chinese|Italian|Mexican|Latino|family style|Japanese|Thai|Indian|Greek|American)\b,?\s*(.*)$/i);
  return r ? { kind: `${r[1].toLowerCase() === 'family style' ? 'family-style' : cap(r[1])} restaurant`, rest: r[2] } : { kind: 'restaurant', rest: m[2] };
}

// ---------- State, liquid and category ----------

export function stateOf(desc) {
  const d = desc.toLowerCase();
  const has = (re) => re.test(d);
  if (has(/\bpickled\b/)) return 'pickled';
  if (has(/\bcanned\b/)) return has(/drained/) ? 'canned-drained' : has(/solids and liquids|with liquid/) ? 'canned-with-liquid' : 'canned';
  if (has(/\bsteamed\b/)) return 'steamed';
  if (has(/\b(boiled|simmered|poached)\b/)) return 'boiled';
  if (has(/\b(pan-fried|deep-fried|stir-fried|fried|frying|pan-broil)\b/)) return 'fried';
  if (has(/\bmicrowav/)) return 'microwaved';
  if (has(/\bbraised\b/)) return 'braised';
  if (has(/\bstewed\b/)) return 'stewed';
  if (has(/\b(broiled|grilled|charbroiled|broil)\b/)) return 'grilled';
  if (has(/\bbaked\b/)) return 'baked';
  if (has(/\b(roasted|oven-roasted|dry roasted)\b/)) return 'roasted';
  if (has(/\bsmoked\b/)) return 'smoked';
  if (has(/\bcooked\b|\bheated\b|dry heat|moist heat|\bcook\b/)) return 'cooked';
  if (has(/\bfrozen\b/)) return 'frozen';
  if (has(/\b(dehydrated|dried|freeze-dried|sun-dried)\b/)) return 'dried';
  if (has(/\bcured\b/)) return 'cured';
  if (has(/formula/) && has(/made with/)) return 'prepared';
  if (has(/not reconstituted/)) return 'dry';
  if (has(/\b(prepared with|prepared from|prepared by|reconstituted|ready-to-drink|brewed|made up|from dry mix|from powder|home-prepared|made from recipe|prepared from recipe)\b/)) return 'prepared';
  if (has(/\b(dry mix|dry|powder|uncooked|unprepared|unheated)\b/) && !has(/dry heat|dry roasted|dry red|dry white|dry wine|dry-roasted/)) return 'dry';
  if (has(/\b(raw|fresh)\b/)) return 'raw';
  return 'as-sold';
}

const LIQUID_GROUPS = new Set(['Drinks', 'Fruit juice', 'Coffee and tea', 'Alcoholic drinks', 'Water', 'Plant milks', 'Milk']);
const NOT_LIQUID = /\b(powder|powdered|dry mix|mix, dry|crystals|dehydrated|instant|concentrate|undiluted|bar|bars|syrup|paste|gel|gum|whipped|pudding|shake mix|drink mix|tablet|capsule|supplement|frozen novelt|ice pop|sorbet|ice cream|cubes?|leaves|beans|grounds|pods|cocoa mix|creamer|dry|dried|evaporated|condensed|malted|kit|mix)\b/i;

// A drink is a liquid as it is drunk: a powder or a frozen concentrate is not, until it is made up with water or milk.
export function liquidOf(group, desc) {
  if (!LIQUID_GROUPS.has(group)) return false;
  const text = desc.replace(/\bfrom concentrate\b/gi, '');
  if (/\b(prepared with|made with|reconstituted|diluted|brewed|ready[- ]to[- ]drink)\b/i.test(text)) return !/\b(bars?|pudding|whipped topping|gel|undiluted)\b/i.test(text);
  return !NOT_LIQUID.test(text);
}

const SR_GROUP = {
  'Dairy and Egg Products': 'Dairy',
  'Spices and Herbs': 'Herbs and spices',
  'Baby Foods': 'Baby food',
  'Fats and Oils': 'Fats and oils',
  'Poultry Products': 'Poultry',
  'Soups, Sauces, and Gravies': 'Sauces and condiments',
  'Sausages and Luncheon Meats': 'Sausages and cold cuts',
  'Breakfast Cereals': 'Breakfast cereals',
  'Fruits and Fruit Juices': 'Fruit',
  'Pork Products': 'Pork',
  'Vegetables and Vegetable Products': 'Vegetables',
  'Nut and Seed Products': 'Nuts and seeds',
  'Beef Products': 'Beef',
  Beverages: 'Drinks',
  'Finfish and Shellfish Products': 'Fish and shellfish',
  'Legumes and Legume Products': 'Legumes',
  'Lamb, Veal, and Game Products': 'Lamb, veal and game',
  'Baked Products': 'Cakes and pastries',
  Sweets: 'Sweets and chocolate',
  'Cereal Grains and Pasta': 'Rice, pasta and grains',
  'Fast Foods': 'Fast food',
  'Meals, Entrees, and Side Dishes': 'Ready meals',
  Snacks: 'Snacks',
  'Restaurant Foods': 'Restaurant meals',
  'Quality Control Materials': 'Other',
};

// Description keywords, for what the category cannot place (Alaska Native foods, "not in a category").
// Each list matches whole words, with or without a plural.
const W = (list) => new RegExp(`\\b(?:${list})(?:s|es)?\\b`, 'i');
const BY_WORD = [
  [W('alcoholic|beer|wine|whiskey|whisky|vodka|rum|gin|brandy|liqueur|cocktail'), 'Alcoholic drinks'],
  [W('coffee|tea|espresso|cappuccino|latte|mocha'), 'Coffee and tea'],
  [W('juice'), 'Fruit juice'],
  [W('soda|cola|soft drink|carbonated|energy drink|sports drink|lemonade|punch|smoothie|beverage'), 'Drinks'],
  [/^cheese\b/i, 'Cheese'],
  [W('egg|omelet|omelette'), 'Eggs'],
  [W('milk|yogurt|yoghurt|cream|kefir|whey|buttermilk'), 'Dairy'],
  [W('beef|steak|veal'), 'Beef'],
  [W('pork|ham|bacon'), 'Pork'],
  [W('lamb|mutton|goat|venison|bison|buffalo|rabbit|elk|deer|moose|game|caribou|seal|sea lion|whale|walrus|muskrat|beaver|reindeer|owl|squirrel|bear|porcupine|raccoon|opossum|ptarmigan|grouse|flesh|meat'), 'Lamb, veal and game'],
  [W('chicken|turkey|duck|goose|poultry|ostrich|quail'), 'Poultry'],
  [W('sausage|frankfurter|hot dog|salami|bologna|pepperoni|luncheon|deli meat'), 'Sausages and cold cuts'],
  [W('salmon|tuna|cod|fish|shrimp|prawn|crab|lobster|oyster|clam|mussel|scallop|squid|octopus|trout|herring|sardine|mackerel|anchovy|halibut|catfish|tilapia|haddock|shellfish|roe|eel|whitefish|pollock|smelt|tunicate|ascidian|chiton|cockle|whelk|abalone|urchin|seaweed'), 'Fish and shellfish'],
  [W('soup|broth|chowder|bisque|stew'), 'Soups'],
  [W('pizza'), 'Pizza'],
  [W('burger|sandwich|burrito|taco|wrap|tamale'), 'Sandwiches and burgers'],
  [W('bread|roll|bun|bagel|toast|muffin|tortilla|pita|naan|croissant|bannock|frybread'), 'Bread and rolls'],
  [W('cake|pie|pastry|doughnut|brownie|danish|cobbler|strudel'), 'Cakes and pastries'],
  [W('cookie|biscuit|cracker|wafer'), 'Biscuits and crackers'],
  [W('candy|chocolate|sweets|gum|licorice|toffee|marshmallow|fudge'), 'Sweets and chocolate'],
  [W('ice cream|pudding|custard|gelatin|sorbet|sherbet|dessert'), 'Desserts'],
  [W('sugar|syrup|honey|jam|jelly|jellies|molasses|preserves|marmalade'), 'Sugar, syrups and spreads'],
  [W('oil|butter|margarine|lard|shortening|tallow|fat'), 'Fats and oils'],
  [W('sauce|gravy|dressing|mayonnaise|ketchup|mustard|salsa|dip|vinegar|marinade|relish|pesto'), 'Sauces and condiments'],
  [W('cocoa|baking|yeast|leavening'), 'Flour and baking'],
  [W('basil|chive|coriander|cilantro|parsley|mint|oregano|thyme|rosemary|sage|dill|spice|herb|pepper, black|cinnamon|nutmeg|ginger|turmeric|paprika|cumin'), 'Herbs and spices'],
  [W('potato|fries|hash brown|tater|cassava|yam|taro|plantain'), 'Potatoes'],
  [W('bean|lentil|chickpea|pea|tofu|tempeh|soy|hummus|legume'), 'Legumes'],
  [W('nut|almond|walnut|cashew|pecan|pistachio|hazelnut|peanut|seed|sesame|sunflower|flax|chia|acorn'), 'Nuts and seeds'],
  [W('rice|pasta|noodle|spaghetti|macaroni|couscous|quinoa|oat|barley|wheat|flour|cornmeal|grits|porridge|oatmeal|bulgur|millet|rye'), 'Rice, pasta and grains'],
  [W('cereal|granola|muesli'), 'Breakfast cereals'],
  [W('chip|crisp|popcorn|pretzel|snack'), 'Snacks'],
  [/\b\w*(berry|berries)\b/i, 'Fruit'],
  [W('apple|banana|orange|grape|melon|peach|pear|plum|cherry|mango|pineapple|lemon|lime|fruit|raisin|date|fig|apricot|kiwi|papaya|guava|prune|currant|cranberr|chokecherr|rose hip|crabapple|prickly pear|persimmon|agave'), 'Fruit'],
  [W('lettuce|spinach|cabbage|broccoli|carrot|onion|tomato|pepper|cucumber|celery|mushroom|squash|corn|kale|vegetable|salad|beet|radish|turnip|asparagus|cauliflower|aubergine|courgette|garlic|leek|greens|kelp|wasabi|pumpkin|rhubarb|dandelion|fiddlehead|cattail|root|leaves|leaf|sourdock|fireweed|lambsquarters|nettle|willow|mirepoix|sprout|chard|collard|okra|artichoke|eggplant|zucchini'), 'Vegetables'],
];
const groupByWords = (desc) => {
  for (const [re, g] of BY_WORD) if (re.test(desc)) return g;
  return 'Other';
};

// FNDDS: the WWEIA category into a group.
const FNDDS_GROUP = [
  [/^(Milk, (whole|reduced fat|lowfat|nonfat)|Flavored milk|Milk shakes|Human milk)/, 'Milk'],
  [/^Plant-based milk/, 'Plant milks'],
  [/^Yogurt|^Plant-based yogurt|^Cream and cream|^Cream cheese, sour/, 'Dairy'],
  [/sandwiches|Burgers|Burritos|Nachos|Other Mexican/, 'Sandwiches and burgers'],
  [/^Cheese|^Cottage/, 'Cheese'],
  [/^Eggs/, 'Eggs'],
  [/^(Ground beef|Beef, )/, 'Beef'],
  [/^(Pork|Bacon)/, 'Pork'],
  [/^Lamb, goat/, 'Lamb, veal and game'],
  [/^(Chicken|Turkey, duck)/, 'Poultry'],
  [/^(Fish|Shellfish)/, 'Fish and shellfish'],
  [/^(Cold cuts|Frankfurters|Sausages|Liver)/, 'Sausages and cold cuts'],
  [/^Soups|^Ramen/, 'Soups'],
  [/^Pizza/, 'Pizza'],
  [/mixed dishes|^Macaroni and cheese|^Fried rice|^Stir-fry|^Bean, pea, legume dishes|^Vegetable dishes|^Soy and meat-alternative|^Meat mixed|^Egg rolls/, 'Mixed dishes'],
  [/^Soy-based condiments/, 'Sauces and condiments'],
  [/^Beans, peas/, 'Legumes'],
  [/^Nuts and seeds/, 'Nuts and seeds'],
  [/^(Yeast breads|Rolls and buns|Bagels|Tortillas|Biscuits, muffins)/, 'Bread and rolls'],
  [/^(Cakes and pies|Doughnuts|Turnovers|Pancakes)/, 'Cakes and pastries'],
  [/^(Cookies|Crackers|Saltine)/, 'Biscuits and crackers'],
  [/^(Potato chips|Tortilla, corn|Popcorn|Pretzels|Cereal bars|Nutrition bars)/, 'Snacks'],
  [/^(Ready-to-eat cereal|Oatmeal|Grits)/, 'Breakfast cereals'],
  [/^(Rice|Pasta, noodles)/, 'Rice, pasta and grains'],
  [/^(Jams, syrups|Sugars and honey|Sugar substitutes)/, 'Sugar, syrups and spreads'],
  [/^Candy/, 'Sweets and chocolate'],
  [/^(Ice cream|Pudding|Gelatins)/, 'Desserts'],
  [/^(Coffee|Tea)/, 'Coffee and tea'],
  [/juice$|^Citrus juice|^Other fruit juice|^Apple juice|^Vegetable juice|^Baby juice/, 'Fruit juice'],
  [/^(Soft drinks|Diet soft|Flavored or carbonated|Other diet drinks|Sport and energy|Diet sport|Fruit drinks|Nutritional beverages|Smoothies)/, 'Drinks'],
  [/^(Beer|Wine|Liquor)/, 'Alcoholic drinks'],
  [/^(Tap water|Bottled water|Enhanced water|Baby water)/, 'Water'],
  [/^(Butter and animal|Margarine)/, 'Fats and oils'],
  [/^Olives, pickles/, 'Vegetables'],
  [/^(Mayonnaise|Dips, gravies|Pasta sauces|Tomato-based condiments|Mustard and other|Salad dressings)/, 'Sauces and condiments'],
  [/^(White potatoes|Mashed potatoes|French fries)/, 'Potatoes'],
  [/^Other starchy/, 'Vegetables'],
  [/^Baby food|^Formula/, 'Baby food'],
  [/^Protein and nutritional powders/, 'Supplements and powders'],
  [/^(Apples|Bananas|Citrus fruits|Dried fruits|Other fruits|Melons|Grapes|Mango|Peaches|Pears|Pineapple|Blueberries|Strawberries)/, 'Fruit'],
  [/^(Other dark green|Other red|Broccoli|Lettuce|Spinach|Carrots|Tomatoes|String beans|Cabbage|Corn|Onions|Other vegetables|Fried vegetables|Coleslaw|Vegetables on|Vegetable sandwiches)/, 'Vegetables'],
];

export function groupOf(food, name, brand = null) {
  const d = food.description;
  let g;
  if (food.dataset !== 'survey_fndds_food' && SR_GROUP[food.category] === 'Fast food' && !brand && /\bpizza\b/i.test(d)) return 'Pizza';
  if (food.dataset === 'survey_fndds_food') {
    g = FNDDS_GROUP.find(([re]) => re.test(food.category))?.[1];
    if (!g) g = groupByWords(d);
  } else {
    g = SR_GROUP[food.category];
    if (!g) g = groupByWords(d);
  }
  if (FROZEN_DESSERT.test(d) || FROZEN_DESSERT.test(name)) return 'Desserts';
  return refine(g, d, name);
}

// Refinements within a group, from the description.
function refine(g, d, name) {
  const low = `${d} ${name}`.toLowerCase();
  const first = d.toLowerCase();
  if (g === 'Dairy') {
    if (/\bcheese\b/.test(first) && !/\b(cheesecake|cheese sauce|cheese dip)\b/.test(first)) return 'Cheese';
    if (/^(egg|eggs)\b|egg substitute/.test(first)) return 'Eggs';
    if (/^(butter|margarine|ghee)\b/.test(first)) return 'Fats and oils';
    if (/^milk shakes?\b/.test(first)) return 'Drinks';
    if (/^(ice cream|ice creams|frozen yogurt|puddings?|custard|milk dessert|dessert)/.test(first)) return 'Desserts';
    if (/^(milk substitutes?|soymilk|soy milk)/.test(first)) return 'Plant milks';
    if (/^milk\b/.test(first) && !/\b(dry|dried|evaporated|condensed|canned|powder|malted|goat|sheep)\b/.test(first)) return 'Milk';
    return 'Dairy';
  }
  if (g === 'Legumes') {
    if (/^(peanuts?|peanut butter)/.test(first)) return 'Nuts and seeds';
    if (/soy sauce|tamari|teriyaki|miso|natto/.test(first)) return /miso|natto/.test(first) ? 'Legumes' : 'Sauces and condiments';
    if (/soymilk|soy milk/.test(first)) return 'Plant milks';
    if (/soy yogurt|soy creamer|creamer/.test(first)) return 'Dairy';
    return 'Legumes';
  }
  if (g === 'Fats and oils') {
    if (/dressing|mayonnaise|sauce|\bdip\b/.test(first)) return 'Sauces and condiments';
    return 'Fats and oils';
  }
  if (g === 'Sauces and condiments') {
    if (/^soups?\b|\bsoup\b|broth|stock|bouillon|chowder|bisque|\bstew\b/.test(first)) return 'Soups';
    if (/\bjuice\b/.test(first)) return 'Fruit juice';
    if (/\boil\b/.test(first) && !/dressing|sauce|mayonnaise/.test(first)) return 'Fats and oils';
    return 'Sauces and condiments';
  }
  if (g === 'Vegetables') {
    if (/^(potatoes|potato|sweet potato|sweet potatoes|cassava|yam|yams|taro,|taro root|plantain|yautia|arrowroot)\b/.test(first)) return 'Potatoes';
    if (/^(catsup|ketchup)|salsa|tomato sauce|relish/.test(first)) return 'Sauces and condiments';
    if (/\bjuice\b/.test(first)) return 'Fruit juice';
    if (/^soups?\b/.test(first)) return 'Soups';
    return 'Vegetables';
  }
  if (g === 'Fruit') {
    if (/\bjuice\b/.test(first) && !/\b(sauce|dried|candied)\b/.test(first)) return 'Fruit juice';
    return 'Fruit';
  }
  if (g === 'Drinks') {
    if (!/\b(non-?alcoholic|alcohol[- ]free)\b/.test(first) && (/^(alcoholic|beer|wine|liquor|whiskey|distilled)|\b(beer|wine|whiskey|vodka|rum|gin|brandy|liqueur|cocktail)\b|alcoholic/.test(first))) return 'Alcoholic drinks';
    if (/\b(tea|coffee|chicory|espresso|latte|cappuccino|mocha)\b/.test(first) && !/\b(with sugar|with milk|lemonade|iced tea mix|lemon)\b/.test(first)) return 'Coffee and tea';
    if (/^(beverages, )?(water|mineral water|spring water)\b|^(bottled|tap|drinking|mineral|spring) water\b/.test(first)) return 'Water';
    if (/\bjuice\b/.test(first) && !/\b(drink|cocktail|punch|ade\b|beverage|blend)\b/.test(first)) return 'Fruit juice';
    if (/(soymilk|soy milk|almond milk|rice milk|oat milk|coconut milk|hemp milk|nut milk)/.test(first)) return 'Plant milks';
    if (/\b(nutritional|protein|whey|instant breakfast|supplement|shake mix)\b/.test(first) && /\b(powder|mix)\b/.test(first)) return 'Supplements and powders';
    return 'Drinks';
  }
  if (g === 'Cakes and pastries') {
    if (/^(bread|rolls?|bagels?|english muffins?|pita|naan|tortillas?|croissants?|buns?|taco shells?|biscuits?|muffins?|pancakes?|waffles?|french toast|crepes?|breadsticks?|stuffing|bread crumbs|focaccia|ciabatta|pan de|cornbread|bread)\b/.test(first)) return 'Bread and rolls';
    if (/^(crackers?|cookies?|wafers?|graham|crispbread|rusk|matzo|melba|pretzels?)\b/.test(first)) return 'Biscuits and crackers';
    return 'Cakes and pastries';
  }
  if (g === 'Sweets and chocolate') {
    if (/^(sugars?|syrups?|honey|jams?|jellies|molasses|preserves|marmalade|toppings?|sweeteners?|fruit butter|frostings?|icings?)\b/.test(first)) return 'Sugar, syrups and spreads';
    if (/^(frozen novelties|ice cream|puddings?|gelatin|desserts?|custards?|egg custards?|sherbet|sorbet|whipped topping|rennin|flan)\b/.test(first)) return 'Desserts';
    return 'Sweets and chocolate';
  }
  if (g === 'Rice, pasta and grains') {
    if (/flour|\bstarch\b|cornmeal|^bran\b|wheat germ|\bgerm\b|^baking|leavening/.test(first)) return 'Flour and baking';
    return 'Rice, pasta and grains';
  }
  if (g === 'Snacks') {
    if (/\b(candy|candies|chocolate|marshmallow)\b/.test(first)) return 'Sweets and chocolate';
    return 'Snacks';
  }
  if (g === 'Beef' || g === 'Pork' || g === 'Poultry' || g === 'Lamb, veal and game') {
    if (/^(babyfood|infant)/.test(first)) return 'Baby food';
    if (g !== 'Poultry' && /^(turkey|chicken)\b/.test(first)) return 'Poultry';
    return g;
  }
  if (g === 'Herbs and spices') {
    if (/^(vinegar|mustard|salt|sauce|seasoning|baking|yeast|leavening)\b/.test(first)) return /^(baking|yeast|leavening)/.test(first) ? 'Flour and baking' : 'Sauces and condiments';
    return g;
  }
  if (g === 'Other') return groupByWords(low);
  return g;
}

// Whatever its category, frozen dairy desserts are desserts.
const FROZEN_DESSERT = /^(ice creams?|frozen yogurts?|sherbets?|sorbets?|frozen novelties|popsicles?|ice pops?)\b/i;

// ---------- Portions ----------

// Portion labels with their size words kept: "1 small serving", "1 large fast food order". USDA's US
// units are named as such, and the placeholders that carry no size are dropped.
export function portionLabel(label) {
  let l = clean(label);
  if (/^(quantity not specified|portion|undetermined)$/i.test(l)) return null;
  if (/^guideline amount/i.test(l)) return null;
  l = l.replace(/,?\s*\b(NFS|NS as to [^,)]*)/gi, '').replace(/\s{2,}/g, ' ').trim();
  if (!l) return null;
  l = l.replace(/^(\d+)\.0\b/, '$1').replace(/^(\d+(?:\.\d+)?) cup\b/i, '$1 US cup').replace(/\bfl oz\b/i, 'US fl oz').replace(/NLEA serving/i, 'serving (US label size)')
    .replace(/(\d)"/g, '$1 in');
  return l;
}

// ---------- The whole record text ----------

const dedupeParens = (s) => s.replace(/\b([A-Za-z][A-Za-z -]*?) \(\1\)/gi, '$1');

export function nameFood(food) {
  const original = clean(food.description);
  // Foundation and SR write some names in Title Case; the survey foods are sentence case with real names capitalised.
  const runs = food.dataset !== 'survey_fndds_food';
  let desc = original.replace(PARENS_DROP, '');
  let brand = null;
  let place = null;

  // FNDDS: a trailing "(Brand)" that starts with a capital: "Cheeseburger (Burger King)", "Nutrition bar (Clif Bar)".
  const tail = desc.match(/^(.*?)\s*\(([A-Z][^()]*)\)\s*$/);
  if (food.dataset === 'survey_fndds_food' && tail && !/^(NFS|NS|2%|1%)/.test(tail[2]) && !/^[A-Z]{1,3}\.?$/.test(tail[2]) && tail[1]) {
    brand = CHAIN_TAIL[tail[2].toLowerCase()] || tail[2];
    desc = tail[1];
  }

  if (!brand) {
    const p = placeOf(desc);
    if (p) { desc = p.rest; place = p.kind; }
  }

  let segs = splitTop(desc);

  // Chains: "BURGER KING, french fries" and "PIZZA HUT 14" Pepperoni Pizza, THIN 'N CRISPY Crust".
  if (!brand) {
    for (const [re, canon] of CHAINS) {
      const m = desc.match(re);
      if (!m) continue;
      brand = canon;
      segs = splitTop(desc.slice(m[0].length).replace(/^[\s,]+/, ''));
      // "14" Pepperoni Pizza, Thin Crust" → "Pepperoni pizza, 14 in, thin crust".
      const piz = segs[0]?.match(/^(\d+)"\s*(.*?)\s*pizza$/i);
      if (piz) segs = [`${piz[2] ? `${piz[2]} ` : ''}pizza`.trim(), `${piz[1]} in`, ...segs.slice(1)];
      break;
    }
  }

  // Other brands: an all-capitals segment ("Yogurt, Greek, CHOBANI") or leading capitals ("SILK Chocolate, soymilk").
  if (!brand && segs.length) {
    const i = segs.findIndex((s) => allCaps(s));
    if (i >= 0) {
      brand = titleCase(segs[i]);
      segs.splice(i, 1);
      segs = segs.map((s) => (allCaps(s) ? titleCase(s) : s));
    } else {
      const m = segs[0].match(/^((?:[A-Z0-9'’&.\-]{2,} )*[A-Z0-9'’&.\-]{3,}) ([A-Za-z].*)$/);
      if (m && allCaps(m[1]) && /[a-z]/.test(m[2])) {
        brand = titleCase(m[1]);
        segs[0] = m[2];
      }
    }
  }
  if (brand) brand = brand.replace(/^Mc([a-z])/, (x, c) => `Mc${c.toUpperCase()}`);

  // Noise, and "raw" (the default, so it is not said).
  segs = segs.map((s) => s.replace(/\bseparable lean and fat\b/gi, 'lean and fat').replace(/\bseparable lean only\b/gi, 'lean only').replace(/\bseparable\b/gi, '')
    .replace(/^raw (\(.*\))$/i, '$1').replace(/\bNS as to [^,]*$/i, '').replace(/\s*\bNFS\b/gi, '').replace(/\s+/g, ' ').trim())
    .filter((s) => s && !NOISE_SEG.test(s) && !/^NS as to/i.test(s));
  const merged = [];
  for (const s of segs) {
    if (/^\(/.test(s) && merged.length) merged[merged.length - 1] += ` ${s}`;
    else merged.push(s);
  }
  segs = merged;

  segs = reorder(segs, { brand: Boolean(brand) });
  let productIsBrand = false;
  if (brand && segs.length === 1 && DROP_HEAD.has(segs[0].toLowerCase())) { segs = [brand]; productIsBrand = true; }
  let name = segs.join(', ');
  name = sentence(name, { runs });
  name = name.replace(/\.$/, '').replace(/(\d+(?:\/\d+)?)"/g, '$1 in').replace(/\s*,\s*,/g, ',').replace(/\s+,/g, ',').trim();
  if (place === 'fast food') name = `${name} (fast food)`;
  else if (place) name = `${name} (${place})`;

  // UK English, keeping the US wording as an alias.
  let uk = name;
  for (const [re, to] of UK) uk = uk.replace(re, to);
  uk = cap(dedupeParens(uk.replace(/\s{2,}/g, ' ')).trim());
  // "Green beans, green, canned": a segment that only repeats the first word of the one before is dropped.
  uk = splitTop(uk).filter((s, i, all) => i === 0 || s.toLowerCase() !== all[i - 1].split(' ')[0].toLowerCase()).join(', ');
  // A US biscuit is a bread-like scone, not a UK biscuit.
  if (/^biscuits?\b/i.test(uk) && !/cookie/i.test(original)) uk = uk.replace(/^biscuits?\b/i, (m) => (m.toLowerCase().endsWith('s') ? 'US-style biscuits' : 'US-style biscuit'));
  if (uk.length > 150) uk = `${uk.slice(0, 147).replace(/[,\s]+\S*$/, '')}...`;

  // The original description is always an alias, so searching USDA's own wording still finds the record.
  const seen = new Set([original.toLowerCase()]);
  const aliases = [original];
  const add = (a) => {
    const t = clean(a);
    if (t && !seen.has(t.toLowerCase()) && t.toLowerCase() !== uk.toLowerCase()) { seen.add(t.toLowerCase()); aliases.push(t); }
  };
  // Search matches words, not phrases, so USDA's own wording (the first alias) already carries every US term
  // and the old word order. What it cannot carry is the UK wording the name did not start with.
  for (const [re, extra, cond] of ALIAS_EXTRA) if (re.test(uk) && !uk.toLowerCase().includes(extra) && (!cond || cond.test(original))) add(uk.replace(re, extra));

  // "Candies, HERSHEY'S GOLDEN ALMOND SOLITAIRES": the brand text is the whole product, so the brand is its first word.
  let brandOut = brand || null;
  if (productIsBrand && brand) {
    const first = brand.split(' ')[0];
    brandOut = brand.split(' ').length > 1 && first.length >= 3 ? first : brand;
  }
  return { name: uk, brand: brandOut, aliases: aliases.slice(0, 4), place: place || null };
}
