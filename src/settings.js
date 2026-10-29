// Changing settings: one place that checks every field, used by the Settings screen and the coach.
import { IANAZone } from 'luxon';
import { logEvent } from './db.js';
import { validTime } from './time.js';
import { saveSettings, getSettings, withGame, RuleError } from './engine.js';

// The looks public/theme.js offers; the app sends one of these names.
const THEMES = ['oath', 'liquid', 'atelier', 'tape', 'sovereign'];

// The game's rules, with the range each one may take. Steps keep the numbers round.
export const RULES = {
  maxHp: { min: 50, max: 500, step: 1, name: 'Max HP' },
  dailyLossCap: { min: 10, max: 500, step: 1, name: 'Most HP one day can cost' },
  taskPenalty: { min: 1, max: 100, step: 1, name: 'HP a hard task costs' },
  cleanBonus: { min: 0, max: 50, step: 1, name: 'Clean-day bonus' },
  comebackBonus: { min: 0, max: 50, step: 1, name: 'Comeback bonus' },
  repeatMultiplier: { min: 1, max: 3, step: 0.25, name: 'Second-miss multiplier' },
  pardonsPerMonth: { min: 0, max: 10, step: 1, name: 'Pardons a month' },
  restDaysPerMonth: { min: 0, max: 10, step: 1, name: 'Rest days a month' },
  maxNonNegotiables: { min: 1, max: 10, step: 1, name: 'Non-negotiables allowed' },
  undoMinutes: { min: 1, max: 120, step: 1, name: 'Minutes to undo a tick' },
};

const TIMES = { morningTime: 'Morning time', middayTime: 'Midday time', eveningTime: 'Evening time', dayEnd: 'Day end' };

export const isRuleKey = (k) => k in RULES;

function ruleValue(key, raw) {
  const r = RULES[key];
  const n = Number(raw);
  if (raw === '' || raw === null || !Number.isFinite(n)) throw new RuleError(`${r.name} must be a number.`);
  if (n < r.min || n > r.max) throw new RuleError(`${r.name} must be between ${r.min} and ${r.max}.`);
  return Math.round(n / r.step) * r.step;
}

// Checks a patch and returns only the fields it may change. Unknown fields are ignored.
export function cleanPatch(b = {}) {
  const patch = {};
  for (const [k, label] of Object.entries(TIMES)) {
    if (b[k] === undefined) continue;
    if (!validTime(b[k])) throw new RuleError(`${label} must be HH:MM.`);
    patch[k] = b[k];
  }
  if (b.alerts !== undefined) {
    if (!['smart', 'both', 'push'].includes(b.alerts)) throw new RuleError('Unknown alert setting.');
    patch.alerts = b.alerts;
  }
  if (b.timezone !== undefined) {
    if (!IANAZone.isValidZone(b.timezone)) throw new RuleError('Unknown time zone.');
    patch.timezone = b.timezone;
  }
  if (b.theme !== undefined) {
    if (!THEMES.includes(b.theme)) throw new RuleError('Unknown theme.');
    patch.theme = b.theme;
  }
  if (b.faceIdLock !== undefined) {
    if (typeof b.faceIdLock !== 'boolean') throw new RuleError('Face ID lock is on or off.');
    patch.faceIdLock = b.faceIdLock;
  }
  for (const k of Object.keys(RULES)) {
    if (b[k] !== undefined) patch[k] = ruleValue(k, b[k]);
  }
  return patch;
}

// Saves a checked patch. A lower max HP brings current HP down with it; rule changes are logged.
export async function applySettings(b) {
  const patch = cleanPatch(b);
  const before = await getSettings();
  const cap = patch.dailyLossCap ?? before.dailyLossCap;
  const max = patch.maxHp ?? before.maxHp;
  if (cap > max) throw new RuleError('One day cannot cost more than your max HP.');
  const saved = await saveSettings(patch);
  const changed = Object.keys(patch).filter((k) => isRuleKey(k) && patch[k] !== before[k]);
  if (changed.length) {
    await logEvent('rules_changed', Object.fromEntries(changed.map((k) => [k, { from: before[k], to: patch[k] }])));
    if (patch.maxHp !== undefined && patch.maxHp < before.maxHp) {
      await withGame(async (tx, game) => { game.hp = Math.min(game.hp, patch.maxHp); });
    }
  }
  return saved;
}
