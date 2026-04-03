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
    ['History', 'Historical documents and books about Kashmir', 1],
    ['Politics', 'Political documents, agreements, and analysis', 2],
    ['Culture', 'Kashmiri culture, traditions, and heritage', 3],
    ['Literature', 'Kashmiri literature, poetry, and prose', 4],
    ['Language', 'Kashmiri language studies and linguistics', 5],
    ['Religion', 'Religious texts and studies', 6],
    ['Geography', 'Maps, geographical studies, and travelogues', 7],
    ['Law', 'Legal documents, treaties, and constitutional matters', 8],
    ['Economy', 'Economic studies and reports', 9],
    ['Art & Architecture', 'Kashmiri art, crafts, and architectural heritage', 10],
    ['Education', 'Educational materials and academic research', 11],
    ['Human Rights', 'Human rights reports and documentation', 12],
    ['Manuscripts', 'Historical manuscripts and rare texts', 13],
    ['Photographs', 'Historical and contemporary photographs', 14],
    ['Audio & Film', 'Audio recordings and film archives', 15],
  ];
  cats.forEach(([name, desc, order]) => insertCat.run(uuid(), name, desc, order));
  console.log('Seeded 15 default categories');
}

module.exports = db;
