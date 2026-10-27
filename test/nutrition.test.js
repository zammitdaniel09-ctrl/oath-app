// The food maths shared by the phone and the server: amounts, label bases, unknowns, concentrates,
// multipacks, shakes, batches and recipes with sub-recipes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolve, line, total, scale, unitsFor, recipeTotals, batchPortion, batchLeft, norm, show, complete, fillSourceParts,
} from '../public/nutrition.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

const banana = {
  key: 'banana-raw', name: 'Banana', basis: 'g', edible: 0.64, refuse: 'Skin',
  nutrients: { kcal: 89, protein: 1.09, carbs: 20.24, sugars: 12.23, fat: 0.33, satfat: 0.112, fibre: 2.6, salt: 0.0025, caffeine: 0, alcohol: 0 },
  portions: [{ label: '1 medium (7" to 7-7/8" long)', g: 118 }],
};
const energy = {
  key: 'energy-zero', name: 'Energy drink, zero sugar', basis: 'ml', liquid: true,
  nutrients: { kcal: 3, protein: 0, carbs: 0.9, sugars: 0, fat: 0, satfat: 0, fibre: null, salt: 0.18, caffeine: 32, alcohol: null },
  pack: { size: 500, unit: 'ml' },
};
const noCaffeine = { ...energy, key: 'import-drink', nutrients: { ...energy.nutrients, caffeine: null } };
const milk = { key: 'milk', name: 'Milk', basis: 'g', density: 1.031, liquid: true, nutrients: { kcal: 50, protein: 3.3, carbs: 4.8, sugars: 5, fat: 2, satfat: 1.2, fibre: 0, salt: 0.1, caffeine: 0, alcohol: 0 } };
const water = { key: 'water', name: 'Water', basis: 'g', density: 1, liquid: true, nutrients: { kcal: 0, protein: 0, carbs: 0, sugars: 0, fat: 0, satfat: 0, fibre: 0, salt: 0.01, caffeine: 0, alcohol: 0 } };
const whey = { key: 'whey', name: 'Whey', basis: 'g', nutrients: { kcal: 380, protein: 78, carbs: 6, sugars: 5, fat: 5, satfat: 3, fibre: null, salt: 0.5, caffeine: null, alcohol: null } };
const oats = { key: 'oats', name: 'Oats', basis: 'g', nutrients: { kcal: 379, protein: 13, carbs: 58, sugars: 1, fat: 6.5, satfat: 1.1, fibre: 10, salt: 0.01, caffeine: 0, alcohol: 0 } };
const bars = { key: 'bars', name: 'Cereal bar', basis: 'g', pack: { size: 150, unit: 'g', count: 6 }, nutrients: { kcal: 420, protein: 6, carbs: 60, sugars: 30, fat: 16, satfat: 7, fibre: 4, salt: 0.4, caffeine: null, alcohol: null } };
const squash = { key: 'squash', name: 'Orange squash', basis: 'ml', concentrate: { water: 4 }, nutrients: { kcal: 50, protein: 0, carbs: 12, sugars: 12, fat: 0, satfat: 0, fibre: 0, salt: 0.02, caffeine: 0, alcohol: 0 } };

test('edible portions: USDA portions are edible weight; a whole weighed banana uses the sourced refuse', () => {
  const p = line(banana, 1, 'p:1 medium (7" to 7-7/8" long)');
  close(p.g, 118);
  close(p.nutrients.kcal, 105.02);
  const whole = resolve(banana, 180, 'whole');
  close(whole.g, 115.2);
  assert.match(whole.note, /edible part of 180 g whole/);
  const noRefuse = { ...banana, edible: null };
  assert.ok(resolve(noRefuse, 180, 'whole').error);
  assert.ok(!unitsFor(noRefuse).some((u) => u.unit === 'whole'));
});

test('drinks labelled per 100 ml are worked out from ml, with no invented density', () => {
  const l = line(energy, 250, 'ml');
  close(l.nutrients.caffeine, 80);
  close(l.nutrients.kcal, 7.5);
  assert.equal(l.ml, 250);
  assert.ok(resolve(energy, 100, 'g').error, 'grams of a per-100-ml drink need a sourced density');
});

test('half a can scales caffeine; a drink with no caffeine on record stays unknown, not zero', () => {
  const half = line(energy, 0.5, 'pack');
  close(half.ml, 250);
  close(half.nutrients.caffeine, 80);
  const unknownCaf = line(noCaffeine, 0.5, 'pack');
  assert.equal(unknownCaf.nutrients.caffeine, null);
  const day = total([half.nutrients, unknownCaf.nutrients]);
  close(day.caffeine, 80);
  assert.equal(day.missing.caffeine, 1);
  assert.equal(show(day, 'caffeine'), '80+ mg');
});

test('one inner bar from a multipack is the pack weight divided by the count', () => {
  const one = line(bars, 1, 'each');
  close(one.g, 25);
  close(one.nutrients.kcal, 105);
  assert.ok(resolve({ ...bars, pack: { size: 150, unit: 'g' } }, 1, 'each').error);
});

test('a concentrate made up with water counts the concentrate once; water adds nothing', () => {
  const made = line(squash, 250, 'prepared');
  close(made.ml, 50);
  close(made.nutrients.kcal, 25);
  const separately = total([line(squash, 50, 'ml').nutrients, line(water, 200, 'ml').nutrients]);
  close(separately.kcal, made.nutrients.kcal);
});

test('a shake: swapping milk for water removes only the milk; a measured batch logs the share drunk', () => {
  const get = { item: (k) => ({ milk, water, whey, oats, banana })[k], recipe: () => null };
  const shake = { key: 'shake', servings: 1, lines: [
    { ref: 'item', ref_key: 'milk', qty: 250, unit: 'ml' },
    { ref: 'item', ref_key: 'whey', qty: 30, unit: 'g' },
    { ref: 'item', ref_key: 'banana', qty: 100, unit: 'g' },
    { ref: 'item', ref_key: 'oats', qty: 40, unit: 'g' },
  ] };
  const withMilk = recipeTotals(shake, get);
  const withWater = recipeTotals(shake, get, { swap: { 0: { ref_key: 'water' } } });
  const milkPart = line(milk, 250, 'ml').nutrients;
  const waterPart = line(water, 250, 'ml').nutrients;
  close(withMilk.nutrients.kcal - withWater.nutrients.kcal, milkPart.kcal - waterPart.kcal);
  close(withMilk.nutrients.protein - withWater.nutrients.protein, milkPart.protein);
  const morePowder = recipeTotals(shake, get, { swap: { 1: { qty: 45 } } });
  close(morePowder.nutrients.kcal - withMilk.nutrients.kcal, 15 * 3.8);
  // Worked example E: a 600 g homogeneous batch, 300 g drunk, is half of it.
  const p = batchPortion({ nutrients: withMilk.nutrients, final_weight: 600, servings: 1 }, 300, 'g');
  close(p.share, 0.5);
  close(p.nutrients.kcal, withMilk.nutrients.kcal / 2);
  // The powder has no fibre value, so the fibre total says so.
  assert.equal(withMilk.nutrients.missing.fibre, 1);
});

test('scenario 14: 300 g and 250 g from a 1,600 g batch is 550/1,600 of it, with 1,050 g left', () => {
  const batch = { nutrients: { kcal: 3200, protein: 160, carbs: 400, sugars: 40, fat: 96, satfat: 20, fibre: 32, salt: 8, caffeine: 0, alcohol: 0 }, final_weight: 1600, servings: 4 };
  const today = batchPortion(batch, 300, 'g');
  const tomorrow = batchPortion(batch, 250, 'g');
  close(today.share + tomorrow.share, 550 / 1600);
  close(today.nutrients.kcal + tomorrow.nutrients.kcal, 3200 * (550 / 1600));
  const left = batchLeft(batch, [today.share, tomorrow.share]);
  close(left.g, 1050);
  close(left.servings, 4 * (1050 / 1600));
  assert.equal(left.over, false);
  assert.ok(batchPortion({ ...batch, final_weight: null }, 100, 'g').error, 'grams need a weighed batch');
});

test('unknowns stay unknown through scaling and totals; an empty day is a known zero', () => {
  const n = scale({ kcal: 100, protein: null }, 50, 100);
  assert.equal(n.protein, null);
  close(n.kcal, 50);
  const t = total([{ kcal: 10, sugars: null }, { kcal: 20, sugars: null }]);
  assert.equal(t.sugars, null);
  assert.equal(t.missing.sugars, 2);
  assert.equal(complete(t), false);
  assert.equal(total([]).kcal, 0);
  assert.equal(show({ protein: null }, 'protein'), '—');
});

test('sub-recipes count once at the share used, and loops are refused', () => {
  const sauce = { key: 'sauce', servings: 4, lines: [{ ref: 'item', ref_key: 'oats', qty: 400, unit: 'g' }] };
  const dish = { key: 'dish', servings: 2, lines: [{ ref: 'recipe', ref_key: 'sauce', qty: 1, unit: 'serving' }, { ref: 'item', ref_key: 'banana', qty: 100, unit: 'g' }] };
  const get = { item: (k) => ({ oats, banana })[k], recipe: (k) => ({ sauce, dish })[k] };
  const t = recipeTotals(dish, get);
  close(t.nutrients.kcal, 379 + 89);
  const a = { key: 'a', servings: 1, lines: [{ ref: 'recipe', ref_key: 'b', qty: 1, unit: 'serving' }] };
  const b = { key: 'b', servings: 1, lines: [{ ref: 'recipe', ref_key: 'a', qty: 1, unit: 'serving' }] };
  assert.throws(() => recipeTotals(a, { item: () => null, recipe: (k) => ({ a, b })[k] }), /Recipe loop/);
});

test('optional lines are counted only when chosen; any line can be left out', () => {
  const bowl = { key: 'bowl', servings: 1, lines: [
    { ref: 'item', ref_key: 'banana', qty: 100, unit: 'g' },
    { ref: 'item', ref_key: 'oats', qty: 20, unit: 'g', optional: true },
  ] };
  const get = { item: (k) => ({ oats, banana })[k], recipe: () => null };
  close(recipeTotals(bowl, get).nutrients.kcal, 89);
  close(recipeTotals(bowl, get, { with: [1] }).nutrients.kcal, 89 + 75.8);
  close(recipeTotals(bowl, get, { with: [1], skip: [0] }).nutrients.kcal, 75.8);
});

test('search text folds accents and Maltese letters', () => {
  assert.equal(norm('Ħobż biż-żejt'), 'hobz biz zejt');
  assert.equal(norm('Qagħaq tal-għasel'), 'qaghaq tal ghasel');
  assert.equal(norm('Crème fraîche'), 'creme fraiche');
});

test('where filled values came from reads as one short line, linking only to a real web page', () => {
  assert.deepEqual(fillSourceParts(null), []);
  assert.deepEqual(fillSourceParts({}), []);
  assert.deepEqual(fillSourceParts({ usda: { name: 'Cola', keys: ['potassium', 'vitc'] } }), [{ text: 'Vitamins and minerals filled from USDA: Cola' }]);
  assert.deepEqual(fillSourceParts({ usda: { name: 'Cola', keys: ['fibre'] } }), [{ text: 'Missing values filled from USDA: Cola' }]);
  assert.deepEqual(fillSourceParts({ estimate: { keys: ['sugars'] } }), [{ text: 'Values marked ~ are estimates' }]);
  assert.deepEqual(fillSourceParts({ web: { url: 'https://www.mcdonalds.com/mt/en/nutrition.html', name: 'McFlurry', keys: ['kcal'] } }), [
    { text: 'Values from ', link: { url: 'https://www.mcdonalds.com/mt/en/nutrition.html', text: 'mcdonalds.com' } },
  ]);
  assert.deepEqual(fillSourceParts({ web: { url: 'javascript:alert(1)', name: 'McFlurry', keys: ['kcal'] } }), [{ text: 'Values from McFlurry' }]);
  // A worked-out amount is said only alongside what it was used for.
  assert.deepEqual(fillSourceParts({ weight: { amount: 330, unit: 'g', from: 'energy' } }), []);
  assert.ok(!fillSourceParts({ usda: { name: 'Gyro sandwich', keys: ['iron'] }, weight: { amount: 249.6, unit: 'g', from: 'portion' } }).some((p) => p.text.includes('—')));
  assert.equal(fillSourceParts({ usda: { name: 'Gyro sandwich', keys: ['iron'] }, weight: { amount: 249.6, unit: 'g', from: 'portion' } })[1].text, 'Worked out for about 250 g, a typical portion');
});
