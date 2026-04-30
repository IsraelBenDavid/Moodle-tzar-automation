// ============================================
// Moodle Extension Tzar - Popup Script
// ============================================

import { MOODLE_HOST, DEFAULT_MODEL_CHOICE } from '../utils/constants.js';

document.addEventListener('DOMContentLoaded', init);

let isProcessingApproval = false;
let approvalQueue = [];

// State
let extensionRequests = [];
let currentTabId = null;
let currentForumUrl = null;

// DOM references
const elements = {};

function init() {
  cacheElements();
  bindEvents();
  loadSavedState();
}

function cacheElements() {
  elements.apiKeyInput = document.getElementById('api-key-input');
  elements.saveApiKeyBtn = document.getElementById('save-api-key');
  elements.toggleKeyBtn = document.getElementById('toggle-key-visibility');
  elements.apiKeyStatus = document.getElementById('api-key-status');
  elements.settingsToggle = document.getElementById('settings-toggle');
  elements.settingsBody = document.getElementById('settings-body');
  elements.settingsIcon = document.getElementById('settings-icon');
  elements.scanForumBtn = document.getElementById('scan-forum-btn');
  elements.scanBtnText = document.getElementById('scan-btn-text');
  elements.scanSpinner = document.getElementById('scan-spinner');
  elements.scanStatus = document.getElementById('scan-status');
  elements.resultsSection = document.getElementById('results-section');
  elements.modelAnthropic = document.getElementById('model-anthropic');
  elements.modelOpenAI = document.getElementById('model-openai');
  elements.modelGemini = document.getElementById('model-gemini');
  elements.modelOptions = document.querySelector('.model-options');
  elements.requestsList = document.getElementById('requests-list');
  elements.requestCount = document.getElementById('request-count');
  elements.errorBanner = document.getElementById('error-banner');
}

function bindEvents() {
  elements.saveApiKeyBtn.addEventListener('click', saveApiKey);
  elements.toggleKeyBtn.addEventListener('click', toggleKeyVisibility);
  elements.settingsToggle.addEventListener('click', toggleSettings);
  elements.scanForumBtn.addEventListener('click', scanForum);
  elements.modelOptions.addEventListener('change', handleModelChange);
}

// ---- Settings & State Management ----

function toggleSettings() {
  elements.settingsBody.classList.toggle('collapsed');
  elements.settingsIcon.classList.toggle('collapsed');
}

function toggleKeyVisibility() {
  const input = elements.apiKeyInput;
  input.type = input.type === 'password' ? 'text' : 'password';
}

async function loadSavedState() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      currentTabId = tab.id;
      currentForumUrl = tab.url;
    }

    const { 
      selectedModel = DEFAULT_MODEL_CHOICE, 
      apiKey_anthropic, 
      apiKey_openai, 
      apiKey_gemini,
      savedRequests,
      savedForumUrl 
    } = await chrome.storage.local.get([
      'selectedModel', 
      'apiKey_anthropic', 
      'apiKey_openai', 
      'apiKey_gemini',
      'savedRequests',
      'savedForumUrl'
    ]);

    // Restore Model Selection
    if (elements.modelAnthropic) elements.modelAnthropic.checked = (selectedModel === 'anthropic');
    if (elements.modelOpenAI) elements.modelOpenAI.checked = (selectedModel === 'openai');
    if (elements.modelGemini) elements.modelGemini.checked = (selectedModel === 'gemini');

    updateApiKeyInputForModel(selectedModel, { apiKey_anthropic, apiKey_openai, apiKey_gemini });

    if (elements.apiKeyInput.value.trim()) {
      elements.settingsBody.classList.add('collapsed');
      elements.settingsIcon.classList.add('collapsed');
    }

    // Restore Results if we are on the same page
    if (savedRequests && savedForumUrl && currentForumUrl === savedForumUrl) {
      extensionRequests = savedRequests;
      renderRequests();
      showStatus(elements.scanStatus, 'Loaded previous scan results.', 'info');
    } else if (savedRequests) {
        // Clear old results if on a new page
        await chrome.storage.local.remove(['savedRequests', 'savedForumUrl']);
    }

  } catch (err) {
    console.error("Error loading state:", err);
  }
}


function getSelectedModel() {
  if (elements.modelAnthropic && elements.modelAnthropic.checked) return 'anthropic';
  if (elements.modelOpenAI && elements.modelOpenAI.checked) return 'openai';
  if (elements.modelGemini && elements.modelGemini.checked) return 'gemini';
  return DEFAULT_MODEL_CHOICE;
}

async function saveApiKey() {
  const key = elements.apiKeyInput.value.trim();
  const selectedModel = getSelectedModel();

  if (!key) {
    showStatus(elements.apiKeyStatus, 'Please enter a valid API key.', 'error');
    return;
  }

  const storageKey = `apiKey_${selectedModel}`;
  await chrome.storage.local.set({ [storageKey]: key, selectedModel: selectedModel });

  showStatus(elements.apiKeyStatus, 'API key saved successfully.', 'success');
}

// ---- Forum Scanning ----

async function scanForum() {
  hideError();

  const selectedModel = getSelectedModel();
  const storageKey = `apiKey_${selectedModel}`;
  const { [storageKey]: apiKey } = await chrome.storage.local.get(storageKey);
  if (!apiKey || apiKey.length === 0) {
    showError('Please save your API key in Settings before scanning.');
    return;
  }

  if (!currentTabId) {
    showError('No active tab found.');
    return;
  }

  if (!currentForumUrl || !currentForumUrl.includes('moodle.huji.ac.il')) {
    showError('Please navigate to a Moodle forum page on moodle.huji.ac.il before scanning.');
    return;
  }

  setScanLoading(true);
  showStatus(elements.scanStatus, 'Extracting forum posts...', 'info');

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      func: extractForumPosts
    });

    const allPosts = results[0]?.result?.posts || [];
    const forumTitle = results[0]?.result?.forumTitle || null;

    if (allPosts.length === 0) {
      showStatus(elements.scanStatus, 'No forum posts found on this page.', 'error');
      setScanLoading(false);
      return;
    }

    // Posts where the last replier differs from the original author are already answered.
    // Skip them — no need to send to AI.
    const answeredCount = allPosts.filter(p => p.isAnswered).length;
    const posts = allPosts.filter(p => !p.isAnswered);

    if (posts.length === 0) {
      showStatus(elements.scanStatus, `All ${answeredCount} post(s) already have replies. Nothing to analyze.`, 'info');
      setScanLoading(false);
      return;
    }

    showStatus(elements.scanStatus, `Found ${posts.length} unanswered post(s). Analyzing with AI...`, 'info');

    const response = await chrome.runtime.sendMessage({
      type: 'ANALYZE_POSTS',
      posts: posts,
      apiKey: apiKey,
      modelChoice: selectedModel
    });

    if (response.error) {
      showError(response.error);
      showStatus(elements.scanStatus, 'Analysis failed.', 'error');
      setScanLoading(false);
      return;
    }

    extensionRequests = response.requests || [];

    // Map discussion URLs, post IDs, and isAnswered back from the extracted posts.
    extensionRequests.forEach(req => {
        const normalizedReqName = (req.studentName || '').toLowerCase().trim();
        const matchedPost = posts.find(p => p.author && p.author.toLowerCase().includes(normalizedReqName));

        if (matchedPost) {
            req.postId = matchedPost.postId;
            req.discussUrl = matchedPost.discussUrl;
            req.isAnswered = matchedPost.isAnswered || false;
        }

        if (!req.assignmentName && forumTitle) {
            req.assignmentName = extractNumberOrNameFromTitle(forumTitle);
        }
    });

    await chrome.storage.local.set({
        savedRequests: extensionRequests,
        savedForumUrl: currentForumUrl
    });

    renderRequests();
    const openCount = extensionRequests.filter(r => r.wantsExtension && !r.isAnswered).length;
    const answeredNote = answeredCount > 0 ? ` (${answeredCount} already answered, skipped)` : '';
    showStatus(elements.scanStatus,
      `Analysis complete. Found ${openCount} open extension request(s)${answeredNote}.`,
      'success'
    );
  } catch (err) {
    showError(`Scan failed: ${err.message}`);
    showStatus(elements.scanStatus, '', '');
  } finally {
    setScanLoading(false);
  }
}

// Helper to extract a generic assignment identifier from the forum title
function extractNumberOrNameFromTitle(title) {
    if(!title) return null;
    // Look for numbers like "2" in "פורום פומבי תרגיל 2"
    const match = title.match(/\d+/);
    return match ? match[0] : title;
}


async function handleModelChange(event) {
  const selectedModel = event.target.value;
  const { apiKey_anthropic, apiKey_openai, apiKey_gemini } = await chrome.storage.local.get(['apiKey_anthropic', 'apiKey_openai', 'apiKey_gemini']);
  updateApiKeyInputForModel(selectedModel, { apiKey_anthropic, apiKey_openai, apiKey_gemini });
  showStatus(elements.apiKeyStatus, '', '');
}

function updateApiKeyInputForModel(model, storedKeys) {
  let placeholderText = '';
  let currentKey = '';

  switch (model) {
    case 'anthropic':
      placeholderText = 'Enter Anthropic API Key (e.g., sk-ant-...)';
      currentKey = storedKeys.apiKey_anthropic || '';
      break;
    case 'openai':
      placeholderText = 'Enter OpenAI API Key (e.g., sk-...)';
      currentKey = storedKeys.apiKey_openai || '';
      break;
    case 'gemini':
      placeholderText = 'Enter Google Gemini API Key (e.g., AIza...)';
      currentKey = storedKeys.apiKey_gemini || '';
      break;
    default:
      placeholderText = 'Enter API Key';
  }
  elements.apiKeyInput.placeholder = placeholderText;
  elements.apiKeyInput.value = currentKey;
}

// Injected to extract posts AND the page title
async function extractForumPosts() {
  const posts = [];
  const seenKeys = new Set();
  
  let forumTitle = document.title;
  const h2Title = document.querySelector('h2');
  if(h2Title) forumTitle = h2Title.textContent;

  try {
    const AUTHOR_SELECTORS = [
      'a[data-userid]', '.author-info a', '.author-info .d-flex a',
      '.postprofile .author a', '.forumng-author a', '.forumng-name a',
      '.author a', '.posting-author a', 'a[href*="user/view.php"]',
      'h4 a', 'a.d-inline-block',
    ];

    const CONTENT_SELECTORS = [
      '[data-region="post-content"]', '.post-content-container .text_to_html',
      '.forumng-message', '.forumng-post-content', '.text_to_html',
      '.posting', '.post-content', '.message', '.post-body',
    ];

    function tryAddPost(container, authorSelectors, contentSelectors) {
      let authorEl = null;
      for (const sel of authorSelectors) {
        try { authorEl = container.querySelector(sel); } catch (e) { continue; }
        if (authorEl) break;
      }
      let contentEl = null;
      for (const sel of contentSelectors) {
        try { contentEl = container.querySelector(sel); } catch (e) { continue; }
        if (contentEl) break;
      }
      if (!authorEl || !contentEl) return false;
      
      const author = authorEl.textContent.trim();
      const content = contentEl.textContent.trim();
      if (!author || !content) return false;
      
      const postId = container.getAttribute('data-post-id') || container.id || null;
      const key = postId || (author + '|' + content).substring(0, 100);
      
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      
      posts.push({ author, content, postId, discussUrl: window.location.href });
      return true;
    }

    for (const sel of [
      'article.forum-post-container', 'article[data-post-id]',
      '[data-region="post"]', 'div.forumpost', '.forumng-post',
      'li.post', 'li.forumpost', 'li.discussion-post',
    ]) {
      document.querySelectorAll(sel).forEach(el => tryAddPost(el, AUTHOR_SELECTORS, CONTENT_SELECTORS));
    }
    
    if (posts.length === 0) {
      document.querySelectorAll('div[id^="p"], article[id^="p"]').forEach(el => {
        if (!/^p\d+$/.test(el.id)) return;
        tryAddPost(el, AUTHOR_SELECTORS, CONTENT_SELECTORS);
      });
    }

    // Forum listing page: each discrow_ row is a topic.
    // Compare the original poster vs the last replier directly from the row —
    // no page fetch needed to decide isAnswered.
    const discussionRows = document.querySelectorAll('tr[id^="discrow_"]');
    if (discussionRows.length > 0 && posts.length === 0) {
      const fetchPromises = Array.from(discussionRows).map(async row => {
        const topicLinkEl = row.querySelector('a[href*="discuss.php"]');
        const discussUrl = topicLinkEl ? topicLinkEl.href : null;
        if (!discussUrl) return null;

        const startedByLink = row.querySelector('.forumng-startedby a[href*="user/view.php"], .forumng-startedby a[data-userid], .author a[href*="user/view.php"], .starter a[href*="user/view.php"]');
        const lastPostLink = row.querySelector('.forumng-lastpost a[href*="user/view.php"], .forumng-lastpost a[data-userid], .lastpost a[href*="user/view.php"]');

        if (!startedByLink || !lastPostLink) return null;

        const getUserId = (link) => {
            try {
                if (link.hasAttribute('data-userid')) return link.getAttribute('data-userid');
                const url = new URL(link.href, window.location.origin);
                return url.searchParams.get('id');
            } catch (e) {
                return null;
            }
        };

        const startedById = getUserId(startedByLink);
        const lastPostId = getUserId(lastPostLink);

        const isAnswered = startedById !== lastPostId;

        let originalAuthor = startedByLink.textContent.trim();
        const initialsSpan = startedByLink.querySelector('.userinitials');
        if (initialsSpan) {
            originalAuthor = initialsSpan.getAttribute('title') || originalAuthor.replace(initialsSpan.textContent, '').trim();
        }

        try {
          const resp = await fetch(discussUrl);
          if (!resp.ok) return null;
          const html = await resp.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');

          let contentEl = null;
          for (const sel of CONTENT_SELECTORS) {
            contentEl = doc.querySelector(sel);
            if (contentEl) break;
          }
          if (!contentEl) return null;
          const content = contentEl.textContent.trim();
          if (!content) return null;

          return { author: originalAuthor, content, postId: row.id, discussUrl, isAnswered };
        } catch (e) {
          return null;
        }
      });

      const results = await Promise.all(fetchPromises);
      for (const r of results) {
        if (!r || seenKeys.has(r.postId)) continue;
        seenKeys.add(r.postId);
        posts.push(r);
      }
    }

    return {posts: posts, forumTitle: forumTitle};
  } catch (err) {
    return {posts: [], forumTitle: null};
  }
}

// ---- Render Requests ----

function renderRequests() {
  elements.requestsList.innerHTML = '';

  const unansweredRequests = extensionRequests.filter(r => r.wantsExtension && !r.isAnswered);
  elements.requestCount.textContent = unansweredRequests.length;

  if (unansweredRequests.length === 0) {
    elements.resultsSection.classList.add('hidden');
    return;
  }

  elements.resultsSection.classList.remove('hidden');

  extensionRequests.forEach((request, index) => {
    if (!request.wantsExtension || request.isAnswered) return;

    const initialDays = request.requestedDays || 3;
    const card = document.createElement('div');
    card.className = 'request-card';
    card.dataset.index = index;

    card.innerHTML = `
      <div class="student-name">${escapeHtml(request.studentName)}</div>
      ${request.assignmentName && request.assignmentName !== "null"
        ? `<div class="assignment-name">Assignment: ${escapeHtml(request.assignmentName)}</div>`
        : '<div class="assignment-name">Assignment: Not specified</div>'
      }
      ${request.reason && request.reason !== "null"
        ? `<div class="reason">Reason: ${escapeHtml(request.reason)}</div>`
        : '<div class="reason">No specific reason provided</div>'
      }
      
      <div class="action-controls">
        <select class="days-select" data-index="${index}">
          <option value="3" ${initialDays === 3 ? 'selected' : ''}>3 Days</option>
          <option value="4" ${initialDays === 4 ? 'selected' : ''}>4 Days</option>
          <option value="7" ${initialDays === 7 ? 'selected' : ''}>7 Days</option>
          <option value="custom" ${initialDays !== 3 && initialDays !== 7 ? 'selected' : ''}>Other...</option>
        </select>
        <input type="number" class="custom-days-input ${initialDays !== 3 && initialDays !== 7 ? '' : 'hidden'}" data-index="${index}" value="${initialDays}" min="1">
        
        <button class="btn btn-approve" data-action="approve" data-index="${index}">Approve</button>
        <button class="btn btn-reject" data-action="reject" data-index="${index}">Reject</button>
      </div>
      <div class="actions" data-index="${index}"></div>
    `;

    const daysSelect = card.querySelector('.days-select');
    const customInput = card.querySelector('.custom-days-input');
    
    daysSelect.addEventListener('change', (e) => {
      if (e.target.value === 'custom') {
        customInput.classList.remove('hidden');
        customInput.focus();
      } else {
        customInput.classList.add('hidden');
      }
    });

    card.querySelector('[data-action="approve"]').addEventListener('click', () => handleApprove(index));
    card.querySelector('[data-action="reject"]').addEventListener('click', () => handleReject(index));

    request.postId = request.postId || card.dataset.postId;
    elements.requestsList.appendChild(card);
  });
}

// ---- Wait For Background Tab Load ----
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1500); 
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ---- Actions ----

// --- Updated handleApprove with Rollback logic ---

async function handleApprove(index) {
    approvalQueue.push(index);
    
    const card = elements.requestsList.querySelector(`[data-index="${index}"]`);
    const actionsContainer = card.querySelector('.actions');
    const actionControls = card.querySelector('.action-controls');
    
    actionControls.classList.add('hidden');
    actionsContainer.innerHTML = '<span class="status-label processing">Queued...</span>';

    processQueue();
}

async function processQueue() {
    if (isProcessingApproval || approvalQueue.length === 0) {
        return;
    }
    
    isProcessingApproval = true;
    const currentIndex = approvalQueue.shift();
    
    try {
        await executeApproval(currentIndex);
    } finally {
        isProcessingApproval = false;
        processQueue(); 
    }
}

async function executeApproval(index) {
  const request = extensionRequests[index];
  const card = elements.requestsList.querySelector(`[data-index="${index}"]`);
  const actionsContainer = card.querySelector('.actions');
  const actionControls = card.querySelector('.action-controls');
  
  const daysSelect = card.querySelector('.days-select');
  const customInput = card.querySelector('.custom-days-input');
  let finalDays = (daysSelect.value === 'custom') ? (parseInt(customInput.value, 10) || 3) : parseInt(daysSelect.value, 10);

  request.requestedDays = finalDays;
  actionsContainer.innerHTML = '<span class="status-label processing">Applying extension...</span>';

  try {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const processRes = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: async (studentName, assignmentName, daysToAdd) => {
        try {
          // 1. Extract Course URL
          const navLinks = Array.from(document.querySelectorAll('.breadcrumb a, nav[aria-label="Breadcrumb"] a, nav[aria-label="נתיב"] a, .breadcrumb-nav a'));
          const courseLink = navLinks.find(a => a.href.includes('course/view.php'));
          if (!courseLink) throw new Error("Course URL not found.");
          const courseUrl = courseLink.href;
          const forumModuleId = new URLSearchParams(window.location.search).get('id');

          // 2. Fetch course page to locate assignment URL
          const courseResp = await fetch(courseUrl);
          const courseHtml = await courseResp.text();
          const courseDoc = new DOMParser().parseFromString(courseHtml, 'text/html');

          let assignUrl = null;
          if (forumModuleId) {
            const forumEl = courseDoc.querySelector(`#module-${forumModuleId}, [id*="module-${forumModuleId}"]`);
            if (forumEl) {
              const section = forumEl.closest('li[id^="section-"], div[id^="section-"], .section.main, [data-sectionid]');
              const sectionAssignLink = section?.querySelector('a[href*="mod/assign/view.php"]');
              if (sectionAssignLink) assignUrl = sectionAssignLink.href;
            }
          }
          if (!assignUrl) {
            const links = Array.from(courseDoc.querySelectorAll('a[href*="mod/assign/view.php"]'));
            if (links.length > 0) {
              const searchName = assignmentName?.toLowerCase();
              assignUrl = searchName && searchName !== "null" 
                ? (links.find(l => l.textContent.toLowerCase().includes(searchName))?.href || links[0].href)
                : links[0].href;
            }
          }
          if (!assignUrl) throw new Error("Assignment link not found.");

          // 3. Fetch grading page to extract user ID and sesskey
          const gradingUrl = new URL(assignUrl);
          gradingUrl.searchParams.set('action', 'grading');
          const gradingResp = await fetch(gradingUrl.toString());
          const gradingHtml = await gradingResp.text();
          const gradingDoc = new DOMParser().parseFromString(gradingHtml, 'text/html');

          const sesskey = gradingDoc.querySelector('input[name="sesskey"]')?.value;
          let userid = null;
          const normalized = studentName.toLowerCase().trim();
          
          for (const row of Array.from(gradingDoc.querySelectorAll('tr'))) {
            const nameEls = Array.from(row.querySelectorAll('td a, td .fullname'));
            if (nameEls.some(el => el.textContent.toLowerCase().includes(normalized))) {
              const m = row.innerHTML.match(/[?&]userid=(\d+)/) || row.innerHTML.match(/[?&]id=(\d+)/);
              if (m) { userid = m[1]; break; }
            }
          }
          if (!userid || !sesskey) throw new Error(`Student not found in grading table.`);

          // 4. Fetch grant extension page
          const grantUrl = new URL(assignUrl);
          grantUrl.searchParams.set('action', 'grantextension');
          grantUrl.searchParams.set('userid', userid);
          grantUrl.searchParams.set('sesskey', sesskey);

          const grantResp = await fetch(grantUrl.toString());
          const grantHtml = await grantResp.text();
          const grantDoc = new DOMParser().parseFromString(grantHtml, 'text/html');

          // Find specific date elements first by ID or name to avoid selecting a wrong search/header form
          const dayEl = grantDoc.querySelector('#id_extensionduedate_day, [name="extensionduedate[day]"]');
          const monthEl = grantDoc.querySelector('#id_extensionduedate_month, [name="extensionduedate[month]"]');
          const yearEl = grantDoc.querySelector('#id_extensionduedate_year, [name="extensionduedate[year]"]');
          
          if (!dayEl || !monthEl || !yearEl) throw new Error("Date fields not found in form.");
          
          // Get the parent form of the date fields specifically
          const form = dayEl.closest('form');
          if (!form) throw new Error("Form wrapper not found for date fields.");

          const hourEl = grantDoc.querySelector('#id_extensionduedate_hour, [name="extensionduedate[hour]"]');
          const minEl = grantDoc.querySelector('#id_extensionduedate_minute, [name="extensionduedate[minute]"]');

          const formData = new FormData(form);

          const year = parseInt(yearEl.value);
          const month = parseInt(monthEl.value) - 1;
          const day = parseInt(dayEl.value);
          const hour = hourEl ? parseInt(hourEl.value) : 23;
          const min = minEl ? parseInt(minEl.value) : 59;

          // Calculate new date
          const target = new Date(year, month, day, hour, min);
          target.setDate(target.getDate() + daysToAdd);

          // Force set the new enabled date properties in the payload
          formData.set('extensionduedate[enabled]', '1');
          formData.set('extensionduedate[year]', target.getFullYear());
          formData.set('extensionduedate[month]', target.getMonth() + 1);
          formData.set('extensionduedate[day]', target.getDate());
          formData.set('extensionduedate[hour]', target.getHours());
          formData.set('extensionduedate[minute]', target.getMinutes());

          const submitBtn = form.querySelector('input[type="submit"], button[type="submit"], #id_submitbutton');
          if (submitBtn && submitBtn.name) formData.set(submitBtn.name, submitBtn.value || 'Save changes');
          else formData.set('submitbutton', 'Save changes');

          // Convert FormData to URLSearchParams to force application/x-www-form-urlencoded
          const urlEncodedData = new URLSearchParams();
          for (const [key, value] of formData.entries()) {
              urlEncodedData.append(key, value);
          }

          const actionUrl = new URL(form.getAttribute('action') || grantUrl.toString(), window.location.href);

          // 5. Submit the extension via POST
          const postResp = await fetch(actionUrl.toString(), { 
              method: 'POST', 
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: urlEncodedData 
          });
          
          const postHtmlText = await postResp.text();
          if (postHtmlText.includes('class="error"') || postHtmlText.includes('invalid-feedback')) {
              throw new Error("Server rejected the extension form.");
          }

          return { success: true, sesskey, grantUrl: grantUrl.toString() };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      args: [request.studentName, request.assignmentName, finalDays]
    });

    const extensionResult = processRes[0]?.result;
    if (!extensionResult || !extensionResult.success) {
      throw new Error(extensionResult?.error || "Failed to process extension.");
    }

    actionsContainer.innerHTML = '<span class="status-label processing">Posting forum reply...</span>';
    
    const replyResult = await postForumReply(currentTab.id, request, finalDays, extensionResult.sesskey);

    if (replyResult.success) {
      actionsContainer.innerHTML = `<span class="status-label approved">Approved for ${finalDays} days · Reply posted</span>`;
      await updateSavedRequestStatus(index, true, finalDays);
    } else {
      actionsContainer.innerHTML = `<span class="status-label processing">Reply failed. Rolling back extension...</span>`;
      
      // Rollback logic handling
      await chrome.scripting.executeScript({
         target: { tabId: currentTab.id },
         func: async (grantUrlStr) => {
             try {
                 const resp = await fetch(grantUrlStr);
                 const html = await resp.text();
                 const doc = new DOMParser().parseFromString(html, 'text/html');
                 
                 const dayEl = doc.querySelector('#id_extensionduedate_day, [name="extensionduedate[day]"]');
                 if(!dayEl) return;
                 const form = dayEl.closest('form');
                 if(form) {
                     const fd = new FormData(form);
                     fd.set('extensionduedate[enabled]', '0'); // Explicitly disable extension
                     const btn = form.querySelector('input[type="submit"], #id_submitbutton');
                     if(btn && btn.name) fd.set(btn.name, btn.value || 'Save changes');
                     else fd.set('submitbutton', 'Save changes');
                     
                     const params = new URLSearchParams();
                     for (const [k, v] of fd.entries()) params.append(k, v);
                     
                     const actionUrl = new URL(form.getAttribute('action') || grantUrlStr, window.location.href);
                     await fetch(actionUrl.toString(), { 
                         method: 'POST', 
                         headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                         body: params 
                     });
                 }
             } catch(e) {}
         },
         args: [extensionResult.grantUrl]
      });
      
      actionsContainer.innerHTML = `<span class="status-label rejected">Error: Reply failed (${replyResult.error}). Extension cancelled.</span>`;
      actionControls.classList.remove('hidden');
    }
  } catch (err) {
    actionsContainer.innerHTML = `<span class="status-label rejected">Error: ${err.message}</span>`;
    actionControls.classList.remove('hidden');
  }
}

async function postForumReply(tabId, request, days, sesskey) {
  try {
    if (!request.discussUrl) return { success: false, error: 'Discussion URL not found.' };

    const firstName = request.studentName.trim().split(/\s+/)[0];
    const msgStr = '\u05e9\u05dc\u05d5\u05dd ' + firstName + ', \u05d4\u05d5\u05d6\u05e0\u05d4 \u05dc\u05da \u05d4\u05d0\u05e8\u05db\u05d4 \u05e9\u05dc ' + days + ' \u05d9\u05de\u05d9\u05dd \u05dc\u05d4\u05d2\u05e9\u05ea \u05d4\u05ea\u05e8\u05d2\u05d9\u05dc. \u05d1\u05d4\u05e6\u05dc\u05d7\u05d4.';

    const replyRes = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async (discussUrl, studentName, message) => {
        try {
          const discResp = await fetch(discussUrl);
          const discHtml = await discResp.text();
          const discDoc = new DOMParser().parseFromString(discHtml, 'text/html');

          const normalized = studentName.toLowerCase().trim();
          const parts = normalized.split(/\s+/).filter(p => p.length > 1);
          const posts = Array.from(discDoc.querySelectorAll('.forumng-post, .forumpost'));
          
          let target = posts.find(p => {
            const author = p.querySelector('.forumng-author, .author, .posting-author');
            return author && parts.every(part => author.textContent.toLowerCase().includes(part));
          });

          if (!target && posts.length > 0) target = posts[0];
          const replyLink = target?.querySelector('a[href*="replyto="], .forumng-replylink a');
          if (!replyLink) throw new Error("Reply link not found.");

          const replyResp = await fetch(replyLink.href);
          const replyHtml = await replyResp.text();
          const replyDoc = new DOMParser().parseFromString(replyHtml, 'text/html');

          const form = replyDoc.querySelector('form[action*="editpost.php"]');
          if (!form) throw new Error("Reply form not found.");

          const formData = new FormData(form);
          const textarea = form.querySelector('textarea[name*="message"]');
          const msgName = textarea ? textarea.name : 'message[text]';
          
          formData.set(msgName, '<p>' + message + '</p>');
          
          const submitBtn = form.querySelector('input[type="submit"], button[type="submit"], #id_submitbutton');
          if (submitBtn && submitBtn.name) formData.append(submitBtn.name, submitBtn.value || 'Submit');
          else formData.append('submitbutton', 'Post to forum');

          const actionUrl = new URL(form.getAttribute('action') || replyLink.href, window.location.href);

          const postResp = await fetch(actionUrl.toString(), {
            method: form.getAttribute('method') || 'POST',
            body: formData
          });

          if (postResp.ok && !postResp.url.includes('editpost.php')) {
            return { success: true };
          } else if (postResp.url.includes('editpost.php')) {
            const text = await postResp.text();
            if (text.includes('class="error"') || text.includes('invalid-feedback')) {
                return { success: false, error: 'Moodle form validation error' };
            }
            return { success: false, error: 'Server rejected the reply form data' };
          }
          return { success: true };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      args: [request.discussUrl, request.studentName, msgStr]
    });

    return replyRes[0]?.result || { success: false, error: "Failed to execute script." };
  } catch (err) {
    return { success: false, error: err.message };
  }
}




async function handleReject(index) {
  const card = elements.requestsList.querySelector(`[data-index="${index}"]`);
  const actionsContainer = card.querySelector('.actions');
  const actionControls = card.querySelector('.action-controls');
  
  actionControls.classList.add('hidden');
  actionsContainer.innerHTML = '<span class="status-label rejected">Rejected</span>';
  
  // Update saved state
  await updateSavedRequestStatus(index, false, 0);
}

// Helper to update storage so approved/rejected state persists while popup is closed
async function updateSavedRequestStatus(index, isApproved, days) {
     const { savedRequests } = await chrome.storage.local.get(['savedRequests']);
     if(savedRequests && savedRequests[index]) {
         savedRequests[index].wantsExtension = false; // Remove from list essentially, or you can add a 'status' field if you want to show it as "handled"
         await chrome.storage.local.set({ savedRequests: savedRequests });
     }
}





function setScanLoading(loading) {
  elements.scanForumBtn.disabled = loading;
  elements.scanSpinner.classList.toggle('hidden', !loading);
  elements.scanBtnText.textContent = loading ? 'Scanning...' : 'Scan Forum';
}

function showStatus(el, message, type) {
  el.textContent = message;
  el.className = `status-msg ${type}`;
}

function showError(message) {
  elements.errorBanner.textContent = message;
  elements.errorBanner.classList.remove('hidden');
}

function hideError() {
  elements.errorBanner.textContent = '';
  elements.errorBanner.classList.add('hidden');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}