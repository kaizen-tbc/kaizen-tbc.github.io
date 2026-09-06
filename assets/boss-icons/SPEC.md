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

## Full boss list — REVISED: one portrait per named NPC, not per encounter
An encounter that actually involves more than one nameable individual (a boss +
a named pet/mount, a set of named lieutenants fought alongside the boss, a
pool of randomly-selected named adds, etc.) needs a SEPARATE portrait for
EVERY one of those individuals - not one combined/representative shot. Players
need to recognize each one on its own (e.g. as a future draggable map marker),
so "pick the most recognizable one" is no longer the rule anywhere below.

Single-NPC encounters are unchanged from before. Multi-NPC ones are called out
explicitly with every individual listed. A few of the older combined files
(`kara-romuloandjulianne`, `kara-wizardofoz`, `bt-council`, `swp-twins`) are
now SUPERSEDED by their split-out replacements below - once the new ones
exist, those old combined files can be deleted.

**Karazhan** (`kara`)
- `kara-attumen.png` — Attumen the Huntsman
- `kara-midnight.png` — Midnight (his horse) — **new**
- `kara-moroes.png` — Moroes
- `kara-guest-dorothea.png` — Baroness Dorothea Millstipe (dinner guest) — **new**
- `kara-guest-rafe.png` — Baron Rafe Dreuger (dinner guest) — **new**
- `kara-guest-catriona.png` — Lady Catriona von'Indi (dinner guest) — **new**
- `kara-guest-crispin.png` — Lord Crispin Ference (dinner guest) — **new**
- `kara-guest-keira.png` — Lady Keira Berrybuck (dinner guest) — **new**
  (only 4 of these 5 guests spawn per pull, randomly - all 5 need portraits)
- `kara-maiden.png` — Maiden of Virtue
- `kara-bigbadwolf.png` — The Big Bad Wolf (Opera event variant - solo, unchanged)
- `kara-romulo.png` — Romulo (Opera event variant) — **new, replaces kara-romuloandjulianne**
- `kara-julianne.png` — Julianne (Opera event variant) — **new, replaces kara-romuloandjulianne**
- `kara-dorothee.png` — Dorothee (Opera event variant) — **new, replaces kara-wizardofoz**
- `kara-tito.png` — Tito (Dorothee's dog) — **new, replaces kara-wizardofoz**
- `kara-strawman.png` — Strawman — **new, replaces kara-wizardofoz**
- `kara-tinhead.png` — Tinhead — **new, replaces kara-wizardofoz**
- `kara-roar.png` — Roar (the cowardly lion) — **new, replaces kara-wizardofoz**
- `kara-crone.png` — The Crone — **new, replaces kara-wizardofoz**
- `kara-curator.png` — The Curator
- `kara-aran.png` — Shade of Aran
- `kara-illhoof.png` — Terestian Illhoof
- `kara-kilrek.png` — Kil'rek (Illhoof's imp servant) — **new**
- `kara-netherspite.png` — Netherspite
- `kara-chess.png` — Chess Event / Court of Karazhan (kept as a scene, not a portrait)
- `kara-malchezaar.png` — Prince Malchezaar
- `kara-nightbane.png` — Nightbane (optional/bonus)

**Gruul's Lair & Magtheridon's Lair** (`gruul-mag`)
- `gruul-mag-maulgar.png` — High King Maulgar
- `gruul-mag-kiggler.png` — Kiggler the Crazed — **new**
- `gruul-mag-blindeye.png` — Blindeye the Seer — **new**
- `gruul-mag-olm.png` — Olm the Summoner — **new**
- `gruul-mag-krosh.png` — Krosh Firehand — **new**
- `gruul-mag-gruul.png` — Gruul the Dragonkiller
- `gruul-mag-magtheridon.png` — Magtheridon

**Serpentshrine Cavern** (`ssc`)
- `ssc-hydross.png` — Hydross the Unstable
- `ssc-lurker.png` — The Lurker Below
- `ssc-leotheras.png` — Leotheras the Blind
- `ssc-karathress.png` — Fathom-Lord Karathress
- `ssc-sharkkis.png` — Fathom-Guard Sharkkis — **new**
- `ssc-tidalvess.png` — Fathom-Guard Tidalvess — **new**
- `ssc-caribdis.png` — Fathom-Guard Caribdis — **new**
- `ssc-morogrim.png` — Morogrim Tidewalker
- `ssc-vashj.png` — Lady Vashj

**The Eye** (`tk`)
- `tk-alar.png` — Al'ar
- `tk-voidreaver.png` — Void Reaver
- `tk-solarian.png` — High Astromancer Solarian
- `tk-kaelthas.png` — Kael'thas Sunstrider
- `tk-sanguinar.png` — Lord Sanguinar (advisor) — **new**
- `tk-capernian.png` — Grand Astromancer Capernian (advisor) — **new**
- `tk-thaladred.png` — Thaladred the Darkener (advisor) — **new**
- `tk-telonicus.png` — Master Engineer Telonicus (advisor) — **new**

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
- `bt-reliquary.png` — Reliquary of Souls (its 3 sequential forms - Essence of
  Suffering/Desire/Anger - are visually similar enough that one portrait is
  fine unless you want all 3; not treating this as mandatory to split)
- `bt-shahraz.png` — Mother Shahraz
- `bt-gathios.png` — Gathios the Shatterer (Illidari Council) — **new, replaces bt-council**
- `bt-zerevor.png` — High Nethermancer Zerevor (Illidari Council) — **new, replaces bt-council**
- `bt-malande.png` — Lady Malande (Illidari Council) — **new, replaces bt-council**
- `bt-veras.png` — Veras Darkshadow (Illidari Council) — **new, replaces bt-council**
- `bt-illidan.png` — Illidan Stormrage

**Sunwell Plateau** (`swp`)
- `swp-kalecgos.png` — Kalecgos
- `swp-sathrovarr.png` — Sathrovarr the Corruptor — **new**
- `swp-brutallus.png` — Brutallus
- `swp-felmyst.png` — Felmyst
- `swp-sacrolash.png` — Sacrolash (Eredar Twins) — **new, replaces swp-twins**
- `swp-alythess.png` — Alythess (Eredar Twins) — **new, replaces swp-twins**
- `swp-muru.png` — M'uru (its Entropius sub-phase is the same entity twisted
  inside-out - one portrait is fine, not treating this as mandatory to split)
- `swp-kiljaeden.png` — Kil'jaeden

~69 icons total (up from 46) once every "new" one above is done, not counting
the optional Reliquary/M'uru splits.
