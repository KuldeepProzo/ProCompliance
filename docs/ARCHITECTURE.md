# ProCompliance Architecture

This document explains the structure, data flow, and key behaviors (roles, tabs, uploads, reminders).

## Overview
- Frontend: vanilla HTML/CSS/JS (no framework). Entry: `index.html`, logic in `assets/js/app.js`, styles in `assets/css/app.css`.
- Backend: Express `server/index.js` with SQLite (better-sqlite3), uploads (multer), email (nodemailer), rate limits, helmet, cron.
- Database: single SQLite file `server/data/procompliance.db`. Uploads in `server/uploads`.
 - Branding: Application is named "ProCompliance" in UI, logs, and emails.

## Frontend
- Routing: hash (`#/tasks`, `#/dashboard`, `#/settings`, `#/standards`, `#/export`, `#/import`, auth routes). `onHashChange()` toggles panels.
- Auth: JWT stored in sessionStorage; menus toggle based on role (Admin/SuperAdmin vs Viewer).
- Tabs in Tasks:
  - For Me (`role=to-me`): tasks where current user is Maker or submitted-to Checker.
  - Others (`role=by-me`): Admins see tasks in their allowed categories; SuperAdmin sees all, excluding tasks where current user is Maker/Checker.
- Editor:
  - Validations:
    - FC Image required if Displayed in FC = Yes.
    - Attachments required only when Maker (non-admin/superadmin) updates an existing task (not on create/import). FC image does not count toward the 1 general attachment requirement.
    - Upload size <= 5MB total per request.
  - FC Image tagging: filename is renamed on client to include `__fc_image` before upload.
  - Auto submission: The first Maker update will auto-submit to the Checker and lock Maker fields until reopened.
- Settings:
  - SuperAdmin: manage Categories, Companies, Users (roles, Admin categories), Reminder policies.
  - Admin: read-only Users list (email, name). Can add Viewer users.
- Standards: manage and apply standards to locations to generate tasks.
- Dashboard: filters and charts/stat cards via `/api/dashboard`.

## Backend
- Auth endpoints: `/api/auth/login`, `/api/auth/forgot`, `/api/auth/reset`.
- Me/meta: `/api/me` (role + permissions + Admin allowed categories), `/api/meta` (categories, companies, people).
- Tasks:
  - CRUD: `POST /api/tasks`, `GET /api/tasks`, `GET /api/tasks/:id`, `PUT /api/tasks/:id`, `DELETE /api/tasks/:id`.
  - Status: `POST /api/tasks/:id/status` (pending/completed/rejected), `POST /api/tasks/:id/request_edit`.
  - Notes/attachments: `GET/POST /api/tasks/:id/notes`, download endpoints for notes and attachments.
- Standards: `GET/POST/DELETE /api/standards`, `POST /api/standards/apply`.
- Settings: Categories/Companies CRUD (SuperAdmin for create/delete), Users list/create (Admin can create Viewer), Users update/delete (SuperAdmin only).
- Export/Import: `GET /api/tasks/export` (Admin/SuperAdmin), `POST /api/tasks/import` + template (SuperAdmin).

### Roles & Scoping
- SuperAdmin: full access to all endpoints/data; bypasses attachment requirements on update.
- Admin: access scoped to categories in `user_categories` for list/export/dashboard/others tab; Maker/Checker visibility unaffected.
- Viewer: only their tasks (maker/checker) and read-only UI.

### Tabs Behavior (server `/api/tasks`)
- `role=to-me`: `(assignee = me) OR (checker = me AND submitted_at IS NOT NULL)`.
- `role=by-me` (Others): Admins further scoped by allowed categories; SuperAdmin unrestricted.

### Uploads & FC Image (server)
- Accepts up to 10 files in `attachments`.
- FC requirements enforced on server for Displayed in FC = Yes (must have image-type file either new or existing on update).
- Client additionally tags FC filename with `__fc_image` (stored as-is).

### Emails/Notifications
- Assignment: to Maker (fallback Assigner).
- Submission: to Checker.
- Reopen-for-edits: to Maker.
- Edit request: to SuperAdmins, category Admins, and Checker.
- Grouped Reminders (cron): to Makers, Checkers, SuperAdmins (all), Admins (their categories only).
- Grouped assignment emails when bulk-creating (Standards Apply, CSV import).
- Links use `APP_URL` and are shown above the table; anchor text is "ProCompliance".

## Database
See `docs/DATABASE.md` for table definitions and relationships.
