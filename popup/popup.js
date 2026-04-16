// ============================================
// Moodle Extension Tzar - Popup Script
// ============================================

import { MOODLE_HOST, DEFAULT_MODEL_CHOICE } from '../utils/constants.js';

document.addEventListener('DOMContentLoaded', init);

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

        // All user links in the row: first = original poster, last = last replier.
        const userLinks = Array.from(row.querySelectorAll('a[href*="user/view.php"], a[data-userid]'));
        if (userLinks.length === 0) return null;

        const originalAuthor = userLinks[0].textContent.trim();
        const lastReplier = userLinks[userLinks.length - 1].textContent.trim();
        // If someone other than the original poster was the last to reply, the thread has a reply.
        const isAnswered = userLinks.length > 1 &&
          lastReplier.toLowerCase() !== originalAuthor.toLowerCase();

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
  const request = extensionRequests[index];
  const card = elements.requestsList.querySelector(`[data-index="${index}"]`);
  const actionsContainer = card.querySelector('.actions');
  const actionControls = card.querySelector('.action-controls');
  
  const daysSelect = card.querySelector('.days-select');
  const customInput = card.querySelector('.custom-days-input');
  let finalDays = (daysSelect.value === 'custom') ? (parseInt(customInput.value, 10) || 3) : parseInt(daysSelect.value, 10);

  request.requestedDays = finalDays;
  actionControls.classList.add('hidden');
  actionsContainer.innerHTML = '<span class="status-label processing">Applying extension...</span>';

  let newTabId = null;
  let grantUrl = null;

  try {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // 1. Get Course URL and Module ID
    const courseUrlRes = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: () => {
        const navLinks = Array.from(document.querySelectorAll('.breadcrumb a, nav[aria-label="Breadcrumb"] a, nav[aria-label="נתיב"] a, .breadcrumb-nav a'));
        const courseLink = navLinks.find(a => a.href.includes('course/view.php'));
        const moduleId = new URLSearchParams(window.location.search).get('id');
        return { courseUrl: courseLink ? courseLink.href : null, moduleId };
      }
    });

    const { courseUrl, moduleId: forumModuleId } = courseUrlRes[0]?.result || {};
    if (!courseUrl) throw new Error("Could not find course URL.");

    const newTab = await chrome.tabs.create({ url: courseUrl, active: false });
    newTabId = newTab.id;
    await waitForTabLoad(newTabId);

    // 2. Find Assignment URL
    const assignUrlRes = await chrome.scripting.executeScript({
      target: { tabId: newTabId },
      func: (assignName, forumModuleId) => {
        if (forumModuleId) {
          const forumEl = document.querySelector(`#module-${forumModuleId}, [id*="module-${forumModuleId}"]`);
          if (forumEl) {
            const section = forumEl.closest('li[id^="section-"], div[id^="section-"], .section.main, [data-sectionid]');
            const sectionAssignLink = section?.querySelector('a[href*="mod/assign/view.php"]');
            if (sectionAssignLink) return sectionAssignLink.href;
          }
        }
        const links = Array.from(document.querySelectorAll('a[href*="mod/assign/view.php"]'));
        if (links.length === 0) return null;
        const searchName = assignName?.toLowerCase();
        if (!searchName || searchName === "null") return links[0].href;
        return links.find(l => l.textContent.toLowerCase().includes(searchName))?.href || links[0].href;
      },
      args: [request.assignmentName ? String(request.assignmentName) : null, forumModuleId || null]
    });

    const assignUrl = assignUrlRes[0]?.result;
    if (!assignUrl) throw new Error("Assignment link not found.");

    // 3. Navigate to Grading Page to get sesskey/userid
    const gradingUrl = new URL(assignUrl);
    gradingUrl.searchParams.set('action', 'grading');
    await chrome.tabs.update(newTabId, { url: gradingUrl.toString() });
    await waitForTabLoad(newTabId);

    const studentInfoRes = await chrome.scripting.executeScript({
      target: { tabId: newTabId },
      func: (studentName) => {
        const sesskey = window.M?.cfg?.sesskey || document.querySelector('input[name="sesskey"]')?.value;
        const normalized = studentName.toLowerCase().trim();
        const rows = Array.from(document.querySelectorAll('tr'));
        for (const row of rows) {
          const nameEls = Array.from(row.querySelectorAll('td a, td .fullname'));
          if (nameEls.some(el => el.textContent.toLowerCase().includes(normalized))) {
            const m = row.innerHTML.match(/[?&]userid=(\d+)/) || row.innerHTML.match(/[?&]id=(\d+)/);
            if (m) return { sesskey, userid: m[1] };
          }
        }
        return { sesskey, userid: null };
      },
      args: [request.studentName]
    });

    const { sesskey, userid } = studentInfoRes[0]?.result || {};
    if (!userid || !sesskey) throw new Error(`Student "${request.studentName}" not found in grading table.`);

    // 4. Grant Extension
    grantUrl = new URL(assignUrl);
    grantUrl.searchParams.set('sesskey', sesskey);
    grantUrl.searchParams.set('userid', userid);
    grantUrl.searchParams.set('action', 'grantextension');
    
    await chrome.tabs.update(newTabId, { url: grantUrl.toString() });
    await waitForTabLoad(newTabId);

    const formResult = await chrome.scripting.executeScript({
      target: { tabId: newTabId },
      func: fillExtensionForm,
      args: [finalDays]
    });

    await waitForTabLoad(newTabId);
    if (!formResult[0]?.result?.success) throw new Error(formResult[0]?.result?.error || "Extension form failed.");

    // 5. Post Forum Reply
    actionsContainer.innerHTML = '<span class="status-label processing">Posting forum reply...</span>';
    const replyResult = await postForumReply(request, finalDays, sesskey);

    if (replyResult.success) {
      actionsContainer.innerHTML = `<span class="status-label approved">Approved for ${finalDays} days · Reply posted</span>`;
      chrome.tabs.remove(newTabId).catch(() => {});
      await updateSavedRequestStatus(index, true, finalDays);
    } else {
      // --- ROLLBACK START ---
      console.warn('[Tzar] Reply failed, rolling back extension...', replyResult.error);
      actionsContainer.innerHTML = `<span class="status-label processing">Reply failed. Rolling back extension...</span>`;
      
      await rollbackExtension(newTabId, grantUrl.toString());
      
      actionsContainer.innerHTML = `<span class="status-label rejected">Error: Reply failed (${replyResult.error}). Extension cancelled.</span>`;
      actionControls.classList.remove('hidden');
      chrome.tabs.remove(newTabId).catch(() => {});
      // --- ROLLBACK END ---
    }
  } catch (err) {
    if (newTabId) chrome.tabs.remove(newTabId).catch(() => {});
    actionsContainer.innerHTML = `<span class="status-label rejected">Error: ${err.message}</span>`;
    actionControls.classList.remove('hidden');
  }
}

// Helper to undo the extension if notification fails
async function rollbackExtension(tabId, grantUrl) {
    try {
        await chrome.tabs.update(tabId, { url: grantUrl });
        await waitForTabLoad(tabId);
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const checkbox = document.getElementById('id_extensionduedate_enabled');
                if (checkbox && checkbox.checked) checkbox.click(); // Disable extension
                const saveBtn = document.getElementById('id_submitbutton');
                if (saveBtn) saveBtn.click();
            }
        });
        await waitForTabLoad(tabId);
    } catch (e) {
        console.error('[Tzar] Rollback failed:', e);
    }
}

// --- Robust postForumReply ---
async function postForumReply(request, days, sesskey) {
  try {
    if (!request.discussUrl) {
      return { success: false, error: 'Discussion URL not found for this student.' };
    }

    const newTab = await chrome.tabs.create({ url: request.discussUrl, active: false });
    await waitForTabLoad(newTab.id);
    
    // Extract first name for a natural greeting
    const firstName = request.studentName.trim().split(/\s+/)[0];
    const msgStr = '\u05e9\u05dc\u05d5\u05dd ' + firstName + ', \u05d4\u05d5\u05d6\u05e0\u05d4 \u05dc\u05da \u05d4\u05d0\u05e8\u05db\u05d4 \u05e9\u05dc ' + days + ' \u05d9\u05de\u05d9\u05dd \u05dc\u05d4\u05d2\u05e9\u05ea \u05d4\u05ea\u05e8\u05d2\u05d9\u05dc. \u05d1\u05d4\u05e6\u05dc\u05d7\u05d4.';

    // Find the specific reply link using name-matching
    const findResult = await chrome.scripting.executeScript({
      target: { tabId: newTab.id },
      func: (studentName) => {
        try {
          const normalized = studentName.toLowerCase().trim();
          const parts = normalized.split(/\s+/).filter(p => p.length > 1);
          const posts = Array.from(document.querySelectorAll('.forumng-post, .forumpost'));
          
          let target = posts.find(p => {
            const author = p.querySelector('.forumng-author, .author, .posting-author');
            return author && parts.every(part => author.textContent.toLowerCase().includes(part));
          });

          if (!target && posts.length > 0) target = posts[0];
          const link = target?.querySelector('a[href*="replyto="], .forumng-replylink a');
          return link ? link.href : null;
        } catch (e) { return null; }
      },
      args: [request.studentName]
    });

    const replyUrl = findResult[0]?.result;
    if (!replyUrl) {
      chrome.tabs.remove(newTab.id).catch(() => {});
      return { success: false, error: 'Reply link not found.' };
    }

    // Step 2: Go to the reply form page
    await chrome.tabs.update(newTab.id, { url: replyUrl });
    await waitForTabLoad(newTab.id);
    
    // Important: wait for Moodle scripts and editors to fully initialize
    await new Promise(r => setTimeout(r, 3000));

    // Step 3: Inject text and force standard Moodle form submission
    const submitResult = await chrome.scripting.executeScript({
      target: { tabId: newTab.id },
      world: 'MAIN', // Run in MAIN to access window.tinyMCE directly
      func: async (message) => {
        try {
          const textarea = document.getElementById('id_message') || document.querySelector('textarea[name="message[text]"]');
          const submitBtn = document.getElementById('id_submitbutton');
          if (!textarea || !submitBtn) return { success: false, error: 'UI elements missing' };

          // Sync content to TinyMCE if it exists
          if (window.tinyMCE && window.tinyMCE.activeEditor) {
            window.tinyMCE.activeEditor.setContent('<p>' + message + '</p>');
            window.tinyMCE.triggerSave(); 
          } else {
            textarea.value = message;
          }

          // Reset dirty state to bypass "unsaved changes" popups
          if (window.M && window.M.core_formchangechecker) {
            window.M.core_formchangechecker.reset_form_dirty();
          }

          // requestSubmit is crucial: it simulates a button click that sends the button name/value
          if (typeof submitBtn.form.requestSubmit === 'function') {
            submitBtn.form.requestSubmit(submitBtn);
          } else {
            submitBtn.click();
          }
          
          return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
      },
      args: [msgStr]
    });

    if (!submitResult[0]?.result?.success) {
      chrome.tabs.remove(newTab.id).catch(() => {});
      return { success: false, error: submitResult[0].result.error || 'Interaction failed' };
    }

    // Step 4: Verification loop - check if we navigated away from the form
    let isSuccess = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const tab = await chrome.tabs.get(newTab.id);
      
      // If the URL no longer contains editpost.php, it means the server accepted the form
      if (tab.url && !tab.url.includes('editpost.php')) {
        isSuccess = true;
        break;
      }

      // Check if Moodle displayed an error message on the same page
      const errorCheck = await chrome.scripting.executeScript({
        target: { tabId: newTab.id },
        func: () => !!document.querySelector('.error, .invalid-feedback:not(:empty)')
      });
      if (errorCheck[0]?.result) {
        chrome.tabs.remove(newTab.id).catch(() => {});
        return { success: false, error: 'Moodle form validation error' };
      }
    }

    chrome.tabs.remove(newTab.id).catch(() => {});
    return isSuccess ? { success: true } : { success: false, error: 'Form submission timed out' };

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

// Injected into the grant-extension page — fills the date form and submits.
function fillExtensionForm(daysToAdd) {
  const log = [];
  try {
    log.push(`URL: ${location.href}`);

    // Enable the extension date checkbox first so the selects are active
    const enableCheckbox = document.getElementById('id_extensionduedate_enabled');
    if (enableCheckbox && !enableCheckbox.checked) {
      enableCheckbox.click();
      log.push('clicked enable checkbox');
    }

    // Find standard Moodle date selectors by ID
    const day = document.getElementById('id_extensionduedate_day');
    const month = document.getElementById('id_extensionduedate_month');
    const year = document.getElementById('id_extensionduedate_year');
    const hour = document.getElementById('id_extensionduedate_hour');
    const min = document.getElementById('id_extensionduedate_minute');

    if (!day || !month || !year) {
      log.push(`day=${!!day} month=${!!month} year=${!!year} hour=${!!hour} min=${!!min}`);
      return { success: false, error: 'Date fields not found.', log };
    }

    // Build base date from the current values already in the form (the assignment's due date)
    const base = new Date(
      parseInt(year.value),
      parseInt(month.value) - 1,
      parseInt(day.value),
      hour ? parseInt(hour.value) : 23,
      min  ? parseInt(min.value)  : 59
    );
    log.push(`base date from form: ${base.toISOString()}`);

    const target = new Date(base);
    target.setDate(target.getDate() + daysToAdd);
    const targetDate = {
      day: target.getDate(),
      month: target.getMonth() + 1,
      year: target.getFullYear(),
      hour: target.getHours(),
      minute: target.getMinutes()
    };
    log.push(`target date: ${JSON.stringify(targetDate)}`);

    function setSelect(el, value) {
      if (!el) return false;
      el.value = String(value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    setSelect(day, targetDate.day);
    setSelect(month, targetDate.month);
    setSelect(year, targetDate.year);
    setSelect(hour, targetDate.hour);
    setSelect(min, targetDate.minute);
    log.push('date set via selects');

    // Click the specific Moodle save button
    const saveBtn = document.getElementById('id_submitbutton');

    if (!saveBtn) {
      return { success: false, error: 'Save button not found.', log };
    }

    log.push('clicking save button');
    // Return a promise so the caller waits for navigation
    return new Promise((resolve) => {
      window.addEventListener('beforeunload', () => resolve({ success: true, log }), { once: true });
      setTimeout(() => resolve({ success: true, log }), 5000); // fallback
      saveBtn.click();
    });
  } catch (err) {
    log.push(`exception: ${err.message}`);
    return { success: false, error: err.message, log };
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