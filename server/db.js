const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'data', 'krrc.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    is_approved INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    subject TEXT,
    author TEXT,
    publication_place TEXT,
    publisher TEXT,
    language TEXT DEFAULT 'English',
    year TEXT,
    edition TEXT,
    doc_type TEXT DEFAULT 'book',
    description TEXT,
    tags TEXT DEFAULT '[]',
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    page_count INTEGER DEFAULT 0,
    extracted_text TEXT,
    text_indexed INTEGER DEFAULT 0,
    is_approved INTEGER DEFAULT 0,
    is_public INTEGER DEFAULT 1,
    uploaded_by TEXT,
    upload_ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS document_metadata (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    parent_id TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS document_categories (
    document_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    PRIMARY KEY (document_id, category_id),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    session_token TEXT UNIQUE NOT NULL,
    user_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS search_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    results_count INTEGER DEFAULT 0,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tutorials (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    screenshot_path TEXT,
    content TEXT,
    section TEXT DEFAULT 'frontend',
    sort_order INTEGER DEFAULT 0,
    is_published INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS perspectives (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    color TEXT DEFAULT '#c9a96e',
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS document_perspectives (
    document_id TEXT NOT NULL,
    perspective_id TEXT NOT NULL,
    PRIMARY KEY (document_id, perspective_id),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (perspective_id) REFERENCES perspectives(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS policies (
    id TEXT PRIMARY KEY,
    perspective_id TEXT,
    title TEXT NOT NULL,
    content TEXT,
    section TEXT DEFAULT 'aims',
    sort_order INTEGER DEFAULT 0,
    is_published INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (perspective_id) REFERENCES perspectives(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS seo_keywords (
    id TEXT PRIMARY KEY,
    keyword TEXT NOT NULL,
    description TEXT,
    priority INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page TEXT NOT NULL,
    path TEXT,
    referrer TEXT,
    user_agent TEXT,
    ip_address TEXT,
    country TEXT,
    session_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS visitor_sessions (
    id TEXT PRIMARY KEY,
    ip_address TEXT,
    user_agent TEXT,
    first_visit DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_visit DATETIME DEFAULT CURRENT_TIMESTAMP,
    page_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS delete_requests (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    comment TEXT,
    status TEXT DEFAULT 'pending',
    reviewed_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (requested_by) REFERENCES users(id),
    FOREIGN KEY (reviewed_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS access_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    label TEXT,
    description TEXT
  );
`);

// Create FTS5 virtual table for full-text search
try {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    title, author, subject, description, extracted_text, tags,
    content=documents, content_rowid=rowid
  )`);
} catch (e) { /* FTS5 already exists */ }

// Seed admin user
const adminExists = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@krrc.local');
if (!adminExists) {
  const hash = bcrypt.hashSync('KRRCAdmin2026!', 10);
  db.prepare('INSERT INTO users (id, email, password, name, role, is_approved) VALUES (?, ?, ?, ?, ?, ?)').run(
    uuid(), 'admin@krrc.local', hash, 'Admin', 'admin', 1
  );
  console.log('Seeded admin user: admin@krrc.local / KRRCAdmin2026!');
}

// Seed default categories for Kashmir
const catCount = db.prepare('SELECT COUNT(*) as cnt FROM categories').get();
if (catCount.cnt === 0) {
  const insertCat = db.prepare('INSERT INTO categories (id, name, description, sort_order) VALUES (?, ?, ?, ?)');
  const cats = [
    ['Books', 'Published books on Kashmir', 1],
    ['Research Articles', 'Academic and scholarly research articles', 2],
    ['Think Tank Reports', 'Reports by think tanks and policy institutes', 3],
    ['HR Organisation Reports', 'Reports by human rights organisations', 4],
    ['Government Reports', 'Official government documents and reports', 5],
    ['Fact-Finding Mission Documents', 'Reports from fact-finding missions and investigations', 6],
    ['Political Pamphlets', 'Political pamphlets, leaflets, and manifestos', 7],
    ['Magazines', 'Magazine issues, periodicals, and journals', 8],
    ['Archival Data', 'Historical archival materials, records, and primary sources', 9],
  ];
  cats.forEach(([name, desc, order]) => insertCat.run(uuid(), name, desc, order));
  console.log('Seeded 9 default categories');
}

// Seed default perspectives
const perspCount = db.prepare('SELECT COUNT(*) as cnt FROM perspectives').get();
if (perspCount.cnt === 0) {
  const insertPersp = db.prepare('INSERT INTO perspectives (id, name, slug, description, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  const persps = [
    ['Indian Perspective', 'indian', 'Documents presenting the Indian government and institutional viewpoint on Kashmir', '#FF9933', 1],
    ['Pakistani Perspective', 'pakistani', 'Documents presenting the Pakistani government and institutional viewpoint on Kashmir', '#01411C', 2],
    ['Kashmiri Perspective', 'kashmiri', 'Documents presenting the Kashmiri people\'s own viewpoint and narrative', '#c9a96e', 3],
    ['International Perspective', 'international', 'Documents from international organisations, UN bodies, and foreign governments', '#4A90D9', 4],
  ];
  persps.forEach(([name, slug, desc, color, order]) => insertPersp.run(uuid(), name, slug, desc, color, order));
  console.log('Seeded 4 default perspectives');
}

// Seed default access settings
const accessCount = db.prepare('SELECT COUNT(*) as cnt FROM access_settings').get();
if (accessCount.cnt === 0) {
  const insertAccess = db.prepare('INSERT INTO access_settings (key, value, label, description) VALUES (?, ?, ?, ?)');
  const settings = [
    ['chatbot_access', 'public', 'Chatbot (KRRC Ai)', 'Control who can use the AI chatbot'],
    ['browse_access', 'public', 'Browse Page', 'Control who can view the archive overview'],
    ['upload_access', 'public', 'Upload Page', 'Control who can upload documents'],
    ['policy_access', 'public', 'Policy Page', 'Control who can view policies and perspectives'],
    ['tutorial_access', 'public', 'Tutorial Page', 'Control who can view tutorials'],
    ['document_detail_access', 'public', 'Document Details', 'Control who can view individual document pages'],
  ];
  settings.forEach(([key, value, label, desc]) => insertAccess.run(key, value, label, desc));
  console.log('Seeded 6 default access settings (all public)');
}

module.exports = db;
