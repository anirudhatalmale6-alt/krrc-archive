const API = '/krrc';
let token = localStorage.getItem('krrc_token');
let user = JSON.parse(localStorage.getItem('krrc_user') || 'null');
let chatSessionId = localStorage.getItem('krrc_chat_session') || '';
let currentPage = 'home';
let browsePage = 1;
let analyticsSessionId = localStorage.getItem('krrc_analytics_session') || '';

// ===== ANALYTICS TRACKING =====
function trackPageView(page) {
    fetch(API + '/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, path: window.location.pathname, referrer: document.referrer, sessionId: analyticsSessionId })
    }).then(r => r.json()).then(d => {
        if (d.sessionId) { analyticsSessionId = d.sessionId; localStorage.setItem('krrc_analytics_session', d.sessionId); }
    }).catch(() => {});
}

// Load dynamic SEO keywords
fetch(API + '/api/seo/keywords').then(r => r.json()).then(keywords => {
    if (keywords.length > 0) {
        const meta = document.getElementById('meta-keywords');
        if (meta) meta.content = keywords.join(', ');
    }
}).catch(() => {});

// ===== HELPERS =====
function escapeHtml(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function renderMarkdown(text) {
    return escapeHtml(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/^- (.+)/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
        .replace(/\n/g, '<br>');
}
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
    trackPageView(page);

    if (page === 'home') loadHomePage();
    else if (page === 'browse') {
        if (!checkAccess('browse')) { document.getElementById('page-browse').querySelector('.container').innerHTML = showAccessGate('the Archive'); return; }
        loadBrowseOverview();
    }
    else if (page === 'tutorial') {
        if (!checkAccess('tutorial')) { document.getElementById('page-tutorial').querySelector('.container').innerHTML = showAccessGate('Tutorials'); return; }
        loadTutorialPage();
    }
    else if (page === 'upload') {
        if (!checkAccess('upload')) { document.getElementById('page-upload').querySelector('.container').innerHTML = showAccessGate('Upload'); return; }
    }
    else if (page === 'admin') loadAdminDashboard();

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
            <div class="cat-card" onclick="openChatbot()">
                <h3>${escapeHtml(c.name)}</h3>
                <div class="count">${c.doc_count || 0} documents</div>
            </div>
        `).join('');
        document.getElementById('stat-categories').textContent = cats.length;
        // Total doc count from categories
        const totalDocs = cats.reduce((sum, c) => sum + (c.doc_count || 0), 0);
        document.getElementById('stat-docs').textContent = totalDocs;
    } catch (e) {}

    // Load archive stats (counts only, no document details)
    try {
        const stats = await fetch(API + '/api/stats').then(r => r.json());
        if (stats.total_docs) document.getElementById('stat-docs').textContent = stats.total_docs;
        if (stats.total_pages) document.getElementById('stat-pages').textContent = stats.total_pages > 1000 ? Math.round(stats.total_pages / 1000) + 'K+' : stats.total_pages;
        if (stats.languages) document.getElementById('stat-languages').textContent = stats.languages;
    } catch (e) {}
}

// ===== BROWSE =====
async function loadBrowseOverview() {
    try {
        const cats = await fetch(API + '/api/categories').then(r => r.json());
        const grid = document.getElementById('browse-categories');
        grid.innerHTML = cats.map(c => `
            <div class="cat-card" onclick="openChatbot()">
                <h3>${escapeHtml(c.name)}</h3>
                <div class="count">${c.doc_count || 0} documents</div>
            </div>
        `).join('');
    } catch (e) {}
}

function heroSearch() {
    const q = document.getElementById('hero-search').value.trim();
    if (!q) return;
    // Open the chatbot panel and send the search as a chat message
    const panel = document.getElementById('chatbot-panel');
    if (!panel.classList.contains('open')) panel.classList.add('open');
    setTimeout(() => {
        const input = document.getElementById('chat-input');
        if (input) { input.value = q; sendChat(); }
    }, 200);
}

function openChatbot() {
    if (!checkAccess('chatbot')) {
        showToast('Login required to use KRRC Ai', 'error');
        showLoginModal();
        return;
    }
    const panel = document.getElementById('chatbot-panel');
    if (!panel.classList.contains('open')) panel.classList.add('open');
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
        const icon = f.type.startsWith('image/') ? 'fa-image' : f.type.startsWith('audio/') ? 'fa-music' : f.type.startsWith('video/') ? 'fa-video' : f.name.match(/\.(epub|mobi|azw)/i) ? 'fa-book' : 'fa-file-pdf';
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
                const icon = f.type.startsWith('image/') ? 'fa-image' : f.type.startsWith('audio/') ? 'fa-music' : f.type.startsWith('video/') ? 'fa-video' : f.name.match(/\.(epub|mobi|azw)/i) ? 'fa-book' : 'fa-file-pdf';
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
    if (!checkAccess('chatbot')) {
        showToast('Login required to use KRRC Ai', 'error');
        showLoginModal();
        return;
    }
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
        document.getElementById('chat-loading').innerHTML = renderMarkdown(data.reply);
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
    else if (tab === 'perspectives') loadAdminPerspectives();
    else if (tab === 'policies') loadAdminPolicies();
    else if (tab === 'access') loadAdminAccessControl();
    else if (tab === 'tutorials') loadAdminTutorials();
    else if (tab === 'seo') loadAdminSEO();
    else if (tab === 'analytics') loadAdminAnalytics();
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
                        ${!d.is_approved ? `<button class="btn btn-sm btn-primary" onclick="approveDoc('${d.id}')" title="Approve"><i class="fas fa-check"></i></button>` : ''}
                        <button class="btn btn-sm" onclick="recategoriseDoc('${d.id}')" title="AI Re-categorise"><i class="fas fa-robot"></i></button>
                        <button class="btn btn-sm" onclick="editDocMeta('${d.id}')" title="Edit"><i class="fas fa-edit"></i></button>
                        <button class="btn btn-sm btn-danger" onclick="deleteDoc('${d.id}')" title="Delete"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>`).join('')}
                </tbody>
            </table></div>
        `;
    } catch (err) { content.innerHTML = '<div style="color:#ff4757;">Error: ' + escapeHtml(err.message) + '</div>'; }
}

async function recategoriseDoc(id) {
    showToast('Running AI categorisation...', 'info');
    try {
        const result = await apiFetch('/api/admin/documents/' + id + '/recategorise', { method: 'POST' });
        if (result.success) {
            const src = result.source === 'epub_metadata' ? 'EPUB metadata' : 'AI';
            showToast('Re-categorised using ' + src + '. Title: ' + (result.updates.title || 'unchanged'), 'success');
            loadAdminDocuments();
        } else {
            showToast(result.message || 'Could not categorise', 'error');
        }
    } catch (err) { showToast(err.message, 'error'); }
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
    const [cats, persps, docPersps] = await Promise.all([
        fetch(API + '/api/categories').then(r => r.json()),
        fetch(API + '/api/perspectives').then(r => r.json()),
        fetch(API + '/api/documents/' + id + '/perspectives').then(r => r.json())
    ]);
    const docPerspIds = docPersps.map(p => p.id);

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
        <div class="form-group" style="margin-bottom:8px;"><label>Perspectives</label>
            <div style="display:flex;flex-wrap:wrap;gap:8px;" id="edit-perspectives">
                ${persps.map(p => `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;padding:4px 10px;border-radius:16px;border:1px solid ${p.color};font-size:0.85rem;">
                    <input type="checkbox" value="${p.id}" ${docPerspIds.includes(p.id) ? 'checked' : ''} style="accent-color:${p.color};">
                    <span style="color:${p.color};">${escapeHtml(p.name)}</span>
                </label>`).join('')}
            </div>
        </div>
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
        // Save perspectives
        const perspCheckboxes = document.querySelectorAll('#edit-perspectives input[type="checkbox"]');
        const perspIds = Array.from(perspCheckboxes).filter(c => c.checked).map(c => c.value);
        await apiFetch('/api/admin/documents/' + id + '/perspectives', {
            method: 'POST',
            body: JSON.stringify({ perspective_ids: perspIds })
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
                    <td><strong>${escapeHtml(u.name)}</strong></td>
                    <td>${escapeHtml(u.email)}</td>
                    <td>
                        ${u.role === 'admin' ? '<span class="badge badge-book">Admin</span>' :
                        `<select onchange="changeUserRole('${u.id}', this.value)" style="width:auto;padding:4px 8px;font-size:0.8rem;">
                            <option value="member" ${u.role === 'member' ? 'selected' : ''}>Member</option>
                            <option value="admin">Admin</option>
                        </select>`}
                    </td>
                    <td>${u.is_approved ? '<span class="badge badge-approved">Approved</span>' : '<span class="badge badge-pending">Pending</span>'}</td>
                    <td>${new Date(u.created_at).toLocaleDateString()}</td>
                    <td style="display:flex;gap:4px;flex-wrap:wrap;">
                        ${!u.is_approved ? `<button class="btn btn-sm" style="background:#2ed573;color:#fff;" onclick="approveUser('${u.id}')" title="Approve"><i class="fas fa-check"></i></button>` : ''}
                        <button class="btn btn-sm" onclick="showResetPassword('${u.id}', '${escapeHtml(u.name)}')" title="Reset Password"><i class="fas fa-key"></i></button>
                        ${u.role !== 'admin' ? `<button class="btn btn-sm" style="background:#ff4757;color:#fff;" onclick="deleteUser('${u.id}')" title="Delete"><i class="fas fa-trash"></i></button>` : ''}
                    </td>
                </tr>`).join('')}
                </tbody>
            </table>

            <div id="reset-password-panel" class="hidden" style="background:var(--card-bg);border-radius:8px;padding:20px;margin-top:20px;border:1px solid var(--accent);">
                <h3 style="margin-bottom:12px;"><i class="fas fa-key" style="color:var(--accent);"></i> Reset Password for <span id="reset-user-name"></span></h3>
                <input type="hidden" id="reset-user-id">
                <div style="display:flex;gap:8px;align-items:center;">
                    <input type="password" id="reset-new-password" placeholder="New password (min 8 chars)" style="flex:1;">
                    <button class="btn btn-accent" onclick="resetPassword()"><i class="fas fa-save"></i> Reset</button>
                    <button class="btn btn-sm" onclick="document.getElementById('reset-password-panel').classList.add('hidden')"><i class="fas fa-times"></i></button>
                </div>
                <p style="font-size:0.8rem;color:var(--text-muted);margin-top:8px;">Password must be at least 8 characters with uppercase, lowercase, and a number.</p>
            </div>
        `;
    } catch (err) { content.innerHTML = '<div style="color:#ff4757;">Error: ' + escapeHtml(err.message) + '</div>'; }
}

function showResetPassword(id, name) {
    document.getElementById('reset-password-panel').classList.remove('hidden');
    document.getElementById('reset-user-id').value = id;
    document.getElementById('reset-user-name').textContent = name;
    document.getElementById('reset-new-password').value = '';
    document.getElementById('reset-new-password').focus();
}

async function resetPassword() {
    const id = document.getElementById('reset-user-id').value;
    const newPassword = document.getElementById('reset-new-password').value;
    if (!newPassword || newPassword.length < 8) { showToast('Password must be at least 8 characters', 'error'); return; }
    try {
        await apiFetch('/api/admin/users/' + id + '/reset-password', { method: 'POST', body: JSON.stringify({ newPassword }) });
        showToast('Password reset successfully');
        document.getElementById('reset-password-panel').classList.add('hidden');
    } catch (err) { showToast(err.message, 'error'); }
}

async function changeUserRole(id, role) {
    try {
        await apiFetch('/api/admin/users/' + id + '/role', { method: 'POST', body: JSON.stringify({ role }) });
        showToast('Role updated to ' + role);
        loadAdminUsers();
    } catch (err) { showToast(err.message, 'error'); }
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

// ===== SEO / KEYWORDS ADMIN =====
async function loadAdminSEO() {
    const content = document.getElementById('admin-content');
    content.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner"></div></div>';
    try {
        const [keywords, settings] = await Promise.all([
            apiFetch('/api/admin/keywords'),
            apiFetch('/api/admin/seo-settings')
        ]);
        content.innerHTML = `
            <h2 style="font-family:var(--font-serif);margin-bottom:20px;">SEO & Keywords</h2>

            <div style="background:var(--card-bg);border-radius:8px;padding:20px;margin-bottom:24px;">
                <h3 style="margin-bottom:16px;">Site SEO Settings</h3>
                <div style="display:grid;gap:12px;">
                    <div><label style="font-size:0.85rem;color:var(--text-secondary);">Meta Title</label>
                        <input type="text" id="seo-title" value="${escapeHtml(settings.seo_title || '')}" placeholder="KRRC - Kashmir Research & Resource Center" style="width:100%;"></div>
                    <div><label style="font-size:0.85rem;color:var(--text-secondary);">Meta Description</label>
                        <textarea id="seo-description" rows="3" style="width:100%;" placeholder="A digital archive of Kashmir-related documents...">${escapeHtml(settings.seo_description || '')}</textarea></div>
                    <div><label style="font-size:0.85rem;color:var(--text-secondary);">Google Analytics ID (e.g. G-XXXXXXX)</label>
                        <input type="text" id="seo-ga-id" value="${escapeHtml(settings.seo_google_analytics_id || '')}" placeholder="G-XXXXXXXXXX" style="width:100%;"></div>
                    <div><label style="font-size:0.85rem;color:var(--text-secondary);">Google Search Console Verification Code</label>
                        <input type="text" id="seo-gsc" value="${escapeHtml(settings.seo_google_search_console || '')}" placeholder="Verification meta tag content" style="width:100%;"></div>
                    <button class="btn btn-accent" onclick="saveSEOSettings()" style="width:fit-content;"><i class="fas fa-save"></i> Save Settings</button>
                </div>
            </div>

            <div style="background:var(--card-bg);border-radius:8px;padding:20px;margin-bottom:24px;">
                <h3 style="margin-bottom:16px;">SEO Keywords <span style="color:var(--text-muted);font-size:0.85rem;">(${keywords.length})</span></h3>
                <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:12px;">Keywords are injected into the page meta tags for search engine optimization.</p>
                <div style="display:flex;gap:8px;margin-bottom:16px;">
                    <input type="text" id="new-keyword" placeholder="Add a keyword..." style="flex:1;">
                    <input type="number" id="new-keyword-priority" placeholder="Priority" style="width:80px;" min="0" max="100" value="0">
                    <button class="btn btn-accent" onclick="addKeyword()"><i class="fas fa-plus"></i> Add</button>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:8px;">
                    ${keywords.map(k => `
                        <span style="background:var(--bg-secondary);border:1px solid var(--accent);border-radius:20px;padding:6px 14px;font-size:0.85rem;display:flex;align-items:center;gap:8px;">
                            ${escapeHtml(k.keyword)}
                            ${k.priority > 0 ? `<span style="color:var(--accent);font-size:0.7rem;">(${k.priority})</span>` : ''}
                            <button onclick="deleteKeyword('${k.id}')" style="background:none;border:none;color:#ff4757;cursor:pointer;padding:0;font-size:0.8rem;"><i class="fas fa-times"></i></button>
                        </span>
                    `).join('')}
                    ${keywords.length === 0 ? '<span style="color:var(--text-muted);">No keywords yet. Add some to improve SEO.</span>' : ''}
                </div>
            </div>

            <div style="background:var(--card-bg);border-radius:8px;padding:20px;">
                <h3 style="margin-bottom:12px;">SEO Resources</h3>
                <div style="font-size:0.9rem;color:var(--text-secondary);line-height:1.8;">
                    <p><i class="fas fa-link" style="color:var(--accent);margin-right:8px;"></i> Sitemap: <a href="/krrc/sitemap.xml" target="_blank" style="color:var(--accent);">/krrc/sitemap.xml</a></p>
                    <p><i class="fas fa-robot" style="color:var(--accent);margin-right:8px;"></i> Robots.txt: <a href="/krrc/robots.txt" target="_blank" style="color:var(--accent);">/krrc/robots.txt</a></p>
                </div>
            </div>
        `;
    } catch (err) { content.innerHTML = '<div style="color:#ff4757;">Error: ' + escapeHtml(err.message) + '</div>'; }
}

async function saveSEOSettings() {
    try {
        await apiFetch('/api/admin/seo-settings', { method: 'POST', body: JSON.stringify({
            seo_title: document.getElementById('seo-title').value,
            seo_description: document.getElementById('seo-description').value,
            google_analytics_id: document.getElementById('seo-ga-id').value,
            google_search_console: document.getElementById('seo-gsc').value
        })});
        showToast('SEO settings saved');
    } catch (err) { showToast(err.message, 'error'); }
}

async function addKeyword() {
    const keyword = document.getElementById('new-keyword').value.trim();
    const priority = parseInt(document.getElementById('new-keyword-priority').value) || 0;
    if (!keyword) return;
    try {
        await apiFetch('/api/admin/keywords', { method: 'POST', body: JSON.stringify({ keyword, priority }) });
        showToast('Keyword added');
        loadAdminSEO();
    } catch (err) { showToast(err.message, 'error'); }
}

async function deleteKeyword(id) {
    try {
        await apiFetch('/api/admin/keywords/' + id, { method: 'DELETE' });
        showToast('Keyword removed');
        loadAdminSEO();
    } catch (err) { showToast(err.message, 'error'); }
}

// ===== ANALYTICS ADMIN =====
async function loadAdminAnalytics() {
    const content = document.getElementById('admin-content');
    content.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner"></div></div>';
    try {
        const data = await apiFetch('/api/admin/analytics?days=' + _analyticsDays);
        content.innerHTML = `
            <h2 style="font-family:var(--font-serif);margin-bottom:20px;">Analytics (Last ${data.days} Days)</h2>
            <div style="display:flex;gap:8px;margin-bottom:20px;">
                <button class="btn btn-sm ${data.days === 7 ? 'btn-accent' : ''}" onclick="loadAnalyticsPeriod(7)">7 Days</button>
                <button class="btn btn-sm ${data.days === 30 ? 'btn-accent' : ''}" onclick="loadAnalyticsPeriod(30)">30 Days</button>
                <button class="btn btn-sm ${data.days === 90 ? 'btn-accent' : ''}" onclick="loadAnalyticsPeriod(90)">90 Days</button>
            </div>
            <div class="stat-grid">
                <div class="stat-card"><div class="stat-num">${data.totalViews}</div><div class="stat-label">Page Views</div></div>
                <div class="stat-card"><div class="stat-num">${data.uniqueVisitors}</div><div class="stat-label">Unique Visitors</div></div>
                <div class="stat-card"><div class="stat-num">${data.chatSessions}</div><div class="stat-label">Chat Sessions</div></div>
                <div class="stat-card"><div class="stat-num">${data.chatMessages}</div><div class="stat-label">Chat Messages</div></div>
            </div>

            ${data.dailyViews.length > 0 ? `
            <div style="background:var(--card-bg);border-radius:8px;padding:20px;margin-top:24px;">
                <h3 style="margin-bottom:16px;">Daily Traffic</h3>
                <div style="display:flex;align-items:flex-end;gap:4px;height:150px;overflow-x:auto;">
                    ${data.dailyViews.map(d => {
                        const maxViews = Math.max(...data.dailyViews.map(x => x.views), 1);
                        const height = Math.max((d.views / maxViews) * 130, 4);
                        return `<div style="display:flex;flex-direction:column;align-items:center;min-width:30px;" title="${d.date}: ${d.views} views, ${d.visitors} visitors">
                            <span style="font-size:0.65rem;color:var(--text-muted);">${d.views}</span>
                            <div style="width:20px;height:${height}px;background:var(--accent);border-radius:3px 3px 0 0;"></div>
                            <span style="font-size:0.6rem;color:var(--text-muted);transform:rotate(-45deg);white-space:nowrap;margin-top:4px;">${d.date.substring(5)}</span>
                        </div>`;
                    }).join('')}
                </div>
            </div>` : ''}

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:20px;">
                <div style="background:var(--card-bg);border-radius:8px;padding:20px;">
                    <h3 style="margin-bottom:12px;">Top Pages</h3>
                    ${data.pageBreakdown.length > 0 ? `<table class="admin-table"><thead><tr><th>Page</th><th>Views</th></tr></thead><tbody>
                        ${data.pageBreakdown.map(p => `<tr><td>${escapeHtml(p.page)}</td><td>${p.views}</td></tr>`).join('')}
                    </tbody></table>` : '<span style="color:var(--text-muted);">No data yet</span>'}
                </div>
                <div style="background:var(--card-bg);border-radius:8px;padding:20px;">
                    <h3 style="margin-bottom:12px;">Browsers</h3>
                    ${data.browsers.length > 0 ? `<table class="admin-table"><thead><tr><th>Browser</th><th>Visits</th></tr></thead><tbody>
                        ${data.browsers.map(b => `<tr><td>${escapeHtml(b.browser)}</td><td>${b.cnt}</td></tr>`).join('')}
                    </tbody></table>` : '<span style="color:var(--text-muted);">No data yet</span>'}
                </div>
            </div>

            ${data.referrers.length > 0 ? `
            <div style="background:var(--card-bg);border-radius:8px;padding:20px;margin-top:20px;">
                <h3 style="margin-bottom:12px;">Top Referrers</h3>
                <table class="admin-table"><thead><tr><th>Source</th><th>Visits</th></tr></thead><tbody>
                    ${data.referrers.map(r => `<tr><td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.referrer)}</td><td>${r.cnt}</td></tr>`).join('')}
                </tbody></table>
            </div>` : ''}
        `;
    } catch (err) { content.innerHTML = '<div style="color:#ff4757;">Error: ' + escapeHtml(err.message) + '</div>'; }
}

let _analyticsDays = 30;
async function loadAnalyticsPeriod(days) {
    _analyticsDays = days;
    loadAdminAnalytics();
}

// ===== ADMIN TUTORIALS =====
async function loadAdminTutorials() {
    const content = document.getElementById('admin-content');
    content.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner"></div></div>';
    try {
        const tutorials = await apiFetch('/api/admin/tutorials');
        const frontend = tutorials.filter(t => t.section === 'frontend');
        const admin = tutorials.filter(t => t.section === 'admin');
        content.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
                <h2 style="font-family:var(--font-serif);flex:1;margin:0;">Tutorials (${tutorials.length})</h2>
                <button class="btn btn-accent" onclick="showTutorialForm()"><i class="fas fa-plus"></i> Add Tutorial Step</button>
            </div>

            <div id="tutorial-form-panel" class="hidden" style="background:var(--card-bg);border-radius:8px;padding:20px;margin-bottom:24px;border:1px solid var(--accent);">
                <h3 id="tutorial-form-title">Add Tutorial Step</h3>
                <input type="hidden" id="edit-tutorial-id" value="">
                <div style="display:grid;gap:12px;margin-top:12px;">
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                        <div><label style="font-size:0.85rem;color:var(--text-secondary);">Title</label>
                            <input type="text" id="tut-title" placeholder="e.g., How to Search the Archive"></div>
                        <div><label style="font-size:0.85rem;color:var(--text-secondary);">Section</label>
                            <select id="tut-section">
                                <option value="frontend">Frontend (Public)</option>
                                <option value="admin">Admin (Members Only)</option>
                            </select></div>
                    </div>
                    <div><label style="font-size:0.85rem;color:var(--text-secondary);">Short Description</label>
                        <input type="text" id="tut-description" placeholder="Brief description of this step"></div>
                    <div><label style="font-size:0.85rem;color:var(--text-secondary);">Screenshot</label>
                        <input type="file" id="tut-screenshot" accept="image/*"></div>
                    <div><label style="font-size:0.85rem;color:var(--text-secondary);">Content (Detailed Explanation)</label>
                        <textarea id="tut-content" rows="6" placeholder="Write a detailed step-by-step explanation. Use plain text."></textarea></div>
                    <div style="display:flex;gap:8px;align-items:center;">
                        <label style="font-size:0.85rem;color:var(--text-secondary);">Sort Order:</label>
                        <input type="number" id="tut-order" value="0" style="width:80px;" min="0">
                    </div>
                    <div style="display:flex;gap:8px;">
                        <button class="btn btn-accent" onclick="saveTutorial()"><i class="fas fa-save"></i> Save</button>
                        <button class="btn btn-sm" onclick="document.getElementById('tutorial-form-panel').classList.add('hidden')"><i class="fas fa-times"></i> Cancel</button>
                    </div>
                </div>
            </div>

            ${frontend.length > 0 ? `<h3 style="margin-bottom:12px;color:var(--accent);"><i class="fas fa-desktop"></i> Frontend Guide (${frontend.length})</h3>
            <div style="display:grid;gap:8px;margin-bottom:24px;">${frontend.map(t => renderAdminTutorialCard(t)).join('')}</div>` : ''}

            ${admin.length > 0 ? `<h3 style="margin-bottom:12px;color:var(--accent);"><i class="fas fa-lock"></i> Admin Guide (${admin.length})</h3>
            <div style="display:grid;gap:8px;">${admin.map(t => renderAdminTutorialCard(t)).join('')}</div>` : ''}

            ${tutorials.length === 0 ? '<div style="text-align:center;padding:40px;color:var(--text-muted);"><i class="fas fa-graduation-cap" style="font-size:2rem;margin-bottom:12px;display:block;"></i>No tutorials yet. Click "Add Tutorial Step" to create one.</div>' : ''}
        `;
    } catch (err) { content.innerHTML = '<div style="color:#ff4757;">Error: ' + escapeHtml(err.message) + '</div>'; }
}

function renderAdminTutorialCard(t) {
    return `<div style="background:var(--bg-secondary);border-radius:8px;padding:12px 16px;display:flex;align-items:center;gap:12px;">
        <span style="background:var(--accent);color:var(--bg-primary);width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.8rem;flex-shrink:0;">${t.sort_order}</span>
        ${t.screenshot_path ? `<img src="${t.screenshot_path}" style="width:60px;height:40px;border-radius:4px;object-fit:cover;flex-shrink:0;">` : '<div style="width:60px;height:40px;border-radius:4px;background:var(--card-bg);display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i class="fas fa-image" style="color:var(--text-muted);"></i></div>'}
        <div style="flex:1;min-width:0;">
            <div style="font-weight:600;">${escapeHtml(t.title)}</div>
            <div style="font-size:0.8rem;color:var(--text-muted);">${escapeHtml(t.description || '')}</div>
        </div>
        <span class="badge ${t.is_published ? 'badge-approved' : 'badge-pending'}">${t.is_published ? 'Published' : 'Draft'}</span>
        <button class="btn btn-sm" onclick="editTutorial('${t.id}')" title="Edit"><i class="fas fa-edit"></i></button>
        <button class="btn btn-sm" style="background:#ff4757;color:#fff;" onclick="deleteTutorial('${t.id}')" title="Delete"><i class="fas fa-trash"></i></button>
    </div>`;
}

function showTutorialForm(editing) {
    document.getElementById('tutorial-form-panel').classList.remove('hidden');
    document.getElementById('tutorial-form-title').textContent = editing ? 'Edit Tutorial Step' : 'Add Tutorial Step';
    if (!editing) {
        document.getElementById('edit-tutorial-id').value = '';
        document.getElementById('tut-title').value = '';
        document.getElementById('tut-description').value = '';
        document.getElementById('tut-content').value = '';
        document.getElementById('tut-section').value = 'frontend';
        document.getElementById('tut-order').value = '0';
        document.getElementById('tut-screenshot').value = '';
    }
}

async function editTutorial(id) {
    try {
        const tutorials = await apiFetch('/api/admin/tutorials');
        const t = tutorials.find(x => x.id === id);
        if (!t) return;
        document.getElementById('edit-tutorial-id').value = t.id;
        document.getElementById('tut-title').value = t.title;
        document.getElementById('tut-description').value = t.description || '';
        document.getElementById('tut-content').value = t.content || '';
        document.getElementById('tut-section').value = t.section;
        document.getElementById('tut-order').value = t.sort_order;
        showTutorialForm(true);
    } catch (err) { showToast(err.message, 'error'); }
}

async function saveTutorial() {
    const id = document.getElementById('edit-tutorial-id').value;
    const formData = new FormData();
    formData.append('title', document.getElementById('tut-title').value);
    formData.append('description', document.getElementById('tut-description').value);
    formData.append('content', document.getElementById('tut-content').value);
    formData.append('section', document.getElementById('tut-section').value);
    formData.append('sort_order', document.getElementById('tut-order').value);
    const file = document.getElementById('tut-screenshot').files[0];
    if (file) formData.append('screenshot', file);

    try {
        const url = id ? API + '/api/admin/tutorials/' + id : API + '/api/admin/tutorials';
        const method = id ? 'PUT' : 'POST';
        const resp = await fetch(url, { method, headers: { 'Authorization': 'Bearer ' + token }, body: formData });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Failed');
        showToast(id ? 'Tutorial updated' : 'Tutorial added');
        document.getElementById('tutorial-form-panel').classList.add('hidden');
        loadAdminTutorials();
    } catch (err) { showToast(err.message, 'error'); }
}

async function deleteTutorial(id) {
    if (!confirm('Delete this tutorial step?')) return;
    try {
        await apiFetch('/api/admin/tutorials/' + id, { method: 'DELETE' });
        showToast('Tutorial deleted');
        loadAdminTutorials();
    } catch (err) { showToast(err.message, 'error'); }
}

// ===== FRONTEND TUTORIAL PAGE =====
let tutorialData = [];
let currentTutorial = null;

async function loadTutorialPage() {
    try {
        const tutorials = await fetch(API + '/api/tutorials').then(r => r.json());
        tutorialData = tutorials;
        const frontend = tutorials.filter(t => t.section === 'frontend');
        const admin = tutorials.filter(t => t.section === 'admin');

        // Build sidebar
        const frontendList = document.getElementById('tutorial-list-frontend');
        frontendList.innerHTML = frontend.map((t, i) => `
            <div class="tutorial-item" data-id="${t.id}" onclick="showTutorialStep('${t.id}')">
                <span class="tutorial-num">${i + 1}</span>
                <span>${escapeHtml(t.title)}</span>
            </div>
        `).join('') || '<div style="padding:10px;color:var(--text-muted);font-size:0.85rem;">No frontend tutorials yet.</div>';

        // Admin tutorials - show only if logged in
        const adminHeader = document.getElementById('tutorial-admin-header');
        const adminList = document.getElementById('tutorial-list-admin');
        if (admin.length > 0 && user) {
            adminHeader.style.display = '';
            adminList.style.display = '';
            adminList.innerHTML = admin.map((t, i) => `
                <div class="tutorial-item" data-id="${t.id}" onclick="showTutorialStep('${t.id}')">
                    <span class="tutorial-num">${i + 1}</span>
                    <span>${escapeHtml(t.title)}</span>
                </div>
            `).join('');
        } else if (admin.length > 0) {
            adminHeader.style.display = '';
            adminList.style.display = '';
            adminList.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:0.85rem;"><i class="fas fa-lock"></i> Login to view admin tutorials.</div>';
        } else {
            adminHeader.style.display = 'none';
            adminList.style.display = 'none';
        }

        // Auto-show first tutorial
        if (frontend.length > 0 && !currentTutorial) {
            showTutorialStep(frontend[0].id);
        }
    } catch (e) { console.error('Tutorial load error:', e); }
}

async function showTutorialStep(id) {
    const t = tutorialData.find(x => x.id === id);
    if (!t) return;

    // Check admin access
    if (t.section === 'admin' && !user) {
        document.getElementById('tutorial-content').innerHTML = `
            <div style="text-align:center;padding:60px 20px;">
                <i class="fas fa-lock" style="font-size:3rem;color:var(--accent);margin-bottom:16px;display:block;"></i>
                <h3>Members Only</h3>
                <p style="color:var(--text-secondary);">Please login to view admin tutorials.</p>
                <button class="btn btn-accent" onclick="showLoginModal()" style="margin-top:16px;">Login</button>
            </div>`;
        return;
    }

    currentTutorial = id;

    // Highlight active sidebar item
    document.querySelectorAll('.tutorial-item').forEach(el => el.classList.remove('active'));
    const activeItem = document.querySelector(`.tutorial-item[data-id="${id}"]`);
    if (activeItem) activeItem.classList.add('active');

    // Find prev/next
    const sectionTutorials = tutorialData.filter(x => x.section === t.section);
    const idx = sectionTutorials.findIndex(x => x.id === id);
    const prev = idx > 0 ? sectionTutorials[idx - 1] : null;
    const next = idx < sectionTutorials.length - 1 ? sectionTutorials[idx + 1] : null;

    const contentEl = document.getElementById('tutorial-content');
    contentEl.innerHTML = `
        <h2>${escapeHtml(t.title)}</h2>
        ${t.description ? `<p style="color:var(--text-secondary);margin-bottom:16px;">${escapeHtml(t.description)}</p>` : ''}
        ${t.screenshot_path ? `<img src="${t.screenshot_path}" alt="${escapeHtml(t.title)}">` : ''}
        <div class="tutorial-step-text">${escapeHtml(t.content || '').replace(/\n/g, '<br>')}</div>
        <div class="tutorial-nav">
            ${prev ? `<button class="btn btn-sm" onclick="showTutorialStep('${prev.id}')"><i class="fas fa-arrow-left"></i> ${escapeHtml(prev.title)}</button>` : '<div></div>'}
            ${next ? `<button class="btn btn-sm btn-accent" onclick="showTutorialStep('${next.id}')">${escapeHtml(next.title)} <i class="fas fa-arrow-right"></i></button>` : '<div></div>'}
        </div>
    `;
    contentEl.scrollTo(0, 0);
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

// ===== POLICY PAGE =====
async function loadPolicyPage() {
    const perspDiv = document.getElementById('policy-perspectives');
    const contentDiv = document.getElementById('policy-content');
    try {
        const [persps, policies] = await Promise.all([
            fetch(API + '/api/perspectives').then(r => r.json()),
            fetch(API + '/api/policies').then(r => r.json())
        ]);

        // Perspective cards with doc counts
        const perspStatsPromises = persps.map(p => fetch(API + '/api/perspectives/' + p.slug + '/stats').then(r => r.json()).catch(() => ({ doc_count: 0 })));
        const perspStats = await Promise.all(perspStatsPromises);

        perspDiv.innerHTML = persps.map((p, i) => `
            <div style="background:rgba(${hexToRgb(p.color)},0.1);border:1px solid ${p.color};border-radius:12px;padding:16px 24px;text-align:center;min-width:160px;cursor:pointer;" onclick="scrollToPerspective('${p.slug}')">
                <div style="font-size:1.1rem;font-weight:600;color:${p.color};margin-bottom:4px;">${escapeHtml(p.name)}</div>
                <div style="font-size:0.8rem;color:var(--text-muted);">${perspStats[i].doc_count || 0} documents</div>
            </div>
        `).join('');

        // Group policies by perspective
        const sections = ['aims', 'objectives', 'general'];
        const sectionLabels = { aims: 'Aims', objectives: 'Objectives', general: 'General Policy' };
        let html = '';

        persps.forEach(p => {
            const perspPolicies = policies.filter(pol => pol.perspective_id === p.id);
            if (perspPolicies.length === 0) return;
            html += `<div id="persp-${p.slug}" style="border-left:4px solid ${p.color};padding-left:20px;margin-bottom:24px;">
                <h3 style="color:${p.color};font-family:var(--font-serif);font-size:1.3rem;margin-bottom:12px;">${escapeHtml(p.name)}</h3>
                ${p.description ? `<p style="color:var(--text-secondary);font-size:0.9rem;margin-bottom:16px;">${escapeHtml(p.description)}</p>` : ''}`;
            sections.forEach(sec => {
                const secPolicies = perspPolicies.filter(pol => pol.section === sec);
                if (secPolicies.length === 0) return;
                html += `<h4 style="color:var(--text-primary);margin:12px 0 8px;font-size:1rem;">${sectionLabels[sec]}</h4>`;
                secPolicies.forEach(pol => {
                    html += `<div style="background:var(--bg-secondary);border-radius:8px;padding:16px;margin-bottom:8px;">
                        <h5 style="color:var(--accent);margin-bottom:6px;">${escapeHtml(pol.title)}</h5>
                        ${pol.content ? `<div style="color:var(--text-secondary);font-size:0.9rem;line-height:1.7;">${escapeHtml(pol.content).replace(/\n/g, '<br>')}</div>` : ''}
                    </div>`;
                });
            });
            html += '</div>';
        });

        // General policies (no perspective)
        const generalPolicies = policies.filter(pol => !pol.perspective_id);
        if (generalPolicies.length > 0) {
            html += `<div style="border-left:4px solid var(--accent);padding-left:20px;margin-bottom:24px;">
                <h3 style="color:var(--accent);font-family:var(--font-serif);font-size:1.3rem;margin-bottom:12px;">General</h3>`;
            generalPolicies.forEach(pol => {
                html += `<div style="background:var(--bg-secondary);border-radius:8px;padding:16px;margin-bottom:8px;">
                    <h5 style="color:var(--accent);margin-bottom:6px;">${escapeHtml(pol.title)}</h5>
                    ${pol.content ? `<div style="color:var(--text-secondary);font-size:0.9rem;line-height:1.7;">${escapeHtml(pol.content).replace(/\n/g, '<br>')}</div>` : ''}
                </div>`;
            });
            html += '</div>';
        }

        if (!html) {
            html = '<div style="text-align:center;padding:40px;color:var(--text-muted);"><i class="fas fa-scroll" style="font-size:2rem;margin-bottom:12px;display:block;"></i>Policy content is being prepared. Check back soon.</div>';
        }

        contentDiv.innerHTML = html;
    } catch (e) { contentDiv.innerHTML = '<div style="color:var(--text-muted);text-align:center;">Could not load policy content.</div>'; }
}

function hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return r + ',' + g + ',' + b;
}

function scrollToPerspective(slug) {
    const el = document.getElementById('persp-' + slug);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ===== ADMIN PERSPECTIVES =====
async function loadAdminPerspectives() {
    const content = document.getElementById('admin-content');
    content.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner"></div></div>';
    try {
        const persps = await fetch(API + '/api/perspectives').then(r => r.json());
        content.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
                <h2 style="font-family:var(--font-serif);flex:1;margin:0;">Perspectives (${persps.length})</h2>
                <button class="btn btn-accent" onclick="showPerspectiveForm()"><i class="fas fa-plus"></i> Add Perspective</button>
            </div>

            <div id="persp-form-panel" class="hidden" style="background:var(--card-bg);border-radius:8px;padding:20px;margin-bottom:24px;border:1px solid var(--accent);">
                <h3 id="persp-form-title">Add Perspective</h3>
                <input type="hidden" id="edit-persp-id" value="">
                <div style="display:grid;gap:12px;margin-top:12px;">
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                        <div><label style="font-size:0.85rem;color:var(--text-secondary);">Name</label>
                            <input type="text" id="persp-name" placeholder="e.g., Indian Perspective"></div>
                        <div><label style="font-size:0.85rem;color:var(--text-secondary);">Color</label>
                            <input type="color" id="persp-color" value="#c9a96e" style="height:38px;width:100%;"></div>
                    </div>
                    <div><label style="font-size:0.85rem;color:var(--text-secondary);">Description</label>
                        <textarea id="persp-description" rows="2" placeholder="Brief description of this perspective"></textarea></div>
                    <div style="display:flex;gap:8px;">
                        <button class="btn btn-accent" onclick="savePerspective()"><i class="fas fa-save"></i> Save</button>
                        <button class="btn btn-sm" onclick="document.getElementById('persp-form-panel').classList.add('hidden')"><i class="fas fa-times"></i> Cancel</button>
                    </div>
                </div>
            </div>

            <div style="display:grid;gap:12px;">
                ${persps.map(p => `<div style="background:var(--bg-secondary);border-radius:8px;padding:16px;display:flex;align-items:center;gap:12px;border-left:4px solid ${p.color};">
                    <div style="width:24px;height:24px;border-radius:50%;background:${p.color};flex-shrink:0;"></div>
                    <div style="flex:1;min-width:0;">
                        <div style="font-weight:600;">${escapeHtml(p.name)}</div>
                        <div style="font-size:0.8rem;color:var(--text-muted);">${escapeHtml(p.slug)} - ${escapeHtml(p.description || 'No description')}</div>
                    </div>
                    <button class="btn btn-sm" onclick="editPerspective('${p.id}')" title="Edit"><i class="fas fa-edit"></i></button>
                    <button class="btn btn-sm" style="background:#ff4757;color:#fff;" onclick="deletePerspective('${p.id}')" title="Delete"><i class="fas fa-trash"></i></button>
                </div>`).join('')}
                ${persps.length === 0 ? '<div style="text-align:center;padding:40px;color:var(--text-muted);">No perspectives yet.</div>' : ''}
            </div>
        `;
    } catch (err) { content.innerHTML = '<div style="color:#ff4757;">Error: ' + escapeHtml(err.message) + '</div>'; }
}

function showPerspectiveForm(editing) {
    document.getElementById('persp-form-panel').classList.remove('hidden');
    document.getElementById('persp-form-title').textContent = editing ? 'Edit Perspective' : 'Add Perspective';
    if (!editing) {
        document.getElementById('edit-persp-id').value = '';
        document.getElementById('persp-name').value = '';
        document.getElementById('persp-color').value = '#c9a96e';
        document.getElementById('persp-description').value = '';
    }
}

async function editPerspective(id) {
    const persps = await fetch(API + '/api/perspectives').then(r => r.json());
    const p = persps.find(x => x.id === id);
    if (!p) return;
    document.getElementById('edit-persp-id').value = p.id;
    document.getElementById('persp-name').value = p.name;
    document.getElementById('persp-color').value = p.color;
    document.getElementById('persp-description').value = p.description || '';
    showPerspectiveForm(true);
}

async function savePerspective() {
    const id = document.getElementById('edit-persp-id').value;
    const data = {
        name: document.getElementById('persp-name').value.trim(),
        color: document.getElementById('persp-color').value,
        description: document.getElementById('persp-description').value.trim()
    };
    if (!data.name) { showToast('Name is required', 'error'); return; }
    try {
        if (id) {
            await apiFetch('/api/admin/perspectives/' + id, { method: 'PUT', body: JSON.stringify(data) });
            showToast('Perspective updated');
        } else {
            await apiFetch('/api/admin/perspectives', { method: 'POST', body: JSON.stringify(data) });
            showToast('Perspective added');
        }
        document.getElementById('persp-form-panel').classList.add('hidden');
        loadAdminPerspectives();
    } catch (err) { showToast(err.message, 'error'); }
}

async function deletePerspective(id) {
    if (!confirm('Delete this perspective? Associated policies and document links will also be removed.')) return;
    try {
        await apiFetch('/api/admin/perspectives/' + id, { method: 'DELETE' });
        showToast('Perspective deleted');
        loadAdminPerspectives();
    } catch (err) { showToast(err.message, 'error'); }
}

// ===== ADMIN POLICIES =====
async function loadAdminPolicies() {
    const content = document.getElementById('admin-content');
    content.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner"></div></div>';
    try {
        const [policies, persps] = await Promise.all([
            apiFetch('/api/admin/policies'),
            fetch(API + '/api/perspectives').then(r => r.json())
        ]);
        content.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
                <h2 style="font-family:var(--font-serif);flex:1;margin:0;">Policies (${policies.length})</h2>
                <button class="btn btn-accent" onclick="showPolicyForm()"><i class="fas fa-plus"></i> Add Policy</button>
            </div>

            <div id="policy-form-panel" class="hidden" style="background:var(--card-bg);border-radius:8px;padding:20px;margin-bottom:24px;border:1px solid var(--accent);">
                <h3 id="policy-form-title">Add Policy</h3>
                <input type="hidden" id="edit-policy-id" value="">
                <div style="display:grid;gap:12px;margin-top:12px;">
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                        <div><label style="font-size:0.85rem;color:var(--text-secondary);">Title</label>
                            <input type="text" id="pol-title" placeholder="Policy title"></div>
                        <div><label style="font-size:0.85rem;color:var(--text-secondary);">Perspective</label>
                            <select id="pol-perspective">
                                <option value="">General (no perspective)</option>
                                ${persps.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
                            </select></div>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                        <div><label style="font-size:0.85rem;color:var(--text-secondary);">Section</label>
                            <select id="pol-section">
                                <option value="aims">Aims</option>
                                <option value="objectives">Objectives</option>
                                <option value="general">General Policy</option>
                            </select></div>
                        <div><label style="font-size:0.85rem;color:var(--text-secondary);">Sort Order</label>
                            <input type="number" id="pol-order" value="0" min="0" style="width:100%;"></div>
                    </div>
                    <div><label style="font-size:0.85rem;color:var(--text-secondary);">Content</label>
                        <textarea id="pol-content" rows="6" placeholder="Write the policy content here..."></textarea></div>
                    <div style="display:flex;gap:8px;">
                        <button class="btn btn-accent" onclick="savePolicy()"><i class="fas fa-save"></i> Save</button>
                        <button class="btn btn-sm" onclick="document.getElementById('policy-form-panel').classList.add('hidden')"><i class="fas fa-times"></i> Cancel</button>
                    </div>
                </div>
            </div>

            <table class="admin-table">
                <thead><tr><th>Title</th><th>Perspective</th><th>Section</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                ${policies.map(pol => `<tr>
                    <td><strong>${escapeHtml(pol.title)}</strong></td>
                    <td>${pol.perspective_name ? `<span style="color:${pol.perspective_color || 'var(--accent)'};">${escapeHtml(pol.perspective_name)}</span>` : '<span style="color:var(--text-muted);">General</span>'}</td>
                    <td><span class="badge badge-book">${pol.section}</span></td>
                    <td>${pol.is_published ? '<span class="badge badge-approved">Published</span>' : '<span class="badge badge-pending">Draft</span>'}</td>
                    <td style="white-space:nowrap;">
                        <button class="btn btn-sm" onclick="editPolicy('${pol.id}')" title="Edit"><i class="fas fa-edit"></i></button>
                        <button class="btn btn-sm" style="background:#ff4757;color:#fff;" onclick="deletePolicy('${pol.id}')" title="Delete"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>`).join('')}
                ${policies.length === 0 ? '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);">No policies yet. Add your aims, objectives, and policies.</td></tr>' : ''}
                </tbody>
            </table>

            <div style="margin-top:24px;">
                <button class="btn btn-accent" onclick="document.getElementById('policy-preview').classList.toggle('hidden')"><i class="fas fa-eye"></i> Toggle Preview</button>
            </div>
            <div id="policy-preview" class="hidden" style="margin-top:16px;background:var(--bg-secondary);border-radius:8px;padding:24px;border:1px solid var(--accent);">
                <h3 style="font-family:var(--font-serif);margin-bottom:16px;color:var(--accent);">Policy Preview</h3>
                <div id="policy-preview-content"></div>
            </div>
        `;
        // Render preview content
        renderPolicyPreview(policies, persps);
    } catch (err) { content.innerHTML = '<div style="color:#ff4757;">Error: ' + escapeHtml(err.message) + '</div>'; }
}

function showPolicyForm(editing) {
    document.getElementById('policy-form-panel').classList.remove('hidden');
    document.getElementById('policy-form-title').textContent = editing ? 'Edit Policy' : 'Add Policy';
    if (!editing) {
        document.getElementById('edit-policy-id').value = '';
        document.getElementById('pol-title').value = '';
        document.getElementById('pol-perspective').value = '';
        document.getElementById('pol-section').value = 'aims';
        document.getElementById('pol-content').value = '';
        document.getElementById('pol-order').value = '0';
    }
}

async function editPolicy(id) {
    const policies = await apiFetch('/api/admin/policies');
    const pol = policies.find(x => x.id === id);
    if (!pol) return;
    document.getElementById('edit-policy-id').value = pol.id;
    document.getElementById('pol-title').value = pol.title;
    document.getElementById('pol-perspective').value = pol.perspective_id || '';
    document.getElementById('pol-section').value = pol.section;
    document.getElementById('pol-content').value = pol.content || '';
    document.getElementById('pol-order').value = pol.sort_order;
    showPolicyForm(true);
}

async function savePolicy() {
    const id = document.getElementById('edit-policy-id').value;
    const data = {
        title: document.getElementById('pol-title').value.trim(),
        perspective_id: document.getElementById('pol-perspective').value || null,
        section: document.getElementById('pol-section').value,
        content: document.getElementById('pol-content').value.trim(),
        sort_order: parseInt(document.getElementById('pol-order').value) || 0
    };
    if (!data.title) { showToast('Title is required', 'error'); return; }
    try {
        if (id) {
            await apiFetch('/api/admin/policies/' + id, { method: 'PUT', body: JSON.stringify(data) });
            showToast('Policy updated');
        } else {
            await apiFetch('/api/admin/policies', { method: 'POST', body: JSON.stringify(data) });
            showToast('Policy added');
        }
        document.getElementById('policy-form-panel').classList.add('hidden');
        loadAdminPolicies();
    } catch (err) { showToast(err.message, 'error'); }
}

async function deletePolicy(id) {
    if (!confirm('Delete this policy?')) return;
    try {
        await apiFetch('/api/admin/policies/' + id, { method: 'DELETE' });
        showToast('Policy deleted');
        loadAdminPolicies();
    } catch (err) { showToast(err.message, 'error'); }
}

function renderPolicyPreview(policies, persps) {
    const sections = ['aims', 'objectives', 'general'];
    const sectionLabels = { aims: 'Aims', objectives: 'Objectives', general: 'General Policy' };
    let html = '';
    persps.forEach(p => {
        const perspPolicies = policies.filter(pol => pol.perspective_id === p.id && pol.is_published);
        if (perspPolicies.length === 0) return;
        html += `<div style="border-left:4px solid ${p.color};padding-left:20px;margin-bottom:24px;">
            <h4 style="color:${p.color};font-family:var(--font-serif);font-size:1.1rem;margin-bottom:8px;">${escapeHtml(p.name)}</h4>`;
        sections.forEach(sec => {
            const secPolicies = perspPolicies.filter(pol => pol.section === sec);
            if (secPolicies.length === 0) return;
            html += `<h5 style="color:var(--text-primary);margin:8px 0 6px;font-size:0.9rem;">${sectionLabels[sec]}</h5>`;
            secPolicies.forEach(pol => {
                html += `<div style="background:var(--bg-primary);border-radius:6px;padding:12px;margin-bottom:6px;">
                    <strong style="color:var(--accent);font-size:0.9rem;">${escapeHtml(pol.title)}</strong>
                    ${pol.content ? `<div style="color:var(--text-secondary);font-size:0.85rem;line-height:1.6;margin-top:4px;">${escapeHtml(pol.content).replace(/\n/g, '<br>')}</div>` : ''}
                </div>`;
            });
        });
        html += '</div>';
    });
    const el = document.getElementById('policy-preview-content');
    if (el) el.innerHTML = html || '<p style="color:var(--text-muted);">No published policies yet.</p>';
}

// ===== ACCESS CONTROL ADMIN =====
async function loadAdminAccessControl() {
    const content = document.getElementById('admin-content');
    content.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner"></div></div>';
    try {
        const settings = await apiFetch('/api/admin/access-settings');
        content.innerHTML = `
            <h2 style="font-family:var(--font-serif);margin-bottom:8px;">Access Control</h2>
            <p style="color:var(--text-secondary);margin-bottom:24px;font-size:0.9rem;">Control which features are public or require membership (login + admin approval). Changes take effect immediately.</p>
            <div style="display:grid;gap:16px;" id="access-toggles">
                ${settings.map(s => `
                    <div style="background:var(--bg-secondary);border-radius:8px;padding:16px 20px;display:flex;align-items:center;gap:16px;">
                        <div style="flex:1;">
                            <div style="font-weight:600;">${escapeHtml(s.label)}</div>
                            <div style="font-size:0.8rem;color:var(--text-muted);">${escapeHtml(s.description || '')}</div>
                        </div>
                        <div style="display:flex;gap:4px;background:var(--bg-primary);border-radius:20px;padding:3px;">
                            <button class="btn btn-sm ${s.value === 'public' ? 'btn-accent' : ''}" onclick="setAccess('${s.key}', 'public', this)" style="border-radius:16px;padding:6px 16px;font-size:0.8rem;">
                                <i class="fas fa-globe"></i> Public
                            </button>
                            <button class="btn btn-sm ${s.value === 'members' ? 'btn-accent' : ''}" onclick="setAccess('${s.key}', 'members', this)" style="border-radius:16px;padding:6px 16px;font-size:0.8rem;">
                                <i class="fas fa-lock"></i> Members
                            </button>
                        </div>
                    </div>
                `).join('')}
            </div>
            <div style="margin-top:24px;padding:16px;background:rgba(201,169,110,0.05);border:1px solid var(--border);border-radius:8px;">
                <h4 style="margin-bottom:8px;"><i class="fas fa-info-circle" style="color:var(--accent);"></i> How it works</h4>
                <ul style="font-size:0.85rem;color:var(--text-secondary);line-height:1.8;list-style:disc;padding-left:20px;">
                    <li><strong>Public</strong> - Anyone can access this feature without logging in</li>
                    <li><strong>Members</strong> - Only registered and approved users can access. Others see a login/register prompt</li>
                    <li>The Home page and About page are always public</li>
                    <li>Admin panel always requires admin login regardless of these settings</li>
                </ul>
            </div>
        `;
    } catch (err) { content.innerHTML = '<div style="color:#ff4757;">Error: ' + escapeHtml(err.message) + '</div>'; }
}

async function setAccess(key, value, btn) {
    try {
        await apiFetch('/api/admin/access-settings', {
            method: 'POST',
            body: JSON.stringify({ settings: { [key]: value } })
        });
        // Update button states visually
        const parent = btn.parentElement;
        parent.querySelectorAll('button').forEach(b => b.classList.remove('btn-accent'));
        btn.classList.add('btn-accent');
        // Refresh cached access settings
        await loadAccessSettings();
        showToast(key.replace(/_/g, ' ') + ' set to ' + value);
    } catch (err) { showToast(err.message, 'error'); }
}

// ===== FRONTEND ACCESS GATING =====
let accessSettings = {};

async function loadAccessSettings() {
    try {
        accessSettings = await fetch(API + '/api/access-settings').then(r => r.json());
    } catch (e) { accessSettings = {}; }
}

function checkAccess(feature) {
    const key = feature + '_access';
    if (accessSettings[key] === 'members' && !user) {
        return false;
    }
    return true;
}

function showAccessGate(featureName) {
    const content = `
        <div style="text-align:center;padding:80px 20px;max-width:500px;margin:0 auto;">
            <i class="fas fa-lock" style="font-size:3rem;color:var(--accent);margin-bottom:20px;display:block;"></i>
            <h2 style="font-family:var(--font-serif);margin-bottom:12px;">Members Only</h2>
            <p style="color:var(--text-secondary);margin-bottom:24px;">This feature is available to registered members. Login or create an account to access ${featureName}.</p>
            <div style="display:flex;gap:12px;justify-content:center;">
                <button class="btn btn-accent" onclick="showLoginModal()" style="padding:12px 28px;"><i class="fas fa-sign-in-alt"></i> Login</button>
                <button class="btn btn-primary" onclick="showRegisterModal()" style="padding:12px 28px;"><i class="fas fa-user-plus"></i> Register</button>
            </div>
            <p style="font-size:0.8rem;color:var(--text-muted);margin-top:16px;">Registration requires admin approval.</p>
        </div>`;
    return content;
}

// ===== INIT =====
async function init() {
    await loadAccessSettings();
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
