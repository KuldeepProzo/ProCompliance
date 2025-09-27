const path = require('path');
const fs = require('fs');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Env
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'procompliance.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'skdhaka207@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || 'no-reply@procompliance.local';
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || '';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// Ensure dirs
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// DB
const db = new Database(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'superadmin',
  reset_token TEXT,
  reset_expires TEXT
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  category_id INTEGER,
  company_id INTEGER,
  assignee TEXT NOT NULL,
  checker TEXT,
  assigned_by TEXT NOT NULL,
  due_date TEXT NOT NULL,
  valid_from TEXT,
  criticality TEXT,
  license_owner TEXT,
  relevant_fc INTEGER DEFAULT 0,
  displayed_fc TEXT,
  repeat_json TEXT DEFAULT '{"frequency":null}',
  reminder_days TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_at TEXT,
  edit_unlocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(category_id) REFERENCES categories(id),
  FOREIGN KEY(company_id) REFERENCES companies(id)
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  file_name TEXT,
  file_size INTEGER,
  file_type TEXT,
  stored_name TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_type TEXT,
  stored_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE TABLE IF NOT EXISTS user_categories (
  user_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  PRIMARY KEY(user_id, category_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(category_id) REFERENCES categories(id)
);
`);

// Reminder policies table (if missing)
try{
  db.exec(`CREATE TABLE IF NOT EXISTS reminder_policies (
    criticality TEXT PRIMARY KEY,
    start_before INTEGER DEFAULT 0,
    windows_json TEXT DEFAULT '[]',
    on_due_days INTEGER DEFAULT 1,
    overdue_days INTEGER DEFAULT 1
  )`);
}catch(_e){}

// No migrations needed for fresh DB

// Seed admin user (keep default admin to ensure access on first boot)
const getUser = db.prepare('SELECT * FROM users WHERE email = ?');
const createUser = db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)');
if (!getUser.get(ADMIN_EMAIL)) {
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  createUser.run(ADMIN_EMAIL, hash, 'Administrator', 'superadmin');
}

// Seed base categories/companies if empty
try{
const countCat = db.prepare('SELECT COUNT(*) as c FROM categories').get().c;
if (countCat === 0) {
  ['Business Ops'].forEach(n => db.prepare('INSERT INTO categories (name) VALUES (?)').run(n));
}
}catch(_e){}
try{
const countComp = db.prepare('SELECT COUNT(*) as c FROM companies').get().c;
if (countComp === 0) {
  ['Prozo'].forEach(n => db.prepare('INSERT INTO companies (name) VALUES (?)').run(n));
}
}catch(_e){}

// App
const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use(limiter);
// Stricter limiters for auth endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const passwordLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });
const refreshLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

// Auth helpers
function sign(user) { return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '12h' }); }
function auth(req, res, next){
  const hdr = req.headers.authorization || '';
  let token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if(!token && req.query && req.query.token) token = String(req.query.token);
  if(!token) return res.status(401).json({ error: 'missing_token' });
  try{
    req.user = jwt.verify(token, JWT_SECRET);
    // token versioning removed
    next();
  }catch(err){ return res.status(401).json({ error: 'invalid_token' }); }
}

// Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
// Use a generous per-file limit; enforce total size per request manually (5MB total)
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Routes
function isSuperAdminRole(role){ return String(role||'').toLowerCase() === 'superadmin'; }
function isAdminRole(role){ const r=String(role||'').toLowerCase(); return r === 'admin' || r === 'superadmin'; }
function requireAdmin(req, res, next){
  try{
    const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.sub);
    const elevated = !!u && isAdminRole(u.role);
    if(!elevated) return res.status(403).json({ error: 'forbidden' });
    next();
  }catch(e){ return res.status(403).json({ error: 'forbidden' }); }
}
function requireSuperAdmin(req, res, next){
  try{
    const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.sub);
    if(!u || !isSuperAdminRole(u.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  }catch(e){ return res.status(403).json({ error: 'forbidden' }); }
}
function getAllowedCategoryIds(userId){
  try{ return (db.prepare('SELECT category_id FROM user_categories WHERE user_id = ?').all(userId)||[]).map(r=> Number(r.category_id)); }
  catch(_e){ return []; }
}
function hasCategoryAccess(userId, categoryId){
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  const role = u ? String(u.role||'').toLowerCase() : 'viewer';
  if(isSuperAdminRole(role)) return true;
  if(String(role)!=='admin') return false;
  if(categoryId == null) return false;
  const allowed = getAllowedCategoryIds(userId);
  return allowed.includes(Number(categoryId));
}
app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const u = getUser.get(email || '');
  if(!u) return res.status(401).json({ error: 'invalid_credentials' });
  if(!bcrypt.compareSync(password || '', u.password_hash)) return res.status(401).json({ error: 'invalid_credentials' });
  const r = String(u.role||'').toLowerCase();
  const effectiveRole = (r==='superadmin' || r==='admin') ? r : 'viewer';
  return res.json({ token: sign(u), user: { id: u.id, email: u.email, name: u.name, role: effectiveRole } });
});

// Removed refresh/signout-others functionality

app.get('/api/me', auth, (req, res) => {
  const u = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(req.user.sub);
  if(!u) return res.status(404).json({ error: 'not_found' });
  const role = String(u.role||'').toLowerCase();
  const effectiveRole = (role==='superadmin' || role==='admin') ? role : 'viewer';
  const allowed_category_ids = effectiveRole==='admin' ? getAllowedCategoryIds(u.id) : [];
  const perms = {
    can_create: effectiveRole==='superadmin' || effectiveRole==='admin',
    can_edit: effectiveRole==='superadmin' || effectiveRole==='admin',
    can_assign: effectiveRole==='superadmin' || effectiveRole==='admin',
    can_add_note: true,
    can_manage_settings: effectiveRole==='superadmin'
  };
  res.json({ user: { ...u, role: effectiveRole, allowed_category_ids }, permissions: perms });
});

app.get('/api/meta', auth, (req, res) => {
  const cats = db.prepare('SELECT id, name FROM categories ORDER BY name').all();
  const comps = db.prepare('SELECT id, name FROM companies ORDER BY name').all();
  const me = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.sub) || {};
  const userRows = db.prepare('SELECT name FROM users ORDER BY name').all();
  const people = ['Me'].concat((userRows||[]).map(u => u.name).filter(n => n && n !== me.name));
  res.json({ categories: cats, companies: comps, people });
});

// Settings meta (admin): surface default password value to UI
app.get('/api/admin/meta', auth, requireAdmin, (req, res) => {
  res.json({ default_password: DEFAULT_PASSWORD || '' });
});

// Standards module
db.exec(`CREATE TABLE IF NOT EXISTS standard_obligations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category_id INTEGER,
  repeat_json TEXT DEFAULT '{"frequency":null}',
  criticality TEXT,
  relevant_fc INTEGER DEFAULT 0,
  displayed_fc TEXT,
  FOREIGN KEY(category_id) REFERENCES categories(id)
)`);

// Lightweight in-place migration: ensure new columns exist when upgrading without dropping DB
try{
  const cols = db.prepare("PRAGMA table_info('standard_obligations')").all();
  const hasDisplayed = Array.isArray(cols) && cols.some(c => String(c.name) === 'displayed_fc');
  if(!hasDisplayed){ db.prepare("ALTER TABLE standard_obligations ADD COLUMN displayed_fc TEXT").run(); }
}catch(_e){}

app.get('/api/standards', auth, requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT s.id, s.title, s.repeat_json, s.criticality, s.relevant_fc, s.displayed_fc, c.name AS category, s.category_id
                           FROM standard_obligations s LEFT JOIN categories c ON c.id = s.category_id ORDER BY s.id`).all();
  res.json({ standards: rows });
});
app.post('/api/standards', auth, requireAdmin, (req, res) => {
  const { title, category_id, repeat_json='{"frequency":null}', criticality=null, relevant_fc=0, displayed_fc='NA' } = req.body || {};
  if(!title) return res.status(400).json({ error: 'title_required' });
  const rel = (typeof relevant_fc === 'string')
    ? (String(relevant_fc).toLowerCase()==='yes' ? 1 : 0)
    : (relevant_fc ? 1 : 0);
  const r = db.prepare('INSERT INTO standard_obligations (title, category_id, repeat_json, criticality, relevant_fc, displayed_fc) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(title), category_id? Number(category_id): null, String(repeat_json), criticality||null, rel, displayed_fc||'NA');
  res.status(201).json({ id: r.lastInsertRowid });
});
app.delete('/api/standards/:id', auth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM standard_obligations WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
// Apply standards to an organization with maker/checker
app.post('/api/standards/apply', auth, requireAdmin, async (req, res) => {
  const { company_id, items } = req.body || {};
  const me = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.sub) || {};
  if(!company_id || !Array.isArray(items) || items.length===0) return res.status(400).json({ error: 'missing_fields' });
  const ins = db.prepare(`INSERT INTO tasks (title, description, category_id, company_id, assignee, checker, assigned_by, due_date, criticality, relevant_fc, displayed_fc, repeat_json, status, created_at, updated_at)
                          VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`);
  const now = new Date().toISOString();
  let created = 0;
  const createdByMaker = new Map(); // makerName -> [taskId]
  for(const it of items){
    const std = db.prepare('SELECT * FROM standard_obligations WHERE id = ?').get(Number(it.standard_id));
    if(!std) continue;
    const due = it.due_date || 'NA';
    // validate maker/checker names against users
    const makerRaw = String(it.maker||'').trim();
    const checkerRaw = String(it.checker||'').trim();
    const fallback = (me.name||'');
    const nameOk = (s)=>{ const n=String(s||'').trim(); if(!n) return false; const row = db.prepare('SELECT 1 as x FROM users WHERE name = ?').get(n); return !!row; };
    let makerName = (makerRaw.toLowerCase()==='me' || makerRaw==='') ? fallback : (nameOk(makerRaw)? makerRaw : fallback);
    let checkerName = (checkerRaw.toLowerCase()==='me') ? fallback : (checkerRaw ? (nameOk(checkerRaw)? checkerRaw : fallback) : fallback);
    const relFc = (typeof std.relevant_fc === 'string')
      ? (String(std.relevant_fc).toLowerCase()==='yes' ? 1 : 0)
      : (std.relevant_fc ? 1 : 0);
    const r = ins.run(std.title, std.category_id||null, Number(company_id), makerName, checkerName, me.name||'', due, std.criticality||null, relFc, (std.displayed_fc||'NA'), std.repeat_json||'{"frequency":null}', now, now);
    const taskId = r.lastInsertRowid;
    if(makerName){ const arr = createdByMaker.get(makerName) || []; arr.push(taskId); createdByMaker.set(makerName, arr); }
    created++;
  }
  // Grouped maker emails for created tasks (fire-and-forget)
  (async ()=>{
    if(mailer && createdByMaker.size>0){
      for(const [makerName, ids] of createdByMaker.entries()){
        try{
          const maker = db.prepare('SELECT email,name FROM users WHERE name = ?').get(makerName||'');
          const to = maker && maker.email; if(!to) continue;
          const tasks = ids.map(id => getTaskWithJoins(id)).filter(Boolean);
          console.log('[standards/apply] grouped assignment email attempt', { to, tasks: tasks.length });
          if(tasks.length>0){ const ok = await sendGroupedEmail(to, makerName, tasks, 'assignment'); console.log('[standards/apply] grouped assignment email result', { to, ok }); }
        }catch(e){ console.error('[standards/apply] grouped assignment email error', e); }
      }
    }
  })();
  res.json({ created });
});

// Settings: categories
app.get('/api/categories', auth, (req, res) => {
  const rows = db.prepare('SELECT id, name FROM categories ORDER BY name').all();
  res.json({ categories: rows });
});
app.post('/api/categories', auth, requireSuperAdmin, (req, res) => {
  const { name } = req.body || {};
  if(!name) return res.status(400).json({ error: 'name_required' });
  try{
    const r = db.prepare('INSERT INTO categories (name) VALUES (?)').run(String(name).trim());
    res.status(201).json({ id: r.lastInsertRowid });
  }catch(e){ res.status(409).json({ error: 'duplicate' }); }
});
app.delete('/api/categories/:id', auth, requireSuperAdmin, (req, res) => {
  const id = Number(req.params.id);
  const num = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE category_id = ?').get(id).c;
  if(num > 0) return res.status(409).json({ error: 'in_use' });
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Settings: companies
app.get('/api/companies', auth, (req, res) => {
  const rows = db.prepare('SELECT id, name FROM companies ORDER BY name').all();
  res.json({ companies: rows });
});

// Reminder policy APIs (admin)
app.get('/api/reminders/policies', auth, requireAdmin, (req, res) => {
  try{
    const rows = db.prepare('SELECT criticality, start_before, windows_json, on_due_days, overdue_days FROM reminder_policies ORDER BY criticality').all();
    res.json({ policies: rows });
  }catch(e){ res.json({ policies: [] }); }
});
app.put('/api/reminders/policies/:criticality', auth, requireAdmin, (req, res) => {
  const c = String(req.params.criticality||'').toLowerCase();
  if(!['high','medium','low'].includes(c)) return res.status(400).json({ error: 'invalid_criticality' });
  const body = req.body || {};
  const start_before = Number(body.start_before||0);
  // Default windows by criticality when not provided
  const defaultWindows = (crit)=> crit==='high' ? '[[31,999,3],[16,30,2],[1,15,1]]' : (crit==='medium' ? '[[16,999,3],[1,15,2]]' : '[[8,999,7],[1,7,2]]');
  let windowsStr = defaultWindows(c);
  try{
    if(Array.isArray(body.windows_json)) windowsStr = JSON.stringify(body.windows_json);
    else if(typeof body.windows_json === 'string' && body.windows_json.trim()!==''){ JSON.parse(body.windows_json); windowsStr = body.windows_json; }
  }catch(_e){ windowsStr = defaultWindows(c); }
  const on_due_days = Number(body.on_due_days ?? 1);
  const overdue_days = Number(body.overdue_days ?? 1);
  try{
    db.prepare('INSERT INTO reminder_policies (criticality, start_before, windows_json, on_due_days, overdue_days) VALUES (?, ?, ?, ?, ?) ON CONFLICT(criticality) DO UPDATE SET start_before=excluded.start_before, windows_json=excluded.windows_json, on_due_days=excluded.on_due_days, overdue_days=excluded.overdue_days')
      .run(c, start_before, windowsStr, on_due_days, overdue_days);
    res.json({ ok: true });
  }catch(e){ res.status(500).json({ error: 'db_error' }); }
});
app.post('/api/companies', auth, requireSuperAdmin, (req, res) => {
  const { name } = req.body || {};
  if(!name) return res.status(400).json({ error: 'name_required' });
  try{
    const r = db.prepare('INSERT INTO companies (name) VALUES (?)').run(String(name).trim());
    res.status(201).json({ id: r.lastInsertRowid });
  }catch(e){ res.status(409).json({ error: 'duplicate' }); }
});
app.delete('/api/companies/:id', auth, requireSuperAdmin, (req, res) => {
  const id = Number(req.params.id);
  const num = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE company_id = ?').get(id).c;
  if(num > 0) return res.status(409).json({ error: 'in_use' });
  db.prepare('DELETE FROM companies WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Users (admin manage)
app.get('/api/users', auth, requireAdmin, (req, res) => {
  const me = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.sub) || { role: 'viewer' };
  const isSuper = String(me.role||'').toLowerCase()==='superadmin';
  const rows = db.prepare('SELECT id, email, name, role FROM users ORDER BY id').all();
  if(!isSuper){
    // Admin: only email and name
    return res.json({ users: rows.map(u=> ({ id:u.id, email:u.email, name:u.name })) });
  }
  const cats = db.prepare('SELECT user_id, category_id FROM user_categories').all();
  const byUser = new Map();
  for(const r of (cats||[])){
    const arr = byUser.get(r.user_id) || []; arr.push(r.category_id); byUser.set(r.user_id, arr);
  }
  return res.json({ users: rows.map(u=> ({...u, categories: byUser.get(u.id)||[]})) });
});
app.post('/api/users', auth, requireAdmin, async (req, res) => {
  const creator = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.sub) || { role: 'viewer' };
  const creatorIsSuper = String(creator.role||'').toLowerCase()==='superadmin';
  const { email, name, password, role, categories } = req.body || {};
  if(!email || !name || !role) return res.status(400).json({ error: 'missing_fields' });
  try{
    const pw = String(password||'') || DEFAULT_PASSWORD;
    if(!pw){ return res.status(500).json({ error: 'default_password_not_set' }); }
    const hash = bcrypt.hashSync(pw, 10);
    const rStr = String(role).toLowerCase();
    let normalizedRole = rStr==='superadmin' ? 'superadmin' : (rStr==='admin' ? 'admin' : 'viewer');
    if(!creatorIsSuper){
      // Admins can only create viewer users
      normalizedRole = 'viewer';
    }
    const r = db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)').run(String(email).trim(), hash, String(name).trim(), normalizedRole);
    const userId = r.lastInsertRowid;
    if(creatorIsSuper && normalizedRole==='admin' && Array.isArray(categories)){
      const ins = db.prepare('INSERT OR IGNORE INTO user_categories (user_id, category_id) VALUES (?, ?)');
      for(const cid of categories.map(Number)) ins.run(userId, cid);
    }
    // Send registration email
    try{ await sendUserRegistrationEmail(String(email).trim(), String(name).trim()); }catch(_e){}
    res.status(201).json({ id: userId });
  }catch(e){ return res.status(409).json({ error: 'duplicate' }); }
});
app.delete('/api/users/:id', auth, requireSuperAdmin, (req, res) => {
  const id = Number(req.params.id);
  const me = Number(req.user.sub);
  if(id === me) return res.status(400).json({ error: 'cannot_delete_self' });
  const superadmins = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'superadmin'").get().c;
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
  if(u && u.role === 'superadmin' && superadmins <= 1) return res.status(400).json({ error: 'last_superadmin' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  db.prepare('DELETE FROM user_categories WHERE user_id = ?').run(id);
  res.json({ ok: true });
});

// Update user (including role/password)
app.put('/api/users/:id', auth, requireSuperAdmin, (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if(!existing) return res.status(404).json({ error: 'not_found' });
  const nextEmail = body.email ? String(body.email).trim() : existing.email;
  const nextName = body.name ? String(body.name).trim() : existing.name;
  const rStr = String(body.role || existing.role || 'viewer').toLowerCase();
  const nextRole = rStr==='superadmin' ? 'superadmin' : (rStr==='admin' ? 'admin' : 'viewer');
  if(existing.role === 'superadmin' && nextRole !== 'superadmin'){
    const saCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'superadmin'").get().c;
    if(saCount <= 1) return res.status(400).json({ error: 'last_superadmin' });
  }
  // role enforcement relies solely on role value; no special email-based exceptions
  if(body.password){
    const hash = bcrypt.hashSync(String(body.password), 10);
    db.prepare('UPDATE users SET email=?, name=?, role=?, password_hash=? WHERE id=?')
      .run(nextEmail, nextName, nextRole, hash, id);
  }else{
    db.prepare('UPDATE users SET email=?, name=?, role=? WHERE id=?')
      .run(nextEmail, nextName, nextRole, id);
  }
  // update categories for admin
  db.prepare('DELETE FROM user_categories WHERE user_id = ?').run(id);
  if(nextRole==='admin' && Array.isArray(body.categories)){
    const ins = db.prepare('INSERT OR IGNORE INTO user_categories (user_id, category_id) VALUES (?, ?)');
    for(const cid of body.categories.map(Number)) ins.run(id, cid);
  }
  res.json({ ok: true });
});

// Create task
app.post('/api/tasks', auth, upload.array('attachments', 10), (req, res) => {
  const body = req.body || {};
  const title = body.title;
  const description = body.description || '';
  const category_id = body.category_id;
  const company_id = body.company_id;
  const maker = (body.maker ?? body.assignee);
  const checker = body.checker;
  const assigned_by = body.assigned_by;
  const due_date = body.due_date;
  const valid_from = body.valid_from ?? null;
  const criticality = body.criticality ?? null;
  const license_owner = body.license_owner ?? null;
  const relevant_fc = body.relevant_fc ?? 0;
  const displayed_fc = body.displayed_fc ?? null;
  const repeat_json = body.repeat_json || '{"frequency":null}';
  const me = db.prepare('SELECT name, role FROM users WHERE id = ?').get(req.user.sub) || {};
  const role = String(me.role||'').toLowerCase();
  if(!(role==='superadmin' || role==='admin')){ return res.status(403).json({ error: 'forbidden' }); }
  if(role==='admin'){
    if(!category_id) return res.status(403).json({ error: 'forbidden_category' });
    const allowed = getAllowedCategoryIds(req.user.sub);
    if(!allowed.includes(Number(category_id))) return res.status(403).json({ error: 'forbidden_category' });
  }
  if(!title || !maker || !assigned_by) return res.status(400).json({ error: 'missing_fields' });
  const normalizePerson = (val, fallbackMe) => {
    const raw = String(val||'').trim();
    if(!raw || raw.toLowerCase()==='me') return fallbackMe;
    // If not an exact user name, fallback to Me
    const row = db.prepare('SELECT 1 as x FROM users WHERE name = ?').get(raw);
    return row ? raw : fallbackMe;
  };
  const assignedByName = normalizePerson(assigned_by, (me.name||''));
  const makerName = normalizePerson(maker, (me.name||''));
  const checkerName = normalizePerson(checker, (me.name||''));
  const now = new Date().toISOString();
  // Do not enforce FC image on first creation (always allowed)
  const r = db.prepare(`INSERT INTO tasks (title, description, category_id, company_id, assignee, checker, assigned_by, due_date, valid_from, criticality, license_owner, relevant_fc, displayed_fc, repeat_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .run(title, description, category_id || null, company_id || null, makerName, checkerName, assignedByName, String(due_date||'NA'), valid_from||null, criticality||null, license_owner||null, String(relevant_fc||'No').toLowerCase()==='yes'?1:0, displayed_fc||null, repeat_json, now, now);
  const taskId = r.lastInsertRowid;
  // add an auto note for assignment
  db.prepare('INSERT INTO notes (task_id, text, created_at) VALUES (?, ?, ?)')
    .run(taskId, `Assigned to ${makerName} by ${assignedByName}`, now);
  // enforce total size <= 5MB
  const totalBytes = (req.files||[]).reduce((s,f)=> s+ (f.size||0), 0);
  if(totalBytes > 5 * 1024 * 1024){ return res.status(400).json({ error: 'attachments_too_large' }); }
  for(const f of req.files || []){
    db.prepare('INSERT INTO attachments (task_id, file_name, file_size, file_type, stored_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(taskId, f.originalname, f.size, f.mimetype, f.filename, now);
  }
  res.status(201).json({ id: taskId });
  // fire-and-forget maker assignment notification
  try{ const full = getTaskWithJoins(taskId); sendAssignmentNotification(full); }catch(_e){}
});

// List tasks with filters and sorting
app.get('/api/tasks', auth, (req, res) => {
  const { title, assignee, maker, assigned_by, category_id, company_id, status, from, to, sort='due_date', dir='asc', role } = req.query;
  const me = db.prepare('SELECT name, role FROM users WHERE id = ?').get(req.user.sub) || { name: '', role: 'viewer' };
  const roleStr = String(me.role||'').toLowerCase();
  const isSuperAdmin = roleStr==='superadmin';
  const isAdminOnly = roleStr==='admin';
  let sql = `SELECT t.*, c.name AS category, co.name AS company FROM tasks t 
             LEFT JOIN categories c ON c.id = t.category_id
             LEFT JOIN companies co ON co.id = t.company_id WHERE 1=1`;
  const params = [];
  if(title){ sql += ' AND lower(t.title) LIKE ?'; params.push(`%${String(title).toLowerCase()}%`); }
  const makerFilter = maker || assignee;
  if(makerFilter){ sql += ' AND t.assignee = ?'; params.push(makerFilter); }
  if(assigned_by){ sql += ' AND t.assigned_by = ?'; params.push(assigned_by); }
  if(category_id){ sql += ' AND t.category_id = ?'; params.push(Number(category_id)); }
  if(company_id){ sql += ' AND t.company_id = ?'; params.push(Number(company_id)); }
  if(status){ sql += ' AND t.status = ?'; params.push(status); }
  if(from){ sql += ' AND t.due_date >= ?'; params.push(from); }
  if(to){ sql += ' AND t.due_date <= ?'; params.push(to); }
  let filteredByAssignee = false;
  // Apply tab role filters for all users (including admins) so tabs behave consistently
  if(role === 'to-me'){
    // For everyone: only tasks where I'm maker or checker
    sql += ' AND (t.assignee = ? OR (t.checker = ? AND t.submitted_at IS NOT NULL))'; params.push(me.name, me.name); filteredByAssignee = true;
  }
  if(role === 'by-me'){
    // Others tab: exclude tasks where I'm maker or (submitted) checker
    // Mark as filtered to avoid viewer fallback later
    filteredByAssignee = true;
    if(!(isSuperAdmin || isAdminOnly)){
      // Viewers cannot see "others"
      sql += ' AND 1=0';
    } else {
      sql += ' AND NOT (t.assignee = ? OR (t.checker = ? AND t.submitted_at IS NOT NULL))';
      params.push(me.name, me.name);
    }
  }
  // viewers see tasks assigned to them OR tasks where they are checker (any status)
  if(!(isSuperAdmin || isAdminOnly)){
    if(!filteredByAssignee){ sql += ' AND (t.assignee = ? OR (t.checker = ? AND t.submitted_at IS NOT NULL))'; params.push(me.name, me.name); }
  } else if(isAdminOnly){
    // Admins: apply category scoping only for Others tab
    if(role === 'by-me'){
      const allowed = getAllowedCategoryIds(req.user.sub);
      if(allowed.length === 0){ sql += ' AND 1=0'; }
      else { sql += ` AND t.category_id IN (${allowed.map(()=>'?').join(',')})`; params.push(...allowed); }
    }
  }
  const allowedSort = new Set(['title','due_date','assigned_by','assignee','status','category','company']);
  const s = allowedSort.has(sort) ? sort : 'due_date';
  const d = (String(dir).toLowerCase()==='desc') ? 'DESC' : 'ASC';
  sql += ` ORDER BY ${s} ${d}`;
  const rows = db.prepare(sql).all(...params);
  res.json({ list: rows });
});

// Dashboard aggregation endpoint
app.get('/api/dashboard', auth, (req, res) => {
  const { status, category_id, company_id, assignee, criticality, from, to } = req.query || {};
  let sql = `SELECT t.*, c.name AS category, co.name AS company FROM tasks t
             LEFT JOIN categories c ON c.id = t.category_id
             LEFT JOIN companies co ON co.id = t.company_id WHERE 1=1`;
  const params = [];
  const meRole = (db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.sub)||{}).role || 'viewer';
  if(String(meRole).toLowerCase()==='admin'){
    const allowed = getAllowedCategoryIds(req.user.sub);
    if(allowed.length === 0){ return res.json({ total:0, criticality:{ high:0, medium:0, low:0, unknown:0 }, criticalityStatus:{ high:{completed:0,pending:0}, medium:{completed:0,pending:0}, low:{completed:0,pending:0}, unknown:{completed:0,pending:0} }, byCategoryStatus:[], byCompanyStatus:[], trend:[], byCompanyCritStatus:[], byCategoryCritStatus:[] }); }
    sql += ` AND t.category_id IN (${allowed.map(()=>'?').join(',')})`; params.push(...allowed);
  }
  if(status){ sql += ' AND t.status = ?'; params.push(status); }
  if(category_id){ sql += ' AND t.category_id = ?'; params.push(Number(category_id)); }
  if(company_id){ sql += ' AND t.company_id = ?'; params.push(Number(company_id)); }
  if(assignee){ sql += ' AND t.assignee = ?'; params.push(String(assignee)); }
  if(criticality){ sql += ' AND lower(t.criticality) = ?'; params.push(String(criticality).toLowerCase()); }
  if(from){ sql += ' AND t.due_date >= ?'; params.push(from); }
  if(to){ sql += ' AND t.due_date <= ?'; params.push(to); }
  const rows = db.prepare(sql).all(...params);
  const today = new Date();
  const startOfToday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const buckets = {};
  const bucketsByCrit = { high: {}, medium: {}, low: {} };
  const inc = (obj, key) => { obj[key] = (obj[key]||0) + 1; };
  const statusCounts = { pending:0, completed:0 }; // rejected rolls into pending
  const criticalityCounts = { high:0, medium:0, low:0, unknown:0 };
  const byCategoryStatus = new Map(); // cat -> { completed, pending }
  const byCompanyStatus = new Map(); // comp -> { completed, pending }
  const byCategoryCritStatus = new Map(); // cat -> { high:{c,p}, medium:{c,p}, low:{c,p}, unknown:{c,p} }
  const byCompanyCritStatus = new Map(); // comp -> { high:{c,p}, medium:{c,p}, low:{c,p}, unknown:{c,p} }
  const criticalityStatus = { high:{completed:0,pending:0}, medium:{completed:0,pending:0}, low:{completed:0,pending:0}, unknown:{completed:0,pending:0} };
  const trend = new Map(); // yyyy-mm or month name -> count (we'll keep yyyy-mm for sorting, map to names client-side if needed)
  for(const t of rows){
    // status
    let st = String(t.status||'').toLowerCase();
    if(st==='rejected') st='pending';
    if(statusCounts.hasOwnProperty(st)) statusCounts[st]++;
    // criticality
    const cr = (t.criticality ? String(t.criticality).toLowerCase() : 'unknown');
    if(criticalityCounts.hasOwnProperty(cr)) criticalityCounts[cr]++; else criticalityCounts.unknown++;
    // category/company status aggregation
    const catKey = t.category || '(Unassigned)';
    const compKey = t.company && String(t.company).trim() ? String(t.company) : '(Unassigned)';
    const catS = byCategoryStatus.get(catKey) || { completed:0, pending:0 };
    catS[st] = (catS[st]||0) + 1;
    byCategoryStatus.set(catKey, catS);
    const catCrit = byCategoryCritStatus.get(catKey) || { high:{completed:0,pending:0}, medium:{completed:0,pending:0}, low:{completed:0,pending:0}, unknown:{completed:0,pending:0} };
    const catCritBucket = catCrit[criticalityCounts.hasOwnProperty(cr)? cr : 'unknown'];
    catCritBucket[st] = (catCritBucket[st]||0) + 1;
    byCategoryCritStatus.set(catKey, catCrit);
    const compS = byCompanyStatus.get(compKey) || { completed:0, pending:0 };
    compS[st] = (compS[st]||0) + 1;
    byCompanyStatus.set(compKey, compS);
    const compCrit = byCompanyCritStatus.get(compKey) || { high:{completed:0,pending:0}, medium:{completed:0,pending:0}, low:{completed:0,pending:0}, unknown:{completed:0,pending:0} };
    const critBucket = compCrit[criticalityCounts.hasOwnProperty(cr)? cr : 'unknown'];
    critBucket[st] = (critBucket[st]||0) + 1;
    byCompanyCritStatus.set(compKey, compCrit);
    if(criticalityStatus[cr]) criticalityStatus[cr][st] += 1; else criticalityStatus.unknown[st] += 1;
    // buckets (combined simplified)
    const dstr = t.due_date;
    if(!dstr || String(dstr).toUpperCase()==='NA') { inc(buckets, 'Unknown'); continue; }
    const d = new Date(dstr);
    if(isNaN(d.getTime())) { inc(buckets, 'Unknown'); continue; }
    const diffDays = Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - startOfToday) / (24*3600*1000));
    const critKey = (cr==='high'||cr==='medium'||cr==='low')? cr : 'low';
    if(diffDays < 0){ inc(buckets, 'Overdue'); inc(bucketsByCrit[critKey], 'Overdue'); }
    else if(diffDays === 0){ inc(buckets, 'Today'); inc(bucketsByCrit[critKey], 'Today'); }
    else if(diffDays <= 7){ inc(buckets, '7 Days'); inc(bucketsByCrit[critKey], '7 Days'); }
    else if(d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth()){ inc(buckets, 'This Month'); inc(bucketsByCrit[critKey], 'This Month'); }
    else {
      const monthLabel = d.toLocaleString('default', { month: 'short' });
      inc(buckets, monthLabel);
      inc(bucketsByCrit[critKey], monthLabel);
    }
    // trend by due month
    const ym = String(d.toISOString()).slice(0,7);
    trend.set(ym, (trend.get(ym)||0) + 1);
  }
  const trendSorted = Array.from(trend.entries()).sort((a,b)=> a[0] < b[0] ? -1 : 1);
  const byCategoryStatusArr = Array.from(byCategoryStatus.entries()).map(([category, s])=> ({ category, completed: s.completed||0, pending: s.pending||0 }));
  const byCompanyStatusArr = Array.from(byCompanyStatus.entries()).map(([company, s])=> ({ company, completed: s.completed||0, pending: s.pending||0 }));
  const byCompanyCritStatusArr = Array.from(byCompanyCritStatus.entries()).map(([company, crit])=> ({ company, crit }));
  const byCategoryCritStatusArr = Array.from(byCategoryCritStatus.entries()).map(([category, crit])=> ({ category, crit }));
  res.json({
    total: rows.length,
    buckets,
    bucketsByCrit,
    statusCounts,
    criticalityCounts,
    byCategoryStatus: byCategoryStatusArr,
    byCompanyStatus: byCompanyStatusArr,
    byCompanyCritStatus: byCompanyCritStatusArr,
    byCategoryCritStatus: byCategoryCritStatusArr,
    criticalityStatus,
    trend: trendSorted
  });
});

// Export CSV
app.get('/api/tasks/export', auth, (req, res) => {
  const me = db.prepare('SELECT name, role FROM users WHERE id = ?').get(req.user.sub) || { name: '', role: 'viewer' };
  const r = String(me.role||'').toLowerCase();
  const isSuperAdmin = r==='superadmin';
  const isAdminOnly = r==='admin';
  if(!(isSuperAdmin || isAdminOnly)) return res.status(403).json({ error: 'forbidden' });
  // reuse filter building
  const { title, assignee, assigned_by, category_id, company_id, status, from, to, role } = req.query;
  let sql = `SELECT t.*, c.name AS category, co.name AS company FROM tasks t 
             LEFT JOIN categories c ON c.id = t.category_id
             LEFT JOIN companies co ON co.id = t.company_id WHERE 1=1`;
  const params = [];
  if(title){ sql += ' AND lower(t.title) LIKE ?'; params.push(`%${String(title).toLowerCase()}%`); }
  if(assignee){ sql += ' AND t.assignee = ?'; params.push(assignee); }
  if(assigned_by){ sql += ' AND t.assigned_by = ?'; params.push(assigned_by); }
  if(category_id){ sql += ' AND t.category_id = ?'; params.push(Number(category_id)); }
  if(company_id){ sql += ' AND t.company_id = ?'; params.push(Number(company_id)); }
  if(status){ sql += ' AND t.status = ?'; params.push(status); }
  if(from){ sql += ' AND t.due_date >= ?'; params.push(from); }
  if(to){ sql += ' AND t.due_date <= ?'; params.push(to); }
  let filteredByAssignee = false;
  if(!(isSuperAdmin || isAdminOnly)){
    if(role === 'to-me'){ sql += ' AND (t.assignee = ? OR (t.checker = ? AND t.submitted_at IS NOT NULL))'; params.push(me.name, me.name); filteredByAssignee = true; }
    if(role === 'by-me'){ sql += ' AND t.assigned_by = ?'; params.push(me.name); }
    if(!filteredByAssignee){ sql += ' AND (t.assignee = ? OR (t.checker = ? AND t.submitted_at IS NOT NULL))'; params.push(me.name, me.name); }
  } else if(isAdminOnly){
    const allowed = getAllowedCategoryIds(req.user.sub);
    if(allowed.length === 0){ sql += ' AND 1=0'; }
    else { sql += ` AND t.category_id IN (${allowed.map(()=>'?').join(',')})`; params.push(...allowed); }
  }
  sql += ' ORDER BY due_date ASC';
  const rows = db.prepare(sql).all(...params);
  const header = [
    'Title','Description','Category','Location / Site','Maker','Checker','AssignedBy',
    'DueDate','ValidFrom','Criticality','LicenseOwner','RelevantFC','DisplayedFC','Status','CreatedAt'
  ];
  const esc = v => {
    const s = (v==null? '': String(v));
    const needs = /[",\n]/.test(s) || /^[=+\-@]/.test(s);
    return needs ? '"' + s.replace(/"/g,'""') + '"' : s;
  };
  const csv = [header.join(',')].concat(rows.map(r => [
    r.title,
    r.description,
    r.category||'',
    r.company||'',
    r.assignee,
    r.checker||'',
    r.assigned_by,
    r.due_date,
    r.valid_from||'',
    r.criticality||'',
    r.license_owner||'',
    (r.relevant_fc? 'Yes':'No'),
    (r.displayed_fc ? r.displayed_fc : 'NA'),
    r.status,
    r.created_at
  ].map(esc).join(','))).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="Compliances.csv"');
  res.send(csv);
});

// Import CSV
app.post('/api/tasks/import', auth, requireSuperAdmin, upload.single('file'), async (req, res) => {
  if(!req.file) return res.status(400).json({ error: 'file_required' });
  const content = fs.readFileSync(path.join(UPLOAD_DIR, req.file.filename), 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  if(lines.length <= 1) return res.json({ imported: 0 });
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  let count = 0;
  const me = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.sub) || { name: '' };
  // Track tasks by maker email (preferred) for grouped assignment mails
  const createdByMakerEmail = new Map(); // emailLower -> { name, ids: number[] }
  const newUsersCache = new Map(); // email(lower) -> user
  for(let i=1;i<lines.length;i++){
    const cols = parseCsvLine(lines[i]);
    const title = cols[idx('title')] || '';
    if(!title) continue;
    const description = cols[idx('description')] || '';
    const categoryName = cols[idx('category')] || '';
    const companyName = cols[idx('company')] || cols[idx('location / site')] || '';
    const makerEmail = cols[idx('maker_email')] || '';
    const checkerEmail = cols[idx('checker_email')] || '';
    // resolve maker by email; create viewer if not exists
    let makerUser = makerEmail ? (newUsersCache.get(String(makerEmail).toLowerCase()) || findUserByEmail(makerEmail)) : null;
    if(!makerUser && makerEmail){ try{ makerUser = createViewerUserByEmail(makerEmail); newUsersCache.set(String(makerEmail).toLowerCase(), makerUser); await sendUserRegistrationEmail(makerUser.email, makerUser.name); }catch(_e){} }
    const assignee = (makerUser && makerUser.name) || '';
    // resolve checker by email; create viewer if not exists
    let checkerUser = checkerEmail ? (newUsersCache.get(String(checkerEmail).toLowerCase()) || findUserByEmail(checkerEmail)) : null;
    if(!checkerUser && checkerEmail){ try{ checkerUser = createViewerUserByEmail(checkerEmail); newUsersCache.set(String(checkerEmail).toLowerCase(), checkerUser); await sendUserRegistrationEmail(checkerUser.email, checkerUser.name); }catch(_e){} }
    const checkerFinal = (checkerUser && checkerUser.name) || '';
    let due_date = cols[idx('duedate')] || 'NA';
    // Accept dd-mm-yyyy and normalize to yyyy-mm-dd or 'NA'
    const normDate = (s)=>{
      if(!s) return 'NA';
      const raw = String(s).trim();
      if(!raw || raw.toUpperCase()==='NA') return 'NA';
      // dd-mm-yyyy
      const m = raw.match(/^([0-3]\d)-([0-1]\d)-(\d{4})$/);
      if(m){ const dd=m[1], mm=m[2], yyyy=m[3]; return `${yyyy}-${mm}-${dd}`; }
      // Already yyyy-mm-dd
      const m2 = raw.match(/^(\d{4})-([0-1]\d)-([0-3]\d)$/);
      if(m2) return raw;
      // Fallback: try Date parse
      const d = new Date(raw);
      if(!isNaN(d.getTime())){
        const y = d.getFullYear();
        const mth = String(d.getMonth()+1).padStart(2,'0');
        const day = String(d.getDate()).padStart(2,'0');
        return `${y}-${mth}-${day}`;
      }
      return 'NA';
    };
    due_date = normDate(due_date);
    const valid_from = cols[idx('validfrom')] || '';
    const criticality = cols[idx('criticality')] || '';
    const license_owner = cols[idx('licenseowner')] || '';
    const relevant_fc = (cols[idx('relevantfc')]||'No');
    const displayed_fc = cols[idx('displayedfc')] || '';
    const assigned_by = me.name || '';
    const status = 'pending';
    // ensure category/company exist
    let category_id = null, company_id = null;
    if(categoryName){
      const c = db.prepare('SELECT id FROM categories WHERE name = ?').get(categoryName);
      category_id = c? c.id : db.prepare('INSERT INTO categories (name) VALUES (?)').run(categoryName).lastInsertRowid;
    }
    if(companyName){
      const c = db.prepare('SELECT id FROM companies WHERE name = ?').get(companyName);
      company_id = c? c.id : db.prepare('INSERT INTO companies (name) VALUES (?)').run(companyName).lastInsertRowid;
    }
    const now = new Date().toISOString();
    const r = db.prepare(`INSERT INTO tasks (title, description, category_id, company_id, assignee, checker, assigned_by, due_date, valid_from, criticality, license_owner, relevant_fc, displayed_fc, repeat_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{"frequency":null}', ?, ?, ?)`)
      .run(title, description, category_id, company_id, assignee, checkerFinal||null, assigned_by, due_date, valid_from||null, criticality||null, license_owner||null, String(relevant_fc).toLowerCase()==='yes'?1:0, displayed_fc||null, status, now, now);
    const taskId = r.lastInsertRowid;
    if(makerEmail){
      const emailKey = String(makerEmail).trim().toLowerCase();
      if(emailKey){ const entry = createdByMakerEmail.get(emailKey) || { name: assignee, ids: [] }; entry.name = assignee || entry.name; entry.ids.push(taskId); createdByMakerEmail.set(emailKey, entry); }
    }
    count++;
  }
  // Grouped emails to makers if their email is available (fire-and-forget)
  (async ()=>{
    if(mailer && createdByMakerEmail.size>0){
      for(const [emailLower, entry] of createdByMakerEmail.entries()){
        try{
          const to = emailLower;
          const tasks = (entry.ids||[]).map(id => getTaskWithJoins(id)).filter(Boolean);
          console.log('[import] grouped assignment email attempt', { to, tasks: tasks.length });
          if(tasks.length>0){ const ok = await sendGroupedEmail(to, entry.name||'there', tasks, 'assignment'); console.log('[import] grouped assignment email result', { to, ok }); }
        }catch(e){ console.error('[import] grouped assignment email error', e); }
      }
    } else {
      if(!mailer) console.warn('[import] mailer not configured; skipping grouped assignment emails');
    }
  })();
  res.json({ imported: count });
});

// Import template CSV (header only) - excludes AssignedBy, CreatedAt, Status per requirements
app.get('/api/tasks/import/template', auth, requireSuperAdmin, (req, res) => {
  const header = [
    'Title','Description','Category','Location / Site','Maker_email','Checker_email','DueDate','ValidFrom','Criticality','LicenseOwner','RelevantFC','DisplayedFC'
  ];
  const csv = header.join(',') + '\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="compliances_import_template.csv"');
  res.send(csv);
});

// Email transport and reminders (reintroduced)
// const mailer = (SMTP_HOST && SMTP_USER) ? nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT===465, auth: { user: SMTP_USER, pass: SMTP_PASS } }) : null;
const mailer = (SMTP_HOST && SMTP_USER)
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      pool: true,
      maxConnections: 5,    // parallel connections
      maxMessages: 100,     // per connection
      rateLimit: 10         // messages per second
    })
  : null;


function shouldSendToday(policy, daysUntil){
  if(daysUntil === 0) return true; // on due
  if(daysUntil < 0) return true;   // overdue daily
  // pre-due windows from policy if present
  try{
    const windows = JSON.parse((policy && policy.windows_json) || '[]');
    for(const w of windows){ const [min,max,cad] = w; if(daysUntil >= Math.min(min,max) && daysUntil <= Math.max(min,max)) return (daysUntil % Math.max(1,cad)) === 0; }
  }catch(_e){}
  return false;
}

async function sendReminderEmail(task){
  if(!mailer) return false;
  const superAdmins = db.prepare("SELECT email,name FROM users WHERE role='superadmin'").all();
  const catAdmins = (task.category_id!=null)
    ? db.prepare(`SELECT u.email,u.name FROM users u JOIN user_categories uc ON uc.user_id = u.id WHERE u.role='admin' AND uc.category_id = ?`).all(Number(task.category_id))
    : [];
  const assignedByUser = db.prepare('SELECT email,name FROM users WHERE name = ?').get(task.assigned_by||'');
  const makerUser = db.prepare('SELECT email,name FROM users WHERE name = ?').get(task.assignee||'');
  const checkerUser = task.submitted_at ? db.prepare('SELECT email,name FROM users WHERE name = ?').get(task.checker||'') : null;
  let to = [makerUser&&makerUser.email].filter(Boolean)[0];
  if(!to){ const fallbacks = (superAdmins||[]).concat(catAdmins||[]); to = (assignedByUser&&assignedByUser.email) || ((fallbacks&&fallbacks[0])? fallbacks[0].email : ''); }
  const cc = [assignedByUser&&assignedByUser.email]
    .concat((superAdmins||[]).map(a=>a.email))
    .concat((catAdmins||[]).map(a=>a.email))
    .concat(checkerUser? [checkerUser.email] : [])
    .filter(Boolean).join(',');
  if(!to) return false;
  const subject = `[Reminder] ${task.title} ${task.due_date && String(task.due_date).toUpperCase()!=='NA'? 'due '+task.due_date : ''}`.trim();
  const body = `Title: ${task.title}\nLocation / Site: ${task.company||''}\nCategory: ${task.category||''}\nMaker: ${task.assignee||''}\nChecker: ${task.checker||''}\nDue: ${task.due_date||'NA'}\nStatus: ${task.status}\n\nVisit ${APP_URL}/#/tasks to view compliances.`;
  try{
    const info = await mailer.sendMail({ from: {
      name: "ProCompliance",
      address: SMTP_FROM
    }, to, cc, subject, text: body });
    return !!(info && (info.accepted||[]).length);
  }catch(_e){ return false; }
}

function titleCaseNameFromEmail(email){
  const local = String(email||'').split('@')[0] || '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const name = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
  return name || (String(email||'').split('@')[0]||'User');
}

async function sendUserRegistrationEmail(to, name){
  if(!mailer || !to) return false;
  const salutation = `Hi ${name||'there'},`;
  const intro = `You have been registered on ProCompliance.`;
  const bodyLines = [
    `Login URL: ${APP_URL}`,
    `Email: ${to}`,
    `Temporary password: ${DEFAULT_PASSWORD}`,
    `Please click "Forgot password" on the login page and reset your password after first login.`
  ];
  const text = `${salutation}\n\n${intro}\n\n${bodyLines.join('\n')}\n`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;">
    <p>${htmlEscape(salutation)}</p>
    <p>${htmlEscape(intro)}</p>
    <p><strong>Login URL:</strong> <a href="${APP_URL}">${APP_URL}</a><br>
    <strong>Email:</strong> ${htmlEscape(to)}<br>
    <strong>Temporary password:</strong> ${htmlEscape(DEFAULT_PASSWORD)}</p>
    <p>Please click "Forgot password" on the login page and reset your password after first login.</p>
  </div>`;
  const subject = 'Welcome to ProCompliance';
  try{ const info = await mailer.sendMail({ from:{ name:'ProCompliance', address: SMTP_FROM }, to, subject, html, text }); return !!(info && (info.accepted||[]).length); }catch(_e){ return false; }
}

function findUserByEmail(email){ return db.prepare('SELECT id, email, name, role FROM users WHERE lower(email)=lower(?)').get(String(email||'')); }

function createViewerUserByEmail(email){
  const nm = titleCaseNameFromEmail(email);
  if(!DEFAULT_PASSWORD){ throw new Error('DEFAULT_PASSWORD not set'); }
  const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
  const r = db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)')
    .run(String(email).trim(), hash, nm, 'viewer');
  return { id: r.lastInsertRowid, email: String(email).trim(), name: nm, role: 'viewer' };
}

// Grouped email helpers
function htmlEscape(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function buildTasksTable(tasks){
  const rows = tasks.map(t=>{
    let statusLabel = 'Pending';
    if(String(t.status)==='completed'){
      // If due date is NA, keep Completed label (no renewal needed)
      statusLabel = (String(t.due_date||'').toUpperCase()==='NA') ? 'Completed' : 'Renewal Needed';
    }
    return `<tr>
      <td>${htmlEscape(t.title)}</td>
      <td>${htmlEscape(t.company||'')}</td>
      <td>${htmlEscape(t.category||'')}</td>
      <td>${htmlEscape(t.assignee||'')}</td>
      <td>${htmlEscape(t.checker||'')}</td>
      <td>${htmlEscape(t.due_date||'NA')}</td>
      <td>${statusLabel}</td>
    </tr>`;
  }).join('');
  return `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:13px;">
    <thead>
      <tr style="background:#f5f5f5;">
        <th align="left">Title</th>
        <th align="left">Location / Site</th>
        <th align="left">Category</th>
        <th align="left">Maker</th>
        <th align="left">Checker</th>
        <th align="left">Due</th>
        <th align="left">Status</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}
async function sendGroupedEmail(to, recipientName, tasks, audience){
  if(!mailer || !to || !tasks || tasks.length===0) return false;
  const salutation = `Hi ${recipientName || 'there'},`;
  const intro = (audience==='assignment')
    ? 'You have been assigned the following new compliances.'
    : (audience==='admin'
      ? 'Below are the compliances that need attention across the organization.'
      : 'Below are the compliances which need your attention.');
  const html = `<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;\">\n    <p>${htmlEscape(salutation)}</p>\n    <p>${htmlEscape(intro)}</p>\n    <p>Visit <a href=\"${APP_URL}/#/tasks\">ProCompliance</a> to view these compliances.</p>\n    ${buildTasksTable(tasks)}\n  </div>`;
  const subject = (audience==='assignment')
    ? `[Assigned] ${tasks.length} new compliances`
    : (audience==='admin'
      ? `[Reminder] ${tasks.length} compliances need attention`
      : `[Reminder] ${tasks.length} compliances need your attention`);
  try{
    console.log('[email] sendGroupedEmail attempt', { to, audience, count: tasks.length, subject });
    const info = await mailer.sendMail({ from: { name: 'ProCompliance', address: SMTP_FROM }, to, subject, html });
    const ok = !!(info && (info.accepted||[]).length);
    console.log('[email] sendGroupedEmail result', { to, ok, messageId: info && info.messageId, accepted: info && info.accepted, rejected: info && info.rejected, response: info && info.response });
    return ok;
  }catch(e){ console.error('[email] sendGroupedEmail error', e); return false; }
}
function computeDaysUntil(dateStr){
  const today = new Date(); const d = new Date(dateStr);
  if(isNaN(d.getTime())) return null;
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / (24*3600*1000));
}
function isTaskEligibleToday(t){
  if(String(t.status)==='pending') return true;
  if(String(t.status)!=='completed') return false;
  if(!t.due_date || String(t.due_date).toUpperCase()==='NA') return false;
  const days = computeDaysUntil(t.due_date); if(days===null) return false;
  const pol = db.prepare('SELECT * FROM reminder_policies WHERE lower(criticality)=?').get(String(t.criticality||'').toLowerCase()) || { windows_json:'[]' };
  return shouldSendToday(pol, days);
}
async function processAndSendGroupedReminders(opts){
  const ignoreDailyLimit = !!(opts && opts.ignoreDailyLimit);
  const today = new Date(); const yyyyMmDd = today.toISOString().slice(0,10);
  const rows = db.prepare(`SELECT t.*, c.name AS category, co.name AS company FROM tasks t
                           LEFT JOIN categories c ON c.id=t.category_id
                           LEFT JOIN companies co ON co.id=t.company_id
                           WHERE t.status IN ('pending','completed')`).all();
  const pendingEligible = [];
  const renewalEligible = [];
  for(const t of rows){
    const already = db.prepare("SELECT 1 as x FROM notes WHERE task_id=? AND text LIKE ? AND substr(created_at,1,10)=?").get(t.id, `%Reminder sent%`, yyyyMmDd);
    if(!ignoreDailyLimit && already) continue;
    if(String(t.status)==='pending'){
      pendingEligible.push(t);
      continue;
    }
    if(String(t.status)==='completed'){
      if(!t.due_date || String(t.due_date).toUpperCase()==='NA') continue;
      const days = computeDaysUntil(t.due_date); if(days===null) continue;
      const pol = db.prepare('SELECT * FROM reminder_policies WHERE lower(criticality)=?').get(String(t.criticality||'').toLowerCase()) || { windows_json:'[]' };
      if(shouldSendToday(pol, days)) renewalEligible.push(t);
    }
  }
  const makerMap = new Map();
  const checkerMap = new Map();
  const addToMap = (map, key, task)=>{ if(!key) return; if(!map.has(key)) map.set(key, []); map.get(key).push(task); };
  for(const t of pendingEligible){ addToMap(makerMap, t.assignee||'', t); if(t.checker && t.submitted_at) addToMap(checkerMap, t.checker, t); }
  for(const t of renewalEligible){ addToMap(makerMap, t.assignee||'', t); if(t.checker && t.submitted_at) addToMap(checkerMap, t.checker, t); }
  const superAdminUsers = db.prepare("SELECT name,email FROM users WHERE role='superadmin'").all();
  const superAdminEmails = (superAdminUsers||[]).map(u=>u.email).filter(Boolean);
  let emailsSent = 0; let anySent = false;
  for(const [name, tasks] of makerMap.entries()){
    const u = db.prepare('SELECT email,name FROM users WHERE name = ?').get(name);
    const email = u && u.email; const display = (u && u.name) || name;
    if(email){ const ok = await sendGroupedEmail(email, display, tasks, 'maker'); if(ok){ emailsSent++; anySent = true; } }
  }
  for(const [name, tasks] of checkerMap.entries()){
    const u = db.prepare('SELECT email,name FROM users WHERE name = ?').get(name);
    const email = u && u.email; const display = (u && u.name) || name;
    if(email){ const ok = await sendGroupedEmail(email, display, tasks, 'checker'); if(ok){ emailsSent++; anySent = true; } }
  }
  const adminTasks = pendingEligible.concat(renewalEligible);
  if(superAdminEmails.length>0 && adminTasks.length>0){ const ok = await sendGroupedEmail(superAdminEmails.join(','), 'Admin', adminTasks, 'admin'); if(ok){ emailsSent++; anySent = true; } }
  // Category-scoped admin notifications
  const adminsWithCats = db.prepare(`SELECT u.id,u.email,u.name, group_concat(uc.category_id) as cats
    FROM users u LEFT JOIN user_categories uc ON uc.user_id = u.id
    WHERE u.role='admin' GROUP BY u.id`).all();
  for(const a of (adminsWithCats||[])){
    const cats = (String(a.cats||'').split(',').filter(Boolean).map(Number));
    if(cats.length===0 || !a.email) continue;
    const scoped = adminTasks.filter(t => t.category_id!=null && cats.includes(Number(t.category_id)));
    if(scoped.length>0){ const ok = await sendGroupedEmail(a.email, a.name||'Admin', scoped, 'admin'); if(ok){ emailsSent++; anySent = true; } }
  }
  let tasksNoted = 0;
  if(anySent){
    for(const t of adminTasks){ db.prepare('INSERT INTO notes (task_id, text, created_at) VALUES (?, ?, ?)').run(t.id, 'Reminder sent (grouped)', new Date().toISOString()); tasksNoted++; }
  }
  return { emailsSent, tasksNoted };
}

app.post('/api/reminders/run', auth, requireAdmin, async (req, res) => {
  const { emailsSent, tasksNoted } = await processAndSendGroupedReminders({ ignoreDailyLimit: true });
  res.json({ sent: emailsSent, tasks: tasksNoted });
});

// Cron daily 09:00 IST
try{
  cron.schedule('21 11 * * *', async () => {
    try{ await processAndSendGroupedReminders(); }catch(_e){}
  }, { timezone: 'Asia/Kolkata' });
}catch(_e){}

function parseCsvLine(line){
  const out = []; let cur = ''; let inq = false;
  for(let i=0;i<line.length;i++){
    const ch = line[i];
    if(inq){
      if(ch==='"' && line[i+1]==='"'){ cur+='"'; i++; }
      else if(ch==='"'){ inq=false; }
      else cur += ch;
    }else{
      if(ch===','){ out.push(cur); cur=''; }
      else if(ch==='"'){ inq=true; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

app.get('/api/tasks/:id', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if(!t) return res.status(404).json({ error: 'not_found' });
  const atts = db.prepare('SELECT id, file_name, file_size, file_type FROM attachments WHERE task_id = ?').all(t.id);
  res.json({ task: t, attachments: atts });
});

app.put('/api/tasks/:id', auth, upload.array('attachments', 10), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if(!existing) return res.status(404).json({ error: 'not_found' });
  // Allow admin or maker (assignee) to edit; checker cannot edit fields
  const me = db.prepare('SELECT name, role FROM users WHERE id = ?').get(req.user.sub) || {};
  const roleStr = String(me.role||'').toLowerCase();
  const isSuper = roleStr === 'superadmin';
  const isAdminOnly = roleStr === 'admin';
  const isElevated = isSuper || isAdminOnly;
  const isMaker = existing.assignee === (me.name||'');
  const adminHasCategory = isSuper || (isAdminOnly && hasCategoryAccess(req.user.sub, existing.category_id));
  // Lock edits for maker once submitted until explicitly reopened
  if(existing.submitted_at && !isElevated && !(existing.edit_unlocked)){ 
    return res.status(403).json({ error: 'locked_submitted' });
  }
  if(!(isMaker || (isElevated && adminHasCategory))) return res.status(403).json({ error: 'forbidden' });
  const body = req.body || {};
  const now = new Date().toISOString();
  // Do not allow changing assigned_by; keep the original assigning admin
  const nextAssignedBy = existing.assigned_by;
  let nextAssignee = String(body.assignee||existing.assignee) === 'Me' ? (me.name||'') : (body.assignee||existing.assignee);
  if(!isElevated) nextAssignee = existing.assignee; // maker cannot reassign
  const nextChecker = isElevated ? (body.checker || existing.checker) : existing.checker;
  // enforce displayed_fc == 'Yes' requires at least one image
  if(!isElevated && String(body.displayed_fc|| existing.displayed_fc || '').toLowerCase()==='yes' && existing.id){
    const hasImageNew = (req.files||[]).some(f => (f.mimetype||'').startsWith('image/'));
    const hasImageExisting = db.prepare("SELECT COUNT(*) as c FROM attachments WHERE task_id = ? AND (file_type LIKE 'image/%')").get(id).c > 0;
    if(!(hasImageNew || hasImageExisting)) return res.status(400).json({ error: 'fc_image_required' });
  }
  // Require Valid From for makers (non-admin) when updating
  if(!isElevated){
    const vfIncoming = (req.body && req.body.valid_from) || existing.valid_from;
    if(!vfIncoming){ return res.status(400).json({ error: 'valid_from_required' }); }
  }
  const next = {
    title: body.title || existing.title,
    description: (body.description !== undefined ? body.description : existing.description) || '',
    category_id: body.category_id ? Number(body.category_id) : (existing.category_id||null),
    company_id: body.company_id ? Number(body.company_id) : (existing.company_id||null),
    assignee: nextAssignee,
    assigned_by: nextAssignedBy,
    checker: nextChecker,
    due_date: (body.due_date !== undefined ? String(body.due_date||'NA') : existing.due_date),
    valid_from: (body.valid_from !== undefined ? body.valid_from : existing.valid_from) || null,
    criticality: (body.criticality !== undefined ? body.criticality : existing.criticality) || null,
    license_owner: (body.license_owner !== undefined ? body.license_owner : existing.license_owner) || null,
    relevant_fc: (body.relevant_fc !== undefined ? (String(body.relevant_fc).toLowerCase()==='yes'?1:0) : (existing.relevant_fc||0)),
    displayed_fc: (body.displayed_fc !== undefined ? body.displayed_fc : existing.displayed_fc) || null,
    repeat_json: body.repeat_json || existing.repeat_json
  };
  // Auto-submit on first maker update: if previously not submitted and a checker exists, set submitted_at and notify checker
  let submittedAt = existing.submitted_at || null;
  if(!submittedAt && next.checker){ submittedAt = now; }
  db.prepare(`UPDATE tasks SET title=?, description=?, category_id=?, company_id=?, assignee=?, assigned_by=?, checker=?, due_date=?, valid_from=?, criticality=?, license_owner=?, relevant_fc=?, displayed_fc=?, repeat_json=?, status=?, submitted_at=?, edit_unlocked=0, updated_at=? WHERE id=?`)
    .run(next.title,
         next.description,
         next.category_id,
         next.company_id,
         next.assignee,
         next.assigned_by,
         next.checker,
         next.due_date,
         next.valid_from,
         next.criticality,
         next.license_owner,
         next.relevant_fc,
         next.displayed_fc,
         next.repeat_json,
         'pending',
         submittedAt,
         now,
         id);
  // if assignee changed, add an auto note and notify if already submitted
  const assigneeChanged = nextAssignee !== existing.assignee;
  if(assigneeChanged){
    db.prepare('INSERT INTO notes (task_id, text, created_at) VALUES (?, ?, ?)')
      .run(id, `Reassigned to ${nextAssignee} by ${nextAssignedBy}`, now);
  }
  const checkerChanged = nextChecker !== existing.checker;
  // enforce total size <= 5MB
  const totalBytes = (req.files||[]).reduce((s,f)=> s+ (f.size||0), 0);
  if(totalBytes > 5 * 1024 * 1024){ return res.status(400).json({ error: 'attachments_too_large' }); }
  for(const f of req.files || []){
    db.prepare('INSERT INTO attachments (task_id, file_name, file_size, file_type, stored_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, f.originalname, f.size, f.mimetype, f.filename, now);
  }
  // Log detailed change note for maker edits; and for admin when reopened for edits
  try{
    const isMakerEdit = (!isElevated && isMaker);
    if(isMakerEdit){
      const trunc = (s) => {
        const str = String(s==null? '': s);
        return str.length>120 ? str.slice(0,117) + '…' : str;
      };
      const oldCat = existing.category_id ? (db.prepare('SELECT name FROM categories WHERE id = ?').get(existing.category_id)||{}).name : '';
      const newCat = next.category_id ? (db.prepare('SELECT name FROM categories WHERE id = ?').get(next.category_id)||{}).name : '';
      const oldCom = existing.company_id ? (db.prepare('SELECT name FROM companies WHERE id = ?').get(existing.company_id)||{}).name : '';
      const newCom = next.company_id ? (db.prepare('SELECT name FROM companies WHERE id = ?').get(next.company_id)||{}).name : '';
      const changes = [];
      if(String(existing.title||'') !== String(next.title||'')) changes.push(`Title: '${trunc(existing.title||'')}' → '${trunc(next.title||'')}'`);
      if(String(existing.description||'') !== String(next.description||'')) changes.push(`Description: '${trunc(existing.description||'')}' → '${trunc(next.description||'')}'`);
      if((existing.category_id||null) !== (next.category_id||null)) changes.push(`Category: '${trunc(oldCat||'')}' → '${trunc(newCat||'')}'`);
      if((existing.company_id||null) !== (next.company_id||null)) changes.push(`Location / Site: '${trunc(oldCom||'')}' → '${trunc(newCom||'')}'`);
      if(String(existing.due_date||'') !== String(next.due_date||'')) changes.push(`Due Date: '${trunc(existing.due_date||'')}' → '${trunc(next.due_date||'')}'`);
      if(String(existing.valid_from||'') !== String(next.valid_from||'')) changes.push(`Valid From: '${trunc(existing.valid_from||'')}' → '${trunc(next.valid_from||'')}'`);
      if(String(existing.criticality||'') !== String(next.criticality||'')) changes.push(`Criticality: '${trunc(existing.criticality||'')}' → '${trunc(next.criticality||'')}'`);
      if(String(existing.license_owner||'') !== String(next.license_owner||'')) changes.push(`Licence Owner: '${trunc(existing.license_owner||'')}' → '${trunc(next.license_owner||'')}'`);
      if(Number(existing.relevant_fc||0) !== Number(next.relevant_fc||0)) changes.push(`Relevant FC: '${(existing.relevant_fc? 'Yes':'No')}' → '${(next.relevant_fc? 'Yes':'No')}'`);
      if(String(existing.displayed_fc||'') !== String(next.displayed_fc||'')) changes.push(`Displayed FC: '${trunc(existing.displayed_fc||'')}' → '${trunc(next.displayed_fc||'')}'`);
      if(String(existing.repeat_json||'') !== String(next.repeat_json||'')) changes.push(`Repeat: '${trunc(existing.repeat_json||'')}' → '${trunc(next.repeat_json||'')}'`);
      if(changes.length>0){
        const noteText = `Edited by ${me.name||''} (maker). Changes:\n- ` + changes.join('\n- ');
        db.prepare('INSERT INTO notes (task_id, text, created_at) VALUES (?, ?, ?)')
          .run(id, noteText, now);
      } else {
        db.prepare('INSERT INTO notes (task_id, text, created_at) VALUES (?, ?, ?)')
          .run(id, `Edited by ${me.name||''} (maker). No field changes detected.`, now);
      }
    } else {
      // For admins: log diffs as well, but only if reopened (or always, to be thorough)
      const trunc = (s) => { const str = String(s==null? '': s); return str.length>120 ? str.slice(0,117)+'…' : str; };
      const oldCat = existing.category_id ? (db.prepare('SELECT name FROM categories WHERE id = ?').get(existing.category_id)||{}).name : '';
      const newCat = next.category_id ? (db.prepare('SELECT name FROM categories WHERE id = ?').get(next.category_id)||{}).name : '';
      const oldCom = existing.company_id ? (db.prepare('SELECT name FROM companies WHERE id = ?').get(existing.company_id)||{}).name : '';
      const newCom = next.company_id ? (db.prepare('SELECT name FROM companies WHERE id = ?').get(next.company_id)||{}).name : '';
      const changes = [];
      if(String(existing.title||'') !== String(next.title||'')) changes.push(`Title: '${trunc(existing.title||'')}' → '${trunc(next.title||'')}'`);
      if(String(existing.description||'') !== String(next.description||'')) changes.push(`Description: '${trunc(existing.description||'')}' → '${trunc(next.description||'')}'`);
      if((existing.category_id||null) !== (next.category_id||null)) changes.push(`Category: '${trunc(oldCat||'')}' → '${trunc(newCat||'')}'`);
      if((existing.company_id||null) !== (next.company_id||null)) changes.push(`Location / Site: '${trunc(oldCom||'')}' → '${trunc(newCom||'')}'`);
      if(String(existing.due_date||'') !== String(next.due_date||'')) changes.push(`Valid Till: '${trunc(existing.due_date||'')}' → '${trunc(next.due_date||'')}'`);
      if(String(existing.valid_from||'') !== String(next.valid_from||'')) changes.push(`Valid From: '${trunc(existing.valid_from||'')}' → '${trunc(next.valid_from||'')}'`);
      if(String(existing.criticality||'') !== String(next.criticality||'')) changes.push(`Criticality: '${trunc(existing.criticality||'')}' → '${trunc(next.criticality||'')}'`);
      if(String(existing.license_owner||'') !== String(next.license_owner||'')) changes.push(`Licence Owner: '${trunc(existing.license_owner||'')}' → '${trunc(next.license_owner||'')}'`);
      if(Number(existing.relevant_fc||0) !== Number(next.relevant_fc||0)) changes.push(`Relevant FC: '${(existing.relevant_fc? 'Yes':'No')}' → '${(next.relevant_fc? 'Yes':'No')}'`);
      if(String(existing.displayed_fc||'') !== String(next.displayed_fc||'')) changes.push(`Displayed FC: '${trunc(existing.displayed_fc||'')}' → '${trunc(next.displayed_fc||'')}'`);
      if(String(existing.repeat_json||'') !== String(next.repeat_json||'')) changes.push(`Repeat: '${trunc(existing.repeat_json||'')}' → '${trunc(next.repeat_json||'')}'`);
      const noteText = changes.length>0 ? (`Edited by ${me.name||''} (admin). Changes:\n- ` + changes.join('\n- ')) : (`Updated by ${me.name||''}`);
      db.prepare('INSERT INTO notes (task_id, text, created_at) VALUES (?, ?, ?)').run(id, noteText, now);
    }
  }catch(_e){
    // best-effort logging; ignore errors
  }
  res.json({ ok: true });
  // fire-and-forget notifications on reassignment
  (async ()=>{
    try{
      const full = getTaskWithJoins(id);
      // Maker should always be notified on reassignment
      if(assigneeChanged){ await sendAssignmentNotification(full); }
      // Checker should be notified only if already submitted
      if((checkerChanged && !!existing.submitted_at) || (!existing.submitted_at && submittedAt && next.checker)){
        await sendSubmissionNotification(full);
      }
    }catch(_e){}
  })();
});

app.post('/api/tasks/:id/status', auth, (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  if(!['pending','completed','rejected'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  const me = db.prepare('SELECT name, role FROM users WHERE id = ?').get(req.user.sub) || {};
  const roleStr = String(me.role||'').toLowerCase();
  const isAdmin = (roleStr === 'admin' || roleStr === 'superadmin');
  const isAssignee = (existing && existing.assignee === (me.name||''));
  const isChecker = (existing && existing.checker === (me.name||''));
  // allow admin; allow assignee always; allow checker if maker has submitted (submitted_at set)
  const checkerAllowed = isChecker && !!(existing && existing.submitted_at);
  if(!(isAdmin || isAssignee || checkerAllowed)) return res.status(403).json({ error: 'forbidden' });
  const now = new Date().toISOString();
  // note message: special text when reopening for edits
  let noteMsg = `Status changed to ${status} by ${isAdmin ? (me.name||'Admin') : (me.name||'')}`;
  const isReopenForEdits = status === 'pending' && (isAdmin || isChecker) && !!(existing && existing.submitted_at);
  if(isReopenForEdits){ noteMsg = `Reopened for edits by ${me.name||''}`; }
  db.prepare('INSERT INTO notes (task_id, text, created_at) VALUES (?, ?, ?)')
    .run(id, noteMsg, now);
  // if reopening to pending, only admin or checker can unlock edits while preserving submitted visibility
  if(status === 'pending' && (isAdmin || isChecker)){
    // Disallow checker-initiated reopen if task is completed. Admin can always reopen.
    if(!isAdmin && isChecker && String(existing.status) === 'completed'){
      return res.status(403).json({ error: 'completed_reopen_admin_only' });
    }
    // Preserve submitted_at so checkers continue to see, but unlock edits
    db.prepare('UPDATE tasks SET status=?, edit_unlocked=1, updated_at=? WHERE id=?').run(status, now, id);
    // Notify maker each time it's reopened for edits
    try{ const full = getTaskWithJoins(id); sendReopenForEditsNotification(full, me.name||''); }catch(_e){}
  } else {
  // keep submitted flag so checker continues to see the task after status changes; reset edit unlock on non-pending
  if(status !== 'pending'){
    db.prepare('UPDATE tasks SET status=?, edit_unlocked=0, updated_at=? WHERE id=?').run(status, now, id);
  } else {
    db.prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?').run(status, now, id);
  }
  }
  res.json({ ok: true });
});

// Maker submit to checker (explicit send for review)
app.post('/api/tasks/:id/submit', auth, (req, res) => {
  const id = Number(req.params.id);
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if(!t) return res.status(404).json({ error: 'not_found' });
  const me = db.prepare('SELECT name, role FROM users WHERE id = ?').get(req.user.sub) || {};
  const isMaker = t.assignee === (me.name||'');
  const isAdmin = String(me.role||'').toLowerCase() === 'admin';
  if(!(isMaker || isAdmin)) return res.status(403).json({ error: 'forbidden' });
  const now = new Date().toISOString();
  // Deprecated route retained for compatibility; do nothing
  return res.json({ ok: true, deprecated: true });
});

// Maker requests edit when locked; notify admins and checker
app.post('/api/tasks/:id/request_edit', auth, async (req, res) => {
  const id = Number(req.params.id);
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if(!t) return res.status(404).json({ error: 'not_found' });
  const me = db.prepare('SELECT name, role FROM users WHERE id = ?').get(req.user.sub) || {};
  const isMaker = t.assignee === (me.name||'');
  const roleStr = String(me.role||'').toLowerCase();
  const isElevated = roleStr==='admin' || roleStr==='superadmin';
  if(!(isMaker || isElevated)) return res.status(403).json({ error: 'forbidden' });
  // Allow request at any time; primarily intended for locked tasks
  const now = new Date().toISOString();
  db.prepare('INSERT INTO notes (task_id, text, created_at) VALUES (?, ?, ?)')
    .run(id, `Edit requested by ${me.name||''}`, now);
  try{
    const full = getTaskWithJoins(id);
    await sendEditRequestNotification(full, me.name||'');
  }catch(_e){}
  res.json({ ok: true });
});

// Delete task (admin)
app.delete('/api/tasks/:id', auth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM attachments WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM notes WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Notes
app.get('/api/tasks/:id/notes', auth, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, text, file_name, file_size, file_type, created_at FROM notes WHERE task_id = ? ORDER BY id DESC').all(Number(req.params.id));
  res.json({ notes: rows });
});
app.post('/api/tasks/:id/notes', auth, upload.single('file'), (req, res) => {
  const id = Number(req.params.id);
  let text = (req.body && req.body.text || '').trim();
  if(!text) return res.status(400).json({ error: 'note_required' });
  const now = new Date().toISOString();
  const f = req.file;
  const me = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.sub) || { name: '' };
  if(me && me.name){ text = `${me.name}: ${text}`; }
  db.prepare('INSERT INTO notes (task_id, text, file_name, file_size, file_type, stored_name, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, text, f? f.originalname : null, f? f.size : null, f? f.mimetype : null, f? f.filename : null, now);
  res.status(201).json({ ok: true });
});

// Download note attachment
app.get('/api/notes/:id/download', auth, (req, res) => {
  const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(req.params.id));
  if(!n || !n.stored_name) return res.status(404).json({ error: 'not_found' });
  const p = path.join(UPLOAD_DIR, n.stored_name);
  if(!fs.existsSync(p)) return res.status(410).json({ error: 'gone' });
  res.setHeader('Content-Type', n.file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${n.file_name}"`);
  fs.createReadStream(p).pipe(res);
});
// View note attachment inline
app.get('/api/notes/:id/view', auth, (req, res) => {
  const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(req.params.id));
  if(!n || !n.stored_name) return res.status(404).json({ error: 'not_found' });
  const p = path.join(UPLOAD_DIR, n.stored_name);
  if(!fs.existsSync(p)) return res.status(410).json({ error: 'gone' });
  res.setHeader('Content-Type', n.file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${n.file_name}"`);
  fs.createReadStream(p).pipe(res);
});

// Download attachment
app.get('/api/attachments/:id/download', auth, (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.id));
  if(!a) return res.status(404).json({ error: 'not_found' });
  const p = path.join(UPLOAD_DIR, a.stored_name);
  if(!fs.existsSync(p)) return res.status(410).json({ error: 'gone' });
  res.setHeader('Content-Type', a.file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${a.file_name}"`);
  fs.createReadStream(p).pipe(res);
});
// View attachment inline
app.get('/api/attachments/:id/view', auth, (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.id));
  if(!a) return res.status(404).json({ error: 'not_found' });
  const p = path.join(UPLOAD_DIR, a.stored_name);
  if(!fs.existsSync(p)) return res.status(410).json({ error: 'gone' });
  res.setHeader('Content-Type', a.file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${a.file_name}"`);
  fs.createReadStream(p).pipe(res);
});

// HTML preview pages with Download button
app.get('/attachments/:id', auth, (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.id));
  if(!a) return res.status(404).send('Not found');
  const hdr = req.headers.authorization || '';
  const token = (req.query && req.query.token) ? String(req.query.token) : (hdr.startsWith('Bearer ') ? hdr.slice(7) : '');
  const viewUrl = `/api/attachments/${a.id}/view${token? `?token=${encodeURIComponent(token)}`: ''}`;
  const dlUrl = `/api/attachments/${a.id}/download${token? `?token=${encodeURIComponent(token)}`: ''}`;
  const isImage = (String(a.file_type||'').toLowerCase().startsWith('image/'));
  const isPdf = (String(a.file_type||'').toLowerCase()==='application/pdf');
  const headerHtml = isPdf ? '' : `<div style="padding:8px;border-bottom:1px solid #e5e7eb;position:sticky;top:0;background:#fff"><a href="${dlUrl}" download class="btn">Download</a></div>`;
  const bodyHtml = isImage
    ? `<div style="display:flex;align-items:center;justify-content:center;width:100%;height:calc(100vh - 42px);background:#111827"><img src="${viewUrl}" alt="preview" style="max-width:100%;max-height:100%;object-fit:contain;background:#fff"></div>`
    : `<iframe src="${viewUrl}" style="border:0;width:100%;height:calc(100vh - ${isPdf? '0':'42'}px)"></iframe>`;
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(a.file_name||'Attachment')}</title></head><body style="margin:0;font-family:Arial,Helvetica,sans-serif">${headerHtml}${bodyHtml}</body></html>`);
});

app.get('/notes/:id', auth, (req, res) => {
  const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(req.params.id));
  if(!n || !n.stored_name) return res.status(404).send('Not found');
  const hdr = req.headers.authorization || '';
  const token = (req.query && req.query.token) ? String(req.query.token) : (hdr.startsWith('Bearer ') ? hdr.slice(7) : '');
  const viewUrl = `/api/notes/${n.id}/view${token? `?token=${encodeURIComponent(token)}`: ''}`;
  const dlUrl = `/api/notes/${n.id}/download${token? `?token=${encodeURIComponent(token)}`: ''}`;
  const isImage = (String(n.file_type||'').toLowerCase().startsWith('image/'));
  const isPdf = (String(n.file_type||'').toLowerCase()==='application/pdf');
  const headerHtml = isPdf ? '' : `<div style=\"padding:8px;border-bottom:1px solid #e5e7eb;position:sticky;top:0;background:#fff\"><a href=\"${dlUrl}\" download class=\"btn\">Download</a></div>`;
  const bodyHtml = isImage
    ? `<div style=\"display:flex;align-items:center;justify-content:center;width:100%;height:calc(100vh - 42px);background:#111827\"><img src=\"${viewUrl}\" alt=\"preview\" style=\"max-width:100%;max-height:100%;object-fit:contain;background:#fff\"></div>`
    : `<iframe src=\"${viewUrl}\" style=\"border:0;width:100%;height:calc(100vh - ${isPdf? '0':'42'}px)\"></iframe>`;
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><meta charset=\"utf-8\"><title>${htmlEscape(n.file_name||'Attachment')}</title></head><body style=\"margin:0;font-family:Arial,Helvetica,sans-serif\">${headerHtml}${bodyHtml}</body></html>`);
});

  // Delete attachment (admin always; maker allowed when not locked OR reopened for edits)
app.delete('/api/attachments/:id', auth, (req, res) => {
  const attId = Number(req.params.id);
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attId);
  if(!a) return res.status(404).json({ error: 'not_found' });
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(a.task_id);
  if(!t) return res.status(404).json({ error: 'not_found' });
  const me = db.prepare('SELECT name, role FROM users WHERE id = ?').get(req.user.sub) || {};
  const roleStr = String(me.role||'').toLowerCase();
  const isAdmin = (roleStr==='admin' || roleStr==='superadmin');
  const isMaker = t.assignee === (me.name||'');
  if(!(isAdmin || isMaker)) return res.status(403).json({ error: 'forbidden' });
  // If submitted and not reopened, maker cannot delete attachments
  if(!isAdmin && t.submitted_at && !t.edit_unlocked){ return res.status(403).json({ error: 'locked_submitted' }); }
  try{
    const p = path.join(UPLOAD_DIR, a.stored_name);
    try{ if(fs.existsSync(p)) fs.unlinkSync(p); }catch(_e){}
    db.prepare('DELETE FROM attachments WHERE id = ?').run(attId);
    // note
    db.prepare('INSERT INTO notes (task_id, text, created_at) VALUES (?, ?, ?)')
      .run(t.id, `Attachment deleted: ${a.file_name} by ${me.name||''}`, new Date().toISOString());
    res.json({ ok: true });
  }catch(e){ res.status(500).json({ error: 'delete_failed' }); }
});

// Serve static frontend
app.use('/', express.static(path.join(__dirname, '..')));

app.listen(PORT, () => {
  console.log(`ProCompliance server listening on http://localhost:${PORT}`);
});

function getTaskWithJoins(id){
  return db.prepare(`SELECT t.*, c.name AS category, co.name AS company FROM tasks t
                     LEFT JOIN categories c ON c.id=t.category_id
                     LEFT JOIN companies co ON co.id=t.company_id
                     WHERE t.id = ?`).get(Number(id));
}
async function sendAssignmentNotification(task){
  if(!mailer || !task) return false;
  const maker = db.prepare('SELECT email,name FROM users WHERE name = ?').get(task.assignee||'');
  const assigner = db.prepare('SELECT email,name FROM users WHERE name = ?').get(task.assigned_by||'');
  let to = maker && maker.email;
  if(!to && assigner && assigner.email) to = assigner.email; // fallback so someone is notified
  const name = (maker && maker.name) || task.assignee || (assigner && assigner.name) || '';
  if(!to) return false;
  const salutation = `Hi ${name},`;
  const intro = 'You have been assigned a new compliance. Please review the details below.';
  const html = `<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;\">\n    <p>${htmlEscape(salutation)}</p>\n    <p>${htmlEscape(intro)}</p>\n    <p>Visit <a href=\"${APP_URL}/#/edit/${task.id}\">ProCompliance</a> to view this compliance.</p>\n    ${buildTasksTable([task])}\n  </div>`;
  const text = `Hi ${name},\n\nYou have been assigned a new compliance. Please review the details below.\n\nTitle: ${task.title}\nLocation / Site: ${task.company||''}\nCategory: ${task.category||''}\nMaker: ${task.assignee||''}\nChecker: ${task.checker||''}\nDue: ${task.due_date||'NA'}\nStatus: ${task.status}\n\nVisit ${APP_URL}/#/edit/${task.id} to view this compliance.`;
  const subject = `[Assigned] ${task.title}`;
  try{
    console.log('[email] sendAssignmentNotification attempt', { to, taskId: task.id, assignee: task.assignee });
    const info = await mailer.sendMail({ from:{ name:'ProCompliance', address: SMTP_FROM }, to, subject, html, text });
    const ok = !!(info && (info.accepted||[]).length);
    console.log('[email] sendAssignmentNotification result', { to, ok, messageId: info && info.messageId, accepted: info && info.accepted, rejected: info && info.rejected, response: info && info.response });
    return ok;
  }catch(e){ console.error('[email] sendAssignmentNotification error', e); return false; }
}
async function sendReopenForEditsNotification(task, actorName){
  if(!mailer || !task) return false;
  const maker = db.prepare('SELECT email,name FROM users WHERE name = ?').get(task.assignee||'');
  const to = maker && maker.email;
  if(!to) return false;
  const name = (maker && maker.name) || task.assignee || '';
  const salutation = `Hi ${name},`;
  const intro = `${actorName||'An admin'} has reopened the compliance for edits. Please make the required changes.`;
  const html = `<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;\">\n    <p>${htmlEscape(salutation)}</p>\n    <p>${htmlEscape(intro)}</p>\n    <p>Visit <a href=\"${APP_URL}/#/edit/${task.id}\">ProCompliance</a> to view this compliance.</p>\n    ${buildTasksTable([task])}\n  </div>`;
  const text = `Hi ${name},\n\n${actorName||'An admin'} has reopened the compliance for edits. Please make the required changes.\n\nTitle: ${task.title}\nLocation / Site: ${task.company||''}\nCategory: ${task.category||''}\nMaker: ${task.assignee||''}\nChecker: ${task.checker||''}\nDue: ${task.due_date||'NA'}\nStatus: ${task.status}\n\nVisit ${APP_URL}/#/edit/${task.id} to edit this compliance.`;
  const subject = `[Reopened for Edits] ${task.title}`;
  try{ const info = await mailer.sendMail({ from:{ name:'ProCompliance', address: SMTP_FROM }, to, subject, html, text }); return !!(info && (info.accepted||[]).length); }catch(_e){ return false; }
}
async function sendSubmissionNotification(task){
  if(!mailer || !task) return false;
  const u = db.prepare('SELECT email,name FROM users WHERE name = ?').get(task.checker||'');
  const to = u && u.email; const name = (u && u.name) || task.checker || '';
  if(!to) return false;
  const salutation = `Hi ${name},`;
  const intro = 'A compliance has been submitted for your review.';
  const html = `<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;\">\n    <p>${htmlEscape(salutation)}</p>\n    <p>${htmlEscape(intro)}</p>\n    <p>Visit <a href=\"${APP_URL}/#/edit/${task.id}\">ProCompliance</a> to view this compliance.</p>\n    ${buildTasksTable([task])}\n  </div>`;
  const subject = `[Action Required] ${task.title} submitted for review`;
  try{ const info = await mailer.sendMail({ from:{ name:'ProCompliance', address: SMTP_FROM }, to, subject, html }); return !!(info && (info.accepted||[]).length); }catch(_e){ return false; }
}

async function sendEditRequestNotification(task, requesterName){
  if(!mailer || !task) return false;
  const superAdmins = db.prepare("SELECT email,name FROM users WHERE role='superadmin'").all();
  const catAdmins = (task.category_id!=null)
    ? db.prepare(`SELECT u.email,u.name FROM users u JOIN user_categories uc ON uc.user_id = u.id WHERE u.role='admin' AND uc.category_id = ?`).all(Number(task.category_id))
    : [];
  const checkerUser = task.checker ? db.prepare('SELECT email,name FROM users WHERE name = ?').get(task.checker) : null;
  const toList = ([]).concat((superAdmins||[])).concat((catAdmins||[])).map(a=>a && a.email).filter(Boolean);
  let to = toList.join(',');
  const cc = checkerUser && checkerUser.email ? checkerUser.email : '';
  if(!to && cc){ to = cc; }
  if(!to) return false;
  const subject = `[Edit Request] ${task.title}`;
  const html = `<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;\">\n    <p>${htmlEscape('Hi,')}</p>\n    <p>${htmlEscape(requesterName||'Maker')} has requested to edit the following compliance:</p>\n    <p>Visit <a href=\"${APP_URL}/#/edit/${task.id}\">ProCompliance</a> to view this compliance.</p>\n    ${buildTasksTable([task])}\n    <p style=\"margin-top:16px;\">You can reopen it as pending to allow edits.</p>\n  </div>`;
  try{ const info = await mailer.sendMail({ from:{ name:'ProCompliance', address: SMTP_FROM }, to, cc: cc && to? cc: undefined, subject, html }); return !!(info && (info.accepted||[]).length); }catch(_e){ return false; }
}

app.post('/api/auth/forgot', passwordLimiter, (req, res) => {
  const { email } = req.body || {};
  console.log('[auth/forgot] request received', { email });
  if(!email) { console.warn('[auth/forgot] missing email'); return res.status(400).json({ error: 'email_required' }); }
  const u = getUser.get(String(email).trim());
  if(!u){ console.log('[auth/forgot] no user for email; returning ok'); return res.json({ ok: true }); }
  const token = uuidv4();
  const expires = new Date(Date.now() + 60*60*1000).toISOString();
  try{
    db.prepare('UPDATE users SET reset_token=?, reset_expires=? WHERE id=?').run(token, expires, u.id);
    console.log('[auth/forgot] token stored', { userId: u.id, expires });
  }catch(e){ console.error('[auth/forgot] failed to store token', e); return res.status(500).json({ error: 'db_error' }); }
  if(!mailer){ console.warn('[auth/forgot] mailer not configured; skipping email'); return res.json({ ok: true, mailed: false }); }
  const resetUrl = `${APP_URL}/#/reset/${encodeURIComponent(token)}`;
  const subject = 'Password Reset - ProCompliance';
  const text = `Hi ${u.name},\n\nWe received a request to reset your password.\n\nReset link (valid for 1 hour): ${resetUrl}\n\nIf you did not request this, you can ignore this email.`;
  mailer.sendMail({ from:{ name: 'ProCompliance', address: SMTP_FROM }, to: u.email, subject, text })
    .then(info => { console.log('[auth/forgot] reset email sent', { to: u.email, messageId: info && info.messageId }); res.json({ ok: true, mailed: true }); })
    .catch(e => { console.error('[auth/forgot] sendMail error', e); res.json({ ok: true, mailed: false }); });
});

app.post('/api/auth/reset', passwordLimiter, (req, res) => {
  const { token, password } = req.body || {};
  console.log('[auth/reset] request received', { tokenPresent: !!token });
  if(!token || !password) { console.warn('[auth/reset] missing fields'); return res.status(400).json({ error: 'missing_fields' }); }
  const row = db.prepare('SELECT id, reset_token, reset_expires FROM users WHERE reset_token = ?').get(String(token));
  if(!row){ console.warn('[auth/reset] invalid token'); return res.status(400).json({ error: 'invalid_token' }); }
  const exp = new Date(row.reset_expires || 0).getTime();
  if(!(exp && exp > Date.now())){ console.warn('[auth/reset] expired token', { userId: row.id }); return res.status(400).json({ error: 'expired' }); }
  try{
    const hash = bcrypt.hashSync(String(password), 10);
    db.prepare('UPDATE users SET password_hash=?, reset_token=NULL, reset_expires=NULL WHERE id=?').run(hash, row.id);
    console.log('[auth/reset] password updated', { userId: row.id });
    res.json({ ok: true });
  }catch(e){ console.error('[auth/reset] update failed', e); return res.status(500).json({ error: 'db_error' }); }
});
