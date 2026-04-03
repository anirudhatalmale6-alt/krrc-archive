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
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts. Please wait 15 minutes.' }, validate: { xForwardedForHeader: false } });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 15, message: { error: 'Too many chat messages. Please slow down.' }, validate: { xForwardedForHeader: false } });

app.use(BASE + '/api', apiLimiter);

// CORS - only allow same origin
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Block direct access to uploaded files (reference-only platform - no downloads)
app.use(BASE + '/uploads', (req, res) => {
  res.status(403).json({ error: 'Direct file access is not permitted. Use the KRRC Ai chatbot to explore the archive.' });
});

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
const ALLOWED_MIMES = [
  'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/epub+zip', 'application/x-mobipocket-ebook',
  'image/jpeg', 'image/png', 'image/gif', 'image/tiff', 'image/bmp',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac',
  'video/mp4', 'video/x-msvideo', 'video/x-matroska', 'video/quicktime', 'video/webm'
];
const ALLOWED_EXTS = ['.pdf', '.doc', '.docx', '.epub', '.mobi', '.djvu', '.fb2', '.azw', '.azw3',
  '.jpg', '.jpeg', '.png', '.gif', '.tiff', '.bmp',
  '.mp3', '.wav', '.ogg', '.flac',
  '.mp4', '.avi', '.mkv', '.mov', '.webm'];
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_MIMES.includes(file.mimetype) || ALLOWED_EXTS.includes(ext)) cb(null, true);
    else cb(new Error('File type not supported. Allowed: PDF, EPUB, DOC, MOBI, images, audio, video'));
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
app.post(BASE + '/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  // Sanitise email
  const cleanEmail = email.trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.is_approved) return res.status(403).json({ error: 'Account pending approval' });
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

app.post(BASE + '/api/auth/register', authLimiter, (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'All fields required' });
  // Sanitise inputs
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name.trim().replace(/[<>]/g, '');
  // Validate email format
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'Invalid email format' });
  // Password strength: min 8 chars, at least 1 uppercase, 1 lowercase, 1 number
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(400).json({ error: 'Password must contain uppercase, lowercase, and a number' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (exists) return res.status(400).json({ error: 'Email already registered' });
  const id = uuid();
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('INSERT INTO users (id, email, password, name) VALUES (?, ?, ?, ?)').run(id, cleanEmail, hash, cleanName);
  res.json({ success: true, message: 'Registration submitted. Awaiting admin approval.' });
});

// ===== FILE UPLOAD & TEXT EXTRACTION =====
function getFileMediaType(mimetype, filename) {
  if (mimetype === 'application/pdf') return 'pdf';
  const ext = (filename || '').toLowerCase();
  if (mimetype === 'application/epub+zip' || ext.endsWith('.epub')) return 'epub';
  if (mimetype === 'application/x-mobipocket-ebook' || ext.endsWith('.mobi') || ext.endsWith('.azw') || ext.endsWith('.azw3')) return 'ebook';
  if (ext.endsWith('.djvu') || ext.endsWith('.fb2')) return 'ebook';
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.includes('word') || mimetype.includes('document')) return 'document';
  return 'other';
}

async function extractEpubText(filePath) {
  try {
    const EPub = require('epub2').default || require('epub2');
    const epub = await EPub.createAsync(filePath);
    const chapters = epub.flow || [];
    let fullText = '';
    for (const ch of chapters) {
      try {
        const text = await epub.getChapterAsync(ch.id);
        // Strip HTML tags
        fullText += (text || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ') + '\n\n';
      } catch (e) { /* skip unreadable chapters */ }
    }
    return { text: fullText.trim(), pages: chapters.length, title: epub.metadata?.title, author: epub.metadata?.creator, language: epub.metadata?.language };
  } catch (e) {
    console.error('[EPUB] Parse error:', e.message);
    return { text: '', pages: 0 };
  }
}

function autoDetectDocType(filename, mimetype) {
  const media = getFileMediaType(mimetype);
  if (media === 'image') return 'image';
  if (media === 'audio') return 'audio';
  if (media === 'video') return 'video';
  return 'book';
}

async function aiCategorise(id, title, extractedText) {
  if (!AI_API_KEY || !extractedText) return;
  try {
    const sample = extractedText.substring(0, 4000);
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': AI_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20241022',
        max_tokens: 400,
        messages: [{ role: 'user', content: `You are classifying a document for the Kashmir Research & Resource Center (KRRC) digital archive. Analyse the text carefully and return ONLY a JSON object (no markdown, no explanation) with these fields:

- doc_type: MUST be one of: book, article, think-tank-report, hr-report, govt-report, fact-finding, pamphlet, magazine, archival, other
  Classification guide:
  * "book" = full-length published book (100+ pages, ISBN, chapters)
  * "article" = research paper, journal article, short report, academic paper, policy brief (typically under 50 pages)
  * "think-tank-report" = published by a think tank or policy institute
  * "hr-report" = human rights organisation report
  * "govt-report" = official government document, legislative record, census data
  * "fact-finding" = investigation report, inquiry commission report
  * "pamphlet" = political pamphlet, leaflet, manifesto
  * "magazine" = magazine issue, periodical, newsletter
  * "archival" = historical record, archival document, correspondence, telegram, memo
  * "other" = does not fit above categories
- subject: brief topic description (max 60 chars)
- language: detected language name (English, Urdu, Kashmiri, Hindi, Persian, etc.)
- suggested_title: a clean, descriptive title if the current title looks like a filename

Title: ${title}
Text sample:
${sample}` }]
      })
    });
    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const ai = JSON.parse(jsonMatch[0]);
      const updates = [];
      const params = [];
      if (ai.doc_type) { updates.push('doc_type = ?'); params.push(ai.doc_type); }
      if (ai.subject) { updates.push('subject = ?'); params.push(ai.subject); }
      if (ai.language) { updates.push('language = ?'); params.push(ai.language); }
      // Update title if it looks auto-generated from filename
      const cleanTitle = (title || '').replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');
      if (ai.suggested_title && (!title || title === cleanTitle || /^\d/.test(title))) {
        updates.push('title = ?'); params.push(ai.suggested_title);
      }
      console.log('[AI Categorise] Doc ' + id + ': type=' + ai.doc_type + ', subject=' + ai.subject + ', lang=' + ai.language);
      if (updates.length > 0) {
        params.push(id);
        db.prepare('UPDATE documents SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
      }
      // Auto-link to category based on doc_type
      if (ai.doc_type) {
        linkDocToCategory(id, ai.doc_type);
      }
    }
  } catch (e) { console.error('[AI Categorise] Error:', e.message); }
}

// Link a document to its category based on doc_type
function linkDocToCategory(docId, docType) {
  const typeToCategory = {
    'book': 'Books', 'article': 'Research Articles', 'think-tank-report': 'Think Tank Reports',
    'hr-report': 'HR Organisation Reports', 'govt-report': 'Government Reports',
    'fact-finding': 'Fact-Finding Mission Documents', 'pamphlet': 'Political Pamphlets',
    'magazine': 'Magazines', 'archival': 'Archival Data'
  };
  const catName = typeToCategory[docType];
  if (!catName) return;
  const cat = db.prepare('SELECT id FROM categories WHERE name = ?').get(catName);
  if (cat) {
    db.prepare('DELETE FROM document_categories WHERE document_id = ?').run(docId);
    db.prepare('INSERT INTO document_categories (document_id, category_id) VALUES (?, ?)').run(docId, cat.id);
  }
}

// Single file upload
app.post(BASE + '/api/documents/upload', uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Duplicate detection: check by original filename and file size
  const duplicate = db.prepare('SELECT id, title FROM documents WHERE original_name = ? AND file_size = ?').get(req.file.originalname, req.file.size);
  if (duplicate) {
    fs.unlinkSync(req.file.path); // Remove the uploaded duplicate file
    return res.status(409).json({ error: 'Duplicate file detected. "' + duplicate.title + '" has already been uploaded.', duplicate_id: duplicate.id });
  }

  const { title, author, subject, publication_place, publisher, language, year, edition, doc_type, description } = req.body;
  const id = uuid();
  const mediaType = getFileMediaType(req.file.mimetype, req.file.originalname);

  // Extract text based on file type
  let extractedText = '';
  let pageCount = 0;
  let epubMeta = {};
  if (mediaType === 'pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const dataBuffer = fs.readFileSync(req.file.path);
      const pdfData = await pdfParse(dataBuffer);
      extractedText = pdfData.text || '';
      pageCount = pdfData.numpages || 0;
    } catch (err) {
      console.error('[PDF] Text extraction error:', err.message);
    }
  } else if (mediaType === 'epub') {
    const result = await extractEpubText(req.file.path);
    extractedText = result.text || '';
    pageCount = result.pages || 0;
    epubMeta = result;
  }

  const effectiveDocType = doc_type || autoDetectDocType(req.file.originalname, req.file.mimetype);
  const effectiveTitle = title || epubMeta.title || req.file.originalname.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  const effectiveAuthor = author || epubMeta.author || '';
  const effectiveLang = language || epubMeta.language || 'English';

  db.prepare(`INSERT INTO documents (id, title, subject, author, publication_place, publisher, language, year, edition, doc_type, description, filename, original_name, file_size, page_count, extracted_text, text_indexed, uploaded_by, upload_ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, effectiveTitle, subject || '', effectiveAuthor, publication_place || '', publisher || '',
    effectiveLang, year || '', edition || '', effectiveDocType, description || '',
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

  // Link to category if doc_type provided manually
  if (doc_type) linkDocToCategory(id, doc_type);

  // AI auto-categorise in background
  const docTitle = effectiveTitle;
  aiCategorise(id, docTitle, extractedText).catch(() => {});

  res.json({ id, title: title || req.file.originalname, pages: pageCount, text_extracted: !!extractedText, file_size: req.file.size, media_type: mediaType });
});

// Mass upload (multiple files)
app.post(BASE + '/api/documents/mass-upload', uploadLimiter, upload.array('files', 50), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const { author, subject, language, year, doc_type, description } = req.body;
  const results = [];

  for (const file of req.files) {
    const id = uuid();
    const mediaType = getFileMediaType(file.mimetype, file.originalname);
    let extractedText = '';
    let pageCount = 0;
    let epubMeta = {};

    if (mediaType === 'pdf') {
      try {
        const pdfParse = require('pdf-parse');
        const dataBuffer = fs.readFileSync(file.path);
        const pdfData = await pdfParse(dataBuffer);
        extractedText = pdfData.text || '';
        pageCount = pdfData.numpages || 0;
      } catch (err) { console.error('[PDF] Parse error:', err.message); }
    } else if (mediaType === 'epub') {
      const result = await extractEpubText(file.path);
      extractedText = result.text || '';
      pageCount = result.pages || 0;
      epubMeta = result;
    }

    const effectiveDocType = doc_type || autoDetectDocType(file.originalname, file.mimetype);
    const fileTitle = epubMeta.title || file.originalname.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');

    db.prepare(`INSERT INTO documents (id, title, subject, author, publication_place, publisher, language, year, edition, doc_type, description, filename, original_name, file_size, page_count, extracted_text, text_indexed, uploaded_by, upload_ip)
      VALUES (?, ?, ?, ?, '', '', ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, fileTitle, subject || '', author || '',
      language || 'English', year || '', effectiveDocType, description || '',
      file.filename, file.originalname, file.size, pageCount,
      extractedText, extractedText ? 1 : 0,
      req.body.uploaded_by_id || null, req.ip
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

    aiCategorise(id, fileTitle, extractedText).catch(() => {});
    results.push({ id, filename: file.originalname, pages: pageCount, text_extracted: !!extractedText, media_type: mediaType });
  }

  res.json({ total: results.length, results });
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
  // Return only first 2000 chars as reference excerpt, clean up PDF text artifacts
  let rawText = (doc.extracted_text || '').substring(0, 2000);
  // Fix common PDF extraction issues: single words per line, excessive whitespace
  rawText = rawText.replace(/([a-zA-Z,;:])\n([a-zA-Z])/g, '$1 $2'); // join broken lines
  rawText = rawText.replace(/\n{3,}/g, '\n\n'); // collapse multiple blank lines
  rawText = rawText.replace(/ {2,}/g, ' '); // collapse multiple spaces
  res.json({ title: doc.title, excerpt: rawText.trim(), has_more: (doc.extracted_text || '').length > 2000 });
});

// ===== ADMIN ROUTES =====
// List all documents (admin)
app.get(BASE + '/api/admin/documents', authenticateToken, requireAdmin, (req, res) => {
  const docs = db.prepare(`SELECT d.*, u.name as uploader_name FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by ORDER BY d.created_at DESC`).all();
  res.json(docs.map(d => ({ ...d, extracted_text: undefined, tags: JSON.parse(d.tags || '[]') })));
});

// Re-categorise document with AI
app.post(BASE + '/api/admin/documents/:id/recategorise', authenticateToken, requireAdmin, async (req, res) => {
  const doc = db.prepare('SELECT id, title, extracted_text, filename FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });

  // Try epub metadata first
  const ext = (doc.filename || '').toLowerCase();
  if (ext.endsWith('.epub')) {
    try {
      const epubPath = path.join(uploadsDir, doc.filename);
      const result = await extractEpubText(epubPath);
      if (result.title) {
        const updates = { title: result.title };
        if (result.author) updates.author = result.author;
        if (result.language) updates.language = result.language;
        const setClauses = Object.keys(updates).map(k => k + ' = ?');
        setClauses.push('updated_at = CURRENT_TIMESTAMP');
        db.prepare('UPDATE documents SET ' + setClauses.join(', ') + ' WHERE id = ?').run(...Object.values(updates), doc.id);
        return res.json({ success: true, source: 'epub_metadata', updates });
      }
    } catch (e) { /* fall through to AI */ }
  }

  // Fall back to AI categorisation
  if (doc.extracted_text) {
    await aiCategorise(doc.id, doc.title, doc.extracted_text);
    const updated = db.prepare('SELECT title, author, doc_type, subject, language, year FROM documents WHERE id = ?').get(doc.id);
    return res.json({ success: true, source: 'ai', updates: updated });
  }

  res.json({ success: false, message: 'No text available for AI categorisation' });
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

app.post(BASE + '/api/admin/users/:id/reset-password', authenticateToken, requireAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.params.id);
  res.json({ success: true });
});

app.post(BASE + '/api/admin/users/:id/role', authenticateToken, requireAdmin, (req, res) => {
  const { role } = req.body;
  if (!['member', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
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

// Public stats (counts only, no document details)
app.get(BASE + '/api/stats', (req, res) => {
  const totalDocs = db.prepare('SELECT COUNT(*) as cnt FROM documents WHERE is_approved = 1').get().cnt;
  const totalPages = db.prepare('SELECT COALESCE(SUM(page_count), 0) as cnt FROM documents WHERE is_approved = 1').get().cnt;
  const languages = db.prepare('SELECT COUNT(DISTINCT language) as cnt FROM documents WHERE is_approved = 1 AND language IS NOT NULL').get().cnt;
  res.json({ total_docs: totalDocs, total_pages: totalPages, languages });
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
app.post(BASE + '/api/chat', chatLimiter, async (req, res) => {
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

  // Search archive for relevant content with multiple strategies
  let contextDocs = '';
  try {
    // Strategy 1: FTS5 full-text search with sanitised query
    const words = message.replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);
    let searchResults = [];
    if (words.length > 0) {
      const ftsQuery = words.map(w => `"${w}"`).join(' OR ');
      try {
        searchResults = db.prepare(`SELECT d.id, d.title, d.author, d.year, d.language, d.subject, d.page_count, d.doc_type,
          substr(d.extracted_text, 1, 8000) as text_excerpt
          FROM documents_fts fts JOIN documents d ON d.rowid = fts.rowid
          WHERE documents_fts MATCH ? AND d.is_approved = 1 LIMIT 5`).all(ftsQuery);
      } catch (ftsErr) { /* FTS query failed, try fallback */ }
    }

    // Strategy 2: If FTS returned nothing, try LIKE search on key fields
    if (searchResults.length === 0 && words.length > 0) {
      const likeConditions = words.slice(0, 5).map(() => '(d.title LIKE ? OR d.author LIKE ? OR d.subject LIKE ? OR d.extracted_text LIKE ?)').join(' OR ');
      const likeParams = words.slice(0, 5).flatMap(w => [`%${w}%`, `%${w}%`, `%${w}%`, `%${w}%`]);
      searchResults = db.prepare(`SELECT d.id, d.title, d.author, d.year, d.language, d.subject, d.page_count, d.doc_type,
        substr(d.extracted_text, 1, 8000) as text_excerpt
        FROM documents d WHERE d.is_approved = 1 AND (${likeConditions}) LIMIT 5`).all(...likeParams);
    }

    // Strategy 3: If still nothing, provide all approved documents metadata + initial text
    if (searchResults.length === 0) {
      searchResults = db.prepare(`SELECT d.id, d.title, d.author, d.year, d.language, d.subject, d.page_count, d.doc_type,
        substr(d.extracted_text, 1, 4000) as text_excerpt
        FROM documents d WHERE d.is_approved = 1 LIMIT 10`).all();
    }

    if (searchResults.length > 0) {
      contextDocs = '\n\n=== KRRC ARCHIVE DOCUMENTS ===\n' +
        'Below are relevant documents from the archive. Use these to answer the user\'s question with specific citations.\n\n' +
        searchResults.map((d, i) => {
          let entry = `--- DOCUMENT ${i + 1} ---\n`;
          entry += `Title: ${d.title}\n`;
          entry += `Author: ${d.author || 'Unknown'}\n`;
          entry += `Year: ${d.year || 'N/A'}\n`;
          entry += `Language: ${d.language || 'N/A'}\n`;
          entry += `Type: ${d.doc_type || 'N/A'}\n`;
          entry += `Total Pages: ${d.page_count || 'N/A'}\n`;
          if (d.subject) entry += `Subject: ${d.subject}\n`;
          if (d.text_excerpt) {
            // Split text into approximate pages and add page markers
            const cleanText = d.text_excerpt.replace(/\n{3,}/g, '\n\n').replace(/\s{3,}/g, ' ').trim();
            const totalPages = d.page_count || 1;
            const charsPerPage = Math.max(Math.floor(cleanText.length / Math.max(totalPages, 1)), 500);
            let paged = '\nContent with approximate page references:\n';
            let pos = 0;
            let pageNum = 1;
            while (pos < cleanText.length && pageNum <= 20) {
              const end = Math.min(pos + charsPerPage, cleanText.length);
              // Try to break at a sentence boundary
              let breakAt = end;
              if (end < cleanText.length) {
                const nearEnd = cleanText.lastIndexOf('. ', end);
                if (nearEnd > pos + charsPerPage * 0.7) breakAt = nearEnd + 2;
              }
              paged += `[Page ~${pageNum}] ${cleanText.substring(pos, breakAt).trim()}\n\n`;
              pos = breakAt;
              pageNum++;
            }
            entry += paged;
          }
          return entry;
        }).join('\n');
    }
  } catch (e) { console.error('[Chat] Archive search error:', e.message); }

  // Get conversation history
  const history = db.prepare('SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 10').all(session.id).reverse();

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': AI_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
        system: `You are KRRC Ai, the Kashmir Research & Resource Center AI assistant. You have access to a digital archive of Kashmir-related books, research articles, reports, and documents.

CRITICAL INSTRUCTIONS:
1. You MUST use the archive documents provided below to answer questions. When archive documents are provided, READ their content excerpts carefully and base your answers on them.
2. For EVERY claim or piece of information you provide, cite the specific source with page numbers using this format:
   (Source: "Document Title" by Author, Year, p. X)
   Or for a range: (Source: "Document Title" by Author, Year, pp. X-Y)
3. The document content below includes [Page ~N] markers. Use these to provide approximate page references in your citations.
4. If the archive contains relevant information, synthesise it into a clear answer with proper citations including page numbers.
5. NEVER say "I have documents but cannot access them" - you CAN access them, they are provided below.
6. NEVER provide download links, file URLs, or offer to share/send documents.
7. You provide REFERENCES ONLY - like a scholar citing sources, always with page numbers.
8. If no archive documents are relevant to the question, say so honestly and explain what topics the archive does cover.
9. Be scholarly, accurate, and respectful of all perspectives on Kashmir.
10. When quoting or paraphrasing from document content, always indicate the document and page number you are drawing from.
${contextDocs}`,
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
        system: 'You are KRRC Ai, a research assistant for the Kashmir Research & Resource Center. Given search results from the archive, provide a brief, helpful summary answering the user\'s query. Always cite sources as: Title, Author, Year, Page (where applicable). NEVER provide download links or offer to share full documents. Provide references only. Be concise and scholarly.',
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

// ===== ANALYTICS TRACKING =====
app.post(BASE + '/api/track', (req, res) => {
  const { page, path: pagePath, referrer } = req.body;
  if (!page) return res.status(400).json({ error: 'Page required' });
  const ua = req.headers['user-agent'] || '';
  const ip = req.ip || '';
  // Skip bots
  if (/bot|crawl|spider|slurp/i.test(ua)) return res.json({ ok: true });
  // Get or create session
  const sessionId = req.body.sessionId || crypto.randomBytes(8).toString('hex');
  let session = db.prepare('SELECT * FROM visitor_sessions WHERE id = ?').get(sessionId);
  if (!session) {
    db.prepare('INSERT INTO visitor_sessions (id, ip_address, user_agent, page_count) VALUES (?, ?, ?, 1)').run(sessionId, ip, ua.substring(0, 255));
  } else {
    db.prepare('UPDATE visitor_sessions SET last_visit = CURRENT_TIMESTAMP, page_count = page_count + 1 WHERE id = ?').run(sessionId);
  }
  db.prepare('INSERT INTO page_views (page, path, referrer, user_agent, ip_address, session_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    page, pagePath || '', (referrer || '').substring(0, 500), ua.substring(0, 255), ip, sessionId
  );
  res.json({ ok: true, sessionId });
});

// Admin analytics dashboard data
app.get(BASE + '/api/admin/analytics', authenticateToken, requireAdmin, (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const totalViews = db.prepare('SELECT COUNT(*) as cnt FROM page_views WHERE created_at >= ?').get(since).cnt;
  const uniqueVisitors = db.prepare('SELECT COUNT(DISTINCT session_id) as cnt FROM page_views WHERE created_at >= ?').get(since).cnt;
  const totalSessions = db.prepare('SELECT COUNT(*) as cnt FROM visitor_sessions WHERE first_visit >= ?').get(since).cnt;

  // Page views by page
  const pageBreakdown = db.prepare('SELECT page, COUNT(*) as views FROM page_views WHERE created_at >= ? GROUP BY page ORDER BY views DESC LIMIT 20').all(since);

  // Views per day
  const dailyViews = db.prepare(`SELECT DATE(created_at) as date, COUNT(*) as views, COUNT(DISTINCT session_id) as visitors
    FROM page_views WHERE created_at >= ? GROUP BY DATE(created_at) ORDER BY date`).all(since);

  // Top referrers
  const referrers = db.prepare(`SELECT referrer, COUNT(*) as cnt FROM page_views
    WHERE referrer != '' AND referrer IS NOT NULL AND created_at >= ? GROUP BY referrer ORDER BY cnt DESC LIMIT 10`).all(since);

  // Top user agents (simplified)
  const browsers = db.prepare(`SELECT
    CASE
      WHEN user_agent LIKE '%Chrome%' AND user_agent NOT LIKE '%Edg%' THEN 'Chrome'
      WHEN user_agent LIKE '%Firefox%' THEN 'Firefox'
      WHEN user_agent LIKE '%Safari%' AND user_agent NOT LIKE '%Chrome%' THEN 'Safari'
      WHEN user_agent LIKE '%Edg%' THEN 'Edge'
      ELSE 'Other'
    END as browser, COUNT(*) as cnt
    FROM page_views WHERE created_at >= ? GROUP BY browser ORDER BY cnt DESC`).all(since);

  // Chat sessions count
  const chatSessions = db.prepare('SELECT COUNT(*) as cnt FROM chat_sessions WHERE created_at >= ?').get(since).cnt;
  const chatMessages = db.prepare('SELECT COUNT(*) as cnt FROM chat_messages WHERE created_at >= ?').get(since).cnt;

  res.json({ totalViews, uniqueVisitors, totalSessions, pageBreakdown, dailyViews, referrers, browsers, chatSessions, chatMessages, days });
});

// ===== SEO KEYWORDS MANAGEMENT =====
app.get(BASE + '/api/admin/keywords', authenticateToken, requireAdmin, (req, res) => {
  const keywords = db.prepare('SELECT * FROM seo_keywords ORDER BY priority DESC, created_at').all();
  res.json(keywords);
});

app.post(BASE + '/api/admin/keywords', authenticateToken, requireAdmin, (req, res) => {
  const { keyword, description, priority } = req.body;
  if (!keyword) return res.status(400).json({ error: 'Keyword required' });
  const id = uuid();
  db.prepare('INSERT INTO seo_keywords (id, keyword, description, priority) VALUES (?, ?, ?, ?)').run(id, keyword.trim(), description || '', priority || 0);
  res.json({ id, keyword: keyword.trim() });
});

app.delete(BASE + '/api/admin/keywords/:id', authenticateToken, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM seo_keywords WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Public SEO keywords (for meta tag injection)
app.get(BASE + '/api/seo/keywords', (req, res) => {
  const keywords = db.prepare('SELECT keyword FROM seo_keywords ORDER BY priority DESC').all();
  res.json(keywords.map(k => k.keyword));
});

// SEO settings (meta description, title, etc.)
app.get(BASE + '/api/admin/seo-settings', authenticateToken, requireAdmin, (req, res) => {
  const settings = {};
  const rows = db.prepare("SELECT key, value FROM platform_settings WHERE key LIKE 'seo_%'").all();
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

app.post(BASE + '/api/admin/seo-settings', authenticateToken, requireAdmin, (req, res) => {
  const { seo_title, seo_description, seo_og_title, seo_og_description, google_analytics_id, google_search_console } = req.body;
  const upsert = db.prepare('INSERT OR REPLACE INTO platform_settings (key, value) VALUES (?, ?)');
  if (seo_title !== undefined) upsert.run('seo_title', seo_title);
  if (seo_description !== undefined) upsert.run('seo_description', seo_description);
  if (seo_og_title !== undefined) upsert.run('seo_og_title', seo_og_title);
  if (seo_og_description !== undefined) upsert.run('seo_og_description', seo_og_description);
  if (google_analytics_id !== undefined) upsert.run('seo_google_analytics_id', google_analytics_id);
  if (google_search_console !== undefined) upsert.run('seo_google_search_console', google_search_console);
  res.json({ success: true });
});

// ===== SITEMAP =====
app.get(BASE + '/sitemap.xml', (req, res) => {
  const baseUrl = 'https://skylarkmedia.se/krrc';
  const cats = db.prepare('SELECT name FROM categories').all();
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
  <url><loc>${baseUrl}/browse</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>
  <url><loc>${baseUrl}/chat</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>${baseUrl}/about</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>
  <url><loc>${baseUrl}/upload</loc><changefreq>monthly</changefreq><priority>0.4</priority></url>
</urlset>`;
  res.type('application/xml').send(xml);
});

// ===== ROBOTS.TXT =====
app.get(BASE + '/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *
Allow: /krrc/
Disallow: /krrc/api/
Disallow: /krrc/uploads/
Sitemap: https://skylarkmedia.se/krrc/sitemap.xml`);
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
