// ===== Auth Guard — redirect to login if not authenticated =====
(function authGuard() {
    const token = localStorage.getItem('energyai_token');
    if (!token) {
        window.location.href = 'login.html';
        return;
    }
})();

/**
 * Wrapper around window.fetch that automatically inserts authorization headers
 * and handles 401 unauthorized errors (redirect to login).
 */
// Active request cache map for request deduplication
const activeRequests = new Map();

/**
 * Wrapper around window.fetch that automatically inserts authorization headers
 * and handles 401 unauthorized errors (redirect to login).
 * Implements request deduplication to prevent redundant concurrent network calls.
 */
async function authFetch(url, options = {}) {
    const method = options.method || 'GET';
    const bodyStr = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : '';
    const requestKey = `${method}:${url}:${bodyStr}`;
    const isGet = method.toUpperCase() === 'GET';

    if (isGet && activeRequests.has(requestKey)) {
        const response = await activeRequests.get(requestKey);
        return response.clone();
    }

    const token = localStorage.getItem('energyai_token');
    options.headers = options.headers || {};
    if (token) {
        options.headers['Authorization'] = `Bearer ${token}`;
    }
    // If options.body is JSON, ensure Content-Type is set
    if (options.body && typeof options.body === 'string' && !options.headers['Content-Type']) {
        options.headers['Content-Type'] = 'application/json';
    }

    const fetchPromise = (async () => {
        try {
            const res = await fetch(url, options);
            if (res.status === 401) {
                localStorage.removeItem('energyai_token');
                localStorage.removeItem('energyai_user');
                window.location.href = 'login.html';
                throw new Error('Authentication expired. Redirecting to login.');
            }
            return res;
        } finally {
            if (isGet) {
                activeRequests.delete(requestKey);
            }
        }
    })();

    if (isGet) {
        activeRequests.set(requestKey, fetchPromise);
    }
    return fetchPromise;
}

// ===== Graceful Fallback UI / Error Boundary =====
function runWithErrorBoundary(fn, elementId, fallbackHtml = '') {
    try {
        fn();
    } catch (error) {
        console.error(`[Error Boundary] Component error:`, error);
        const element = document.getElementById(elementId);
        if (element) {
            element.innerHTML = fallbackHtml || `
                <div class="error-boundary-fallback" style="padding: 1.5rem; text-align: center; background: rgba(239, 68, 68, 0.05); border: 1px dashed rgba(239, 68, 68, 0.2); border-radius: 8px; margin: 10px 0;">
                    <span style="color: #ef4444; font-size: 0.9rem; font-weight: 500;">⚠️ Failed to load this component</span>
                </div>
            `;
        }
    }
}

// Logout handler — show confirmation modal
function logout() {
    const modal = document.getElementById('logoutModal');
    if (modal) modal.classList.add('active');
}

function confirmLogout() {
    localStorage.removeItem('energyai_token');
    localStorage.removeItem('energyai_user');
    window.location.href = 'login.html';
}

const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const cachedBackend = localStorage.getItem('energyai_backend_url');
const baseEndpoint = (isLocal ? window.location.origin : (cachedBackend || window.location.origin)).replace(/\/$/, '');

const API_BASE = baseEndpoint + '/api';
const AUTH_BASE = baseEndpoint + '/api/auth';
const NOTIF_BASE = baseEndpoint + '/api/notifications';
const HEALTH_URL = baseEndpoint + '/health';
const REFRESH_INTERVAL = 30000; // 30 seconds

// Query Vercel configuration to dynamically update the backend URL
if (!isLocal) {
    (async function initApiUrls() {
        try {
            const res = await fetch(window.location.origin + '/api/config');
            const data = await res.json();
            if (data.success && data.backendUrl) {
                const base = data.backendUrl.replace(/\/$/, '');
                if (localStorage.getItem('energyai_backend_url') !== base) {
                    localStorage.setItem('energyai_backend_url', base);
                    window.location.reload();
                }
            }
        } catch (err) {
            console.warn('[API] Failed to fetch backend config:', err.message);
        }
    })();
}

// Chart instances
let mainChartIns, anomalyChartIns, trendChartIns;
let refreshTimer = null;

// User data
let currentUser = JSON.parse(localStorage.getItem('energyai_user') || '{}');

// Elements
const uploadForm = document.getElementById('uploadForm');
const uploadStatus = document.getElementById('uploadStatus');
const trainBtn = document.getElementById('trainBtn');
const getRecsBtn = document.getElementById('getRecsBtn');
const predictBtn = document.getElementById('predictBtn');
const anomalyBtn = document.getElementById('anomalyBtn');
const recsList = document.getElementById('recsList');

// ===== Toast Notification System =====
function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ===== Initialize Dashboard =====
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    populateUserInfo();
    setupNavigation();
    setupMobileMenu();
    setupSettings();
    setupChartToggles();
    
    // Initial data load
    checkDataAndRender();
    
    // ML Status check
    setTimeout(checkMLStatus, 1000);

    // Event Listeners
    const genWeekBtn = document.getElementById('genWeekPredBtn');
    if (genWeekBtn) genWeekBtn.addEventListener('click', loadWeeklyPredictions);

    const exportBtn = document.getElementById('exportCsvBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportReportsCsv);
    
    const pdfBtn = document.getElementById('exportPdfBtn');
    if (pdfBtn) pdfBtn.addEventListener('click', exportReportsPdf);

    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

    const sampleBtn = document.getElementById('loadSampleBtn');
    if (sampleBtn) {
        sampleBtn.addEventListener('click', loadSampleData);
    }

    startAutoRefresh();
    loadNotificationHistory();
});

// ===== Populate User Info =====
function populateUserInfo() {
    const userName = document.getElementById('user-name');
    const userAvatar = document.getElementById('user-avatar');
    const profileAvatar = document.getElementById('profile-avatar');
    const profileUsername = document.getElementById('profile-username');
    const profileEmail = document.getElementById('profile-email');
    const profileNotifs = document.getElementById('profile-notifs');
    const profileBudget = document.getElementById('profile-budget');

    const profileNotifEmail = document.getElementById('profile-notif-email');
    if (currentUser.username) {
        const initial = currentUser.username.charAt(0).toUpperCase();
        if (userName) userName.textContent = currentUser.username;
        if (userAvatar) userAvatar.textContent = initial;
        if (profileAvatar) profileAvatar.textContent = initial;
        if (profileUsername) profileUsername.textContent = currentUser.username;
    }
    if (profileEmail) profileEmail.textContent = currentUser.email || '—';
    if (profileNotifs) profileNotifs.textContent = currentUser.notificationsEnabled ? '✅ Enabled' : '❌ Disabled';
    if (profileBudget) profileBudget.textContent = currentUser.budgetLimit ? `${currentUser.budgetLimit} kWh/month` : 'Not set';
    if (profileNotifEmail) profileNotifEmail.textContent = currentUser.notificationEmail || currentUser.email || '—';

    console.log('[Profile] Profile loaded');
}

// ===== Sync user state everywhere =====
function syncUserState(userData) {
    // Safe state updates: check if anything has actually changed
    const isDifferent = Object.keys(userData).some(key => currentUser[key] !== userData[key]);
    if (!isDifferent) return;

    currentUser = { ...currentUser, ...userData };
    localStorage.setItem('energyai_user', JSON.stringify(currentUser));
    populateUserInfo();
}

// ===== Section-Based Navigation =====
const sectionTitles = {
    dashboard: 'Dashboard',
    analytics: 'Analytics',
    'bill-history': 'Bill History',
    reports: 'Reports',
    settings: 'Settings',
    profile: 'Profile'
};

function setupNavigation() {
    const navLinks = document.querySelectorAll('.nav-link[data-section]');
    const pageTitle = document.getElementById('page-title');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const sectionId = link.dataset.section;

            // Update active nav link
            navLinks.forEach(n => n.classList.remove('active'));
            link.classList.add('active');

            // Show/hide page sections
            document.querySelectorAll('.page-section').forEach(sec => sec.classList.remove('active'));
            const targetSection = document.getElementById(`section-${sectionId}`);
            if (targetSection) {
                targetSection.classList.add('active');
            }

            // Update page title
            if (pageTitle) {
                pageTitle.textContent = sectionTitles[sectionId] || 'Dashboard';
            }

            // Section-specific actions
            if (sectionId === 'settings') {
                loadSettingsValues();
            }
            if (sectionId === 'reports') {
                renderReportsTable();
            }
            if (sectionId === 'profile') {
                populateUserInfo();
                loadActivityLog();
            }
            if (sectionId === 'bill-history') {
                loadFullBillHistory();
            }
            if (sectionId === 'analytics') {
                loadBillHistory();
            }

            // Close mobile sidebar if open
            closeMobileSidebar();
        });
    });
}

// ===== Mobile Menu =====
function setupMobileMenu() {
    const menuBtn = document.getElementById('mobileMenuBtn');
    const sidebar = document.getElementById('sidebar');

    if (menuBtn && sidebar) {
        // Create overlay element
        let overlay = document.querySelector('.sidebar-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'sidebar-overlay';
            document.querySelector('.app-layout').appendChild(overlay);
        }

        menuBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            overlay.classList.toggle('active');
        });

        overlay.addEventListener('click', () => {
            closeMobileSidebar();
        });
    }
}

function closeMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
}

// ===== Auto-Refresh Polling =====
function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
        loadRealtimeStatus();
    }, REFRESH_INTERVAL);
}

// ===== ML Service Status Check =====
async function checkMLStatus() {
    const badge = document.getElementById('ml-status');
    const controlStatus = document.getElementById('ml-control-status');
    if (!badge) return;

    try {
        const res = await authFetch(`${API_BASE}/ml-service/status`);
        const data = await res.json();
        
        if (data.status === 'healthy' || data.status === 'online' || data.success) {
            badge.innerHTML = '<span class="ml-dot" id="ml-dot-top"></span> ML: Active';
            badge.classList.remove('disconnected');
            if (controlStatus) controlStatus.textContent = 'Engine online (Port 5000)';
        } else {
            throw new Error('Offline');
        }
    } catch (err) {
        badge.innerHTML = '<span class="ml-dot" id="ml-dot-top"></span> ML: Offline';
        badge.classList.add('disconnected');
        if (controlStatus) controlStatus.textContent = 'Service is offline';
    }
}

// ===== ML Service Start/Stop =====
async function startMLService() {
    const controlDot = document.getElementById('ml-dot');
    const controlStatus = document.getElementById('ml-control-status');
    if (controlDot) controlDot.className = 'ml-status-dot starting';
    if (controlStatus) controlStatus.textContent = 'Starting service...';

    try {
        const res = await authFetch(`${API_BASE}/ml-service/start`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('ML Service started!', 'success');
            setTimeout(() => checkMLStatus(), 3000);
        } else {
            showToast(data.message || 'Failed to start ML service', 'error');
            if (controlDot) controlDot.className = 'ml-status-dot stopped';
            if (controlStatus) controlStatus.textContent = 'Failed to start';
        }
    } catch (err) {
        showToast('Could not reach backend to start ML service', 'error');
        if (controlDot) controlDot.className = 'ml-status-dot stopped';
        if (controlStatus) controlStatus.textContent = 'Error starting service';
    }
}

async function stopMLService() {
    const controlDot = document.getElementById('ml-dot');
    const controlStatus = document.getElementById('ml-control-status');

    try {
        const res = await authFetch(`${API_BASE}/ml-service/stop`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('ML Service stopped', 'info');
            if (controlDot) controlDot.className = 'ml-status-dot stopped';
            if (controlStatus) controlStatus.textContent = 'Service stopped';
            checkMLStatus();
        } else {
            showToast(data.message || 'Failed to stop ML service', 'error');
        }
    } catch (err) {
        showToast('Could not reach backend to stop ML service', 'error');
    }
}

// ===== Real-Time Status Cards =====
async function loadRealtimeStatus() {
    try {
        const res = await authFetch(`${API_BASE}/realtime-status`);
        const data = await res.json();

        if (data.success) {
            const s = data.status;

            // Update cards with animation
            updateCard('card-current', s.currentUsage);
            updateCard('card-predicted', s.predictedUsage);
            updateCard('card-avg', s.dailyAvg);
            updateCard('card-anomalies', s.anomalyCount);

            // Show anomaly banner if needed
            const banner = document.getElementById('anomaly-banner');
            if (s.anomalyCount > 0) {
                banner.style.display = 'flex';
                document.getElementById('anomaly-banner-text').textContent =
                    `${s.anomalyCount} anomal${s.anomalyCount === 1 ? 'y' : 'ies'} detected in your energy consumption — check the analytics section.`;
            }

            // Render hourly trend if available
            if (s.hourlyTrend && s.hourlyTrend.length > 0) {
                renderTrendChart(s.hourlyTrend);
            }

            // Update last-updated timestamp
            updateLastUpdated();
        }
    } catch (err) {
        console.error('Failed to load realtime status', err);
    }
}

function updateLastUpdated() {
    const el = document.getElementById('lastUpdatedText');
    if (el) {
        const now = new Date();
        el.textContent = 'Last updated: ' + now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
}

function updateCard(id, value) {
    const el = document.getElementById(id);
    if (el) {
        const displayValue = typeof value === 'number' ? value.toFixed(value % 1 === 0 ? 0 : 2) : value;
        if (el.textContent !== String(displayValue)) {
            el.textContent = displayValue;
            el.classList.add('updated');
            setTimeout(() => el.classList.remove('updated'), 600);
        }
    }
}

// ===== Dual Input Tab Switching =====
const methodTabs = document.querySelectorAll('.method-tab');
if(methodTabs) {
    methodTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            methodTabs.forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.method-panel').forEach(p => p.classList.remove('active'));
            
            tab.classList.add('active');
            const panel = document.getElementById(`panel-${tab.dataset.method}`);
            if(panel) panel.classList.add('active');
        });
    });
}

// ===== Copy CSV Sample =====
const copyCsvSampleBtn = document.getElementById('copyCsvSample');
if (copyCsvSampleBtn) {
    copyCsvSampleBtn.addEventListener('click', () => {
        const sampleText = `Date,Units\n2025-01-01,12.5\n2025-01-02,14.2\n2025-01-03,11.8\n2025-01-04,16.1\n2025-01-05,13.7`;
        navigator.clipboard.writeText(sampleText).then(() => {
            const orig = copyCsvSampleBtn.textContent;
            copyCsvSampleBtn.textContent = 'Copied!';
            setTimeout(() => copyCsvSampleBtn.textContent = orig, 2000);
        });
    });
}

// ===== Bill File Handling =====
const billDropzone = document.getElementById('billDropzone');
const billFileInput = document.getElementById('billFileInput');
const billPreview = document.getElementById('billPreview');
const previewFileName = document.getElementById('previewFileName');
const previewFileSize = document.getElementById('previewFileSize');
const previewImgContainer = document.getElementById('previewImgContainer');
const previewImg = document.getElementById('previewImg');
const previewRemoveBtn = document.getElementById('previewRemoveBtn');
const processBillBtn = document.getElementById('processBillBtn');
const billUploadStatus = document.getElementById('billUploadStatus');
const billProgress = document.getElementById('billProgress');
const billProgressFill = document.getElementById('billProgressFill');
const billProgressText = document.getElementById('billProgressText');
const extractionResults = document.getElementById('extractionResults');

let currentBillFile = null;
let activeExtractedData = null;

if (billDropzone && billFileInput) {
    billDropzone.addEventListener('click', () => billFileInput.click());

    billDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        billDropzone.classList.add('dragover');
    });

    billDropzone.addEventListener('dragleave', () => {
        billDropzone.classList.remove('dragover');
    });

    billDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        billDropzone.classList.remove('dragover');
        if (e.dataTransfer.files.length) {
            handleBillSelection(e.dataTransfer.files[0]);
        }
    });

    billFileInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
            handleBillSelection(e.target.files[0]);
        }
    });
}

function handleBillSelection(file) {
    const validTypes = ['image/jpeg', 'image/png', 'application/pdf', 'image/bmp', 'image/webp'];
    if (!validTypes.includes(file.type)) {
        showToast('Unsupported file type. Use JPG, PNG, or PDF.', 'warning');
        return;
    }
    if (file.size > 10 * 1024 * 1024) {
        showToast('File size must be under 10MB', 'warning');
        return;
    }

    currentBillFile = file;
    billDropzone.style.display = 'none';
    billPreview.style.display = 'flex';
    processBillBtn.style.display = 'flex';
    if(extractionResults) extractionResults.style.display = 'none';
    if(billUploadStatus) billUploadStatus.textContent = '';

    previewFileName.textContent = file.name;
    previewFileSize.textContent = (file.size / 1024 / 1024).toFixed(2) + ' MB';

    if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (e) => {
            previewImg.src = e.target.result;
            previewImgContainer.style.display = 'block';
        };
        reader.readAsDataURL(file);
    } else {
        previewImgContainer.style.display = 'none';
    }
}

if (previewRemoveBtn) {
    previewRemoveBtn.addEventListener('click', () => {
        currentBillFile = null;
        billFileInput.value = '';
        billPreview.style.display = 'none';
        processBillBtn.style.display = 'none';
        billDropzone.style.display = 'flex';
        if(extractionResults) extractionResults.style.display = 'none';
    });
}

if (processBillBtn) {
    processBillBtn.addEventListener('click', async () => {
        if (!currentBillFile) return;

        const formData = new FormData();
        formData.append('bill', currentBillFile);

        processBillBtn.disabled = true;
        processBillBtn.innerHTML = '<svg class="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Processing with AI...';
        
        billProgress.style.display = 'flex';
        billProgressFill.style.width = '30%';
        billProgressText.textContent = 'Uploading bill...';
        billUploadStatus.textContent = '';

        // Fake progress animation for better UX
        let progress = 30;
        const progressInterval = setInterval(() => {
            progress += 3;
            if (progress > 85) clearInterval(progressInterval);
            else {
                billProgressFill.style.width = progress + '%';
                if (progress > 40) billProgressText.textContent = 'Preprocessing image...';
                if (progress > 55) billProgressText.textContent = 'Running PaddleOCR extraction...';
                if (progress > 70) billProgressText.textContent = 'Validating extracted fields...';
            }
        }, 800);

        try {
            const res = await authFetch(`${API_BASE}/upload-bill`, {
                method: 'POST',
                body: formData
            });
            const data = await res.json();

            if (!data.success) {
                throw new Error(data.message || 'OCR upload failed');
            }

            let extractedData = null;

            if (data.billId) {
                // Background processing: poll status endpoint
                billProgressText.textContent = 'Computing confidence scores...';
                const pollStart = Date.now();
                const pollTimeout = 120000; // 2 minutes

                while (Date.now() - pollStart < pollTimeout) {
                    // Wait 2 seconds before checking status
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    const statusRes = await authFetch(`${API_BASE}/bill-status/${data.billId}`);
                    const statusData = await statusRes.json();

                    if (statusData.status === 'success') {
                        extractedData = statusData.extracted;
                        break;
                    } else if (statusData.status === 'failed') {
                        throw new Error(statusData.message || 'OCR processing failed');
                    }

                    // Increment progress slightly while waiting
                    if (progress < 95) {
                        progress += 2;
                        billProgressFill.style.width = Math.min(progress, 95) + '%';
                    }
                    const elapsed = Math.floor((Date.now() - pollStart) / 1000);
                    billProgressText.textContent = `Extracting fields (${elapsed}s elapsed)...`;
                }

                if (!extractedData) {
                    throw new Error('OCR processing timed out');
                }
            } else if (data.extracted) {
                // Synchronous fallback (if backend runs synchronously)
                extractedData = data.extracted;
            } else {
                throw new Error('No extracted data returned');
            }
            
            clearInterval(progressInterval);
            billProgressFill.style.width = '100%';
            billProgressText.textContent = 'Complete!';

            showToast('Bill analyzed! Please verify and correct any values.', 'success');
            displayExtractionResults(extractedData);
        } catch (err) {
            clearInterval(progressInterval);
            billUploadStatus.textContent = `Error: ${err.message}`;
            billUploadStatus.style.color = '#ef4444';
            showToast(err.message || 'Failed to process bill', 'error');
            billProgress.style.display = 'none';
        } finally {
            processBillBtn.disabled = false;
            processBillBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> Process Bill with OCR';
            setTimeout(() => {
                if(billProgressText.textContent === 'Complete!') billProgress.style.display = 'none';
            }, 2000);
        }
    });
}

function displayExtractionResults(data) {
    if(!data) return;
    activeExtractedData = data;
    
    // Set field values
    document.getElementById('ext-board').value = data.electricityBoard || '';
    document.getElementById('ext-consumer').value = data.consumerNumber?.value ?? data.consumerNumber ?? '';
    document.getElementById('ext-month').value = data.billingMonth?.value ?? data.billingMonth ?? '';
    document.getElementById('ext-units').value = data.totalUnits?.value ?? data.totalUnits ?? '';
    document.getElementById('ext-amount').value = data.billAmount?.value ?? data.billAmount ?? '';
    document.getElementById('ext-prev').value = data.previousReading?.value ?? data.previousReading ?? '';
    document.getElementById('ext-curr').value = data.currentReading?.value ?? data.currentReading ?? '';
    
    // New fields
    const billingDateEl = document.getElementById('ext-billing-date');
    const dueDateEl = document.getElementById('ext-due-date');
    const serviceNumEl = document.getElementById('ext-service-number');
    if (billingDateEl) billingDateEl.value = data.billingDate?.value ?? data.billingDate ?? '';
    if (dueDateEl) dueDateEl.value = data.dueDate?.value ?? data.dueDate ?? '';
    if (serviceNumEl) serviceNumEl.value = data.serviceNumber?.value ?? data.serviceNumber ?? '';
    
    // Per-field confidence badges
    const fieldConfMap = {
        'ext-board': null,
        'ext-consumer': data.consumerNumber,
        'ext-month': data.billingMonth,
        'ext-units': data.totalUnits,
        'ext-amount': data.billAmount,
        'ext-prev': data.previousReading,
        'ext-curr': data.currentReading,
        'ext-billing-date': data.billingDate,
        'ext-due-date': data.dueDate,
        'ext-service-number': data.serviceNumber,
    };
    
    // Get validation data if available
    const validation = data.validation || {};
    
    for (const [id, fieldData] of Object.entries(fieldConfMap)) {
        const el = document.getElementById(id);
        if (!el) continue;
        
        // Remove any existing confidence badge and warnings
        const existingBadge = el.parentElement.querySelector('.field-confidence');
        if (existingBadge) existingBadge.remove();
        const existingWarns = el.parentElement.querySelectorAll('.validation-warning, .validation-error');
        existingWarns.forEach(w => w.remove());
        
        const rawVal = fieldData?.value ?? fieldData;
        const conf = fieldData?.confidence;
        
        // Highlight missing/suspicious fields
        if (!rawVal || rawVal === 0 || rawVal === 'Unknown') {
            el.style.border = '2px solid #ef4444';
            el.style.backgroundColor = 'rgba(239, 68, 68, 0.05)';
        } else if (conf !== undefined && conf < 50) {
            el.style.border = '2px solid #ef4444';
            el.style.backgroundColor = 'rgba(239, 68, 68, 0.05)';
        } else if (conf !== undefined && conf < 70) {
            el.style.border = '2px solid #f59e0b';
            el.style.backgroundColor = 'rgba(245, 158, 11, 0.05)';
        } else {
            el.style.border = '';
            el.style.backgroundColor = '';
        }
        
        // Add confidence badge if available
        if (conf !== undefined) {
            const badge = document.createElement('span');
            let confClass = 'conf-high';
            let confIcon = '✓';
            if (conf < 50) { confClass = 'conf-low'; confIcon = '✗'; }
            else if (conf < 70) { confClass = 'conf-medium'; confIcon = '~'; }
            badge.className = `field-confidence ${confClass} just-loaded`;
            badge.innerHTML = `<span class="conf-icon">${confIcon}</span> ${conf}%`;
            el.parentElement.appendChild(badge);
            setTimeout(() => badge.classList.remove('just-loaded'), 600);
        }
        
        // Add validation warnings
        const fieldName = {
            'ext-consumer': 'consumer_number',
            'ext-month': 'billing_month',
            'ext-units': 'total_units',
            'ext-amount': 'bill_amount',
            'ext-prev': 'previous_reading',
            'ext-curr': 'current_reading',
            'ext-billing-date': 'billing_date',
            'ext-due-date': 'due_date',
            'ext-service-number': 'service_number',
        }[id];
        
        const fieldValidation = validation[fieldName];
        if (fieldValidation) {
            if (fieldValidation.errors) {
                fieldValidation.errors.forEach(err => {
                    const warn = document.createElement('span');
                    warn.className = 'validation-error';
                    warn.textContent = '✗ ' + err;
                    el.parentElement.appendChild(warn);
                });
            }
            if (fieldValidation.warnings) {
                fieldValidation.warnings.forEach(w => {
                    const warn = document.createElement('span');
                    warn.className = 'validation-warning';
                    warn.textContent = '⚠ ' + w;
                    el.parentElement.appendChild(warn);
                });
            }
        }
        
        // Remove highlight once user begins editing
        el.addEventListener('input', function clearHighlight() {
            el.style.border = '';
            el.style.backgroundColor = '';
            el.removeEventListener('input', clearHighlight);
        });
    }

    // Overall confidence display
    const confEl = document.getElementById('ext-confidence');
    const overallConf = data.overall_confidence ?? data.confidence_score ?? 50;
    const confLabel = (data.overall_confidence_label || data.confidence || 'medium').toUpperCase();
    confEl.textContent = `${confLabel} (${overallConf}%)`;
    confEl.className = 'extract-value';
    if (overallConf >= 70) confEl.className = 'extract-value conf-high';
    else if (overallConf >= 40) confEl.className = 'extract-value conf-medium';
    else confEl.className = 'extract-value conf-low';
    
    // OCR engine badge
    let engineHtml = '';
    if (data.ocr_engine) {
        engineHtml = `<span class="ocr-engine-badge">⚡ ${data.ocr_engine}</span> `;
    }
    
    // Image quality bar
    let qualityHtml = '';
    if (data.image_quality && data.image_quality.score !== undefined) {
        const qs = data.image_quality.score;
        const qClass = qs >= 70 ? 'good' : qs >= 40 ? 'fair' : 'poor';
        const qLabel = qs >= 70 ? 'Good' : qs >= 40 ? 'Fair' : 'Poor';
        qualityHtml = `
            <div style="margin-bottom: 8px;">
                <span style="font-size: 12px; color: #94a3b8;">Image Quality: ${qLabel} (${qs}%)</span>
                <div class="image-quality-bar"><div class="fill ${qClass}" style="width: ${qs}%"></div></div>
            </div>
        `;
    }
    
    // Warning / success message
    let warningHtml = '';
    if (overallConf < 40) {
        warningHtml = `
            ${qualityHtml}
            <div style="background: rgba(239, 68, 68, 0.1); padding: 12px; border-radius: 8px; border: 1px solid rgba(239, 68, 68, 0.2); margin-bottom: 12px;">
                <p style="margin: 0; color: #ef4444; font-weight: 600;">⚠ Low Confidence Extraction ${engineHtml}</p>
                <p style="margin: 4px 0 0; font-size: 13px; color: #94a3b8;">Some fields could not be extracted reliably. Please verify the values highlighted in red above and correct any mistakes before saving.</p>
            </div>
        `;
    } else {
        warningHtml = `
            ${qualityHtml}
            <div style="background: rgba(16, 185, 129, 0.1); padding: 12px; border-radius: 8px; border: 1px solid rgba(16, 185, 129, 0.2); margin-bottom: 12px;">
                <p style="margin: 0; color: #10b981; font-weight: 600;">✓ Verification Required ${engineHtml}</p>
                <p style="margin: 4px 0 0; font-size: 13px; color: #94a3b8;">Review the extracted data. You can manually edit any field if it's incorrect.</p>
            </div>
        `;
    }
    
    document.getElementById('ext-records-msg').innerHTML = warningHtml;
    extractionResults.style.display = 'block';
    
    // Hide process button to show results
    processBillBtn.style.display = 'none';
}

// Confirm OCR Bill Action
const confirmBillBtn = document.getElementById('confirmBillBtn');
if (confirmBillBtn) {
    confirmBillBtn.addEventListener('click', async () => {
        if (!activeExtractedData) return;
        
        confirmBillBtn.disabled = true;
        confirmBillBtn.textContent = 'Saving & training models...';
        
        const payload = {
            consumerNumber: document.getElementById('ext-consumer').value,
            billingMonth: document.getElementById('ext-month').value,
            totalUnits: parseFloat(document.getElementById('ext-units').value) || 0,
            billAmount: parseFloat(document.getElementById('ext-amount').value) || 0,
            previousReading: parseFloat(document.getElementById('ext-prev').value) || 0,
            currentReading: parseFloat(document.getElementById('ext-curr').value) || 0,
            electricityBoard: document.getElementById('ext-board').value,
            billingDate: document.getElementById('ext-billing-date') ? document.getElementById('ext-billing-date').value : '',
            dueDate: document.getElementById('ext-due-date') ? document.getElementById('ext-due-date').value : '',
            serviceNumber: document.getElementById('ext-service-number') ? document.getElementById('ext-service-number').value : '',
            originalFileName: activeExtractedData.originalFileName || activeExtractedData.original_file_name,
            fileType: activeExtractedData.fileType || activeExtractedData.file_type,
            extractionConfidence: activeExtractedData.overall_confidence_label || activeExtractedData.confidence,
            rawTextLength: activeExtractedData.rawTextLength || activeExtractedData.raw_text_length
        };
        
        try {
            const res = await authFetch(`${API_BASE.replace('/auth', '')}/confirm-bill`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await res.json();
            
            if (result.success) {
                showToast('Bill saved and energy predictions updated!', 'success');
                extractionResults.style.display = 'none';
                
                // Reset Dropzone & Preview
                currentBillFile = null;
                activeExtractedData = null;
                billFileInput.value = '';
                billPreview.style.display = 'none';
                billDropzone.style.display = 'flex';
                
                // Refresh dashboard data
                loadBillHistory();
                markUserDataInitialized();
                checkDataAndRender();
            } else {
                throw new Error(result.message || 'Failed to save bill data');
            }
        } catch (err) {
            showToast(`Error confirming bill: ${err.message}`, 'error');
        } finally {
            confirmBillBtn.disabled = false;
            confirmBillBtn.textContent = 'Confirm & Process predictions';
        }
    });
}

// Cancel OCR Bill Action
const cancelOcrBtn = document.getElementById('cancelOcrBtn');
if (cancelOcrBtn) {
    cancelOcrBtn.addEventListener('click', () => {
        currentBillFile = null;
        activeExtractedData = null;
        billFileInput.value = '';
        billPreview.style.display = 'none';
        processBillBtn.style.display = 'none';
        billDropzone.style.display = 'flex';
        extractionResults.style.display = 'none';
    });
}

const loadSampleBtn2 = document.getElementById('loadSampleBtn2');
if (loadSampleBtn2) {
    loadSampleBtn2.addEventListener('click', async () => {
        const originalSampleBtn = document.getElementById('loadSampleBtn');
        if(originalSampleBtn) originalSampleBtn.click();
    });
}

// ===== Upload Data =====
uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData();
    const fileField = document.getElementById('dataset');
    formData.append('dataset', fileField.files[0]);

    uploadStatus.textContent = "Uploading and processing data...";
    uploadStatus.style.color = "#64748b";

    try {
        const res = await authFetch(`${API_BASE}/upload-data`, {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            uploadStatus.textContent = data.message;
            uploadStatus.style.color = "#10b981";
            showToast('Data uploaded and processed successfully!', 'success');
            markUserDataInitialized();
            checkDataAndRender();
        } else {
            throw new Error(data.message);
        }
    } catch (err) {
        uploadStatus.textContent = `Error: ${err.message}`;
        uploadStatus.style.color = "#ef4444";
        showToast('Failed to upload data', 'error');
    }
});

// ===== Train Models =====
trainBtn.addEventListener('click', async () => {
    const originalText = trainBtn.textContent;
    trainBtn.textContent = 'Training (this may take a minute)...';
    trainBtn.disabled = true;

    try {
        const res = await authFetch(`${API_BASE}/train-model`);
        const data = await res.json();
        if (data.success) {
            showToast('Models trained successfully!', 'success');
        } else {
            showToast(`Training error: ${data.message}`, 'error');
        }
    } catch (err) {
        showToast('Failed to train model.', 'error');
    } finally {
        trainBtn.textContent = originalText;
        trainBtn.disabled = false;
    }
});

// ===== Generate Prediction =====
predictBtn.addEventListener('click', async () => {
    predictBtn.textContent = 'Predicting...';
    try {
        const res = await authFetch(`${API_BASE}/predict`);
        const data = await res.json();
        if (data.success && data.predictions.length > 0) {
            const pred = data.predictions[0];
            showToast(`Prediction: ${pred.predicted_units.toFixed(2)} units for ${pred.targetDate}`, 'info', 6000);
            loadEnhancedHistorical();
            loadRealtimeStatus();
        } else {
            showToast('No predictions generated. Train models first.', 'warning');
        }
    } catch (err) {
        console.error(err);
        showToast('Failed to generate prediction.', 'error');
    } finally {
        predictBtn.textContent = 'Generate Next Prediction';
    }
});

// ===== Detect Anomalies =====
anomalyBtn.addEventListener('click', async () => {
    anomalyBtn.textContent = 'Analyzing...';
    try {
        const res = await authFetch(`${API_BASE}/anomaly-detection`);
        const data = await res.json();
        if (data.success) {
            renderAnomalyChart(data.anomalies);
            if (data.anomalies.length > 0) {
                showToast(`${data.anomalies.length} anomalies detected!`, 'warning');
                loadEnhancedHistorical();
                loadRealtimeStatus();
            } else {
                showToast('No anomalies detected. All good!', 'success');
            }
        } else {
            showToast('Failed to detect anomalies', 'error');
        }
    } catch (err) {
        console.error(err);
    } finally {
        anomalyBtn.textContent = 'Detect Anomalies';
    }
});

// ===== Load Recommendations =====
getRecsBtn.addEventListener('click', loadRecommendations);

async function loadRecommendations() {
    recsList.innerHTML = '<li>Loading...</li>';
    try {
        const res = await authFetch(`${API_BASE}/recommendations`);
        const data = await res.json();
        if (data.success) {
            recsList.innerHTML = '';
            if (data.data.length === 0) {
                recsList.innerHTML = '<li>No specific recommendations at this time.</li>';
                return;
            }
            data.data.forEach(r => {
                const li = document.createElement('li');
                const priority = r.priority || 'low';
                li.className = `priority-${priority}`;
                const badge = `<span class="rec-badge ${priority}">${r.type || 'Tip'}</span>`;
                li.innerHTML = `${badge} ${r.message}`;
                recsList.appendChild(li);
            });
        }
    } catch (err) {
        recsList.innerHTML = '<li>Failed to load recommendations.</li>';
    }
}

// ===== Reports Table =====
async function renderReportsTable() {
    const tbody = document.getElementById('reports-tbody');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Loading report data...</td></tr>';

    try {
        // Try enhanced data first (has anomaly info)
        let records = [];
        try {
            const res = await authFetch(`${API_BASE}/enhanced-historical`);
            const data = await res.json();
            if (data.success && data.data.length > 0) {
                records = data.data;
            }
        } catch {
            // fallback to basic
            const res = await authFetch(`${API_BASE}/historical-data`);
            const data = await res.json();
            if (data.success && data.data.length > 0) {
                records = data.data;
            }
        }

        if (records.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No data available. Upload a CSV dataset first.</td></tr>';
            return;
        }

        // Sort by date descending (most recent first)
        records.sort((a, b) => new Date(b.date) - new Date(a.date));

        // Compute summary stats
        const allUnits = records.filter(r => typeof r.units === 'number').map(r => r.units);
        const total = allUnits.reduce((a, b) => a + b, 0);
        const avg = allUnits.length > 0 ? total / allUnits.length : 0;
        const max = allUnits.length > 0 ? Math.max(...allUnits) : 0;
        const min = allUnits.length > 0 ? Math.min(...allUnits) : 0;
        const summaryEl = document.getElementById('report-summary');
        if (summaryEl) {
            summaryEl.innerHTML = `
                <div class="report-stat"><span class="report-stat-label">Total</span><span class="report-stat-value">${total.toFixed(2)} kWh</span></div>
                <div class="report-stat"><span class="report-stat-label">Average</span><span class="report-stat-value">${avg.toFixed(2)} kWh</span></div>
                <div class="report-stat"><span class="report-stat-label">Max</span><span class="report-stat-value">${max.toFixed(2)} kWh</span></div>
                <div class="report-stat"><span class="report-stat-label">Min</span><span class="report-stat-value">${min.toFixed(2)} kWh</span></div>
            `;
        }

        // Build table rows (show last 50)
        const displayRecords = records.slice(0, 50);
        tbody.innerHTML = '';

        displayRecords.forEach(r => {
            const tr = document.createElement('tr');
            const date = new Date(r.date).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
            const units = typeof r.units === 'number' ? r.units.toFixed(2) : r.units;
            const cost = typeof r.units === 'number' ? '₹' + (r.units * 6.5).toFixed(2) : '—';

            let statusClass = 'status-normal';
            let statusText = 'Normal';
            if (r.isAnomaly) {
                statusClass = 'status-anomaly';
                statusText = '⚠ Anomaly';
            } else if (typeof r.units === 'number' && r.units > 50) {
                statusClass = 'status-high';
                statusText = 'High';
            }

            tr.innerHTML = `
                <td>${date}</td>
                <td>${units}</td>
                <td>${cost}</td>
                <td><span class="${statusClass}">${statusText}</span></td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error('Failed to render reports table', err);
        tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Error loading report data.</td></tr>';
    }
}

// ===== Data Availability Check & Conditional Rendering =====
let hasUserData = false;

function getUserDataKey() {
    return `energyai_data_init_${currentUser.id || 'default'}`;
}

async function checkDataAndRender() {
    const emptyState = document.getElementById('empty-state');
    const dashContent = document.getElementById('dashboard-content');
    const badgeEl = document.getElementById('dataset-status-badge');

    try {
        // Fetch user data status
        const statusRes = await authFetch(`${API_BASE}/user-data-status`);
        const statusData = await statusRes.json();
        const hasData = statusData.success && statusData.hasData;

        // Update dataset status badge
        if (badgeEl) {
            badgeEl.style.display = 'flex';
            badgeEl.className = 'status-badge'; // reset classes
            const textEl = badgeEl.querySelector('.status-text');
            
            if (statusData.datasetStatus === 'ready') {
                badgeEl.classList.add('status-ready');
                if (textEl) textEl.textContent = 'Dataset Ready';
            } else if (statusData.datasetStatus === 'processing') {
                badgeEl.classList.add('status-processing');
                if (textEl) textEl.textContent = 'Processing...';
            } else {
                badgeEl.classList.add('status-not-uploaded');
                if (textEl) textEl.textContent = 'No Dataset';
            }
        }

        if (hasData) {
            if (emptyState) emptyState.style.display = 'none';
            if (dashContent) dashContent.style.display = 'block';

            // Wrap component rendering in error boundaries
            runWithErrorBoundary(() => loadRealtimeStatus(), 'status-cards');
            runWithErrorBoundary(() => loadEnhancedHistorical(), 'mainChart');
            runWithErrorBoundary(() => loadRecommendations(), 'recsList');
            runWithErrorBoundary(() => loadMonthlyProjection(), 'monthly-panel');
            runWithErrorBoundary(() => loadAnomalyLog(), 'anomaly-log');
            runWithErrorBoundary(() => loadDailyUsageChart(), 'dailyUsageChart');
            runWithErrorBoundary(() => loadWeeklyCompChart(), 'weeklyCompChart');
            runWithErrorBoundary(() => renderApplianceBreakdown(), 'applianceChart');
        } else {
            if (emptyState) emptyState.style.display = 'flex';
            if (dashContent) dashContent.style.display = 'none';
        }

        console.log('[Dashboard] Dashboard loaded');
    } catch (err) {
        console.error('Data status load failed', err);
        if (emptyState) emptyState.style.display = 'flex';
        if (dashContent) dashContent.style.display = 'none';
    }
}

async function loadSampleData() {
    showToast('Initializing sample dataset...', 'info');
    try {
        const res = await authFetch(`${API_BASE}/upload-data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isSample: true })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Sample data loaded!', 'success');
            checkDataAndRender();
        }
    } catch (err) {
        showToast('Failed to load sample data', 'error');
    }
}

// Called after successful upload — marks user as initialized
function markUserDataInitialized() {
    localStorage.setItem(getUserDataKey(), 'true');
}

// ===== Enhanced Historical Data with Anomaly Overlay =====
async function loadEnhancedHistorical() {
    try {
        const res = await authFetch(`${API_BASE}/enhanced-historical`);
        const data = await res.json();
        if (data.success && data.data.length > 0) {
            renderEnhancedMainChart(data.data, 'daily');
        }
    } catch (err) {
        console.error('Failed to load enhanced data', err);
        try {
            const res = await authFetch(`${API_BASE}/historical-data`);
            const data = await res.json();
            if (data.success && data.data.length > 0) {
                renderBasicMainChart(data.data);
            }
        } catch (e) {
            console.error('Fallback also failed', e);
        }
    }
}

// ===== Chart Configuration =====
Chart.defaults.color = '#94a3b8';
Chart.defaults.borderColor = '#e2e8f0';

let cachedEnhancedData = [];

function renderEnhancedMainChart(records, mode = 'daily') {
    cachedEnhancedData = records;
    const ctx = document.getElementById('mainChart').getContext('2d');

    let processedRecords = records;

    // Weekly aggregation
    if (mode === 'weekly') {
        const weeklyMap = {};
        records.forEach(r => {
            const d = new Date(r.date);
            const weekStart = new Date(d);
            weekStart.setDate(d.getDate() - d.getDay());
            const key = weekStart.toISOString().split('T')[0];
            if (!weeklyMap[key]) weeklyMap[key] = { units: [], predicted: [], anomaly: false };
            weeklyMap[key].units.push(r.units);
            if (r.predicted_units) weeklyMap[key].predicted.push(r.predicted_units);
            if (r.isAnomaly) weeklyMap[key].anomaly = true;
        });
        processedRecords = Object.entries(weeklyMap).map(([key, val]) => ({
            date: key,
            units: val.units.reduce((a, b) => a + b, 0) / val.units.length,
            predicted_units: val.predicted.length > 0 ? val.predicted.reduce((a, b) => a + b, 0) / val.predicted.length : null,
            isAnomaly: val.anomaly
        }));
    }

    const labels = processedRecords.map(r => new Date(r.date).toLocaleDateString());
    const actualUnits = processedRecords.map(r => r.units);
    const predictedUnits = processedRecords.map(r => r.predicted_units);
    const hasAnyPrediction = predictedUnits.some(v => v !== null);

    // Build anomaly point data
    const anomalyPoints = processedRecords.map((r, i) => r.isAnomaly ? r.units : null);

    const datasets = [
        {
            label: 'Actual Consumption (Units)',
            data: actualUnits,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.06)',
            fill: true,
            tension: 0.3,
            pointRadius: 2,
            borderWidth: 2,
            order: 2
        }
    ];

    // Predicted line overlay
    if (hasAnyPrediction) {
        datasets.push({
            label: 'Predicted Usage',
            data: predictedUnits,
            borderColor: '#8b5cf6',
            backgroundColor: 'rgba(139, 92, 246, 0.06)',
            borderDash: [6, 3],
            fill: false,
            tension: 0.3,
            pointRadius: 3,
            borderWidth: 2,
            spanGaps: true,
            order: 1
        });
    }

    // Anomaly markers overlay
    const hasAnomalies = anomalyPoints.some(v => v !== null);
    if (hasAnomalies) {
        datasets.push({
            label: 'Anomaly Points',
            data: anomalyPoints,
            borderColor: '#ef4444',
            backgroundColor: '#ef4444',
            pointRadius: 8,
            pointHoverRadius: 10,
            pointStyle: 'triangle',
            showLine: false,
            order: 0
        });
    }

    if (mainChartIns) mainChartIns.destroy();

    mainChartIns = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: {
                    labels: {
                        usePointStyle: true,
                        padding: 16,
                        font: { family: "'Inter', sans-serif" }
                    }
                },
                tooltip: {
                    backgroundColor: '#0f172a',
                    titleFont: { family: "'Inter', sans-serif" },
                    bodyFont: { family: "'Inter', sans-serif" },
                    callbacks: {
                        afterBody: (items) => {
                            const idx = items[0]?.dataIndex;
                            if (idx !== undefined && anomalyPoints[idx] !== null) {
                                return '⚠️ ANOMALY DETECTED';
                            }
                            return '';
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: false,
                    grid: { color: 'rgba(226, 232, 240, 0.5)' }
                },
                x: {
                    ticks: { maxRotation: 45, maxTicksLimit: 15 },
                    grid: { display: false }
                }
            }
        }
    });
}

function renderBasicMainChart(records) {
    const ctx = document.getElementById('mainChart').getContext('2d');
    const labels = records.map(r => new Date(r.date).toLocaleDateString());
    const units = records.map(r => r.units);

    if (mainChartIns) mainChartIns.destroy();

    mainChartIns = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Historical Consumption (Units)',
                data: units,
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.06)',
                fill: true,
                tension: 0.3,
                pointRadius: 2
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: { beginAtZero: false, grid: { color: 'rgba(226, 232, 240, 0.5)' } },
                x: { grid: { display: false } }
            }
        }
    });
}

function renderAnomalyChart(anomalies) {
    const ctx = document.getElementById('anomalyChart').getContext('2d');

    if (anomalies.length === 0) {
        if (anomalyChartIns) anomalyChartIns.destroy();
        ctx.font = '14px Inter';
        ctx.fillStyle = '#10b981';
        ctx.textAlign = 'center';
        ctx.fillText('No anomalies detected ✅', ctx.canvas.width / 2, ctx.canvas.height / 2);
        return;
    }

    const labels = anomalies.map(a => a.date);
    const actualData = anomalies.map(a => a.units);
    const expectedData = anomalies.map(a => a.expected_units);

    if (anomalyChartIns) anomalyChartIns.destroy();

    anomalyChartIns = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Anomaly Usage',
                    data: actualData,
                    backgroundColor: 'rgba(239, 68, 68, 0.5)',
                    borderColor: '#ef4444',
                    borderWidth: 1,
                    borderRadius: 6
                },
                {
                    label: 'Expected Average',
                    data: expectedData,
                    backgroundColor: 'rgba(59, 130, 246, 0.25)',
                    borderColor: '#3b82f6',
                    borderWidth: 1,
                    borderRadius: 6
                }
            ]
        },
        options: {
            responsive: true,
            plugins: {
                tooltip: {
                    backgroundColor: '#0f172a',
                    callbacks: {
                        afterLabel: (ctx) => {
                            if (ctx.datasetIndex === 0) {
                                const diff = ((ctx.raw - expectedData[ctx.dataIndex]) / expectedData[ctx.dataIndex] * 100).toFixed(0);
                                return `${diff > 0 ? '+' : ''}${diff}% from expected`;
                            }
                        }
                    }
                }
            },
            scales: {
                x: { ticks: { maxRotation: 45 }, grid: { display: false } },
                y: { beginAtZero: false, grid: { color: 'rgba(226, 232, 240, 0.5)' } }
            }
        }
    });
}

function renderTrendChart(trendData) {
    const el = document.getElementById('trendChart');
    if (!el) return;
    const ctx = el.getContext('2d');
    const labels = trendData.map(d => new Date(d.date).toLocaleDateString());
    const units = trendData.map(d => d.units);
    const colors = trendData.map(d => d.anomaly ? '#ef4444' : '#10b981');

    if (trendChartIns) trendChartIns.destroy();

    trendChartIns = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Recent Consumption',
                data: units,
                backgroundColor: colors.map(c => c === '#ef4444' ? 'rgba(239,68,68,0.4)' : 'rgba(16,185,129,0.25)'),
                borderColor: colors,
                borderWidth: 1,
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false }
            },
            scales: {
                x: { ticks: { maxRotation: 45, maxTicksLimit: 12 }, grid: { display: false } },
                y: { beginAtZero: false, grid: { color: 'rgba(226, 232, 240, 0.5)' } }
            }
        }
    });
}

// ===== Chart Toggle (Daily/Weekly) =====
function setupChartToggles() {
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const range = btn.dataset.range;
            if (cachedEnhancedData.length > 0) {
                renderEnhancedMainChart(cachedEnhancedData, range);
            }
        });
    });
}

// ===== Settings Panel =====
function setupSettings() {
    const saveBtn = document.getElementById('saveSettingsBtn');
    const testBtn = document.getElementById('testEmailBtn');
    const statusMsg = document.getElementById('settingsStatus');

    saveBtn.addEventListener('click', async () => {
        const email = document.getElementById('setting-email').value.trim();
        const budget = parseFloat(document.getElementById('setting-budget').value) || 0;
        const notifs = document.getElementById('setting-notifications').checked;

        statusMsg.textContent = 'Saving...';
        statusMsg.style.color = '#64748b';

        try {
            const res = await authFetch(`${AUTH_BASE}/update-profile`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: currentUser.id,
                    notificationEmail: email,
                    budgetLimit: budget,
                    notificationsEnabled: notifs
                })
            });
            const data = await res.json();
            if (data.success) {
                syncUserState(data.user);
                statusMsg.textContent = '✓ Settings saved successfully!';
                statusMsg.style.color = '#10b981';
                showToast('Settings saved!', 'success');
            } else {
                throw new Error(data.message);
            }
        } catch (err) {
            statusMsg.textContent = `Error: ${err.message}`;
            statusMsg.style.color = '#ef4444';
            showToast('Failed to save settings', 'error');
        }
    });

    testBtn.addEventListener('click', async () => {
        testBtn.textContent = 'Sending...';
        testBtn.disabled = true;

        try {
            const res = await authFetch(`${NOTIF_BASE}/test-email`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: currentUser.id })
            });
            const data = await res.json();
            if (data.success) {
                showToast(`Test email sent to ${data.message.replace('Test email sent to ', '')}`, 'success');
            } else {
                showToast(data.message || 'Failed to send test email', 'warning');
            }
        } catch (err) {
            showToast('Failed to send test email. Check SMTP settings.', 'error');
        } finally {
            testBtn.textContent = 'Send Test Email';
            testBtn.disabled = false;
        }
    });
}

function loadSettingsValues() {
    document.getElementById('setting-email').value = currentUser.notificationEmail || currentUser.email || '';
    document.getElementById('setting-budget').value = currentUser.budgetLimit || '';
    document.getElementById('setting-notifications').checked = currentUser.notificationsEnabled || false;
}

// ===== Change Password =====
(function setupChangePassword() {
    const btn = document.getElementById('changePasswordBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const curr = document.getElementById('setting-current-pw').value;
        const newPw = document.getElementById('setting-new-pw').value;
        const confirm = document.getElementById('setting-confirm-pw').value;
        const statusEl = document.getElementById('passwordStatus');
        if (!curr || !newPw || !confirm) {
            statusEl.textContent = 'All fields are required.';
            statusEl.style.color = '#ef4444';
            return;
        }
        if (newPw !== confirm) {
            statusEl.textContent = 'New passwords do not match.';
            statusEl.style.color = '#ef4444';
            return;
        }
        btn.textContent = 'Updating...';
        btn.disabled = true;
        try {
            const res = await authFetch(`${AUTH_BASE}/change-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: currentUser.id, currentPassword: curr, newPassword: newPw })
            });
            const data = await res.json();
            if (data.success) {
                statusEl.textContent = 'Password updated successfully.';
                statusEl.style.color = '#10b981';
                showToast('Password changed!', 'success');
                document.getElementById('setting-current-pw').value = '';
                document.getElementById('setting-new-pw').value = '';
                document.getElementById('setting-confirm-pw').value = '';
            } else {
                statusEl.textContent = data.message || 'Failed to change password.';
                statusEl.style.color = '#ef4444';
            }
        } catch (err) {
            statusEl.textContent = 'Network error.';
            statusEl.style.color = '#ef4444';
        } finally {
            btn.textContent = 'Update Password';
            btn.disabled = false;
        }
    });
})();

// ===== Theme Option Buttons =====
(function setupThemeOptions() {
    document.querySelectorAll('.theme-opt').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.themeVal;
            document.documentElement.setAttribute('data-theme', val);
            localStorage.setItem('energyai_theme', val);
        });
    });
})();

// ===== Utility: Format kWh =====
function formatKWh(value) {
    if (typeof value !== 'number' || isNaN(value)) return '--';
    return value.toFixed(2);
}

// ===== Aggregate records by day (sum units, flag anomalies) =====
function aggregateByDay(records) {
    const dayMap = {};
    records.forEach(r => {
        const key = new Date(r.date).toISOString().split('T')[0];
        if (!dayMap[key]) dayMap[key] = { date: key, units: 0, isAnomaly: false, count: 0 };
        dayMap[key].units += r.units;
        dayMap[key].count++;
        if (r.isAnomaly) dayMap[key].isAnomaly = true;
    });
    return Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));
}

// ===== Daily Usage Line Chart =====
let dailyUsageChartIns;
async function loadDailyUsageChart() {
    try {
        const res = await authFetch(`${API_BASE}/enhanced-historical`);
        const data = await res.json();
        if (!data.success || !data.data.length) return;
        // Aggregate hourly/multiple records into daily totals
        const dailyData = aggregateByDay(data.data).slice(-14);
        const ctx = document.getElementById('dailyUsageChart');
        if (!ctx) return;
        const labels = dailyData.map(r => {
            const d = new Date(r.date + 'T00:00:00');
            return d.toLocaleDateString('en-IN', {day:'numeric',month:'short'});
        });
        const units = dailyData.map(r => r.units);
        const anomalyPts = dailyData.map(r => r.isAnomaly ? r.units : null);
        if (dailyUsageChartIns) dailyUsageChartIns.destroy();
        dailyUsageChartIns = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Daily Usage (kWh)',
                    data: units,
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59,130,246,0.08)',
                    fill: true, tension: 0.35, pointRadius: 3, borderWidth: 2
                }, {
                    label: 'Anomaly',
                    data: anomalyPts,
                    borderColor: '#ef4444',
                    backgroundColor: '#ef4444',
                    pointRadius: 8, pointHoverRadius: 10,
                    pointStyle: 'circle', showLine: false
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    title: { display: true, text: 'Daily Electricity Usage (Last 14 Days)', font: { family: "'Inter'", size: 13, weight: '600' }, color: '#0f172a' },
                    legend: { labels: { usePointStyle: true, padding: 12, font: { family: "'Inter'" } } },
                    tooltip: { backgroundColor: '#0f172a', callbacks: { label: ctx => `${ctx.dataset.label}: ${formatKWh(ctx.raw)} kWh` } }
                },
                scales: {
                    y: { title: { display: true, text: 'Consumption (kWh)' }, beginAtZero: false, grid: { color: 'rgba(226,232,240,0.5)' } },
                    x: { grid: { display: false } }
                }
            }
        });
    } catch (e) { console.error('Daily usage chart error', e); }
}

// ===== Weekly Comparison Bar Chart (Current vs Previous Week) =====
let weeklyCompChartIns;
async function loadWeeklyCompChart() {
    try {
        const res = await authFetch(`${API_BASE}/enhanced-historical`);
        const data = await res.json();
        if (!data.success || !data.data.length) return;
        const dailyData = aggregateByDay(data.data);
        const thisWeek = dailyData.slice(-7);
        const prevWeek = dailyData.slice(-14, -7);
        const dayLabels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
        const labels = thisWeek.map((r, i) => {
            const d = new Date(r.date + 'T00:00:00');
            return dayLabels[((d.getDay() + 6) % 7)];
        });
        const thisData = thisWeek.map(r => r.units);
        const prevData = prevWeek.map(r => r.units);
        const ctx = document.getElementById('weeklyCompChart');
        if (!ctx) return;
        if (weeklyCompChartIns) weeklyCompChartIns.destroy();
        weeklyCompChartIns = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    { label: 'This Week', data: thisData, backgroundColor: 'rgba(59,130,246,0.6)', borderColor: '#3b82f6', borderWidth: 1, borderRadius: 6 },
                    { label: 'Last Week', data: prevData, backgroundColor: 'rgba(148,163,184,0.35)', borderColor: '#94a3b8', borderWidth: 1, borderRadius: 6 }
                ]
            },
            options: {
                responsive: true,
                plugins: {
                    title: { display: true, text: 'This Week vs Last Week', font: { family: "'Inter'", size: 13, weight: '600' } },
                    legend: { labels: { usePointStyle: true, padding: 12 } },
                    tooltip: { backgroundColor: '#0f172a', callbacks: {
                        afterBody: (items) => {
                            if (items.length >= 2 && items[1].raw > 0) {
                                const pct = ((items[0].raw - items[1].raw) / items[1].raw * 100).toFixed(1);
                                return `Change: ${pct > 0 ? '+' : ''}${pct}%`;
                            }
                        }
                    }}
                },
                scales: {
                    y: { title: { display: true, text: 'kWh' }, beginAtZero: false, grid: { color: 'rgba(226,232,240,0.5)' } },
                    x: { grid: { display: false } }
                }
            }
        });
    } catch (e) { console.error('Weekly comp chart error', e); }
}

// ===== Weekly Predictions (7-day forecast) =====
let weeklyPredChartIns;
async function loadWeeklyPredictions() {
    const btn = document.getElementById('genWeekPredBtn');
    const list = document.getElementById('prediction-list');
    if (btn) { btn.textContent = 'Generating...'; btn.disabled = true; }
    try {
        const res = await authFetch(`${API_BASE}/predict-week`);
        const data = await res.json();
        if (data.success && data.predictions && data.predictions.length > 0) {
            // Render list
            if (list) {
                list.innerHTML = '';
                data.predictions.forEach(p => {
                    const div = document.createElement('div');
                    div.className = 'pred-item';
                    div.innerHTML = `<span class="pred-day">${p.dayName}</span><span class="pred-value">${formatKWh(p.predicted_units)} kWh</span>`;
                    list.appendChild(div);
                });
                const totalDiv = document.createElement('div');
                totalDiv.className = 'pred-item';
                totalDiv.style.borderColor = '#8b5cf6';
                totalDiv.innerHTML = `<span class="pred-day" style="color:#8b5cf6">Week Total</span><span class="pred-value" style="color:#8b5cf6">${formatKWh(data.weeklyTotal)} kWh</span>`;
                list.appendChild(totalDiv);
            }
            // Render bar chart
            const ctx = document.getElementById('weeklyPredChart');
            if (ctx) {
                if (weeklyPredChartIns) weeklyPredChartIns.destroy();
                weeklyPredChartIns = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: data.predictions.map(p => p.dayName.substring(0, 3)),
                        datasets: [{ label: 'Predicted (kWh)', data: data.predictions.map(p => p.predicted_units), backgroundColor: 'rgba(139,92,246,0.4)', borderColor: '#8b5cf6', borderWidth: 1, borderRadius: 6 }]
                    },
                    options: {
                        responsive: true,
                        plugins: {
                            title: { display: true, text: '7-Day Forecast', font: { family: "'Inter'", size: 13, weight: '600' }, color: '#0f172a' },
                            legend: { display: false },
                            tooltip: { backgroundColor: '#0f172a', callbacks: { label: ctx => `${formatKWh(ctx.raw)} kWh` } }
                        },
                        scales: {
                            y: { title: { display: true, text: 'Predicted (kWh)' }, beginAtZero: false, grid: { color: 'rgba(226,232,240,0.5)' } },
                            x: { grid: { display: false } }
                        }
                    }
                });
            }
            showToast(`7-day forecast generated! Weekly total: ${formatKWh(data.weeklyTotal)} kWh`, 'success');
        } else {
            showToast('Could not generate weekly predictions. Train models first.', 'warning');
        }
    } catch (e) {
        console.error(e);
        showToast('Failed to generate weekly predictions.', 'error');
    } finally {
        if (btn) { btn.textContent = 'Generate Forecast'; btn.disabled = false; }
    }
}

// ===== Monthly Projection + Budget Tracking =====
let monthlyPredChartIns;
async function loadMonthlyProjection() {
    try {
        const res = await authFetch(`${API_BASE}/monthly-projection`);
        const data = await res.json();
        if (!data.success) return;

        const projected = data.projected || 0;
        const daysRemaining = data.daysRemaining || 0;
        const actualSoFar = data.actualSoFar || 0;
        const dailyAvg = data.dailyAvg || 0;
        const budgetLimit = currentUser.budgetLimit || 0;

        // Update stats
        const projEl = document.getElementById('projected-total');
        const budgetEl = document.getElementById('budget-limit-display');
        const daysEl = document.getElementById('days-remaining');
        if (projEl) projEl.textContent = formatKWh(projected);
        if (budgetEl) budgetEl.textContent = budgetLimit > 0 ? formatKWh(budgetLimit) : 'Not set';
        if (daysEl) daysEl.textContent = daysRemaining;

        // Budget gauge
        const gaugeFill = document.getElementById('budget-gauge-fill');
        const gaugeLabel = document.getElementById('gauge-limit-label');
        if (budgetLimit > 0) {
            const pct = Math.min((projected / budgetLimit) * 100, 100);
            if (gaugeFill) {
                gaugeFill.style.width = pct + '%';
                if (pct > 80) gaugeFill.classList.add('warning');
                else gaugeFill.classList.remove('warning');
            }
            if (gaugeLabel) gaugeLabel.textContent = formatKWh(budgetLimit) + ' kWh';

            // Budget warning
            if (projected > budgetLimit) {
                const banner = document.getElementById('budget-banner');
                const bannerText = document.getElementById('budget-banner-text');
                const badge = document.getElementById('budget-status-badge');
                const panel = document.getElementById('monthly-panel');
                if (banner) banner.style.display = 'flex';
                if (bannerText) bannerText.textContent = `\u26A0 You are likely to exceed your monthly limit by ${formatKWh(projected - budgetLimit)} kWh. Reduce usage to stay on track.`;
                if (badge) badge.style.display = 'inline-block';
                if (panel) panel.classList.add('over-budget');
            }
        } else {
            if (gaugeFill) gaugeFill.style.width = '0%';
            if (gaugeLabel) gaugeLabel.textContent = 'No limit set';
        }

        // Monthly area chart
        const ctx = document.getElementById('monthlyPredChart');
        if (ctx) {
            const daysInMonth = data.daysInMonth || 30;
            const daysElapsed = data.daysElapsed || 0;
            const dailyActual = daysElapsed > 0 ? actualSoFar / daysElapsed : 0;
            const labels = [];
            const actualLine = [];
            const projLine = [];
            for (let i = 1; i <= daysInMonth; i++) {
                labels.push('Day ' + i);
                if (i <= daysElapsed) {
                    actualLine.push(dailyActual);
                    projLine.push(null);
                } else {
                    actualLine.push(null);
                    projLine.push(dailyAvg);
                }
            }
            if (monthlyPredChartIns) monthlyPredChartIns.destroy();
            const datasets = [
                { label: 'Actual (kWh)', data: actualLine, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.2, pointRadius: 0, borderWidth: 2, spanGaps: false },
                { label: 'Projected (kWh)', data: projLine, borderColor: '#8b5cf6', backgroundColor: 'rgba(139,92,246,0.08)', fill: true, tension: 0.2, pointRadius: 0, borderWidth: 2, borderDash: [5,3], spanGaps: false }
            ];
            const annotations = {};
            if (budgetLimit > 0) {
                const budgetPerDay = budgetLimit / daysInMonth;
                annotations.budgetLine = { type: 'line', yMin: budgetPerDay, yMax: budgetPerDay, borderColor: '#ef4444', borderWidth: 2, borderDash: [6,3], label: { display: true, content: 'Budget Limit', position: 'end', backgroundColor: '#ef4444', font: { size: 10 } } };
            }
            monthlyPredChartIns = new Chart(ctx, {
                type: 'line',
                data: { labels, datasets },
                options: {
                    responsive: true,
                    plugins: {
                        title: { display: true, text: 'Monthly Usage Projection', font: { family: "'Inter'", size: 13, weight: '600' }, color: '#0f172a' },
                        legend: { labels: { usePointStyle: true, padding: 12 } },
                        tooltip: { backgroundColor: '#0f172a', callbacks: { label: ctx => ctx.raw !== null ? `${formatKWh(ctx.raw)} kWh/day` : '' } },
                        annotation: { annotations }
                    },
                    scales: {
                        y: { title: { display: true, text: 'kWh / day' }, beginAtZero: true, grid: { color: 'rgba(226,232,240,0.5)' } },
                        x: { ticks: { maxTicksLimit: 10 }, grid: { display: false } }
                    }
                }
            });
        }
    } catch (e) { console.error('Monthly projection error', e); }
}

// ===== Notification History (Alert Feed) =====
async function loadNotificationHistory() {
    const feed = document.getElementById('alert-feed');
    if (!feed) return;
    try {
        const url = currentUser.id ? `${NOTIF_BASE}/history?userId=${currentUser.id}` : `${NOTIF_BASE}/history`;
        const res = await authFetch(url);
        const data = await res.json();
        if (data.success && data.data && data.data.length > 0) {
            feed.innerHTML = '';
            const badge = document.getElementById('notification-badge');
            const countEl = document.getElementById('notif-count');
            const unread = data.unreadCount || 0;
            if (badge) badge.style.display = 'flex';
            if (countEl) countEl.textContent = unread || data.data.length;
            data.data.slice(0, 10).forEach(n => {
                const div = document.createElement('div');
                div.className = `alert-feed-item alert-type-${n.type || 'info'}${n.read ? '' : ' unread'}`;
                const time = new Date(n.sentAt).toLocaleDateString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
                div.innerHTML = `<span>${n.message || 'Notification'}</span><span class="alert-time">${time}</span>`;
                feed.appendChild(div);
            });
        }
    } catch (e) { /* notifications may not be available */ }
}

// ===== Anomaly Log =====
async function loadAnomalyLog() {
    const log = document.getElementById('anomaly-log');
    if (!log) return;
    try {
        const res = await authFetch(`${API_BASE}/anomaly-detection`);
        const data = await res.json();
        if (data.success && data.anomalies && data.anomalies.length > 0) {
            log.innerHTML = '';
            data.anomalies.slice(0, 5).forEach(a => {
                const div = document.createElement('div');
                div.className = 'anomaly-log-item';
                div.innerHTML = `<span class="anomaly-log-date">${a.date}</span><span class="anomaly-log-value">${formatKWh(a.units)} kWh</span><span class="anomaly-log-expected">expected: ${formatKWh(a.expected_units)} kWh</span>`;
                log.appendChild(div);
            });
        }
    } catch (e) { /* anomaly service may be offline */ }
}

// ===== CSV Export =====
function exportReportsCsv() {
    const table = document.getElementById('reports-table');
    if (!table) return;
    let csv = '';
    const rows = table.querySelectorAll('tr');
    rows.forEach(row => {
        const cells = row.querySelectorAll('th, td');
        const rowData = Array.from(cells).map(c => '"' + c.textContent.trim().replace(/"/g, '""') + '"');
        csv += rowData.join(',') + '\n';
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'energy_report.csv';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Report exported as CSV', 'success');
}

// ===== PDF Export =====
function exportReportsPdf() {
    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        doc.setFontSize(18);
        doc.setTextColor(15, 23, 42);
        doc.text('Energy Usage Report', 14, 20);
        doc.setFontSize(10);
        doc.setTextColor(100);
        doc.text(`Generated: ${new Date().toLocaleDateString('en-IN', { year:'numeric', month:'long', day:'numeric' })}`, 14, 28);
        doc.text(`User: ${currentUser.username || 'N/A'}`, 14, 34);

        const table = document.getElementById('reports-table');
        if (table) {
            doc.autoTable({ html: '#reports-table', startY: 42, theme: 'grid',
                headStyles: { fillColor: [59, 130, 246], textColor: 255, fontStyle: 'bold' },
                alternateRowStyles: { fillColor: [248, 250, 252] },
                styles: { fontSize: 9, cellPadding: 3 }
            });
        }
        doc.save('energy_report.pdf');
        showToast('Report exported as PDF', 'success');
    } catch (e) {
        console.error('PDF export error:', e);
        showToast('PDF export failed. Try CSV instead.', 'error');
    }
}

// ===== Dark Mode =====
function initTheme() {
    const saved = localStorage.getItem('energyai_theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('energyai_theme', next);
    if (typeof Chart !== 'undefined') {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        Chart.defaults.color = isDark ? '#cbd5e1' : '#334155';
        Chart.defaults.borderColor = isDark ? 'rgba(148,163,184,0.1)' : 'rgba(0,0,0,0.05)';
    }
}

// ===== Appliance Breakdown Doughnut Chart =====
// ===== Appliance Breakdown Doughnut Chart (Dynamic Model) =====
let applianceChartIns;
function renderApplianceBreakdown() {
    const ctx = document.getElementById('applianceChart');
    if (!ctx) return;
    
    // Get actual current usage from the dashboard card
    const el = document.getElementById('card-current');
    const totalUsage = el ? parseFloat(el.textContent) || 0 : 0;

    // Dynamic appliance model: ratios shift slightly based on total consumption
    // High usage usually implies higher HVAC/AC usage
    let acRatio = 0.35;
    if (totalUsage > 25) acRatio = 0.45;
    if (totalUsage > 40) acRatio = 0.55;

    const appliances = [
        { name: 'HVAC (AC/Heating)', pct: acRatio, color: '#ef4444' },
        { name: 'Kitchen & Cooking', pct: 0.15, color: '#f59e0b' },
        { name: 'Water Heating', pct: 0.12, color: '#06b6d4' },
        { name: 'Refrigeration', pct: 0.10, color: '#3b82f6' },
        { name: 'Washing & Drying', pct: 0.08, color: '#10b981' },
        { name: 'Entertainment', pct: 0.08, color: '#8b5cf6' },
        { name: 'Lighting', pct: 0.07, color: '#eab308' },
        { name: 'Other / Idle', pct: Math.max(0.05, 1 - (acRatio + 0.15 + 0.12 + 0.10 + 0.08 + 0.08 + 0.07)), color: '#94a3b8' }
    ];

    if (applianceChartIns) applianceChartIns.destroy();
    
    applianceChartIns = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: appliances.map(a => a.name),
            datasets: [{ 
                data: appliances.map(a => +(totalUsage * a.pct).toFixed(2)),
                backgroundColor: appliances.map(a => a.color), 
                borderWidth: 2, 
                borderColor: 'var(--color-surface, #fff)' 
            }]
        },
        options: {
            responsive: true, 
            cutout: '70%',
            plugins: {
                legend: { display: false },
                tooltip: { 
                    backgroundColor: '#0f172a', 
                    padding: 12,
                    callbacks: { 
                        label: c => `${c.label}: ${c.raw} kWh (${(appliances[c.dataIndex].pct * 100).toFixed(0)}%)` 
                    } 
                }
            }
        }
    });

    // Custom legend
    const legendEl = document.getElementById('applianceLegend');
    if (legendEl) {
        legendEl.innerHTML = appliances.map(a =>
            `<div class="appliance-item"><span class="appliance-dot" style="background:${a.color}"></span><span>${a.name}</span><span class="appliance-pct">${(a.pct * 100).toFixed(0)}%</span></div>`
        ).join('');
    }
}

// ===== Activity Log =====
async function loadActivityLog() {
    const tbody = document.getElementById('activity-tbody');
    if (!tbody) return;
    try {
        const url = currentUser.id ? `${API_BASE}/activity-log?userId=${currentUser.id}` : `${API_BASE}/activity-log`;
        const res = await authFetch(url);
        const data = await res.json();
        if (data.success && data.data && data.data.length > 0) {
            tbody.innerHTML = '';
            data.data.forEach(log => {
                const tr = document.createElement('tr');
                const time = new Date(log.timestamp).toLocaleDateString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
                const actionLabels = { login: '🔑 Login', register: '📝 Register', settings_update: '⚙️ Settings', data_upload: '📤 Upload', model_train: '🤖 Training' };
                tr.innerHTML = `<td>${actionLabels[log.action] || log.action}</td><td>${log.details || '—'}</td><td>${time}</td>`;
                tbody.appendChild(tr);
            });
        } else {
            tbody.innerHTML = '<tr><td colspan="3" class="empty-state">No activity yet.</td></tr>';
        }
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="3" class="empty-state">Could not load activity log.</td></tr>';
    }
}

// (Activity log and bill history loading is handled in the main setupNavigation)

// ===== Bill Upload Feature =====

// Bind refresh bill history button
const refreshHistoryBtn = document.getElementById('refreshBillHistoryBtn');
if (refreshHistoryBtn) {
    refreshHistoryBtn.addEventListener('click', loadBillHistory);
}

// ===== Bill History =====
async function loadBillHistory() {
    const tbody = document.getElementById('bill-history-tbody');
    if (!tbody) return;

    try {
        const res = await authFetch(`${API_BASE}/bill-history`);
        const data = await res.json();

        if (data.success && data.records && data.records.length > 0) {
            tbody.innerHTML = '';
            data.records.forEach(r => {
                const tr = document.createElement('tr');
                const date = r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
                const confClass = r.extractionConfidence === 'high' ? 'status-normal' :
                                  r.extractionConfidence === 'medium' ? 'status-high' : 'status-anomaly';
                const confLabel = (r.extractionConfidence || 'unknown').charAt(0).toUpperCase() + (r.extractionConfidence || 'unknown').slice(1);

                tr.innerHTML = `
                    <td>${date}</td>
                    <td>${r.electricityBoard || '—'}</td>
                    <td>${r.consumerNumber || '—'}</td>
                    <td>${r.totalUnits ? r.totalUnits + ' kWh' : '—'}</td>
                    <td>${r.billAmount ? '₹' + r.billAmount.toFixed(2) : '—'}</td>
                    <td><span class="${confClass}">${confLabel}</span></td>
                `;
                tbody.appendChild(tr);
            });

            // Render bill comparison chart
            renderBillCompChart(data.records);
        }
    } catch (err) {
        console.error('Failed to load bill history:', err);
    }
}

// ===== Bill Comparison Chart =====
let billCompChartIns;
function renderBillCompChart(records) {
    const ctx = document.getElementById('billCompChart');
    if (!ctx) return;

    const validRecords = records.filter(r => r.totalUnits && r.billAmount).reverse();
    if (validRecords.length === 0) return;

    const labels = validRecords.map(r => r.billingMonth || new Date(r.createdAt).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }));
    const unitsData = validRecords.map(r => r.totalUnits);
    const amountData = validRecords.map(r => r.billAmount);

    if (billCompChartIns) billCompChartIns.destroy();

    billCompChartIns = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Units (kWh)',
                    data: unitsData,
                    backgroundColor: 'rgba(59, 130, 246, 0.5)',
                    borderColor: '#3b82f6',
                    borderWidth: 1,
                    borderRadius: 6,
                    yAxisID: 'y'
                },
                {
                    label: 'Amount (₹)',
                    data: amountData,
                    type: 'line',
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16, 185, 129, 0.08)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 4,
                    borderWidth: 2,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                title: { display: true, text: 'Monthly Bill Comparison', font: { family: "'Inter'", size: 13, weight: '600' }, color: '#0f172a' },
                legend: { labels: { usePointStyle: true, padding: 12 } },
                tooltip: { backgroundColor: '#0f172a' }
            },
            scales: {
                y: {
                    type: 'linear', display: true, position: 'left',
                    title: { display: true, text: 'Units (kWh)' },
                    grid: { color: 'rgba(226,232,240,0.5)' }
                },
                y1: {
                    type: 'linear', display: true, position: 'right',
                    title: { display: true, text: 'Amount (₹)' },
                    grid: { drawOnChartArea: false }
                },
                x: { grid: { display: false } }
            }
        }
    });
}

// ===== Full Bill History Page (with search, sort, pagination) =====
let allBillRecords = [];
let billSortField = 'date';
let billSortDir = 'desc';
let billPage = 1;
const billPageSize = 15;

async function loadFullBillHistory() {
    const tbody = document.getElementById('bill-history-tbody-full');
    if (!tbody) return;

    try {
        const res = await authFetch(`${API_BASE}/bill-history`);
        const data = await res.json();
        if (data.success && data.records && data.records.length > 0) {
            allBillRecords = data.records;
            billPage = 1;
            renderFullBillTable();
            renderBillTrendChart(data.records);
        } else {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No bills uploaded yet.</td></tr>';
        }
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load bill history.</td></tr>';
    }
}

function renderFullBillTable() {
    const tbody = document.getElementById('bill-history-tbody-full');
    const searchVal = (document.getElementById('billSearchInput')?.value || '').toLowerCase();

    let filtered = allBillRecords.filter(r => {
        if (!searchVal) return true;
        return (r.electricityBoard || '').toLowerCase().includes(searchVal)
            || (r.consumerNumber || '').toLowerCase().includes(searchVal)
            || (r.billingMonth || '').toLowerCase().includes(searchVal);
    });

    // Sort
    filtered.sort((a, b) => {
        let va, vb;
        if (billSortField === 'date') { va = new Date(a.createdAt || 0); vb = new Date(b.createdAt || 0); }
        else if (billSortField === 'units') { va = a.totalUnits || 0; vb = b.totalUnits || 0; }
        else if (billSortField === 'amount') { va = a.billAmount || 0; vb = b.billAmount || 0; }
        else if (billSortField === 'board') { va = (a.electricityBoard || '').toLowerCase(); vb = (b.electricityBoard || '').toLowerCase(); }
        else { va = 0; vb = 0; }
        if (va < vb) return billSortDir === 'asc' ? -1 : 1;
        if (va > vb) return billSortDir === 'asc' ? 1 : -1;
        return 0;
    });

    // Pagination
    const totalPages = Math.max(1, Math.ceil(filtered.length / billPageSize));
    billPage = Math.min(billPage, totalPages);
    const startIdx = (billPage - 1) * billPageSize;
    const pageData = filtered.slice(startIdx, startIdx + billPageSize);

    tbody.innerHTML = '';
    if (pageData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No matching bills found.</td></tr>';
    } else {
        pageData.forEach(r => {
            const tr = document.createElement('tr');
            const date = r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
            const confClass = r.extractionConfidence === 'high' ? 'status-normal' : r.extractionConfidence === 'medium' ? 'status-high' : 'status-anomaly';
            const confLabel = (r.extractionConfidence || 'unknown').charAt(0).toUpperCase() + (r.extractionConfidence || 'unknown').slice(1);
            tr.innerHTML = `
                <td>${date}</td>
                <td>${r.electricityBoard || '—'}</td>
                <td>${r.consumerNumber || '—'}</td>
                <td>${r.billingMonth || '—'}</td>
                <td>${r.totalUnits ? r.totalUnits + ' kWh' : '—'}</td>
                <td>${r.billAmount ? '₹' + r.billAmount.toFixed(2) : '—'}</td>
                <td><span class="${confClass}">${confLabel}</span></td>
            `;
            tbody.appendChild(tr);
        });
    }

    // Pagination controls
    const paginationEl = document.getElementById('billPagination');
    const pageInfoEl = document.getElementById('billPageInfo');
    if (filtered.length > billPageSize) {
        if (paginationEl) paginationEl.style.display = 'flex';
        if (pageInfoEl) pageInfoEl.textContent = `Page ${billPage} of ${totalPages}`;
    } else {
        if (paginationEl) paginationEl.style.display = 'none';
    }
}

// Bill trend chart for dedicated page
let billTrendChartIns;
function renderBillTrendChart(records) {
    const ctx = document.getElementById('billTrendChart');
    if (!ctx) return;
    const valid = records.filter(r => r.totalUnits).reverse();
    if (valid.length === 0) return;
    const labels = valid.map(r => r.billingMonth || new Date(r.createdAt).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }));
    const units = valid.map(r => r.totalUnits);
    if (billTrendChartIns) billTrendChartIns.destroy();
    billTrendChartIns = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{ label: 'Units (kWh)', data: units, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.08)', fill: true, tension: 0.3, pointRadius: 4, borderWidth: 2 }]
        },
        options: {
            responsive: true,
            plugins: {
                title: { display: true, text: 'Bill-to-Bill Consumption Trend', font: { family: "'Inter'", size: 13, weight: '600' } },
                legend: { display: false },
                tooltip: { backgroundColor: '#0f172a' }
            },
            scales: {
                y: { title: { display: true, text: 'kWh' }, beginAtZero: false, grid: { color: 'rgba(226,232,240,0.5)' } },
                x: { grid: { display: false } }
            }
        }
    });
}

// Bill history event listeners
(function setupBillHistoryPage() {
    const searchInput = document.getElementById('billSearchInput');
    if (searchInput) {
        searchInput.addEventListener('input', () => { billPage = 1; renderFullBillTable(); });
    }
    const refreshBtn = document.getElementById('refreshBillHistoryBtn2');
    if (refreshBtn) refreshBtn.addEventListener('click', loadFullBillHistory);

    const prevBtn = document.getElementById('billPrevPage');
    const nextBtn = document.getElementById('billNextPage');
    if (prevBtn) prevBtn.addEventListener('click', () => { billPage = Math.max(1, billPage - 1); renderFullBillTable(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { billPage++; renderFullBillTable(); });

    // Sortable headers
    document.querySelectorAll('#bill-history-table-full .sortable-th').forEach(th => {
        th.addEventListener('click', () => {
            const field = th.dataset.sort;
            if (billSortField === field) {
                billSortDir = billSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                billSortField = field;
                billSortDir = 'desc';
            }
            billPage = 1;
            renderFullBillTable();
        });
    });
})();

