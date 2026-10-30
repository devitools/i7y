# Shared palette

`palette.json` is the source of truth for web, desktop and mobile colors. Mobile imports it directly. `palette.css` exposes the same values as CSS variables for the shared web/desktop interface. Run `node scripts/sync-palette.mjs` after editing the JSON; add `--check` to verify generated CSS without changing files.
