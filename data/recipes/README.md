# Recipe library

One JSON file per family, each an array of recipes. Seeded into the app by key, so editing a file and
redeploying updates the same recipe (Daniel's own edits are never overwritten).

Every recipe here is original, written for Oath, and marked "AI-written, not kitchen-tested" in the app.
Nutrition is never typed in: it is worked out from the ingredient lines and the catalogue
(`data/foods/usda-foods.json`, built from USDA FoodData Central).

## Format

```json
{
  "key": "porridge-banana",
  "name": "Banana porridge",
  "name_mt": null,
  "family": "breakfast-fruit-oats",
  "type": "base",
  "parent_key": null,
  "req": ["breakfast-fruit-oats/banana-porridge"],
  "summary": "Oats simmered in milk, topped with sliced banana.",
  "servings": 1,
  "final_weight": null,
  "prep_min": 2,
  "cook_min": 6,
  "equipment": ["saucepan"],
  "tags": ["breakfast", "meat-free", "hot"],
  "lines": [
    { "ref": "item", "ref_key": "oats-rolled-dry", "qty": 50, "unit": "g", "label": "oats" },
    { "ref": "item", "ref_key": "milk-semi-skimmed", "qty": 250, "unit": "ml", "label": "milk" },
    { "ref": "item", "ref_key": "banana-raw", "qty": 100, "unit": "g", "label": "banana" },
    { "ref": "item", "ref_key": "honey-as-sold", "qty": 7, "unit": "g", "label": "honey", "optional": true }
  ],
  "method": [
    "Put the oats and milk in a small saucepan and bring to a simmer, stirring.",
    "Cook for 4 to 5 minutes until thick, then pour into a bowl.",
    "Slice the banana over the top and drizzle with honey if you like."
  ],
  "notes": ""
}
```

- `type`: `base` (a distinct dish), `variant` (the same dish with a real substitution; `parent_key` names its base),
  `component` (a sauce, dough, dressing or filling used inside other recipes), `template` (a shake preset or a
  saved meal combination: an editable assembly, not an authored recipe).
- `lines[].ref`: `item` (a catalogue key) or `recipe` (another recipe's key, with unit `serving`, or `g` when that
  recipe has a `final_weight`).
- `lines[].unit`: `g` (edible weight), `ml` (only for records that list ml), `p:<exact USDA portion label>` such as
  `p:1 tsp`, or `whole` (weighed with peel or bones, only where the record allows it).
- `lines[].label`: the ingredient as the method names it. The method must mention every label.
- `optional: true` lines are left out of the totals unless chosen.
- `final_weight` stays `null`: the app asks for the cooked weight of a real batch rather than asserting one.

Check with `node scripts/check-recipes.mjs [family ...] [--list]`. Find catalogue keys with
`node scripts/find-food.mjs "words"`.
