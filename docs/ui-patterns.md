# Shared UI patterns

The web and Tauri desktop clients use the same Vue components and styles.

- Keep one page title outside the main panel, using `PageHeader`.
- Root lists have no breadcrumb. Child screens link to their parents; omit the current title from the breadcrumb. Preserve entity IDs and return context in URLs.
- Use `PageActions` for toolbar actions: all controls visible at widths of 1024 px and above; compact menus below that breakpoint.
- Put row actions before the record name through `leadingRowActions`. Keep the same row background across actions and data, without a sticky action band. Use accessible labels for icon controls.
- Operational forms fill the content width. Group related fields in wrapping rows; stack on narrow screens. Authentication uses a focused card.
- Avoid duplicate exits: use the parent breadcrumb and a form Cancel action where abandoning a form is meaningful; omit a second Back to list control with the same behavior.
- Dense inventory lists become cards below 1024 px. Keep horizontal scrolling confined to wide data tables.
- Keep repository URL and branch on two lines in lists; use a wrapping inline row for repository, branch and Compose path in project context. Do not infer version-control status from missing metadata.
- Use the shared icon mapping in `icons.ts`. Edit actions use Lucide Square Pen; other actions retain Material Symbols. The Lucide ISC license ships at `public/licenses/lucide.txt`. Avoid unsupported ligatures and decorative icons on obvious text-only actions.
- Verify changes rendered in web at wide and narrow widths and in the actual Tauri app. Use synthetic scenarios for secret-producing or destructive states. Distinguish visual coverage from backend behavior validation.

Loading follows the inventory pattern: one table loading indicator, with no additional page progress bar. New forms render immediately; dependent choices load in the background and submission stays disabled until they are ready. Existing records use the standard centered loading state while their values are fetched.
