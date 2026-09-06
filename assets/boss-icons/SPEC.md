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
  frame, like a character portrait, not a full-body shot. Displays at ~50-68px in
  the pin (bigger than a first pass assumed, since these are real art, not a flat
  icon - but still small), so it has to read as a clear, recognizable *silhouette
  and face* at a glance, not just look nice zoomed in.
- **Representative, not photoreal-accurate.** These are stylized AI-generated
  portraits, not in-game model renders — close enough to be recognizable to
  someone who's fought the boss is the bar, not a pixel-perfect likeness. Fine if
  it reads as "AI art" as long as it looks *good* (clean, confident linework/
  rendering, not muddy or uncanny).
- **Background: plain and neutral, not a busy scene.** The first pass used
  moody thematic backdrops (fire mist, dungeon scenery, etc.) that looked
  *great* at full size but turn into indistinct color blobs once shrunk down
  to pin size - the face stopped being the thing your eye lands on. Use a
  simple flat or soft two-tone gradient background instead (a single color or
  a subtle radial fade works fine, still themed if you want - e.g. dark red for
  a fel demon, icy blue-white for a frost boss - just not textured/detailed),
  chosen so the boss's silhouette and face contrast *hard* against it. The
  background's whole job is to make the subject pop, not to be a scene of its
  own. Keep the subject centered with a little breathing room at the edges
  (the display crops to a circle).
- **Simplify the level of detail generally** - fewer competing highlights,
  less busy armor/fur/scale texture, bolder shapes and clearer value contrast
  (dark vs. light) throughout, not just in the background. Simple reads better
  than intricate at this size; "simple is more" is the whole brief here.
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

## Full boss list — DONE. One portrait per named NPC, not per encounter.
This is the actual delivered set (79 files) - not a plan anymore. Naming below
matches the real files exactly. All the encounters that involve more than one
nameable individual (a boss + a named pet/mount, a set of named lieutenants,
a pool of randomly-selected named adds, sequential named forms) got a separate
portrait per individual, on the theory that each needs to be recognizable on
its own (e.g. as a future draggable map marker) - not just whichever one is
most iconic. The old combined files this replaced
(`kara-romuloandjulianne`, `kara-wizardofoz`, `bt-council`, `bt-reliquary`,
`swp-twins`) are already deleted.

**Karazhan** (`kara`) — 27 files
- `kara-attumen.png` — Attumen the Huntsman (re-generated solo once Midnight got his own)
- `kara-midnight.png` — Midnight (his horse)
- `kara-moroes.png` — Moroes
- `kara-baroness-dorothea-millstipe.png`, `kara-baron-rafe-dreuger.png`,
  `kara-lady-catriona-vonindi.png`, `kara-lord-crispin-ference.png`,
  `kara-lady-keira-berrybuck.png`, `kara-lord-robin-daris.png` — his 6 possible
  dinner guests (only 4 spawn per pull, randomly - all 6 needed portraits;
  Robin Daris was missing from the original plan, correctly added anyway)
- `kara-maiden.png` — Maiden of Virtue
- `kara-bigbadwolf.png` — The Big Bad Wolf (Opera event variant, solo)
- `kara-romulo.png`, `kara-julianne.png` — Romulo and Julianne (Opera event variant)
- `kara-dorothee.png`, `kara-tito.png`, `kara-strawman.png`, `kara-tinhead.png`,
  `kara-roar.png`, `kara-crone.png` — Wizard of Oz (Opera event variant), full cast
- `kara-curator.png` — The Curator
- `kara-aran.png` — Shade of Aran
- `kara-illhoof.png` — Terestian Illhoof
- `kara-kilrek.png` — Kil'rek (Illhoof's imp servant)
- `kara-netherspite.png` — Netherspite
- `kara-chess.png` — Chess Event / Court of Karazhan (a scene, not a portrait)
- `kara-malchezaar.png` — Prince Malchezaar
- `kara-nightbane.png` — Nightbane (optional/bonus)

**Gruul's Lair & Magtheridon's Lair** (`gruul-mag`) — 7 files
- `gruul-mag-maulgar.png` — High King Maulgar
- `gruul-mag-kiggler-crazed.png`, `gruul-mag-blindeye-seer.png`,
  `gruul-mag-olm-summoner.png`, `gruul-mag-krosh-firehand.png` — his 4 lieutenants
- `gruul-mag-gruul.png` — Gruul the Dragonkiller
- `gruul-mag-magtheridon.png` — Magtheridon

**Serpentshrine Cavern** (`ssc`) — 9 files
- `ssc-hydross.png` — Hydross the Unstable
- `ssc-lurker.png` — The Lurker Below
- `ssc-leotheras.png` — Leotheras the Blind
- `ssc-karathress.png` — Fathom-Lord Karathress
- `ssc-sharkkis.png`, `ssc-tidalvess.png`, `ssc-caribdis.png` — his 3 fathom-guards
- `ssc-morogrim.png` — Morogrim Tidewalker
- `ssc-vashj.png` — Lady Vashj

**The Eye** (`tk`) — 8 files
- `tk-alar.png` — Al'ar
- `tk-voidreaver.png` — Void Reaver
- `tk-solarian.png` — High Astromancer Solarian
- `tk-kaelthas.png` — Kael'thas Sunstrider
- `tk-lord-sanguinar.png`, `tk-capernian.png`, `tk-thaladred-darkener.png`,
  `tk-telonicus.png` — his 4 advisors

**Battle for Mount Hyjal** (`hyjal`) — 5 files
- `hyjal-winterchill.png` — Rage Winterchill
- `hyjal-anetheron.png` — Anetheron
- `hyjal-kazrogal.png` — Kaz'rogal
- `hyjal-azgalor.png` — Azgalor
- `hyjal-archimonde.png` — Archimonde

**Black Temple** (`bt`) — 14 files
- `bt-najentus.png` — High Warlord Naj'entus
- `bt-supremus.png` — Supremus
- `bt-akama.png` — Shade of Akama
- `bt-gorefiend.png` — Teron Gorefiend
- `bt-bloodboil.png` — Gurtogg Bloodboil
- `bt-essence-suffering.png`, `bt-essence-desire.png`, `bt-essence-anger.png` —
  Reliquary of Souls' 3 sequential forms (split after all, not left combined)
- `bt-shahraz.png` — Mother Shahraz
- `bt-gathios.png`, `bt-zerevor.png`, `bt-lady-malande.png`,
  `bt-veras-darkshadow.png` — the Illidari Council's 4 members
- `bt-illidan.png` — Illidan Stormrage

**Sunwell Plateau** (`swp`) — 9 files
- `swp-kalecgos.png` — Kalecgos
- `swp-sathrovarr.png` — Sathrovarr the Corruptor
- `swp-brutallus.png` — Brutallus
- `swp-felmyst.png` — Felmyst
- `swp-sacrolash.png`, `swp-alythess.png` — the Eredar Twins
- `swp-muru.png` — M'uru
- `swp-entropius.png` — Entropius (M'uru's sub-phase, split after all)
- `swp-kiljaeden.png` — Kil'jaeden

79 icons total. Every one spot-checked for quality/consistency - genuinely good
work, no regenerations needed.
