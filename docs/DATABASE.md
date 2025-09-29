# Database Schema

SQLite database stored at `server/data/procompliance.db`.

## Tables

### users
- id INTEGER PK
- email TEXT UNIQUE NOT NULL
- password_hash TEXT NOT NULL
- name TEXT NOT NULL
- role TEXT NOT NULL DEFAULT 'superadmin' (values: superadmin|admin|viewer)
- reset_token TEXT
- reset_expires TEXT (ISO date)

### categories
- id INTEGER PK
- name TEXT UNIQUE NOT NULL

### companies
- id INTEGER PK
- name TEXT UNIQUE NOT NULL

### tasks
- id INTEGER PK
- title TEXT NOT NULL
- description TEXT DEFAULT ''
- category_id INTEGER (FK categories.id)
- company_id INTEGER (FK companies.id)
- assignee TEXT NOT NULL (Maker, matches `users.name`)
- checker TEXT NULL (Checker, matches `users.name`)
- assigned_by TEXT NOT NULL (Admin/SuperAdmin name)
- due_date TEXT NOT NULL (YYYY-MM-DD or 'NA')
- valid_from TEXT NULL (YYYY-MM-DD)
- criticality TEXT NULL (high|medium|low)
- license_owner TEXT NULL
- relevant_fc INTEGER DEFAULT 0 (0/1)
- displayed_fc TEXT NULL ('Yes'|'No'|NULL)
- repeat_json TEXT DEFAULT '{"frequency":null}'
- reminder_days TEXT DEFAULT ''
- status TEXT NOT NULL DEFAULT 'pending' (pending|completed|rejected)
- submitted_at TEXT NULL (ISO date when submitted to checker)
- edit_unlocked INTEGER NOT NULL DEFAULT 0
- created_at TEXT NOT NULL (ISO)
- updated_at TEXT NOT NULL (ISO)

### notes
- id INTEGER PK
- task_id INTEGER NOT NULL (FK tasks.id)
- text TEXT NOT NULL
- file_name TEXT NULL
- file_size INTEGER NULL
- file_type TEXT NULL
- stored_name TEXT NULL
- created_at TEXT NOT NULL (ISO)

### attachments
- id INTEGER PK
- task_id INTEGER NOT NULL (FK tasks.id)
- file_name TEXT NOT NULL (client-sent name; FC images may include `__fc_image` suffix)
- file_size INTEGER NOT NULL
- file_type TEXT NULL (MIME)
- stored_name TEXT NOT NULL (server filename)
- created_at TEXT NOT NULL (ISO)

### user_categories
- user_id INTEGER NOT NULL (FK users.id)
- category_id INTEGER NOT NULL (FK categories.id)
- PRIMARY KEY (user_id, category_id)

## Indices
- Implicit PK indices. Add custom indices if query volume grows.

## Data Lifecycles
- Seeding: First boot creates SuperAdmin (`ADMIN_EMAIL`, `ADMIN_PASSWORD`) and base category/company.
- Deletions: Deleting a task removes its attachments and notes.
- Uploads: Stored under `server/uploads/` named by UUID, metadata in `attachments`.
- Inline preview endpoints: `/api/attachments/:id/view`, `/api/notes/:id/view` and HTML pages `/attachments/:id`, `/notes/:id`.
