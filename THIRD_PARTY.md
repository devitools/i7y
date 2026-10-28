# Quasar Dashboard PRO base

Source: https://github.com/patrickmonteiro/quasar-dashboard-pro

Upstream commit: `946a6f2bb0917a3ef9d263eac68565716f63d37e`.

Copyright 2026 Patrick Monteiro. Apache License 2.0, included in `licenses/Quasar-Dashboard-PRO-LICENSE`.

The application uses the upstream MainLayout (QLayout, QHeader, QDrawer and navigation styles), global styles, theme variables, icon mapping and RecordDetailDialog as its base. The inventory page follows the upstream CrudPage card and table structure. Demo modules, data, authentication, notifications and promotional footer are omitted.

Modified files: `apps/web/src/layouts/MainLayout.vue` integrates i7y branding, inventory navigation, workspace filter, language selection and backend indicator; `apps/web/src/components/RecordDetailDialog.vue` accepts a translated close label. `apps/web/src/css/app.scss` and `apps/web/src/css/quasar.variables.scss` retain the upstream styling with explanatory comments removed. The icon mapping is integrated into `apps/web/src/main.ts` for the existing Vite entry point. PocketBase and inventory routes remain application code.
