# Boss icon generation spec (for Codex)

## What these are for
Small "portrait" icons used on Kaizen's map-pin system (Strats tab) — one icon per
boss, dropped into a circular pin badge. **Our own CSS already draws the colored
ring/border around the icon** (same system used for class/spec icons today), so
**do not** bake a ring, vignette border, or circular crop into the image itself.
Deliver plain square images; we crop them into a circle in code via `object-fit:cover`.

## File format
- **Square, 512×512px**, PNG or JPG (PNG if there's real transparency to gain from
  it, JPG otherwise — don't fight for a clean alpha cutout, see Style below).
- Centered **headshot/bust crop** — face and upper "shoulders" filling most of the
  frame, like a character portrait, not a full-body shot. Should read clearly at
  ~30px (how it actually displays in the pin), so keep it simple and high-contrast.
- **Representative, not photoreal-accurate.** These are stylized AI-generated
  portraits, not in-game model renders — close enough to be recognizable to
  someone who's fought the boss is the bar, not a pixel-perfect likeness. Fine if
  it reads as "AI art" as long as it looks *good* (clean, confident linework/
  rendering, not muddy or uncanny).
- Background: a simple, moody, thematic backdrop (a soft dark vignette, or a
  color/element tied to the boss's theme — fel-green mist for a demon, ice for a
  frost boss, etc.) rather than a flat/blank background. Since the final display
  crops to a circle, keep the subject centered with a little breathing room at
  the edges.
- One consistent overall art style across the whole set (painterly digital
  portrait style is a good default) so they read as one cohesive set rather than
  each boss looking like it came from a different generator/style.

## File naming and folder
Drop finished files directly into `assets/boss-icons/`, named `<raid-code>-<boss-slug>.png`
(or `.jpg`) — lowercase, hyphenated, matching the list below exactly. Raid codes
reuse the same short codes Kaizen already uses for strat images:

| Raid | code |
|---|---|
| Karazhan | `kara` |
| Gruul's Lair & Magtheridon's Lair | `gruul-mag` |
| Serpentshrine Cavern | `ssc` |
| The Eye (Tempest Keep) | `tk` |
| Battle for Mount Hyjal | `hyjal` |
| Black Temple | `bt` |
| Sunwell Plateau | `swp` |

## Full boss list
One icon per line unless noted. A "group" encounter (multiple named NPCs fought
together) only needs ONE icon — use whichever single member is the most
recognizable/central figure for the headshot.

**Karazhan** (`kara`)
- `kara-attumen.png` — Attumen the Huntsman (mounted on Midnight)
- `kara-moroes.png` — Moroes
- `kara-maiden.png` — Maiden of Virtue
- `kara-bigbadwolf.png` — The Big Bad Wolf (Opera event variant)
- `kara-romuloandjulianne.png` — Romulo and Julianne (Opera event variant)
- `kara-wizardofoz.png` — Wizard of Oz / Dorothee's group (Opera event variant)
- `kara-curator.png` — The Curator
- `kara-aran.png` — Shade of Aran
- `kara-illhoof.png` — Terestian Illhoof
- `kara-netherspite.png` — Netherspite
- `kara-chess.png` — Chess Event / Court of Karazhan (medivh's chess room - a
  chessboard/throne room scene works better than a "portrait" here)
- `kara-malchezaar.png` — Prince Malchezaar
- `kara-nightbane.png` — Nightbane (optional/bonus)

**Gruul's Lair & Magtheridon's Lair** (`gruul-mag`)
- `gruul-mag-maulgar.png` — High King Maulgar (group encounter, use Maulgar himself)
- `gruul-mag-gruul.png` — Gruul the Dragonkiller
- `gruul-mag-magtheridon.png` — Magtheridon

**Serpentshrine Cavern** (`ssc`)
- `ssc-hydross.png` — Hydross the Unstable
- `ssc-lurker.png` — The Lurker Below
- `ssc-leotheras.png` — Leotheras the Blind
- `ssc-karathress.png` — Fathom-Lord Karathress (group encounter)
- `ssc-morogrim.png` — Morogrim Tidewalker
- `ssc-vashj.png` — Lady Vashj

**The Eye** (`tk`)
- `tk-alar.png` — Al'ar
- `tk-voidreaver.png` — Void Reaver
- `tk-solarian.png` — High Astromancer Solarian
- `tk-kaelthas.png` — Kael'thas Sunstrider

**Battle for Mount Hyjal** (`hyjal`)
- `hyjal-winterchill.png` — Rage Winterchill
- `hyjal-anetheron.png` — Anetheron
- `hyjal-kazrogal.png` — Kaz'rogal
- `hyjal-azgalor.png` — Azgalor
- `hyjal-archimonde.png` — Archimonde

**Black Temple** (`bt`)
- `bt-najentus.png` — High Warlord Naj'entus
- `bt-supremus.png` — Supremus
- `bt-akama.png` — Shade of Akama
- `bt-gorefiend.png` — Teron Gorefiend
- `bt-bloodboil.png` — Gurtogg Bloodboil
- `bt-reliquary.png` — Reliquary of Souls
- `bt-shahraz.png` — Mother Shahraz
- `bt-council.png` — Illidari Council (group encounter, use Gathios the Shatterer)
- `bt-illidan.png` — Illidan Stormrage

**Sunwell Plateau** (`swp`)
- `swp-kalecgos.png` — Kalecgos
- `swp-brutallus.png` — Brutallus
- `swp-felmyst.png` — Felmyst
- `swp-twins.png` — Eredar Twins (Sacrolash and Alythess - group encounter)
- `swp-muru.png` — M'uru
- `swp-kiljaeden.png` — Kil'jaeden

46 icons total.
