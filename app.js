/* ============================================================
   PartnerHub — app.js
   Full application logic: GitHub API, CRUD, UI, Search, Export
   ============================================================ */

'use strict';

// ============================================================
// WORKFLOW STATUSES — single source of truth
// ============================================================
const WORKFLOW_STATUSES = [
  // Onboarding  (partner entered after positive call)
  { value: 'Call Completed',        group: 'Onboarding'  },
  { value: 'NDA Sent',              group: 'Onboarding'  },
  { value: 'NDA Signed',            group: 'Onboarding'  },
  { value: 'DC Sent',               group: 'Onboarding'  },
  { value: 'DC Received',           group: 'Onboarding'  },
  { value: 'DC Delayed',            group: 'Onboarding'  },
  // Submission
  { value: 'Submitted to RFP Team', group: 'Submission'  },
  { value: 'Proposal Submitted',    group: 'Submission'  },
  // Outcome
  { value: 'Contract Won',          group: 'Outcome'     },
  { value: 'Contract Lost',         group: 'Outcome'     },
  { value: 'Future Pipeline',       group: 'Outcome'     },
];

// Statuses that count as "Active Pipeline" for the dashboard card
const PIPELINE_STATUSES = new Set([
  'Call Completed',
  'NDA Sent','NDA Signed','DC Sent','DC Delayed','DC Received',
  'Submitted to RFP Team','Proposal Submitted'
]);

// Build a grouped <select> options string from WORKFLOW_STATUSES
function buildStatusOptions(selectedValue = '') {
  let html = '<option value="">Select status...</option>';
  let currentGroup = '';
  WORKFLOW_STATUSES.forEach(s => {
    if (s.group !== currentGroup) {
      if (currentGroup) html += '</optgroup>';
      html += `<optgroup label="── ${s.group}">`;
      currentGroup = s.group;
    }
    html += `<option value="${s.value}" ${selectedValue === s.value ? 'selected' : ''}>${s.value}</option>`;
  });
  if (currentGroup) html += '</optgroup>';
  return html;
}


// ============================================================
// STATE
// ============================================================
let partners = [];
let filteredPartners = [];
let githubConfig = { token: '', owner: '', repo: '', branch: 'main' };
let currentDeleteId = null;
let currentEditId = null;
let fileSha = null; // GitHub file SHA for updates

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  loadPartners();
  setupNavigation();
  resetOpportunityRows('f-opp-list'); // seed first empty row on Add Partner form
  document.getElementById('sidebarToggle').addEventListener('click', toggleSidebar);

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target === el) closeModal(el.id);
    });
  });

  // Keyboard shortcut: ESC closes any open modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => closeModal(m.id));
    }
    // Secret admin shortcut: Ctrl + Shift + G opens GitHub Config
    if (e.ctrlKey && e.shiftKey && e.key === 'G') {
      e.preventDefault();
      openModal('configModal');
    }
  });
});

// ============================================================
// NAVIGATION
// ============================================================
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.getAttribute('data-page');
      navigate(page);
      closeSidebar();
    });
  });
}

function navigate(page) {
  // Update nav
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navItem = document.querySelector(`[data-page="${page}"]`);
  if (navItem) navItem.classList.add('active');

  // Hide all pages
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));

  // Show target page
  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.remove('hidden');

  // Update breadcrumb
  const labels = {
    dashboard: 'Dashboard',
    analytics: 'Employee Analytics',
    database: 'Partner Database',
    add: 'Add Partner'
  };
  document.getElementById('pageBreadcrumb').textContent = labels[page] || page;

  // Render page-specific content
  if (page === 'dashboard') renderDashboard();
  if (page === 'analytics') renderAnalytics();
  if (page === 'database') {
    renderTable(partners);
    // Re-apply any active filters already in the UI
    const q = document.getElementById('searchInput')?.value;
    const s = document.getElementById('statusFilter')?.value;
    const e = document.getElementById('employeeFilter')?.value;
    if (q || s || e) filterPartners();
  }
  if (page === 'add') { clearAddForm(); if (!document.getElementById('f-opp-list').querySelector('.opp-row')) resetOpportunityRows('f-opp-list'); }
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
}

// ============================================================
// GITHUB CONFIG
// ============================================================
function loadConfig() {
  try {
    const saved = localStorage.getItem('ph_config');
    if (saved) githubConfig = JSON.parse(saved);
  } catch (e) { console.warn('Config load error:', e); }

  document.getElementById('cfg-token').value  = githubConfig.token  || '';
  document.getElementById('cfg-owner').value  = githubConfig.owner  || '';
  document.getElementById('cfg-repo').value   = githubConfig.repo   || '';
  document.getElementById('cfg-branch').value = githubConfig.branch || 'main';
}

function saveConfig() {
  const token  = document.getElementById('cfg-token').value.trim();
  const owner  = document.getElementById('cfg-owner').value.trim();
  const repo   = document.getElementById('cfg-repo').value.trim();
  const branch = document.getElementById('cfg-branch').value.trim() || 'main';

  if (!token || !owner || !repo) {
    showConfigStatus('error', '❌ Please fill in Token, Owner and Repo Name.');
    return;
  }

  githubConfig = { token, owner, repo, branch };
  try { localStorage.setItem('ph_config', JSON.stringify(githubConfig)); } catch(e) {}
  showConfigStatus('info', '<span style="color:#94a3b8">⏳ Connecting to GitHub…</span>');
  runDiagnostics();
}

// Single combined test — no /user endpoint (causes CORS errors)
// Just verify repo access + file existence directly
async function runDiagnostics() {
  const el = document.getElementById('configStatus');

  // Step 1: repo access
  el.innerHTML = '<span style="color:#94a3b8">⏳ Step 1/2 — Verifying repository access…</span>';
  el.className = 'config-status';
  try {
    const repoResp = await ghFetch(
      `https://api.github.com/repos/${githubConfig.owner}/${githubConfig.repo}`
    );
    if (repoResp.status === 401) {
      return showConfigStatus('error', '❌ Token invalid or expired.<br>Go to <strong>github.com → Settings → Developer Settings → Personal Access Tokens</strong> and generate a new one with <strong>repo</strong> scope.');
    }
    if (repoResp.status === 403) {
      return showConfigStatus('error', '❌ Token does not have write access to this repo.<br>Make sure the token has <strong>repo</strong> (full) scope selected.');
    }
    if (repoResp.status === 404) {
      return showConfigStatus('error', `❌ Repository not found.<br>Check that owner is <strong>${githubConfig.owner}</strong> and repo is <strong>${githubConfig.repo}</strong>.`);
    }
    if (!repoResp.ok) {
      return showConfigStatus('error', `❌ Repo access failed: HTTP ${repoResp.status}. Check your token and repo name.`);
    }
  } catch (e) {
    return showConfigStatus('error', `❌ Network error: ${e.message}<br>Check your internet connection and try again.`);
  }

  // Step 2: data/partners.json
  el.innerHTML = '<span style="color:#94a3b8">⏳ Step 2/2 — Locating data/partners.json…</span>';
  try {
    const fileResp = await ghFetch(
      `https://api.github.com/repos/${githubConfig.owner}/${githubConfig.repo}/contents/data/partners.json?ref=${githubConfig.branch}`
    );
    if (fileResp.ok) {
      const fileData = await fileResp.json();
      fileSha = fileData.sha;
    } else if (fileResp.status === 404) {
      // File doesn't exist — create it automatically
      el.innerHTML = '<span style="color:#94a3b8">⏳ Creating data/partners.json…</span>';
      const init = await initPartnersFile();
      if (!init.ok) {
        return showConfigStatus('error', `❌ Could not create data/partners.json: ${init.error}<br>Make sure your token has <strong>repo</strong> write scope.`);
      }
    } else {
      return showConfigStatus('error', `❌ File check failed: HTTP ${fileResp.status}`);
    }
  } catch (e) {
    return showConfigStatus('error', `❌ Network error: ${e.message}`);
  }

  // All good — save connected flag so we never ask again
  githubConfig.connected = true;
  try { localStorage.setItem('ph_config', JSON.stringify(githubConfig)); } catch(e) {}

  showConfigStatus('success', '✅ Connected! Loading partner data…');
  hideBanner();
  setTimeout(async () => {
    closeModal('configModal');
    await loadPartners();
  }, 900);
}

async function initPartnersFile() {
  try {
    const content = btoa('[]');
    const r = await fetch(
      `https://api.github.com/repos/${githubConfig.owner}/${githubConfig.repo}/contents/data/partners.json`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${githubConfig.token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: 'Initialize PartnerHub database',
          content,
          branch: githubConfig.branch
        })
      }
    );
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return { ok: false, error: err.message || `HTTP ${r.status}` };
    }
    const data = await r.json();
    fileSha = data.content.sha;
    partners = [];
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
}

function showConfigStatus(type, message) {
  const el = document.getElementById('configStatus');
  el.innerHTML = message;
  el.className = `config-status ${type === 'info' ? '' : type}`;
}

// Helper: all GitHub API calls go through here
function ghFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${githubConfig.token}`,
      Accept: 'application/vnd.github.v3+json',
      ...(options.headers || {})
    }
  });
}

function showNotConfiguredBanner() {
  if (document.getElementById('gh-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'gh-banner';
  banner.innerHTML = `
    <div style="background:linear-gradient(135deg,#1e293b,#0f172a);border:1px solid rgba(245,158,11,0.4);border-radius:10px;padding:14px 20px;margin-bottom:22px;display:flex;align-items:center;justify-content:space-between;gap:16px;box-shadow:0 4px 14px rgba(0,0,0,0.15)">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="font-size:1.3rem">⚠️</div>
        <div>
          <div style="font-size:0.88rem;font-weight:700;color:#fbbf24;margin-bottom:2px">GitHub Not Connected</div>
          <div style="font-size:0.78rem;color:#94a3b8">Partner data will not persist. Press <kbd style="background:#334155;color:#e2e8f0;padding:1px 6px;border-radius:4px;font-size:0.72rem">Ctrl+Shift+G</kbd> to connect.</div>
        </div>
      </div>
      <button onclick="openModal('configModal')" style="background:linear-gradient(135deg,#00d4aa,#00b891);color:#0a0f1e;border:none;padding:8px 16px;border-radius:8px;font-family:Poppins,sans-serif;font-size:0.78rem;font-weight:700;cursor:pointer;white-space:nowrap">Connect Now</button>
    </div>`;
  document.querySelector('.content-area').insertBefore(banner, document.querySelector('.content-area').firstChild);
}

function hideBanner() {
  const b = document.getElementById('gh-banner');
  if (b) b.remove();
}

// ============================================================
// DATA LOADING
// ============================================================
async function loadPartners() {
  // If token is saved, always try to connect silently — never prompt the user
  if (githubConfig.token && githubConfig.owner && githubConfig.repo) {
    hideBanner();
    setSyncStatus('loading', 'Loading…');
    await loadFromGitHub();
  } else {
    // Truly first-time setup — no credentials at all
    showNotConfiguredBanner();
    setSyncStatus('warning', 'Not connected');
    partners = [];
    renderAll();
  }
}

async function loadFromGitHub() {
  setSyncStatus('loading', 'Loading…');
  try {
    const resp = await ghFetch(
      `https://api.github.com/repos/${githubConfig.owner}/${githubConfig.repo}/contents/data/partners.json?ref=${githubConfig.branch}&_=${Date.now()}`
    );

    if (resp.ok) {
      const data = await resp.json();
      fileSha = data.sha;
      // Safe UTF-8 base64 decode
      const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, '')), c => c.charCodeAt(0));
      const raw = new TextDecoder('utf-8').decode(bytes);
      partners = JSON.parse(raw);
      setSyncStatus('connected', `Synced · ${partners.length} partner${partners.length !== 1 ? 's' : ''}`);
      hideBanner();
      updateNavBadge();
      renderAll();

    } else if (resp.status === 404) {
      // File doesn't exist yet — create it silently
      const init = await initPartnersFile();
      if (init.ok) {
        setSyncStatus('connected', 'Ready · 0 partners');
        partners = [];
        renderAll();
      } else {
        setSyncStatus('error', 'Setup failed');
        showToast(`❌ Could not create data file: ${init.error}`, 'error');
      }

    } else if (resp.status === 401) {
      // Token expired — tell user once via toast, don't interrupt with modal
      setSyncStatus('error', 'Token expired');
      showToast('❌ GitHub token expired. Press Ctrl+Shift+G to update it.', 'error');
      partners = [];
      renderAll();

    } else {
      throw new Error(`HTTP ${resp.status}`);
    }

  } catch (e) {
    console.error('GitHub load error:', e);
    setSyncStatus('error', 'Load failed');
    // Show a non-intrusive toast — never show the config modal automatically
    showToast(`⚠️ Could not reach GitHub: ${e.message}`, 'warning');
    partners = [];
    renderAll();
  }
}

// ============================================================
// GITHUB SAVE
// ============================================================
async function saveToGitHub(message = 'Update partners', _retryCount = 0) {
  if (!githubConfig.token || !githubConfig.owner || !githubConfig.repo) {
    showToast('⚠️ GitHub not configured. Press Ctrl+Shift+G to connect.', 'warning');
    showNotConfiguredBanner();
    return false;
  }

  showLoading('Saving to GitHub...');
  try {
    // Always fetch the latest SHA before saving to prevent 409 conflicts
    const shaResp = await ghFetch(
      `https://api.github.com/repos/${githubConfig.owner}/${githubConfig.repo}/contents/data/partners.json?ref=${githubConfig.branch}`
    );
    if (shaResp.ok) {
      const shaData = await shaResp.json();
      fileSha = shaData.sha;
    } else if (shaResp.status !== 404) {
      throw new Error(`Could not fetch file SHA: HTTP ${shaResp.status}`);
    }

    // Encode partners data to base64 safely (handles Unicode)
    const raw = JSON.stringify(partners, null, 2);
    const bytes = new TextEncoder().encode(raw);
    const binary = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
    const content = btoa(binary);

    const body = { message, content, branch: githubConfig.branch };
    if (fileSha) body.sha = fileSha;

    const resp = await fetch(
      `https://api.github.com/repos/${githubConfig.owner}/${githubConfig.repo}/contents/data/partners.json`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${githubConfig.token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    if (resp.ok) {
      const data = await resp.json();
      fileSha = data.content.sha;

      // Bug fix 4: Verify the save actually landed by reading back from GitHub
      const verified = await verifySave(data.content.sha);
      hideLoading();
      if (verified) {
        setSyncStatus('connected', `Saved ✓ · ${partners.length} partners`);
        return true;
      } else {
        setSyncStatus('error', 'Verify failed');
        showToast('⚠️ Save appeared to succeed but verification failed. Please refresh.', 'warning');
        return false;
      }

    } else if (resp.status === 409 && _retryCount < 2) {
      // Bug fix 5: SHA conflict with retry limit (max 2 retries)
      hideLoading();
      fileSha = null;
      return await saveToGitHub(message, _retryCount + 1);

    } else {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${resp.status}`);
    }

  } catch (e) {
    hideLoading();
    setSyncStatus('error', 'Save failed');
    showToast(`❌ Save failed: ${e.message}`, 'error');
    return false;
  }
}

// Bug fix 4 helper: confirm the saved SHA exists in the repo
async function verifySave(expectedSha) {
  try {
    const r = await ghFetch(
      `https://api.github.com/repos/${githubConfig.owner}/${githubConfig.repo}/contents/data/partners.json?ref=${githubConfig.branch}&_=${Date.now()}`
    );
    if (!r.ok) return false;
    const d = await r.json();
    return d.sha === expectedSha;
  } catch { return false; }
}

// ============================================================
// CRUD OPERATIONS
// ============================================================
async function addPartner() {
  const employee = document.getElementById('f-employee').value.trim();
  const company = document.getElementById('f-company').value.trim();
  const status = document.getElementById('f-status').value;

  if (!employee || !company || !status) {
    showToast('⚠️ Please fill in required fields (Employee, Company, Status)', 'warning');
    return;
  }

  const techRaw = document.getElementById('f-technologies').value;
  const technologies = techRaw.split(',').map(t => t.trim()).filter(Boolean);
  const competencies = document.getElementById('f-competencies').value.split(',').map(t => t.trim()).filter(Boolean);
  const services = document.getElementById('f-services').value.split(',').map(t => t.trim()).filter(Boolean);

  const partner = {
    id: Date.now().toString(),
    employee,
    company,
    contact: document.getElementById('f-contact').value.trim(),
    email: document.getElementById('f-email').value.trim(),
    website: document.getElementById('f-website').value.trim(),
    technologies,
    status,
    opportunities: readOpportunityRows('f-opp-list'),
    bdNotes:      document.getElementById('f-bdNotes').value.trim(),
    createdAt: new Date().toISOString().split('T')[0],
    capabilityStatement: {
      overview: document.getElementById('f-overview').value.trim(),
      coreCompetencies: competencies,
      services: services,
      industries: document.getElementById('f-industries').value.trim(),
      differentiators: document.getElementById('f-differentiators').value.trim(),
      pastPerformance: document.getElementById('f-pastPerformance').value.trim(),
      certifications: document.getElementById('f-certifications').value.trim()
    }
  };

  partners.unshift(partner);
  let saved = false;
  try {
    saved = await saveToGitHub(`Add partner: ${company}`);
  } finally {
    hideLoading(); // Bug fix 9: always hide loader
  }
  if (saved) {
    showToast(`✓ ${company} added successfully`, 'success');
    clearAddForm();
    renderAll();
    navigate('database');
  } else {
    partners.shift(); // rollback
    renderAll();
  }
}

function openDeleteModal(id) {
  const partner = partners.find(p => p.id === id);
  if (!partner) return;
  currentDeleteId = id;
  document.getElementById('deletePartnerName').textContent = partner.company;
  document.getElementById('confirmDeleteBtn').onclick = () => confirmDelete(id);
  openModal('deleteModal');
}

async function confirmDelete(id) {
  const partner = partners.find(p => p.id === id);
  if (!partner) return;

  const oldPartners = [...partners];
  partners = partners.filter(p => p.id !== id);
  closeModal('deleteModal');

  let saved = false;
  try {
    saved = await saveToGitHub(`Delete partner: ${partner.company}`);
  } finally {
    hideLoading();
  }
  if (saved) {
    showToast(`✓ ${partner.company} deleted`, 'success');
  } else {
    partners = oldPartners; // rollback
  }
  renderAll();
}

function openEditModal(id) {
  const partner = partners.find(p => p.id === id);
  if (!partner) return;
  currentEditId = id;

  const cap = partner.capabilityStatement || {};
  const body = document.getElementById('editModalBody');

  body.innerHTML = `
    <div class="edit-form-section">
      <div class="edit-section-label">Partner Information</div>
      <div class="edit-form-grid">
        <div class="form-group">
          <label class="form-label">Employee Name <span class="required">*</span></label>
          <input type="text" id="e-employee" class="form-input" value="${esc(partner.employee)}" />
        </div>
        <div class="form-group">
          <label class="form-label">Company Name <span class="required">*</span></label>
          <input type="text" id="e-company" class="form-input" value="${esc(partner.company)}" />
        </div>
        <div class="form-group">
          <label class="form-label">Contact Person</label>
          <input type="text" id="e-contact" class="form-input" value="${esc(partner.contact || '')}" />
        </div>
        <div class="form-group">
          <label class="form-label">Email Address</label>
          <input type="email" id="e-email" class="form-input" value="${esc(partner.email || '')}" />
        </div>
        <div class="form-group">
          <label class="form-label">Company Website</label>
          <input type="url" id="e-website" class="form-input" value="${esc(partner.website || '')}" placeholder="https://www.company.com" />
        </div>
        <div class="form-group">
          <label class="form-label">Technologies <span class="form-hint">(comma separated)</span></label>
          <input type="text" id="e-technologies" class="form-input" value="${esc((partner.technologies || []).join(', '))}" />
        </div>
        <div class="form-group">
          <label class="form-label">Partner Status <span class="required">*</span></label>
          <select id="e-status" class="form-input form-select">
            ${buildStatusOptions(partner.status)}
          </select>
        </div>
      </div>
    </div>

    <div class="edit-form-section">
      <div class="edit-section-label">Opportunity Details</div>
      <div class="opp-list-header" style="margin-bottom:10px">
        <span class="form-label" style="margin:0">Opportunities Submitted / Reached Out To</span>
        <button type="button" class="btn-add-opp" onclick="addOpportunityRow('e-opp-list')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Opportunity
        </button>
      </div>
      <div id="e-opp-list" class="opp-list"></div>
      <div class="form-group" style="margin-top:16px">
        <label class="form-label">BD Owner Notes / Comments</label>
        <textarea id="e-bdNotes" class="form-textarea" rows="3" placeholder="Notes from the BD owner...">${esc(partner.bdNotes || '')}</textarea>
      </div>
    </div>

    <div class="edit-form-section">
      <div class="edit-section-label">Capability Statement</div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Company Overview</label>
        <textarea id="e-overview" class="form-textarea" rows="3">${esc(cap.overview || '')}</textarea>
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Core Competencies <span class="form-hint">(comma separated)</span></label>
        <input type="text" id="e-competencies" class="form-input" value="${esc((cap.coreCompetencies || []).join(', '))}" />
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Relevant Services <span class="form-hint">(comma separated)</span></label>
        <input type="text" id="e-services" class="form-input" value="${esc((cap.services || []).join(', '))}" />
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Industries Served</label>
        <input type="text" id="e-industries" class="form-input" value="${esc(cap.industries || '')}" />
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Differentiators</label>
        <textarea id="e-differentiators" class="form-textarea" rows="2">${esc(cap.differentiators || '')}</textarea>
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Past Performance</label>
        <textarea id="e-pastPerformance" class="form-textarea" rows="2">${esc(cap.pastPerformance || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Certifications / Compliance</label>
        <input type="text" id="e-certifications" class="form-input" value="${esc(cap.certifications || '')}" />
      </div>
    </div>
  `;

  document.getElementById('saveEditBtn').onclick = () => saveEdit(id);
  openModal('editModal');
  populateOpportunityRows('e-opp-list', partner.opportunities || []);
}

async function saveEdit(id) {
  const idx = partners.findIndex(p => p.id === id);
  if (idx === -1) return;

  const employee = document.getElementById('e-employee').value.trim();
  const company = document.getElementById('e-company').value.trim();
  const status = document.getElementById('e-status').value;

  if (!employee || !company || !status) {
    showToast('⚠️ Please fill required fields', 'warning');
    return;
  }

  const oldPartner = { ...partners[idx] };
  const technologies = document.getElementById('e-technologies').value.split(',').map(t => t.trim()).filter(Boolean);
  const competencies = document.getElementById('e-competencies').value.split(',').map(t => t.trim()).filter(Boolean);
  const services = document.getElementById('e-services').value.split(',').map(t => t.trim()).filter(Boolean);

  partners[idx] = {
    ...partners[idx],
    employee, company, status,
    contact: document.getElementById('e-contact').value.trim(),
    email: document.getElementById('e-email').value.trim(),
    website: document.getElementById('e-website').value.trim(),
    technologies,
    opportunities: readOpportunityRows('e-opp-list'),
    bdNotes:       document.getElementById('e-bdNotes').value.trim(),
    capabilityStatement: {
      overview: document.getElementById('e-overview').value.trim(),
      coreCompetencies: competencies,
      services: services,
      industries: document.getElementById('e-industries').value.trim(),
      differentiators: document.getElementById('e-differentiators').value.trim(),
      pastPerformance: document.getElementById('e-pastPerformance').value.trim(),
      certifications: document.getElementById('e-certifications').value.trim()
    }
  };

  closeModal('editModal');
  let saved = false;
  try {
    saved = await saveToGitHub(`Update partner: ${company}`);
  } finally {
    hideLoading();
  }
  if (saved) {
    showToast(`✓ ${company} updated successfully`, 'success');
  } else {
    partners[idx] = oldPartner;
  }
  renderAll();
}

function openViewModal(id) {
  const partner = partners.find(p => p.id === id);
  if (!partner) return;
  const cap = partner.capabilityStatement || {};

  document.getElementById('viewModalTitle').textContent = partner.company;

  const tagsHtml = (partner.technologies || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const compHtml = (cap.coreCompetencies || []).map(c => `<span class="tag">${esc(c)}</span>`).join('');
  const svcHtml = (cap.services || []).map(s => `<span class="tag" style="background:#f5f3ff;color:#7c3aed;border-color:rgba(139,92,246,0.2)">${esc(s)}</span>`).join('');

  document.getElementById('viewModalBody').innerHTML = `
    <div class="detail-header">
      <div class="detail-avatar">${partner.company.charAt(0)}</div>
      <div>
        <div class="detail-company-name">${esc(partner.company)}</div>
        <div class="detail-meta">
          ${esc(partner.contact || 'No contact')} &nbsp;·&nbsp;
          ${esc(partner.email || 'No email')} &nbsp;·&nbsp;
          ${partner.website ? `<a href="${esc(partner.website)}" target="_blank" rel="noopener" style="color:var(--accent-dark);text-decoration:none;font-weight:500">🌐 Visit Website</a> &nbsp;·&nbsp;` : ''}
          ${statusBadge(partner.status)}
        </div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Partner Details</div>
      <div class="detail-grid">
        <div class="detail-field"><div class="detail-field-label">Sourced By</div><div class="detail-field-value">${esc(partner.employee)}</div></div>
        <div class="detail-field"><div class="detail-field-label">Status</div><div class="detail-field-value">${statusBadge(partner.status)}</div></div>
        <div class="detail-field"><div class="detail-field-label">Contact Email</div><div class="detail-field-value">${partner.email ? `<a href="mailto:${esc(partner.email)}" style="color:var(--accent-dark)">${esc(partner.email)}</a>` : '—'}</div></div>
        <div class="detail-field"><div class="detail-field-label">Website</div><div class="detail-field-value">${partner.website ? `<a href="${esc(partner.website)}" target="_blank" rel="noopener" style="color:var(--accent-dark)">${esc(partner.website)}</a>` : '—'}</div></div>
        <div class="detail-field"><div class="detail-field-label">Added On</div><div class="detail-field-value">${formatDate(partner.createdAt)}</div></div>
      </div>
    </div>

    ${((partner.opportunities && partner.opportunities.length) || partner.bdNotes) ? `
    <div class="detail-section">
      <div class="detail-section-title">Opportunity Details</div>
      ${partner.opportunities && partner.opportunities.length ? `
      <div class="opp-view-list">
        ${partner.opportunities.map((o, i) => `
          <div class="opp-view-row">
            <div class="opp-view-num">${i + 1}</div>
            <div class="opp-view-content">
              <div class="opp-view-name">${esc(o.opportunity || '—')}</div>
              ${o.eventId ? `<code class="opp-event-chip">${esc(o.eventId)}</code>` : ''}
            </div>
          </div>`).join('')}
      </div>` : ''}
      ${partner.bdNotes ? `
      <div class="cap-section" style="margin-top:14px">
        <div class="cap-label">BD Owner Notes</div>
        <div class="cap-value" style="white-space:pre-wrap">${esc(partner.bdNotes)}</div>
      </div>` : ''}
    </div>` : ''}

    <div class="detail-section">
      <div class="detail-section-title">Technologies</div>
      <div class="tech-tags">${tagsHtml || '<span style="color:var(--text-muted);font-size:0.8rem">None listed</span>'}</div>
    </div>

    ${cap.overview ? `
    <div class="detail-section">
      <div class="detail-section-title">Capability Statement</div>
      <div class="cap-section"><div class="cap-label">Company Overview</div><div class="cap-value">${esc(cap.overview)}</div></div>
      ${cap.coreCompetencies && cap.coreCompetencies.length ? `<div class="cap-section"><div class="cap-label">Core Competencies</div><div class="tech-tags" style="margin-top:4px">${compHtml}</div></div>` : ''}
      ${cap.services && cap.services.length ? `<div class="cap-section"><div class="cap-label">Services</div><div class="tech-tags" style="margin-top:4px">${svcHtml}</div></div>` : ''}
      ${cap.industries ? `<div class="cap-section"><div class="cap-label">Industries Served</div><div class="cap-value">${esc(cap.industries)}</div></div>` : ''}
      ${cap.differentiators ? `<div class="cap-section"><div class="cap-label">Differentiators</div><div class="cap-value">${esc(cap.differentiators)}</div></div>` : ''}
      ${cap.pastPerformance ? `<div class="cap-section"><div class="cap-label">Past Performance</div><div class="cap-value">${esc(cap.pastPerformance)}</div></div>` : ''}
      ${cap.certifications ? `<div class="cap-section"><div class="cap-label">Certifications</div><div class="cap-value">${esc(cap.certifications)}</div></div>` : ''}
    </div>` : ''}
  `;

  document.getElementById('viewEditBtn').onclick = () => {
    closeModal('viewModal');
    openEditModal(id);
  };

  openModal('viewModal');
}

// ============================================================
// RENDER
// ============================================================
function renderAll() {
  updateNavBadge();
  const currentPage = getCurrentPage();
  if (currentPage === 'dashboard') renderDashboard();
  if (currentPage === 'analytics') renderAnalytics();
  if (currentPage === 'database') renderTable(partners);
}

function getCurrentPage() {
  const pages = ['dashboard', 'analytics', 'database', 'add'];
  for (const p of pages) {
    const el = document.getElementById(`page-${p}`);
    if (el && !el.classList.contains('hidden')) return p;
  }
  return 'dashboard';
}

function updateNavBadge() {
  document.getElementById('nav-partner-count').textContent = partners.length;
}

function renderDashboard() {
  const counts = getStatusCounts();
  const pipelineCount = partners.filter(p => PIPELINE_STATUSES.has(p.status)).length;
  animateNumber('stat-total',    partners.length);
  animateNumber('stat-pipeline', pipelineCount);
  animateNumber('stat-dc',       counts['DC Received'] || 0);
  animateNumber('stat-won',      counts['Contract Won'] || 0);
  animateNumber('stat-lost',     counts['Contract Lost'] || 0);

  renderRecentPartners();
  renderTopTechnologies();
}

function renderRecentPartners() {
  const recent = [...partners].slice(0, 6);
  const container = document.getElementById('recentPartners');
  if (!recent.length) {
    container.innerHTML = `<div class="empty-state" style="padding:30px"><p>No partners yet</p></div>`;
    return;
  }
  container.innerHTML = recent.map(p => `
    <div class="recent-item" onclick="openViewModal('${p.id}')">
      <div class="recent-avatar">${p.company.charAt(0)}</div>
      <div class="recent-info">
        <div class="recent-company">${esc(p.company)}</div>
        <div class="recent-employee">by ${esc(p.employee)}</div>
      </div>
      ${statusBadge(p.status)}
    </div>
  `).join('');
}

function renderTopTechnologies() {
  const techCount = {};
  partners.forEach(p => (p.technologies || []).forEach(t => {
    techCount[t] = (techCount[t] || 0) + 1;
  }));

  const sorted = Object.entries(techCount).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = sorted[0]?.[1] || 1;
  const container = document.getElementById('topTechnologies');

  if (!sorted.length) {
    container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:0.8rem">No technology data yet</div>`;
    return;
  }

  container.innerHTML = sorted.map(([name, count]) => `
    <div class="tech-bar-row">
      <div class="tech-bar-name">${esc(name)}</div>
      <div class="tech-bar-track">
        <div class="tech-bar-fill" style="width: ${Math.round((count / max) * 100)}%"></div>
      </div>
      <div class="tech-bar-count">${count}</div>
    </div>
  `).join('');
}

function renderAnalytics() {
  renderEmployeeAnalytics();
  renderStatusBreakdown();
}

function renderEmployeeAnalytics() {
  const empCount = {};
  partners.forEach(p => {
    empCount[p.employee] = (empCount[p.employee] || 0) + 1;
  });
  const sorted = Object.entries(empCount).sort((a, b) => b[1] - a[1]);
  const max = sorted[0]?.[1] || 1;
  const container = document.getElementById('employeeAnalytics');

  if (!sorted.length) {
    container.innerHTML = `<div style="color:var(--text-muted);font-size:0.8rem">No data yet.</div>`;
    return;
  }

  container.innerHTML = sorted.map(([name, count]) => `
    <div class="employee-card">
      <div class="employee-card-top">
        <div class="employee-avatar">${name.charAt(0).toUpperCase()}</div>
        <div>
          <div class="employee-name">${esc(name)}</div>
          <div class="employee-count">${count} partner${count !== 1 ? 's' : ''} sourced</div>
        </div>
      </div>
      <div class="employee-bar-track">
        <div class="employee-bar-fill" style="width:${Math.round((count / max) * 100)}%"></div>
      </div>
    </div>
  `).join('');
}

function renderStatusBreakdown() {
  const counts = getStatusCounts();
  const statuses = [
    { key: 'Call Completed',        color: '#f97316', bg: '#fff7ed' },
    { key: 'NDA Sent',              color: '#8b5cf6', bg: '#f5f3ff' },
    { key: 'NDA Signed',            color: '#7c3aed', bg: '#ede9fe' },
    { key: 'DC Sent',               color: '#6366f1', bg: '#eef2ff' },
    { key: 'DC Received',           color: '#059669', bg: '#ecfdf5' },
    { key: 'DC Delayed',            color: '#ef4444', bg: '#fef2f2' },
    { key: 'Submitted to RFP Team', color: '#a21caf', bg: '#fdf4ff' },
    { key: 'Proposal Submitted',    color: '#4f46e5', bg: '#eef2ff' },
    { key: 'Contract Won',          color: '#16a34a', bg: '#dcfce7' },
    { key: 'Contract Lost',         color: '#dc2626', bg: '#fef2f2' },
    { key: 'Future Pipeline',       color: '#0369a1', bg: '#f0f9ff' },
  ];

  document.getElementById('statusBreakdown').innerHTML = statuses.map(s => `
    <div class="status-breakdown-card" style="background:${s.bg}">
      <div class="status-breakdown-num" style="color:${s.color}">${counts[s.key] || 0}</div>
      <div class="status-breakdown-label">${esc(s.key)}</div>
    </div>
  `).join('');
}

function renderTable(data) {
  filteredPartners = data;
  const tbody = document.getElementById('partnersTableBody');
  const empty = document.getElementById('emptyState');
  const count = document.getElementById('tableCount');

  count.textContent = `${data.length} partner${data.length !== 1 ? 's' : ''}`;

  if (!data.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  tbody.innerHTML = data.map(p => {
    const tags = (p.technologies || []);
    const visibleTags = tags.slice(0, 3);
    const extra = tags.length - 3;
    const tagHtml = visibleTags.map(t => `<span class="tag">${esc(t)}</span>`).join('') +
      (extra > 0 ? `<span class="tag tag-overflow">+${extra}</span>` : '');

    return `
      <tr>
        <td>
          <div class="company-cell">
            <div class="company-avatar">${p.company.charAt(0)}</div>
            <div>
              <div class="company-name">${esc(p.company)}</div>
              <div class="company-email">
                ${p.website
                  ? `<a href="${esc(p.website)}" target="_blank" rel="noopener" style="color:var(--accent-dark);text-decoration:none;font-size:0.72rem;font-weight:500" title="${esc(p.website)}">🌐 Website</a>`
                  : esc(p.contact || '')}
              </div>
            </div>
          </div>
        </td>
        <td><span style="font-weight:500">${esc(p.employee)}</span></td>
        <td>${esc(p.email || '—')}</td>
        <td><div class="tech-tags">${tagHtml || '—'}</div></td>
        <td>${statusBadge(p.status)}</td>
        <td style="color:var(--text-muted);white-space:nowrap">${formatDate(p.createdAt)}</td>
        <td>
          <div class="action-buttons">
            <button class="btn-icon btn-icon-view" title="View" onclick="openViewModal('${p.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              View
            </button>
            <button class="btn-icon btn-icon-edit" title="Edit" onclick="openEditModal('${p.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Edit
            </button>
            <button class="btn-icon btn-icon-delete" title="Delete" onclick="openDeleteModal('${p.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
              Delete
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // Populate employee filter
  const employeeFilter = document.getElementById('employeeFilter');
  const currentVal = employeeFilter.value;
  const employees = [...new Set(partners.map(p => p.employee))].sort();
  employeeFilter.innerHTML = `<option value="">All Employees</option>` +
    employees.map(e => `<option value="${esc(e)}" ${currentVal === e ? 'selected' : ''}>${esc(e)}</option>`).join('');
}

// ============================================================
// SEARCH & FILTER
// ============================================================
function filterPartners() {
  const query = document.getElementById('searchInput').value.toLowerCase().trim();
  const status = document.getElementById('statusFilter').value;
  const employee = document.getElementById('employeeFilter').value;

  let filtered = partners.filter(p => {
    const cap = p.capabilityStatement || {};
    const searchFields = [
      p.company, p.employee, p.contact, p.email,
      ...(p.opportunities || []).flatMap(o => [o.opportunity, o.eventId]),
      p.bdNotes,
      ...(p.technologies || []),
      cap.overview, cap.industries, cap.differentiators,
      cap.pastPerformance, cap.certifications,
      ...(cap.coreCompetencies || []),
      ...(cap.services || [])
    ].filter(Boolean).join(' ').toLowerCase();

    const matchQuery = !query || searchFields.includes(query);
    const matchStatus = !status || p.status === status;
    const matchEmployee = !employee || p.employee === employee;
    return matchQuery && matchStatus && matchEmployee;
  });

  renderTable(filtered);
}

// ============================================================
// CSV EXPORT
// ============================================================
function exportCSV() {
  // Bug fix 7: export filtered set if filters are active, otherwise all
  const exportData = filteredPartners.length && filteredPartners.length < partners.length
    ? filteredPartners
    : partners;

  if (!exportData.length) {
    showToast('⚠️ No partners to export', 'warning');
    return;
  }

  const headers = ['Employee', 'Company', 'Contact', 'Email', 'Website', 'Technologies', 'Opportunities', 'BD Notes', 'Status', 'Added',
    'Overview', 'Core Competencies', 'Services', 'Industries', 'Differentiators', 'Past Performance', 'Certifications'];

  const rows = exportData.map(p => {
    const cap = p.capabilityStatement || {};
    return [
      p.employee, p.company, p.contact, p.email, p.website || '',
      (p.technologies || []).join('; '),
      (p.opportunities || []).map(o => `${o.opportunity}${o.eventId ? ' ['+o.eventId+']' : ''}`).join('; '),
      p.bdNotes || '',
      p.status, p.createdAt,
      cap.overview, (cap.coreCompetencies || []).join('; '),
      (cap.services || []).join('; '),
      cap.industries, cap.differentiators, cap.pastPerformance, cap.certifications
    ].map(v => `"${(v || '').replace(/"/g, '""')}"`);
  });

  const csv = [headers.map(h => `"${h}"`), ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `partnerhub-export-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('✓ CSV exported successfully', 'success');
}

// ============================================================
// HELPERS
// ============================================================
function getStatusCounts() {
  return partners.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {});
}

function statusBadge(status) {
  const cls = (status || '').replace(/\s+/g, '-');
  return `<span class="status-badge status-${cls}">${esc(status || 'Unknown')}</span>`;
}

function formatDate(str) {
  if (!str) return '—';
  try {
    return new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return str; }
}

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function animateNumber(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = parseInt(el.textContent) || 0;
  const duration = 600;
  const startTime = performance.now();
  const update = (now) => {
    const t = Math.min((now - startTime) / duration, 1);
    const ease = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(start + (target - start) * ease);
    if (t < 1) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

function clearAddForm() {
  ['f-employee','f-company','f-contact','f-email','f-website','f-technologies',
   'f-bdNotes',
   'f-overview','f-competencies','f-services','f-industries',
   'f-differentiators','f-pastPerformance','f-certifications'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const status = document.getElementById('f-status');
  if (status) status.value = '';
  resetOpportunityRows('f-opp-list');
}

// ============================================================
// MODAL CONTROL
// ============================================================
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  document.body.style.overflow = '';
}

// ============================================================
// TOAST
// ============================================================
let toastTimeout;
function showToast(message, type = 'success') {
  clearTimeout(toastTimeout);
  const toast = document.getElementById('toast');
  const icons = { success: '✓', warning: '⚠', error: '✕', info: 'ℹ' };
  const colors = { success: '#00d4aa', warning: '#f59e0b', error: '#ef4444', info: '#3b82f6' };

  document.getElementById('toastMessage').textContent = message;
  document.getElementById('toastIcon').textContent = icons[type] || '✓';
  document.getElementById('toastIcon').style.color = colors[type];

  toast.classList.remove('hidden');
  toast.style.animation = 'slideInRight 0.3s ease';

  toastTimeout = setTimeout(() => {
    toast.style.animation = 'slideOutRight 0.3s ease forwards';
    setTimeout(() => toast.classList.add('hidden'), 300);
  }, 3500);
}

// ============================================================
// LOADING
// ============================================================
function showLoading(text = 'Syncing...') {
  document.getElementById('loadingText').textContent = text;
  document.getElementById('loadingOverlay').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loadingOverlay').classList.add('hidden');
}

// ============================================================
// SYNC STATUS
// ============================================================
function setSyncStatus(state, text) {
  const dot = document.querySelector('.sync-dot');
  const textEl = document.getElementById('syncText');
  dot.className = 'sync-dot';
  if (state === 'error') dot.classList.add('error');
  if (state === 'warning') dot.classList.add('warning');
  textEl.textContent = text;
}


// ============================================================
// OPPORTUNITY ROWS — dynamic multi-entry helpers
// ============================================================
function oppRowHTML(idx, opp, evtId) {
  return `
    <div class="opp-row" data-idx="${idx}">
      <div class="opp-row-num">${idx + 1}</div>
      <input type="text" class="form-input opp-input-name" placeholder="Opportunity name / RFP title" value="${esc(opp || '')}" />
      <input type="text" class="form-input opp-input-id" placeholder="Event ID (e.g. EVT-2024-0042)" value="${esc(evtId || '')}" style="max-width:200px" />
      <button type="button" class="opp-remove-btn" onclick="removeOpportunityRow(this)" title="Remove">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
}

function addOpportunityRow(listId, opp = '', evtId = '') {
  const list = document.getElementById(listId);
  const idx  = list.querySelectorAll('.opp-row').length;
  list.insertAdjacentHTML('beforeend', oppRowHTML(idx, opp, evtId));
  renumberOppRows(list);
}

function removeOpportunityRow(btn) {
  const row  = btn.closest('.opp-row');
  const list = row.closest('.opp-list');
  row.remove();
  renumberOppRows(list);
  // Always keep at least one empty row
  if (!list.querySelectorAll('.opp-row').length) addOpportunityRow(list.id);
}

function renumberOppRows(list) {
  list.querySelectorAll('.opp-row').forEach((row, i) => {
    row.setAttribute('data-idx', i);
    row.querySelector('.opp-row-num').textContent = i + 1;
  });
}

function readOpportunityRows(listId) {
  const list = document.getElementById(listId);
  if (!list) return [];
  return Array.from(list.querySelectorAll('.opp-row'))
    .map(row => ({
      opportunity: row.querySelector('.opp-input-name').value.trim(),
      eventId:     row.querySelector('.opp-input-id').value.trim()
    }))
    .filter(o => o.opportunity || o.eventId);
}

function populateOpportunityRows(listId, opps) {
  const list = document.getElementById(listId);
  if (!list) return;
  list.innerHTML = '';
  if (!opps || !opps.length) {
    addOpportunityRow(listId);
    return;
  }
  opps.forEach((o, i) => addOpportunityRow(listId, o.opportunity, o.eventId));
}

function resetOpportunityRows(listId) {
  const list = document.getElementById(listId);
  if (!list) return;
  list.innerHTML = '';
  addOpportunityRow(listId);
}

// ============================================================
// SAMPLE DATA (fallback when no GitHub & no local file)
// ============================================================
function getSampleData() {
  return [];
}
