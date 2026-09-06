# Raid target marker icons

The 8 standard WoW raid target markers - Blizzard's own icons (not a custom
redraw), cropped from a clean extraction of the real client texture
(`Interface\TargetingFrame\UI-RaidTargetingIcon_1` through `_8`), 64×64px
PNG with transparency, one file per mark:

`star.png`, `circle.png`, `diamond.png`, `triangle.png`, `moon.png`,
`square.png`, `cross.png`, `skull.png`

Used by the "+Mark" toolbar button on the Strats map (see MARK_TYPES in
kaizen_raid_manager.html). No code changes needed if these are ever
replaced - just overwrite a file at the same name/path.
