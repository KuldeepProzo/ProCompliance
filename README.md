# ProCompliance

ProCompliance is a Node.js + SQLite app for managing compliances (tasks) with assignments, due dates, repeating schedules, attachments, notes, and reminder emails.

- Frontend: vanilla HTML/CSS/JS in `index.html` and `assets/`
- Backend: Express server in `server/index.js` (SQLite via better-sqlite3)
- Email: Nodemailer SMTP for notifications/reminders

Prerequisites
- Node.js 18 or newer (LTS recommended)
- Build tools for native modules (if your platform lacks prebuilds for `better-sqlite3`)
  - Linux: `build-essential`/`make`/`gcc` (or distro equivalents)
  - Windows: Node-gyp prerequisites (Python, Build Tools)
- An SMTP account (optional but required for emails)

Directory Layout
```
ProCompliance/
  index.html            # frontend entry
  assets/               # css/js
  server/
    index.js            # express server
    data/               # SQLite DB (created at runtime)
    uploads/            # file uploads (created at runtime)
  package.json
```

Environment Variables
Create a `.env` file in `ProCompliance/` (same folder as `package.json`). Defaults are shown; change for production.
```
# Server
PORT=8080
JWT_SECRET=change_this_in_prod
DB_PATH=server/data/procompliance.db
UPLOAD_DIR=server/uploads

# Seed SuperAdmin (first-boot only, creates user if not present)
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=changeme

# SMTP (optional but required for emails)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your_smtp_user
SMTP_PASS=your_smtp_password
SMTP_FROM=no-reply@yourdomain.com
```

Install & Run (Development)
```
cd ProCompliance
npm install
npm run start
# open http://localhost:${PORT}/
```

First Login
- Use the seed SuperAdmin from `.env` (created on first boot if missing): `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
- Change the password after logging in.

Production Deployment
1) Install dependencies and build environment
```
cd /opt/ProCompliance
npm ci
```

2) Set env vars (`.env`) as above; ensure directories exist and are writable
```
mkdir -p server/data server/uploads
chown -R app:app server/data server/uploads
chmod 700 server/data server/uploads
```

3) Run with a process manager (PM2 example)
```
npm i -g pm2
pm2 start server/index.js --name procompliance
pm2 save
pm2 startup   # follow the printed instructions
```

4) Reverse proxy (Nginx example)
```
server {
  listen 80;
  server_name your.domain.com;

  location / {
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:8080;
  }
}
```
Use Let’s Encrypt/Certbot for TLS.

Data & Backups
- Database file: `server/data/procompliance.db`
- Uploads: `server/uploads/`

Backup (hot copy is usually fine for SQLite, but safest with a brief stop):
```
pm2 stop procompliance
tar czf /backups/procompliance_$(date +%F).tar.gz server/data server/uploads .env
pm2 start procompliance
```

Restore:
```
pm2 stop procompliance
tar xzf /backups/procompliance_YYYY-MM-DD.tar.gz -C /opt/ProCompliance
pm2 start procompliance
```

Emails & Reminders
- Configure SMTP variables in `.env`.
- Emails sent for: assignment, submission to checker, reopen for edits, reminders (grouped) to SuperAdmins and category Admins.
- Reminder cron (server local time, Asia/Kolkata set in code): runs daily by default.

Roles & Permissions
- SuperAdmin: full access, manage settings, view all tasks/tabs.
- Admin: full access within assigned categories; sees tasks as:
  - For Me: only where user is Maker or (submitted) Checker
  - Others: tasks in assigned categories
- Viewer: sees tasks assigned to them or submitted for them as checker; cannot administer.

CSV Import/Export
- Export CSV: from UI Export tab.
- Get template: `GET /api/tasks/import/template` (authorized).
- Import CSV: UI Import tab (SuperAdmin only).
  - Attachments are not required on creation/import.
  - Makers must add at least one general attachment when updating an existing compliance.
  - If “Displayed in FC” is Yes, an FC image is always required.

File Uploads
- Max 5MB total per request (enforced server-side).
- FC image uploads are tagged on the client filename with `__fc_image` and accepted as images server-side.

Security Notes
- Set a strong `JWT_SECRET`.
- Run behind a reverse proxy with TLS.
- Limit access to `server/data` and `server/uploads` directories.

Troubleshooting
- 502/Bad Gateway behind Nginx: ensure PM2 process is running and `proxy_pass` points to the correct PORT.
- Emails not sending: verify SMTP envs, and that users (maker/checker/admin) have valid emails set.
- Database locked: rare with `better-sqlite3`; ensure single server process writes to DB.

License
MIT (see `LICENSE`).

