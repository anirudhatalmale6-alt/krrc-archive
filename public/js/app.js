const API = '/krrc';
let token = localStorage.getItem('krrc_token');
let user = JSON.parse(localStorage.getItem('krrc_user') || 'null');
let chatSessionId = localStorage.getItem('krrc_chat_session') || '';
let currentPage = 'home';
let browsePage = 1;

// ===== HELPERS =====
function escapeHtml(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function formatDocType(t) { const labels = { book: 'Book', article: 'Research Article', 'think-tank-report': 'Think Tank Report', 'hr-report': 'HR Org Report', 'govt-report': 'Govt Report', 'fact-finding': 'Fact-Finding', pamphlet: 'Pamphlet', magazine: 'Magazine', archival: 'Archival', other: 'Other' }; return labels[t] || t || 'Book'; }

async function apiFetch(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(API + path, { ...opts, headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

function showToast(msg, type = 'success') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast ' + type;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 3000);
}

// ===== NAVIGATION =====
function toggleMobileMenu() {
    const nav = document.getElementById('nav-links');
    const icon = document.getElementById('hamburger-icon');
    nav.classList.toggle('open');
    icon.className = nav.classList.contains('open') ? 'fas fa-times' : 'fas fa-bars';
}

function closeMobileMenu() {
    const nav = document.getElementById('nav-links');
    const icon = document.getElementById('hamburger-icon');
    if (nav) { nav.classList.remove('open'); }
    if (icon) { icon.className = 'fas fa-bars'; }
}

function showPage(page) {
    closeMobileMenu();
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-' + page).classList.add('active');
    document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
    const navBtn = document.querySelector(`.nav-link[onclick*="'${page}'"]`);
    if (navBtn) navBtn.classList.add('active');
    currentPage = page;
    window.scrollTo(0, 0);

    if (page === 'home') loadHomePage();
    if (page === 'browse') loadBrowseDocs();
    if (page === 'admin') loadAdminDashboard();

    document.getElementById('main-footer').style.display = page === 'admin' ? 'none' : '';
}

// ===== AUTH =====
function showLoginModal() { closeMobileMenu(); document.getElementById('login-modal').classList.add('active'); }
function hideLoginModal() { document.getElementById('login-modal').classList.remove('active'); }
function showRegisterModal() { hideLoginModal(); document.getElementById('register-modal').classList.add('active'); }
function hideRegisterModal() { document.getElementById('register-modal').classList.remove('active'); }

async function doLogin() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    try {
        const data = await apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
        token = data.token;
        user = data.user;
        localStorage.setItem('krrc_token', token);
        localStorage.setItem('krrc_user', JSON.stringify(user));
        hideLoginModal();
        updateAuthUI();
        showToast('Logged in as ' + user.name);
    } catch (err) { showToast(err.message, 'error'); }
}

async function doRegister() {
    const name = document.getElementById('reg-name').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    try {
        await apiFetch('/api/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password }) });
        hideRegisterModal();
        showToast('Registration submitted. Awaiting admin approval.');
    } catch (err) { showToast(err.message, 'error'); }
}

function logout() {
    token = null; user = null;
    localStorage.removeItem('krrc_token');
    localStorage.removeItem('krrc_user');
    updateAuthUI();
    showPage('home');
    showToast('Logged out');
}

function updateAuthUI() {
    const isAdmin = user && user.role === 'admin';
    document.getElementById('nav-login-btn').classList.toggle('hidden', !!user);
    document.getElementById('nav-logout-btn').classList.toggle('hidden', !user);
    document.getElementById('nav-admin-btn').classList.toggle('hidden', !isAdmin);
}

// ===== HOME PAGE =====
async function loadHomePage() {
    // Load categories
    try {
        const cats = await fetch(API + '/api/categories').then(r => r.json());
        const grid = document.getElementById('home-categories');
        grid.innerHTML = cats.map(c => `
            <div class="cat-card" onclick="browseByCategory('${c.id}', '${escapeHtml(c.name)}')">
                <h3>${escapeHtml(c.name)}</h3>
                <div class="count">${c.doc_count || 0} documents</div>
            </div>
        `).join('');
        document.getElementById('stat-categories').textContent = cats.length;
    } catch (e) {}

    // Load recent docs
    try {
        const data = await fetch(API + '/api/documents?limit=5').then(r => r.json());
        renderDocList(document.getElementById('home-recent'), data.documents);
        document.getElementById('stat-docs').textContent = data.total;

        // Calculate total pages
        const totalPages = data.documents.reduce((sum, d) => sum + (d.page_count || 0), 0);
        document.getElementById('stat-pages').textContent = totalPages > 1000 ? Math.round(totalPages / 1000) + 'K+' : totalPages;

        // Languages
        const langs = [...new Set(data.documents.map(d => d.language))].length;
        document.getElementById('stat-languages').textContent = langs;
    } catch (e) {}
}

// ===== BROWSE =====
function browseByCategory(catId, catName) {
    showPage('browse');
    document.getElementById('filter-category').value = catId;
    loadBrowseDocs();
}

async function loadBrowseDocs() {
    const category = document.getElementById('filter-category').value;
    const language = document.getElementById('filter-language').value;
    const type = document.getElementById('filter-type').value;
    const sort = document.getElementById('filter-sort').value;
    const container = document.getElementById('browse-results');
    container.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner"></div></div>';

    try {
        const params = new URLSearchParams({ page: browsePage, limit: 20, sort });
        if (category) params.set('category', category);
        if (language) params.set('language', language);
        if (type) params.set('type', type);
        const data = await fetch(API + '/api/documents?' + params).then(r => r.json());
        renderDocList(container, data.documents);
        renderPagination(data.page, data.pages);
    } catch (e) { container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">Error loading documents</div>'; }
}

async function browseSearch() {
    const q = document.getElementById('browse-search').value.trim();
    if (!q) { loadBrowseDocs(); return; }
    const container = document.getElementById('browse-results');
    const aiBox = document.getElementById('browse-ai-answer');
    container.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner"></div></div>';

    try {
        // Try AI search first
        const aiData = await apiFetch('/api/ai-search', { method: 'POST', body: JSON.stringify({ query: q }) });
        if (aiData.answer) {
            aiBox.classList.remove('hidden');
            aiBox.innerHTML = `<div style="font-weight:600;margin-bottom:8px;color:var(--accent);"><i class="fas fa-robot"></i> AI Summary</div><div style="font-size:0.9rem;line-height:1.6;white-space:pre-wrap;">${escapeHtml(aiData.answer)}</div>`;
        } else { aiBox.classList.add('hidden'); }
        if (aiData.documents && aiData.documents.length > 0) {
            renderDocList(container, aiData.documents);
        } else {
            container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">No documents found for "' + escapeHtml(q) + '"</div>';
        }
    } catch (e) {
        // Fallback to regular search
        try {
            const data = await fetch(API + '/api/documents/search?q=' + encodeURIComponent(q)).then(r => r.json());
            aiBox.classList.add('hidden');
            renderDocList(container, data.documents);
        } catch (e2) { container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">Search error</div>'; }
    }
}

function heroSearch() {
    const q = document.getElementById('hero-search').value.trim();
    if (!q) return;
    showPage('browse');
    document.getElementById('browse-search').value = q;
    browseSearch();
}

function renderDocList(container, docs) {
    if (!docs || docs.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">No documents found</div>';
        return;
    }
    container.innerHTML = docs.map(d => {
        const typeIcons = { article: 'fa-file-lines', magazine: 'fa-newspaper', pamphlet: 'fa-bullhorn', archival: 'fa-archive', 'govt-report': 'fa-landmark', 'hr-report': 'fa-hand-holding-heart', 'think-tank-report': 'fa-building-columns', 'fact-finding': 'fa-magnifying-glass-location' };
        const typeIcon = typeIcons[d.doc_type] || 'fa-book';
        return `<div class="doc-card" onclick="showDocument('${d.id}')">
            <div class="doc-icon"><i class="fas ${typeIcon}"></i></div>
            <div class="doc-info">
                <h3>${escapeHtml(d.title)}</h3>
                <div class="doc-meta">
                    ${d.author ? `<span><i class="fas fa-user"></i> ${escapeHtml(d.author)}</span>` : ''}
                    ${d.year ? `<span><i class="fas fa-calendar"></i> ${escapeHtml(d.year)}</span>` : ''}
                    ${d.language ? `<span><i class="fas fa-globe"></i> ${escapeHtml(d.language)}</span>` : ''}
                    ${d.page_count ? `<span><i class="fas fa-file"></i> ${d.page_count} pages</span>` : ''}
                    <span class="badge badge-article">${formatDocType(d.doc_type)}</span>
                </div>
                ${d.snippet ? `<div class="doc-desc">${d.snippet}</div>` : d.description ? `<div class="doc-desc">${escapeHtml(d.description).substring(0, 200)}</div>` : ''}
            </div>
        </div>`;
    }).join('');
}

function renderPagination(current, total) {
    const container = document.getElementById('browse-pagination');
    if (total <= 1) { container.innerHTML = ''; return; }
    let html = '';
    if (current > 1) html += `<button onclick="goToPage(${current-1})"><i class="fas fa-chevron-left"></i></button>`;
    for (let i = 1; i <= total; i++) {
        if (i === 1 || i === total || (i >= current - 2 && i <= current + 2)) {
            html += `<button class="${i === current ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
        } else if (i === current - 3 || i === current + 3) { html += '<button disabled>...</button>'; }
    }
    if (current < total) html += `<button onclick="goToPage(${current+1})"><i class="fas fa-chevron-right"></i></button>`;
    container.innerHTML = html;
}

function goToPage(p) { browsePage = p; loadBrowseDocs(); }

// ===== DOCUMENT DETAIL =====
async function showDocument(id) {
    showPage('document');
    const container = document.getElementById('document-detail');
    container.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner"></div></div>';
    try {
        const doc = await fetch(API + '/api/documents/' + id).then(r => r.json());
        const excerpt = await fetch(API + '/api/documents/' + id + '/excerpt').then(r => r.json()).catch(() => null);
        container.innerHTML = `
            <button class="btn btn-sm" onclick="showPage('browse')" style="margin-bottom:16px;"><i class="fas fa-arrow-left"></i> Back</button>
            <h1>${escapeHtml(doc.title)}</h1>
            ${doc.description ? `<p style="color:var(--text-secondary);margin-top:8px;">${escapeHtml(doc.description)}</p>` : ''}
            <div class="meta-grid">
                ${metaItem('Author', doc.author)}
                ${metaItem('Language', doc.language)}
                ${metaItem('Year', doc.year)}
                ${metaItem('Edition', doc.edition)}
                ${metaItem('Publisher', doc.publisher)}
                ${metaItem('Publication Place', doc.publication_place)}
                ${metaItem('Type', doc.doc_type)}
                ${metaItem('Pages', doc.page_count)}
                ${metaItem('Subject', doc.subject)}
            </div>
            ${doc.categories && doc.categories.length > 0 ? `<div style="margin:16px 0;"><span style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;">Categories:</span> ${doc.categories.map(c => `<span class="badge badge-book" style="margin-left:6px;">${escapeHtml(c.name)}</span>`).join('')}</div>` : ''}
            ${doc.tags && doc.tags.length > 0 ? `<div style="margin:16px 0;"><span style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;">Tags:</span> ${doc.tags.map(t => `<span class="badge badge-article" style="margin-left:6px;">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
            ${excerpt && excerpt.excerpt ? `<div style="margin-top:24px;padding:20px;background:var(--bg-secondary);border-radius:8px;border:1px solid var(--border);">
                <h3 style="font-size:0.9rem;color:var(--accent);margin-bottom:12px;"><i class="fas fa-book-open"></i> Excerpt (Reference Only)</h3>
                <p style="font-size:0.85rem;color:var(--text-secondary);line-height:1.7;white-space:normal;">${escapeHtml(excerpt.excerpt).replace(/\n{3,}/g, '\n\n').replace(/([^\n])\n([^\n])/g, '$1 $2')}</p>
                ${excerpt.has_more ? '<p style="font-size:0.75rem;color:var(--text-muted);margin-top:12px;text-align:center;"><i class="fas fa-lock"></i> Full text available for reference. Contact the archive for access.</p>' : ''}
            </div>` : ''}
            <div style="margin-top:24px;padding:16px;background:rgba(201,169,110,0.05);border:1px solid var(--border);border-radius:8px;text-align:center;">
                <i class="fas fa-info-circle" style="color:var(--accent);"></i>
                <span style="font-size:0.85rem;color:var(--text-secondary);">This document is available for reference only. Downloads are not available to protect copyright.</span>
            </div>
        `;
    } catch (e) { container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">Document not found</div>'; }
}

function metaItem(label, value) {
    if (!value) return '';
    return `<div class="meta-item"><div class="meta-label">${label}</div><div class="meta-value">${escapeHtml(String(value))}</div></div>`;
}

// ===== UPLOAD =====
// selectedFile replaced by selectedFiles array

let selectedFiles = [];

function handleFileSelect(input) {
    selectedFiles = Array.from(input.files);
    if (selectedFiles.length === 0) return;

    const fileList = document.getElementById('file-list');
    const fileInfo = document.getElementById('file-info');

    if (selectedFiles.length === 1) {
        fileList.classList.add('hidden');
        fileInfo.classList.remove('hidden');
        const f = selectedFiles[0];
        const icon = f.type.startsWith('image/') ? 'fa-image' : f.type.startsWith('audio/') ? 'fa-music' : f.type.startsWith('video/') ? 'fa-video' : 'fa-file-pdf';
        fileInfo.innerHTML = `<i class="fas ${icon}" style="color:var(--accent);"></i> <strong>${escapeHtml(f.name)}</strong> (${(f.size / 1024 / 1024).toFixed(1)} MB)`;
        if (!document.getElementById('upload-title').value) {
            document.getElementById('upload-title').value = f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
        }
    } else {
        fileInfo.classList.add('hidden');
        fileList.classList.remove('hidden');
        const totalSize = selectedFiles.reduce((s, f) => s + f.size, 0);
        fileList.innerHTML = `<div style="margin-bottom:8px;font-weight:600;"><i class="fas fa-layer-group" style="color:var(--accent);"></i> ${selectedFiles.length} files selected (${(totalSize / 1024 / 1024).toFixed(1)} MB total)</div>` +
            selectedFiles.map(f => {
                const icon = f.type.startsWith('image/') ? 'fa-image' : f.type.startsWith('audio/') ? 'fa-music' : f.type.startsWith('video/') ? 'fa-video' : 'fa-file-pdf';
                return `<div style="font-size:0.85rem;padding:2px 0;"><i class="fas ${icon}" style="color:var(--text-muted);width:16px;"></i> ${escapeHtml(f.name)} (${(f.size / 1024 / 1024).toFixed(1)} MB)</div>`;
            }).join('');
    }
}

// Drag and drop
const dropZone = document.getElementById('drop-zone');
if (dropZone) {
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) {
            document.getElementById('file-input').files = e.dataTransfer.files;
            handleFileSelect(document.getElementById('file-input'));
        }
    });
}

async function uploadDocument() {
    if (selectedFiles.length === 0) { showToast('Please select files to upload', 'error'); return; }

    const btn = document.getElementById('upload-btn');
    btn.disabled = true;
    const progressDiv = document.getElementById('upload-progress');
    progressDiv.classList.remove('hidden');

    const sharedMeta = {
        author: document.getElementById('upload-author').value.trim(),
        subject: document.getElementById('upload-subject').value.trim(),
        doc_type: document.getElementById('upload-type').value,
        language: document.getElementById('upload-language').value,
        year: document.getElementById('upload-year').value.trim(),
        publisher: document.getElementById('upload-publisher').value.trim(),
        publication_place: document.getElementById('upload-place').value.trim(),
        edition: document.getElementById('upload-edition').value.trim(),
        description: document.getElementById('upload-desc').value.trim()
    };

    if (selectedFiles.length === 1) {
        btn.innerHTML = '<div class="spinner"></div> Uploading & processing...';
        const formData = new FormData();
        formData.append('file', selectedFiles[0]);
        formData.append('title', document.getElementById('upload-title').value.trim() || selectedFiles[0].name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '));
        Object.entries(sharedMeta).forEach(([k, v]) => formData.append(k, v));
        if (user) formData.append('uploaded_by_id', user.id);

        try {
            const res = await fetch(API + '/api/documents/upload', { method: 'POST', body: formData });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Upload failed');
            showToast('Uploaded! AI will auto-categorise. Pending admin review.', 'success');
        } catch (err) { showToast(err.message, 'error'); }
    } else {
        // Mass upload
        btn.innerHTML = '<div class="spinner"></div> Uploading ' + selectedFiles.length + ' files...';
        let uploaded = 0;
        let failed = 0;

        for (let i = 0; i < selectedFiles.length; i++) {
            progressDiv.innerHTML = `<div style="background:var(--bg-card);padding:8px 12px;border-radius:6px;font-size:0.85rem;">Uploading ${i + 1} of ${selectedFiles.length}: ${escapeHtml(selectedFiles[i].name)}</div>`;
            const formData = new FormData();
            formData.append('file', selectedFiles[i]);
            formData.append('title', selectedFiles[i].name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '));
            Object.entries(sharedMeta).forEach(([k, v]) => formData.append(k, v));
            if (user) formData.append('uploaded_by_id', user.id);

            try {
                const res = await fetch(API + '/api/documents/upload', { method: 'POST', body: formData });
                if (!res.ok) { failed++; continue; }
                uploaded++;
            } catch (err) { failed++; }
        }
        showToast(`Mass upload complete: ${uploaded} uploaded, ${failed} failed. AI will auto-categorise. Pending admin review.`, uploaded > 0 ? 'success' : 'error');
    }

    // Reset
    selectedFiles = [];
    document.getElementById('file-input').value = '';
    document.getElementById('file-info').classList.add('hidden');
    document.getElementById('file-list').classList.add('hidden');
    progressDiv.classList.add('hidden');
    progressDiv.innerHTML = '';
    document.getElementById('upload-title').value = '';
    document.getElementById('upload-author').value = '';
    document.getElementById('upload-subject').value = '';
    document.getElementById('upload-year').value = '';
    document.getElementById('upload-publisher').value = '';
    document.getElementById('upload-place').value = '';
    document.getElementById('upload-edition').value = '';
    document.getElementById('upload-desc').value = '';
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-upload"></i> Upload to Archive';
}

// ===== CHATBOT =====
function toggleChat() {
    document.getElementById('chatbot-panel').classList.toggle('open');
}

async function sendChat() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';

    const container = document.getElementById('chat-messages');
    container.innerHTML += `<div class="chat-msg user">${escapeHtml(msg)}</div>`;
    container.innerHTML += `<div class="chat-msg bot" id="chat-loading"><div class="spinner"></div></div>`;
    container.scrollTop = container.scrollHeight;

    try {
        const data = await apiFetch('/api/chat', { method: 'POST', body: JSON.stringify({ message: msg, sessionId: chatSessionId }) });
        chatSessionId = data.sessionId;
        localStorage.setItem('krrc_chat_session', chatSessionId);
        document.getElementById('chat-loading').innerHTML = data.reply.replace(/\n/g, '<br>');
    } catch (err) {
        document.getElementById('chat-loading').innerHTML = 'Sorry, I encountered an error. Please try again.';
    }
    document.getElementById('chat-loading').removeAttribute('id');
    container.scrollTop = container.scrollHeight;
}

// ===== ADMIN =====
let adminTab = 'dashboard';

function switchAdminTab(tab) {
    adminTab = tab;
    document.querySelectorAll('.admin-sidebar button').forEach(b => b.classList.remove('active'));
    document.querySelector(`.admin-sidebar button[onclick*="${tab}"]`).classList.add('active');
    if (tab === 'dashboard') loadAdminDashboard();
    else if (tab === 'documents') loadAdminDocuments();
    else if (tab === 'users') loadAdminUsers();
    else if (tab === 'categories') loadAdminCategories();
    else if (tab === 'ftp') loadFtpImport();
}

async function loadAdminDashboard() {
    const content = document.getElementById('admin-content');
    try {
        const stats = await apiFetch('/api/admin/stats');
        content.innerHTML = `
            <h2 style="font-family:var(--font-serif);margin-bottom:20px;">Dashboard</h2>
            <div class="stat-grid">
                <div class="stat-card"><div class="stat-num">${stats.totalDocs}</div><div class="stat-label">Total Documents</div></div>
                <div class="stat-card"><div class="stat-num">${stats.approvedDocs}</div><div class="stat-label">Approved</div></div>
                <div class="stat-card"><div class="stat-num">${stats.pendingDocs}</div><div class="stat-label">Pending Review</div></div>
                <div class="stat-card"><div class="stat-num">${stats.totalUsers}</div><div class="stat-label">Users</div></div>
                <div class="stat-card"><div class="stat-num">${stats.pendingUsers}</div><div class="stat-label">Pending Users</div></div>
                <div class="stat-card"><div class="stat-num">${stats.totalSearches}</div><div class="stat-label">Total Searches</div></div>
            </div>
            ${stats.languages.length > 0 ? `<h3 style="margin:20px 0 10px;">Languages</h3><div style="display:flex;gap:8px;flex-wrap:wrap;">${stats.languages.map(l => `<span class="badge badge-book">${escapeHtml(l.language)}: ${l.cnt}</span>`).join('')}</div>` : ''}
            ${stats.docTypes.length > 0 ? `<h3 style="margin:20px 0 10px;">Document Types</h3><div style="display:flex;gap:8px;flex-wrap:wrap;">${stats.docTypes.map(t => `<span class="badge badge-article">${escapeHtml(t.doc_type)}: ${t.cnt}</span>`).join('')}</div>` : ''}
            ${stats.recentSearches.length > 0 ? `<h3 style="margin:20px 0 10px;">Recent Searches</h3><table class="admin-table"><thead><tr><th>Query</th><th>Results</th><th>Date</th></tr></thead><tbody>${stats.recentSearches.map(s => `<tr><td>${escapeHtml(s.query)}</td><td>${s.results_count}</td><td>${new Date(s.created_at).toLocaleDateString()}</td></tr>`).join('')}</tbody></table>` : ''}
        `;
    } catch (err) { content.innerHTML = '<div style="color:#ff4757;">Error: ' + escapeHtml(err.message) + '</div>'; }
}

async function loadAdminDocuments() {
    const content = document.getElementById('admin-content');
    content.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner"></div></div>';
    try {
        const docs = await apiFetch('/api/admin/documents');
        content.innerHTML = `
            <h2 style="font-family:var(--font-serif);margin-bottom:20px;">Documents (${docs.length})</h2>
            <div style="overflow-x:auto;">
            <table class="admin-table">
                <thead><tr><th>Title</th><th>Author</th><th>Language</th><th>Year</th><th>Type</th><th>Pages</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                ${docs.map(d => `<tr>
                    <td style="max-width:250px;"><strong>${escapeHtml(d.title)}</strong><br><span style="font-size:0.7rem;color:var(--text-muted);">${escapeHtml(d.original_name)}</span></td>
                    <td>${escapeHtml(d.author || '-')}</td>
                    <td>${escapeHtml(d.language)}</td>
                    <td>${escapeHtml(d.year || '-')}</td>
                    <td><span class="badge badge-${d.doc_type === 'article' ? 'article' : 'book'}">${d.doc_type}</span></td>
                    <td>${d.page_count || 0}</td>
                    <td>${d.is_approved ? '<span class="badge badge-approved">Approved</span>' : '<span class="badge badge-pending">Pending</span>'}</td>
                    <td style="white-space:nowrap;">
                        ${!d.is_approved ? `<button class="btn btn-sm btn-primary" onclick="approveDoc('${d.id}')"><i class="fas fa-check"></i></button>` : ''}
                        <button class="btn btn-sm" onclick="editDocMeta('${d.id}')"><i class="fas fa-edit"></i></button>
                        <button class="btn btn-sm btn-danger" onclick="deleteDoc('${d.id}')"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>`).join('')}
                </tbody>
            </table></div>
        `;
    } catch (err) { content.innerHTML = '<div style="color:#ff4757;">Error: ' + escapeHtml(err.message) + '</div>'; }
}

async function approveDoc(id) {
    try {
        await apiFetch('/api/admin/documents/' + id + '/approve', { method: 'POST' });
        showToast('Document approved');
        loadAdminDocuments();
    } catch (err) { showToast(err.message, 'error'); }
}

async function deleteDoc(id) {
    if (!confirm('Delete this document permanently?')) return;
    try {
        await apiFetch('/api/admin/documents/' + id, { method: 'DELETE' });
        showToast('Document deleted');
        loadAdminDocuments();
    } catch (err) { showToast(err.message, 'error'); }
}

async function editDocMeta(id) {
    const docs = await apiFetch('/api/admin/documents');
    const doc = docs.find(d => d.id === id);
    if (!doc) return;
    const cats = await fetch(API + '/api/categories').then(r => r.json());

    const modal = document.getElementById('login-modal'); // reuse modal
    modal.querySelector('.modal').innerHTML = `
        <h3><i class="fas fa-edit" style="color:var(--accent);"></i> Edit Document</h3>
        <div class="form-group" style="margin-bottom:8px;"><label>Title</label><input type="text" id="edit-title" value="${escapeHtml(doc.title)}"></div>
        <div class="form-group" style="margin-bottom:8px;"><label>Author</label><input type="text" id="edit-author" value="${escapeHtml(doc.author || '')}"></div>
        <div class="form-group" style="margin-bottom:8px;"><label>Subject</label><input type="text" id="edit-subject" value="${escapeHtml(doc.subject || '')}"></div>
        <div class="form-group" style="margin-bottom:8px;"><label>Language</label><input type="text" id="edit-language" value="${escapeHtml(doc.language || '')}"></div>
        <div class="form-group" style="margin-bottom:8px;"><label>Year</label><input type="text" id="edit-year" value="${escapeHtml(doc.year || '')}"></div>
        <div class="form-group" style="margin-bottom:8px;"><label>Publisher</label><input type="text" id="edit-publisher" value="${escapeHtml(doc.publisher || '')}"></div>
        <div class="form-group" style="margin-bottom:8px;"><label>Publication Place</label><input type="text" id="edit-place" value="${escapeHtml(doc.publication_place || '')}"></div>
        <div class="form-group" style="margin-bottom:8px;"><label>Edition</label><input type="text" id="edit-edition" value="${escapeHtml(doc.edition || '')}"></div>
        <div class="form-group" style="margin-bottom:8px;"><label>Description</label><textarea id="edit-desc" rows="3">${escapeHtml(doc.description || '')}</textarea></div>
        <div style="display:flex;gap:8px;margin-top:12px;">
            <button class="btn btn-primary" onclick="saveDocEdit('${id}')" style="flex:1;">Save</button>
            <button class="btn" onclick="hideLoginModal();resetLoginModal();">Cancel</button>
        </div>
    `;
    modal.classList.add('active');
}

async function saveDocEdit(id) {
    try {
        await apiFetch('/api/admin/documents/' + id, {
            method: 'PATCH',
            body: JSON.stringify({
                title: document.getElementById('edit-title').value.trim(),
                author: document.getElementById('edit-author').value.trim(),
                subject: document.getElementById('edit-subject').value.trim(),
                language: document.getElementById('edit-language').value.trim(),
                year: document.getElementById('edit-year').value.trim(),
                publisher: document.getElementById('edit-publisher').value.trim(),
                publication_place: document.getElementById('edit-place').value.trim(),
                edition: document.getElementById('edit-edition').value.trim(),
                description: document.getElementById('edit-desc').value.trim()
            })
        });
        hideLoginModal();
        resetLoginModal();
        showToast('Document updated');
        loadAdminDocuments();
    } catch (err) { showToast(err.message, 'error'); }
}

function resetLoginModal() {
    document.getElementById('login-modal').querySelector('.modal').innerHTML = `
        <h3><i class="fas fa-lock" style="color:var(--accent);"></i> Login</h3>
        <div class="form-group" style="margin-bottom:12px;"><label>Email</label><input type="email" id="login-email" placeholder="admin@krrc.local"></div>
        <div class="form-group" style="margin-bottom:16px;"><label>Password</label><input type="password" id="login-password" placeholder="Password" onkeydown="if(event.key==='Enter')doLogin()"></div>
        <div style="display:flex;gap:8px;">
            <button class="btn btn-primary" onclick="doLogin()" style="flex:1;">Login</button>
            <button class="btn" onclick="hideLoginModal()">Cancel</button>
        </div>
        <p style="text-align:center;margin-top:12px;font-size:0.8rem;color:var(--text-muted);">Don't have an account? <a href="#" onclick="showRegisterModal()">Register</a></p>
    `;
}

async function loadAdminUsers() {
    const content = document.getElementById('admin-content');
    try {
        const users = await apiFetch('/api/admin/users');
        content.innerHTML = `
            <h2 style="font-family:var(--font-serif);margin-bottom:20px;">Users (${users.length})</h2>
            <table class="admin-table">
                <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>
                <tbody>
                ${users.map(u => `<tr>
                    <td>${escapeHtml(u.name)}</td>
                    <td>${escapeHtml(u.email)}</td>
                    <td>${u.role}</td>
                    <td>${u.is_approved ? '<span class="badge badge-approved">Approved</span>' : '<span class="badge badge-pending">Pending</span>'}</td>
                    <td>${new Date(u.created_at).toLocaleDateString()}</td>
                    <td>
                        ${!u.is_approved ? `<button class="btn btn-sm btn-primary" onclick="approveUser('${u.id}')"><i class="fas fa-check"></i></button>` : ''}
                        ${u.role !== 'admin' ? `<button class="btn btn-sm btn-danger" onclick="deleteUser('${u.id}')"><i class="fas fa-trash"></i></button>` : ''}
                    </td>
                </tr>`).join('')}
                </tbody>
            </table>
        `;
    } catch (err) { content.innerHTML = '<div style="color:#ff4757;">Error: ' + escapeHtml(err.message) + '</div>'; }
}

async function approveUser(id) {
    try { await apiFetch('/api/admin/users/' + id + '/approve', { method: 'POST' }); showToast('User approved'); loadAdminUsers(); } catch (err) { showToast(err.message, 'error'); }
}

async function deleteUser(id) {
    if (!confirm('Delete this user?')) return;
    try { await apiFetch('/api/admin/users/' + id, { method: 'DELETE' }); showToast('User deleted'); loadAdminUsers(); } catch (err) { showToast(err.message, 'error'); }
}

async function loadAdminCategories() {
    const content = document.getElementById('admin-content');
    try {
        const cats = await fetch(API + '/api/categories').then(r => r.json());
        content.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
                <h2 style="font-family:var(--font-serif);flex:1;margin:0;">Categories</h2>
                <button class="btn btn-primary btn-sm" onclick="addCategory()"><i class="fas fa-plus"></i> Add Category</button>
            </div>
            <table class="admin-table">
                <thead><tr><th>Name</th><th>Documents</th><th>Actions</th></tr></thead>
                <tbody>
                ${cats.map(c => `<tr>
                    <td><strong>${escapeHtml(c.name)}</strong><br><span style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(c.description || '')}</span></td>
                    <td>${c.doc_count || 0}</td>
                    <td><button class="btn btn-sm btn-danger" onclick="deleteCategory('${c.id}')"><i class="fas fa-trash"></i></button></td>
                </tr>`).join('')}
                </tbody>
            </table>
        `;
    } catch (err) { content.innerHTML = '<div style="color:#ff4757;">Error</div>'; }
}

async function addCategory() {
    const name = prompt('Category name:');
    if (!name) return;
    const desc = prompt('Description (optional):') || '';
    try { await apiFetch('/api/admin/categories', { method: 'POST', body: JSON.stringify({ name, description: desc }) }); showToast('Category added'); loadAdminCategories(); } catch (err) { showToast(err.message, 'error'); }
}

async function deleteCategory(id) {
    if (!confirm('Delete this category?')) return;
    try { await apiFetch('/api/admin/categories/' + id, { method: 'DELETE' }); showToast('Deleted'); loadAdminCategories(); } catch (err) { showToast(err.message, 'error'); }
}

// ===== FTP IMPORT =====
async function loadFtpImport() {
    const content = document.getElementById('admin-content');
    content.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner"></div></div>';
    try {
        const files = await apiFetch('/api/admin/ftp-files');
        const newFiles = files.filter(f => !f.imported);
        content.innerHTML = `
            <h2 style="font-family:var(--font-serif);margin-bottom:10px;">FTP Import</h2>
            <p style="color:var(--text-muted);margin-bottom:20px;">Upload PDF files via FTP, then import them here. FTP files are automatically detected.</p>
            <div style="background:var(--bg-card);padding:16px;border-radius:8px;margin-bottom:20px;border:1px solid var(--border);">
                <h4 style="margin-bottom:8px;">FTP Connection Details</h4>
                <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:0.9rem;">
                    <span style="color:var(--text-muted);">Host:</span><span>94.72.110.114</span>
                    <span style="color:var(--text-muted);">Username:</span><span>krrc-ftp</span>
                    <span style="color:var(--text-muted);">Password:</span><span>KRRCUpload2026!</span>
                    <span style="color:var(--text-muted);">Port:</span><span>21 (FTP)</span>
                </div>
            </div>
            ${newFiles.length > 0 ? `<button class="btn btn-primary" onclick="importAllFtp()" style="margin-bottom:16px;"><i class="fas fa-download"></i> Import All New Files (${newFiles.length})</button>` : ''}
            <div style="margin-bottom:8px;font-size:0.85rem;color:var(--text-muted);">${files.length} files found in FTP folder</div>
            <table class="admin-table">
                <thead><tr><th>Filename</th><th>Size</th><th>Date</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>${files.length === 0 ? '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);">No PDF files in FTP folder. Upload files via FTP first.</td></tr>' :
                    files.map(f => `<tr>
                        <td>${escapeHtml(f.name)}</td>
                        <td>${(f.size / 1024 / 1024).toFixed(1)} MB</td>
                        <td>${new Date(f.modified).toLocaleDateString()}</td>
                        <td>${f.imported ? '<span style="color:#4caf50;">Imported</span>' : '<span style="color:var(--accent);">New</span>'}</td>
                        <td>${f.imported ? '-' : `<button class="btn btn-sm" onclick="importFtpFile('${escapeHtml(f.name)}')"><i class="fas fa-download"></i> Import</button>`}</td>
                    </tr>`).join('')}
                </tbody>
            </table>`;
    } catch (err) { content.innerHTML = '<p style="color:#f44336;">Error: ' + escapeHtml(err.message) + '</p>'; }
}

async function importFtpFile(filename) {
    try {
        showToast('Importing ' + filename + '...', 'info');
        const result = await apiFetch('/api/admin/ftp-import', { method: 'POST', body: JSON.stringify({ filename }) });
        showToast('Imported: ' + result.title + ' (' + result.pages + ' pages)', 'success');
        loadFtpImport();
    } catch (err) { showToast(err.message, 'error'); }
}

async function importAllFtp() {
    try {
        showToast('Importing all files...', 'info');
        const result = await apiFetch('/api/admin/ftp-import-all', { method: 'POST' });
        showToast('Imported ' + result.imported + ' files, skipped ' + result.skipped, 'success');
        loadFtpImport();
    } catch (err) { showToast(err.message, 'error'); }
}

// ===== INIT =====
async function init() {
    updateAuthUI();
    loadHomePage();

    // Load filter options
    try {
        const cats = await fetch(API + '/api/categories').then(r => r.json());
        const catSelect = document.getElementById('filter-category');
        cats.forEach(c => { const opt = document.createElement('option'); opt.value = c.id; opt.textContent = c.name; catSelect.appendChild(opt); });
    } catch (e) {}

    // Add language options
    const langSelect = document.getElementById('filter-language');
    ['English', 'Kashmiri', 'Urdu', 'Hindi', 'Persian', 'Arabic', 'Punjabi', 'Sanskrit', 'Dogri'].forEach(l => {
        const opt = document.createElement('option'); opt.value = l; opt.textContent = l; langSelect.appendChild(opt);
    });
}

init();
