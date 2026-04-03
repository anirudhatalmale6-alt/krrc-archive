const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3006;
const JWT_SECRET = process.env.JWT_SECRET || 'krrc-secret-2026';
const BASE = process.env.BASE_PATH || '/krrc';
const AI_API_KEY = process.env.AI_API_KEY || '';

// Security
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '1mb' }));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, message: { error: 'Too many requests' }, validate: { xForwardedForHeader: false } });
const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: { error: 'Too many uploads, try again later' }, validate: { xForwardedForHeader: false } });

app.use(BASE + '/api', apiLimiter);

// Static files
app.use(BASE, express.static(path.join(__dirname, '../public')));

// Upload storage
const uploadsDir = path.join(__dirname, '../public/uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuid() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  }
});

// Auth middleware
function authenticateToken(req, res, next) {
  const auth = req.headers['authorization'];
  const token = auth && auth.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ===== AUTH =====
app.post(BASE + '/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.is_approved) return res.status(403).json({ error: 'Account pending approval' });
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

app.post(BASE + '/api/auth/register', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'All fields required' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(400).json({ error: 'Email already registered' });
  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, email, password, name) VALUES (?, ?, ?, ?)').run(id, email, hash, name);
  res.json({ success: true, message: 'Registration submitted. Awaiting admin approval.' });
});

// ===== PDF UPLOAD & TEXT EXTRACTION =====
app.post(BASE + '/api/documents/upload', uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });

  const { title, author, subject, publication_place, publisher, language, year, edition, doc_type, description } = req.body;
  const id = uuid();

  // Extract text from PDF
  let extractedText = '';
  let pageCount = 0;
  try {
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(req.file.path);
    const pdfData = await pdfParse(dataBuffer);
    extractedText = pdfData.text || '';
    pageCount = pdfData.numpages || 0;
  } catch (err) {
    console.error('[PDF] Text extraction error:', err.message);
  }

  db.prepare(`INSERT INTO documents (id, title, subject, author, publication_place, publisher, language, year, edition, doc_type, description, filename, original_name, file_size, page_count, extracted_text, text_indexed, uploaded_by, upload_ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, title || req.file.originalname, subject || '', author || '', publication_place || '', publisher || '',
    language || 'English', year || '', edition || '', doc_type || 'book', description || '',
    req.file.filename, req.file.originalname, req.file.size, pageCount,
    extractedText, extractedText ? 1 : 0,
    req.body.uploaded_by_id || null, req.ip
  );

  // Update FTS index
  if (extractedText) {
    try {
      const doc = db.prepare('SELECT rowid, title, author, subject, description, extracted_text, tags FROM documents WHERE id = ?').get(id);
      if (doc) {
        db.prepare('INSERT INTO documents_fts(rowid, title, author, subject, description, extracted_text, tags) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          doc.rowid, doc.title, doc.author, doc.subject, doc.description, doc.extracted_text, doc.tags
        );
      }
    } catch (e) { console.error('[FTS] Index error:', e.message); }
  }

  res.json({ id, title: title || req.file.originalname, pages: pageCount, text_extracted: !!extractedText, file_size: req.file.size });
});

// ===== DOCUMENT ROUTES =====
// List documents (public - approved only)
app.get(BASE + '/api/documents', (req, res) => {
  const { page = 1, limit = 20, category, language, year, type, sort = 'newest' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = 'WHERE d.is_approved = 1 AND d.is_public = 1';
  const params = [];

  if (category) { where += ' AND dc.category_id = ?'; params.push(category); }
  if (language) { where += ' AND d.language = ?'; params.push(language); }
  if (year) { where += ' AND d.year = ?'; params.push(year); }
  if (type) { where += ' AND d.doc_type = ?'; params.push(type); }

  const orderBy = sort === 'oldest' ? 'ORDER BY d.year ASC, d.created_at ASC' :
                   sort === 'title' ? 'ORDER BY d.title ASC' :
                   sort === 'author' ? 'ORDER BY d.author ASC' :
                   'ORDER BY d.created_at DESC';

  const joinCat = category ? 'LEFT JOIN document_categories dc ON dc.document_id = d.id' : '';
  const countSql = `SELECT COUNT(DISTINCT d.id) as total FROM documents d ${joinCat} ${where}`;
  const total = db.prepare(countSql).get(...params).total;

  const sql = `SELECT DISTINCT d.id, d.title, d.author, d.subject, d.language, d.year, d.edition, d.doc_type, d.page_count, d.description, d.publication_place, d.publisher, d.created_at
    FROM documents d ${joinCat} ${where} ${orderBy} LIMIT ? OFFSET ?`;
  const docs = db.prepare(sql).all(...params, parseInt(limit), offset);

  res.json({ documents: docs, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
});

// Search documents
app.get(BASE + '/api/documents/search', (req, res) => {
  const { q, page = 1, limit = 20 } = req.query;
  if (!q) return res.status(400).json({ error: 'Search query required' });
  const offset = (parseInt(page) - 1) * parseInt(limit);

  // Log search
  db.prepare('INSERT INTO search_logs (query, ip_address) VALUES (?, ?)').run(q, req.ip);

  try {
    const sql = `SELECT d.id, d.title, d.author, d.subject, d.language, d.year, d.edition, d.doc_type, d.page_count, d.description, d.publication_place, d.publisher, d.created_at,
      snippet(documents_fts, 4, '<mark>', '</mark>', '...', 40) as snippet
      FROM documents_fts fts
      JOIN documents d ON d.rowid = fts.rowid
      WHERE documents_fts MATCH ? AND d.is_approved = 1 AND d.is_public = 1
      ORDER BY rank LIMIT ? OFFSET ?`;
    const docs = db.prepare(sql).all(q, parseInt(limit), offset);

    const countSql = `SELECT COUNT(*) as total FROM documents_fts fts JOIN documents d ON d.rowid = fts.rowid WHERE documents_fts MATCH ? AND d.is_approved = 1`;
    const total = db.prepare(countSql).get(q).total;

    db.prepare('UPDATE search_logs SET results_count = ? WHERE id = (SELECT MAX(id) FROM search_logs WHERE query = ?)').run(total, q);

    res.json({ documents: docs, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)), query: q });
  } catch (err) {
    // Fallback to LIKE search if FTS fails
    const likeSql = `SELECT id, title, author, subject, language, year, edition, doc_type, page_count, description, publication_place, publisher, created_at
      FROM documents WHERE is_approved = 1 AND is_public = 1 AND (title LIKE ? OR author LIKE ? OR subject LIKE ? OR description LIKE ? OR extracted_text LIKE ?)
      ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const likeQ = `%${q}%`;
    const docs = db.prepare(likeSql).all(likeQ, likeQ, likeQ, likeQ, likeQ, parseInt(limit), offset);
    res.json({ documents: docs, total: docs.length, page: parseInt(page), pages: 1, query: q });
  }
});

// Get single document (public metadata only - no download)
app.get(BASE + '/api/documents/:id', (req, res) => {
  const doc = db.prepare(`SELECT id, title, author, subject, language, year, edition, doc_type, page_count, description,
    publication_place, publisher, tags, created_at FROM documents WHERE id = ? AND is_approved = 1 AND is_public = 1`).get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  // Get categories
  const categories = db.prepare('SELECT c.id, c.name FROM categories c JOIN document_categories dc ON dc.category_id = c.id WHERE dc.document_id = ?').all(req.params.id);
  res.json({ ...doc, categories, tags: JSON.parse(doc.tags || '[]') });
});

// Get document text excerpt (for reference, not full download)
app.get(BASE + '/api/documents/:id/excerpt', (req, res) => {
  const doc = db.prepare('SELECT extracted_text, title FROM documents WHERE id = ? AND is_approved = 1 AND is_public = 1').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  // Return only first 2000 chars as reference excerpt
  const excerpt = (doc.extracted_text || '').substring(0, 2000);
  res.json({ title: doc.title, excerpt, has_more: (doc.extracted_text || '').length > 2000 });
});

// ===== ADMIN ROUTES =====
// List all documents (admin)
app.get(BASE + '/api/admin/documents', authenticateToken, requireAdmin, (req, res) => {
  const docs = db.prepare(`SELECT d.*, u.name as uploader_name FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by ORDER BY d.created_at DESC`).all();
  res.json(docs.map(d => ({ ...d, extracted_text: undefined, tags: JSON.parse(d.tags || '[]') })));
});

// Approve document
app.post(BASE + '/api/admin/documents/:id/approve', authenticateToken, requireAdmin, (req, res) => {
  db.prepare('UPDATE documents SET is_approved = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Reject/delete document
app.delete(BASE + '/api/admin/documents/:id', authenticateToken, requireAdmin, (req, res) => {
  const doc = db.prepare('SELECT filename FROM documents WHERE id = ?').get(req.params.id);
  if (doc) {
    const filePath = path.join(uploadsDir, doc.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  db.prepare('DELETE FROM document_categories WHERE document_id = ?').run(req.params.id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Update document metadata
app.patch(BASE + '/api/admin/documents/:id', authenticateToken, requireAdmin, (req, res) => {
  const { title, author, subject, publication_place, publisher, language, year, edition, doc_type, description, tags, is_public, categories } = req.body;
  const updates = [];
  const params = [];
  if (title !== undefined) { updates.push('title = ?'); params.push(title); }
  if (author !== undefined) { updates.push('author = ?'); params.push(author); }
  if (subject !== undefined) { updates.push('subject = ?'); params.push(subject); }
  if (publication_place !== undefined) { updates.push('publication_place = ?'); params.push(publication_place); }
  if (publisher !== undefined) { updates.push('publisher = ?'); params.push(publisher); }
  if (language !== undefined) { updates.push('language = ?'); params.push(language); }
  if (year !== undefined) { updates.push('year = ?'); params.push(year); }
  if (edition !== undefined) { updates.push('edition = ?'); params.push(edition); }
  if (doc_type !== undefined) { updates.push('doc_type = ?'); params.push(doc_type); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (tags !== undefined) { updates.push('tags = ?'); params.push(JSON.stringify(tags)); }
  if (is_public !== undefined) { updates.push('is_public = ?'); params.push(is_public ? 1 : 0); }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.params.id);
    db.prepare(`UPDATE documents SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  // Update categories
  if (categories !== undefined) {
    db.prepare('DELETE FROM document_categories WHERE document_id = ?').run(req.params.id);
    const insertCat = db.prepare('INSERT INTO document_categories (document_id, category_id) VALUES (?, ?)');
    categories.forEach(catId => insertCat.run(req.params.id, catId));
  }

  res.json({ success: true });
});

// Admin users
app.get(BASE + '/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, email, name, role, is_approved, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

app.post(BASE + '/api/admin/users/:id/approve', authenticateToken, requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET is_approved = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.delete(BASE + '/api/admin/users/:id', authenticateToken, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ? AND role != ?').run(req.params.id, 'admin');
  res.json({ success: true });
});

// Admin stats
app.get(BASE + '/api/admin/stats', authenticateToken, requireAdmin, (req, res) => {
  const totalDocs = db.prepare('SELECT COUNT(*) as cnt FROM documents').get().cnt;
  const approvedDocs = db.prepare("SELECT COUNT(*) as cnt FROM documents WHERE is_approved = 1").get().cnt;
  const pendingDocs = db.prepare("SELECT COUNT(*) as cnt FROM documents WHERE is_approved = 0").get().cnt;
  const totalUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  const pendingUsers = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE is_approved = 0").get().cnt;
  const totalSearches = db.prepare('SELECT COUNT(*) as cnt FROM search_logs').get().cnt;
  const languages = db.prepare('SELECT language, COUNT(*) as cnt FROM documents WHERE is_approved = 1 GROUP BY language ORDER BY cnt DESC').all();
  const docTypes = db.prepare('SELECT doc_type, COUNT(*) as cnt FROM documents WHERE is_approved = 1 GROUP BY doc_type ORDER BY cnt DESC').all();
  const recentSearches = db.prepare('SELECT query, results_count, created_at FROM search_logs ORDER BY created_at DESC LIMIT 20').all();
  res.json({ totalDocs, approvedDocs, pendingDocs, totalUsers, pendingUsers, totalSearches, languages, docTypes, recentSearches });
});

// ===== FTP IMPORT =====
const ftpDir = path.join(__dirname, '../ftp-uploads');
fs.mkdirSync(ftpDir, { recursive: true });

app.get(BASE + '/api/admin/ftp-files', authenticateToken, requireAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(ftpDir)
      .filter(f => f.toLowerCase().endsWith('.pdf'))
      .map(f => {
        const stat = fs.statSync(path.join(ftpDir, f));
        const alreadyImported = db.prepare('SELECT id FROM documents WHERE original_name = ?').get(f);
        return { name: f, size: stat.size, modified: stat.mtime, imported: !!alreadyImported };
      })
      .sort((a, b) => b.modified - a.modified);
    res.json(files);
  } catch (e) { res.json([]); }
});

app.post(BASE + '/api/admin/ftp-import', authenticateToken, requireAdmin, async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename required' });

  const srcPath = path.join(ftpDir, filename);
  if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'File not found in FTP folder' });

  // Check if already imported
  const existing = db.prepare('SELECT id FROM documents WHERE original_name = ?').get(filename);
  if (existing) return res.status(400).json({ error: 'File already imported' });

  // Copy to uploads dir
  const newFilename = uuid() + '.pdf';
  const destPath = path.join(uploadsDir, newFilename);
  fs.copyFileSync(srcPath, destPath);
  const stat = fs.statSync(destPath);

  // Extract text
  let extractedText = '';
  let pageCount = 0;
  try {
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(destPath);
    const pdfData = await pdfParse(dataBuffer);
    extractedText = pdfData.text || '';
    pageCount = pdfData.numpages || 0;
  } catch (err) {
    console.error('[FTP Import] PDF parse error:', err.message);
  }

  const id = uuid();
  const title = filename.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');

  db.prepare(`INSERT INTO documents (id, title, subject, author, publication_place, publisher, language, year, edition, doc_type, description, filename, original_name, file_size, page_count, extracted_text, text_indexed, is_approved, uploaded_by)
    VALUES (?, ?, '', '', '', '', 'English', '', '', 'book', '', ?, ?, ?, ?, ?, ?, 0, ?)`).run(
    id, title, newFilename, filename, stat.size, pageCount, extractedText, extractedText ? 1 : 0, req.user.id
  );

  // Update FTS index
  if (extractedText) {
    try {
      const doc = db.prepare('SELECT rowid, title, author, subject, description, extracted_text, tags FROM documents WHERE id = ?').get(id);
      if (doc) {
        db.prepare('INSERT INTO documents_fts(rowid, title, author, subject, description, extracted_text, tags) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          doc.rowid, doc.title, doc.author, doc.subject, doc.description, doc.extracted_text, doc.tags
        );
      }
    } catch (e) { console.error('[FTS] Index error:', e.message); }
  }

  res.json({ id, title, pages: pageCount, text_extracted: !!extractedText, file_size: stat.size });
});

app.post(BASE + '/api/admin/ftp-import-all', authenticateToken, requireAdmin, async (req, res) => {
  const files = fs.readdirSync(ftpDir).filter(f => f.toLowerCase().endsWith('.pdf'));
  const results = [];

  for (const filename of files) {
    const existing = db.prepare('SELECT id FROM documents WHERE original_name = ?').get(filename);
    if (existing) { results.push({ filename, status: 'skipped', reason: 'already imported' }); continue; }

    const srcPath = path.join(ftpDir, filename);
    const newFilename = uuid() + '.pdf';
    const destPath = path.join(uploadsDir, newFilename);
    fs.copyFileSync(srcPath, destPath);
    const stat = fs.statSync(destPath);

    let extractedText = '';
    let pageCount = 0;
    try {
      const pdfParse = require('pdf-parse');
      const dataBuffer = fs.readFileSync(destPath);
      const pdfData = await pdfParse(dataBuffer);
      extractedText = pdfData.text || '';
      pageCount = pdfData.numpages || 0;
    } catch (err) {
      console.error('[FTP Import] PDF parse error for ' + filename + ':', err.message);
    }

    const id = uuid();
    const title = filename.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');

    db.prepare(`INSERT INTO documents (id, title, subject, author, publication_place, publisher, language, year, edition, doc_type, description, filename, original_name, file_size, page_count, extracted_text, text_indexed, is_approved, uploaded_by)
      VALUES (?, ?, '', '', '', '', 'English', '', '', 'book', '', ?, ?, ?, ?, ?, ?, 0, ?)`).run(
      id, title, newFilename, filename, stat.size, pageCount, extractedText, extractedText ? 1 : 0, req.user.id
    );

    if (extractedText) {
      try {
        const doc = db.prepare('SELECT rowid, title, author, subject, description, extracted_text, tags FROM documents WHERE id = ?').get(id);
        if (doc) {
          db.prepare('INSERT INTO documents_fts(rowid, title, author, subject, description, extracted_text, tags) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            doc.rowid, doc.title, doc.author, doc.subject, doc.description, doc.extracted_text, doc.tags
          );
        }
      } catch (e) { /* ignore */ }
    }

    results.push({ filename, status: 'imported', id, pages: pageCount, text_extracted: !!extractedText });
  }

  res.json({ total: files.length, imported: results.filter(r => r.status === 'imported').length, skipped: results.filter(r => r.status === 'skipped').length, results });
});

// Categories CRUD
app.get(BASE + '/api/categories', (req, res) => {
  const cats = db.prepare('SELECT c.*, (SELECT COUNT(*) FROM document_categories dc JOIN documents d ON d.id = dc.document_id WHERE dc.category_id = c.id AND d.is_approved = 1) as doc_count FROM categories c ORDER BY c.sort_order').all();
  res.json(cats);
});

app.post(BASE + '/api/admin/categories', authenticateToken, requireAdmin, (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = uuid();
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM categories').get().m || 0;
  db.prepare('INSERT INTO categories (id, name, description, sort_order) VALUES (?, ?, ?, ?)').run(id, name, description || '', maxOrder + 1);
  res.json({ id, name });
});

app.delete(BASE + '/api/admin/categories/:id', authenticateToken, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM document_categories WHERE category_id = ?').run(req.params.id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ===== AI CHATBOT =====
app.post(BASE + '/api/chat', async (req, res) => {
  if (!AI_API_KEY) return res.status(500).json({ error: 'AI not configured' });
  const { message, sessionId } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  // Get or create session
  let session;
  if (sessionId) {
    session = db.prepare('SELECT * FROM chat_sessions WHERE session_token = ?').get(sessionId);
  }
  if (!session) {
    const newId = uuid();
    const token = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO chat_sessions (id, session_token) VALUES (?, ?)').run(newId, token);
    session = { id: newId, session_token: token };
  }

  // Save user message
  db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)').run(session.id, 'user', message);

  // Search archive for relevant content
  let contextDocs = '';
  try {
    const searchResults = db.prepare(`SELECT d.title, d.author, d.year, d.language, d.subject,
      snippet(documents_fts, 4, '', '', '...', 60) as snippet
      FROM documents_fts fts JOIN documents d ON d.rowid = fts.rowid
      WHERE documents_fts MATCH ? AND d.is_approved = 1 LIMIT 5`).all(message.split(' ').filter(w => w.length > 2).join(' OR '));
    if (searchResults.length > 0) {
      contextDocs = '\n\nRelevant documents from the KRRC archive:\n' +
        searchResults.map(d => `- "${d.title}" by ${d.author || 'Unknown'} (${d.year || 'N/A'}, ${d.language}) - ${d.snippet || d.subject || ''}`).join('\n');
    }
  } catch (e) { /* search failed, continue without context */ }

  // Get conversation history
  const history = db.prepare('SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 10').all(session.id).reverse();

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': AI_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: `You are the KRRC (Kashmir Research and Resource Center) AI assistant. You help users explore the digital archive of Kashmir-related books, research articles, and documents. You answer questions about Kashmir's history, culture, politics, geography, literature, and more, drawing from the archive when possible. Be helpful, scholarly, and accurate. If you reference archive documents, mention their titles and authors. If you don't know something, say so. Always be respectful of all perspectives on Kashmir.${contextDocs}`,
        messages: history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
      })
    });
    const data = await response.json();
    const reply = data.content?.[0]?.text || 'I apologize, I could not generate a response.';

    // Save assistant reply
    db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)').run(session.id, 'assistant', reply);

    res.json({ reply, sessionId: session.session_token });
  } catch (err) {
    console.error('[AI Chat] Error:', err);
    res.json({ reply: 'Sorry, I encountered an error. Please try again.', sessionId: session.session_token });
  }
});

// ===== AI SEARCH (semantic) =====
app.post(BASE + '/api/ai-search', async (req, res) => {
  if (!AI_API_KEY) return res.status(500).json({ error: 'AI not configured' });
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Query required' });

  // First do FTS search
  let docs = [];
  try {
    docs = db.prepare(`SELECT d.id, d.title, d.author, d.year, d.language, d.subject, d.description, d.page_count,
      substr(d.extracted_text, 1, 500) as excerpt
      FROM documents_fts fts JOIN documents d ON d.rowid = fts.rowid
      WHERE documents_fts MATCH ? AND d.is_approved = 1 LIMIT 10`).all(query.split(' ').filter(w => w.length > 2).join(' OR '));
  } catch (e) {
    docs = db.prepare(`SELECT id, title, author, year, language, subject, description, page_count,
      substr(extracted_text, 1, 500) as excerpt
      FROM documents WHERE is_approved = 1 AND (title LIKE ? OR author LIKE ? OR extracted_text LIKE ?) LIMIT 10`).all(`%${query}%`, `%${query}%`, `%${query}%`);
  }

  if (docs.length === 0) return res.json({ answer: 'No documents found matching your query.', documents: [] });

  // Ask AI to synthesize
  try {
    const context = docs.map(d => `Title: "${d.title}" | Author: ${d.author || 'Unknown'} | Year: ${d.year || 'N/A'} | Language: ${d.language} | Subject: ${d.subject || ''}\nExcerpt: ${d.excerpt || d.description || 'No excerpt'}`).join('\n\n');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': AI_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: 'You are a research assistant for KRRC (Kashmir Research and Resource Center). Given search results from the archive, provide a brief, helpful summary answering the user\'s query. Reference specific documents by title and author when relevant. Be concise.',
        messages: [{ role: 'user', content: `Query: "${query}"\n\nArchive results:\n${context}\n\nPlease summarize what the archive has on this topic.` }]
      })
    });
    const data = await response.json();
    const answer = data.content?.[0]?.text || '';
    res.json({ answer, documents: docs.map(d => ({ id: d.id, title: d.title, author: d.author, year: d.year, language: d.language, subject: d.subject, page_count: d.page_count })) });
  } catch (err) {
    res.json({ answer: '', documents: docs.map(d => ({ id: d.id, title: d.title, author: d.author, year: d.year, language: d.language })) });
  }
});

// SPA routes
app.get(BASE + '/*', (req, res) => {
  if (!req.path.includes('/api/') && !req.path.includes('/uploads/')) {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  }
});
app.get(BASE, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`[KRRC] Server running on port ${PORT} at ${BASE}`);
});
