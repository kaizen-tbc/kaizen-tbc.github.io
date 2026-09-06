# Raid target marker icon spec (for Codex)

## What these are for
The 8 standard World of Warcraft raid target markers (Skull, X, Square, Moon,
Triangle, Diamond, Circle, Star) as small flat icons used on Kaizen's map-pin
system (Strats tab) - the "+Mark" toolbar button drops one of these onto a
strat's map, same idea as the mob-pin/boss-icon set already in
`assets/boss-icons/`. Reference for the actual in-game icons/colors:
https://addonstudio.org/wiki/WoW:Target_markers

## File format
- **Square, 256×256px, PNG with a transparent background.** These are flat
  icons, not portraits - no background art at all, just the mark shape on
  full alpha transparency, the same way a UI icon works. There is no ring or
  circular crop applied in code for this set (unlike boss-icons, which get a
  circular crop), so the shape itself should already read as a clean icon on
  its own square canvas.
- **Minimal/clean redraw of Blizzard's 8 icons, not a scan of the originals.**
  Keep each one instantly recognizable as the icon it's based on (same
  silhouette, same conventional color - see the color list below) but
  simplified: bold flat shapes, a clean thin outline for contrast against any
  background color, no busy texture/gradient noise. These display small
  (~25-30px on the map, same size class as a role pin), so fine detail is
  wasted - bold and legible at a glance is the entire brief, same "simple is
  more" direction as the boss-icon set.
- **One consistent style across all 8** so they read as one cohesive set.

## Conventional colors (match these - it's how officers already recognize
each one at a glance from in-game raid markers)
| Mark | Color |
|---|---|
| Star | Yellow |
| Circle | Orange |
| Diamond | Purple/pink |
| Triangle | Green |
| Moon | White/silver crescent |
| Square | Blue |
| Cross (X) | Red |
| Skull | White/bone, dark eye sockets |

## File naming and folder
Drop finished files directly into `assets/marks/`, named exactly:
`star.png`, `circle.png`, `diamond.png`, `triangle.png`, `moon.png`,
`square.png`, `cross.png`, `skull.png` - lowercase, no other characters.
8 files total. No code changes needed once they land at these exact paths -
the mark-pin feature is already wired up to read from here.
