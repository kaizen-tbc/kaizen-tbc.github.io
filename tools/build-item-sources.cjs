// One-time/occasional generator for app/item-sources.json - the "where does
// this item come from" map the Recruit Check tooltip uses (owner: "is there
// a way to show where the item came from, like what raid?"). Blizzard's item
// API has no drop-source field (confirmed: preview_item/static item carry no
// loot info), so this reads the loot tables the AtlasLootClassic addon ships
// - facts only (item id -> instance/boss), not its code - and compacts them.
//
// Usage: node tools/build-item-sources.cjs [path to the WoW AddOns folder]
// Re-run when AtlasLoot updates (new phase/content) and commit the result.
//
// Sources: AtlasLootClassic_DungeonsAndRaids/data-tbc.lua (instance -> boss
// -> item ids, normal/heroic) and AtlasLootClassic/Data/Token.lua (tier
// tokens -> the class pieces they turn into - e.g. Cowl of Tirisfal is not a
// direct drop, it's redeemed from "Helm of the Vanquished Hero"). Blocks
// gated to Wrath (GameVersion_GE WRATH) are skipped.
const fs = require('fs');
const path = require('path');

const ADDONS = process.argv[2] || 'C:/Program Files (x86)/World of Warcraft/_anniversary_/Interface/AddOns';
const LOOT = path.join(ADDONS, 'AtlasLootClassic_DungeonsAndRaids', 'data-tbc.lua');
const TOKENS = path.join(ADDONS, 'AtlasLootClassic', 'Data', 'Token.lua');
const OUT = path.join(__dirname, '..', 'item-sources.json');

const INSTANCE_NAMES = {
  HellfireRamparts: 'Hellfire Ramparts', TheBloodFurnace: 'The Blood Furnace', TheShatteredHalls: 'The Shattered Halls',
  'Mana-Tombs': 'Mana-Tombs', AuchenaiCrypts: 'Auchenai Crypts', SethekkHalls: 'Sethekk Halls', ShadowLabyrinth: 'Shadow Labyrinth',
  TheSlavePens: 'The Slave Pens', TheUnderbog: 'The Underbog', TheSteamvault: 'The Steamvault',
  OldHillsbradFoothills: 'Old Hillsbrad Foothills', TheBlackMorass: 'The Black Morass', TheArcatraz: 'The Arcatraz',
  TheBotanica: 'The Botanica', TheMechanar: 'The Mechanar', MagistersTerrace: "Magisters' Terrace", Karazhan: 'Karazhan',
  ZulAman: "Zul'Aman", WorldBossesBC: 'World Bosses', MagtheridonsLair: "Magtheridon's Lair", GruulsLair: "Gruul's Lair",
  SerpentshrineCavern: 'Serpentshrine Cavern', TempestKeep: 'Tempest Keep', HyjalSummit: 'Hyjal Summit',
  BlackTemple: 'Black Temple', SunwellPlateau: 'Sunwell Plateau',
};
const prettyInstance = k => INSTANCE_NAMES[k] || k.replace(/([a-z])([A-Z])/g, '$1 $2');

const instances = [], instIdx = new Map();
const bosses = [], bossIdx = new Map();
const idx = (list, map, v) => { if (!map.has(v)) { map.set(v, list.length); list.push(v); } return map.get(v); };

// itemId -> [[inst, boss, flags, tokenId?]]; flags bit1 = heroic, bit2 = via token
const items = {};
const addSource = (id, entry) => {
  const list = items[id] || (items[id] = []);
  if (!list.some(e => e[0] === entry[0] && e[1] === entry[1] && e[2] === entry[2] && e[3] === entry[3])) list.push(entry);
};

// ---- instance/boss/item loot ----
const lines = fs.readFileSync(LOOT, 'utf8').split(/\r?\n/);
let inst = null, boss = null, heroic = false, depth = 0, skip = null;
for (const raw of lines) {
  const line = raw.replace(/--.*$/, '');
  const startsSkip = skip === null && /GameVersion_GE\(\s*AtlasLoot\.WRATH_VERSION_NUM/.test(line);
  if (startsSkip) skip = depth;
  const opens = (line.match(/\{/g) || []).length, closes = (line.match(/\}/g) || []).length;
  const m = line.match(/^data\["([^"]+)"\]\s*=\s*\{/);
  if (skip === null) {
    if (m) { inst = idx(instances, instIdx, prettyInstance(m[1])); boss = null; heroic = false; }
    else if (inst !== null) {
      const b = line.match(/^\s*name\s*=\s*AL\["([^"]+)"\]/);
      if (b && depth >= 3) { boss = idx(bosses, bossIdx, b[1]); heroic = false; }
      const d = line.match(/\[(\w+)_DIFF\]\s*=\s*\{/);
      if (d) heroic = d[1] === 'HEROIC';
      const it = line.match(/^\s*\{\s*\d+\s*,\s*(\d+)\s*[,}]/);
      if (it && boss !== null && Number(it[1]) > 0) addSource(it[1], [inst, boss, heroic ? 1 : 0]);
    }
  }
  depth += opens - closes;
  if (skip !== null && depth <= skip) skip = null;
}

// ---- tier tokens -> the pieces they become ----
const tokenNames = {};
let tokenExpansions = 0;
for (const raw of fs.readFileSync(TOKENS, 'utf8').split(/\r?\n/)) {
  const m = raw.match(/^\s*\[(\d+)\]\s*=\s*\{(.*?)\}\s*,?\s*(?:--\s*(.*))?$/);
  if (!m) continue;
  const typeM = m[2].match(/type\s*=\s*(\d+)/);
  if (!typeM || (typeM[1] !== '6' && typeM[1] !== '8')) continue; // "Token for..." only
  const tokenId = m[1];
  const dropped = items[tokenId];
  if (!dropped) continue;
  const body = m[2].replace(/type\s*=\s*\d+/, '');
  const results = (body.match(/\b\d{4,6}\b/g) || []).filter(n => n !== tokenId);
  if (!results.length) continue;
  tokenNames[tokenId] = (m[3] || '').trim() || 'Token';
  for (const r of results) for (const src of dropped.filter(s => s.length === 3)) { addSource(r, [src[0], src[1], src[2] | 2, Number(tokenId)]); tokenExpansions++; }
}

fs.writeFileSync(OUT, JSON.stringify({ instances, bosses, tokens: tokenNames, items }));
console.log(`items: ${Object.keys(items).length}, instances: ${instances.length}, bosses: ${bosses.length}, token links: ${tokenExpansions}, bytes: ${fs.statSync(OUT).size}`);
