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
let directStudentName = null;

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
  elements.directExtensionSection = document.getElementById('direct-extension-section');
  elements.directStudentLabel = document.getElementById('direct-student-label');
  elements.directAssignmentName = document.getElementById('direct-assignment-name');
  elements.directDaysSelect = document.getElementById('direct-days-select');
  elements.directCustomDays = document.getElementById('direct-custom-days');
  elements.directGrantBtn = document.getElementById('direct-grant-btn');
  elements.directCustomReplyToggle = document.getElementById('direct-custom-reply-toggle');
  elements.directCustomReplyText = document.getElementById('direct-custom-reply-text');
  elements.directStatus = document.getElementById('direct-extension-status');
  elements.directDeadlineInfo = document.getElementById('direct-deadline-info');
  elements.directTimeOverride = document.getElementById('direct-time-override');
}

function bindEvents() {
  elements.saveApiKeyBtn.addEventListener('click', saveApiKey);
  elements.toggleKeyBtn.addEventListener('click', toggleKeyVisibility);
  elements.settingsToggle.addEventListener('click', toggleSettings);
  elements.scanForumBtn.addEventListener('click', scanForum);
  elements.modelOptions.addEventListener('change', handleModelChange);

  elements.directDaysSelect.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      elements.directCustomDays.classList.remove('hidden');
      elements.directCustomDays.focus();
    } else {
      elements.directCustomDays.classList.add('hidden');
    }
  });
  elements.directCustomReplyToggle.addEventListener('change', () => {
    if (elements.directCustomReplyToggle.checked) {
      elements.directCustomReplyText.classList.remove('hidden');
      if (!elements.directCustomReplyText.value.trim() && directStudentName) {
        const days = elements.directDaysSelect.value === 'custom'
          ? (parseInt(elements.directCustomDays.value, 10) || 3)
          : parseInt(elements.directDaysSelect.value, 10);
        elements.directCustomReplyText.value = getDefaultReplyMessage(directStudentName, days);
      }
    } else {
      elements.directCustomReplyText.classList.add('hidden');
    }
  });
  elements.directGrantBtn.addEventListener('click', handleDirectGrant);
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
      if (tab.url && (tab.url.includes('/mod/forum/discuss.php') || tab.url.includes('/mod/forumng/discuss.php'))) {
        await initDirectExtension(tab.id);
      }
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
      fetchAndDisplayDeadlines();
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
    fetchAndDisplayDeadlines();
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

function getDefaultReplyMessage(studentName, days) {
  const firstName = studentName.trim().split(/\s+/)[0];
  return 'שלום ' + firstName + ', הוזנה לך הארכה של ' + days + ' ימים להגשת התרגיל. בהצלחה.';
}

function renderDeadlineText(result) {
  if (!result || result.error) return 'Deadline: N/A';
  if (result.noDeadline) return 'Deadline: not set';
  return (result.isExtension ? 'Extension: ' : 'Deadline: ') + result.formatted;
}

async function initDirectExtension(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const AUTHOR_SELECTORS = [
          'a[data-userid]', '.author-info a', '.author-info .d-flex a',
          '.postprofile .author a', '.forumng-author a', '.forumng-name a',
          '.author a', '.posting-author a', 'a[href*="user/view.php"]', 'h4 a',
        ];
        const POST_SELECTORS = [
          'article.forum-post-container', 'article[data-post-id]',
          '[data-region="post"]', 'div.forumpost', '.forumng-post',
          'li.post', 'li.forumpost',
        ];
        let firstPost = null;
        for (const sel of POST_SELECTORS) {
          firstPost = document.querySelector(sel);
          if (firstPost) break;
        }
        if (!firstPost) return null;
        let authorEl = null;
        for (const sel of AUTHOR_SELECTORS) {
          try { authorEl = firstPost.querySelector(sel); } catch (e) { continue; }
          if (authorEl) break;
        }
        return authorEl ? authorEl.textContent.trim() : null;
      }
    });

    const studentName = results[0]?.result;
    if (!studentName) return;

    directStudentName = studentName;
    elements.directStudentLabel.textContent = 'Student: ' + studentName;
    elements.directDeadlineInfo.textContent = 'Deadline: loading...';
    elements.directExtensionSection.classList.remove('hidden');

    // Fetch deadline in background
    chrome.scripting.executeScript({
      target: { tabId },
      func: _pageFetchAllDeadlines,
      args: [[{ studentName, assignmentName: null, index: 0 }]]
    }).then(res => {
      if (elements.directDeadlineInfo)
        elements.directDeadlineInfo.textContent = renderDeadlineText(res[0]?.result?.[0]);
    }).catch(() => {
      if (elements.directDeadlineInfo) elements.directDeadlineInfo.textContent = 'Deadline: N/A';
    });
  } catch (err) {
    console.error('initDirectExtension failed:', err);
  }
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
      <div class="deadline-info">Deadline: loading...</div>

      <div class="action-controls">
        <select class="days-select" data-index="${index}">
          <option value="3" ${initialDays === 3 ? 'selected' : ''}>3 Days</option>
          <option value="4" ${initialDays === 4 ? 'selected' : ''}>4 Days</option>
          <option value="7" ${initialDays === 7 ? 'selected' : ''}>7 Days</option>
          <option value="custom" ${initialDays !== 3 && initialDays !== 7 ? 'selected' : ''}>Other...</option>
        </select>
        <input type="number" class="custom-days-input ${initialDays !== 3 && initialDays !== 7 ? '' : 'hidden'}" data-index="${index}" value="${initialDays}" min="1">
        <span class="time-separator">at</span>
        <input type="time" class="time-override-input" data-index="${index}" title="Override submission time (leave blank to keep original)">
        <button class="btn btn-approve" data-action="approve" data-index="${index}">Approve</button>
        <button class="btn btn-reject" data-action="reject" data-index="${index}">Reject</button>
      </div>
      <div class="custom-reply-row">
        <label class="custom-reply-toggle-label">
          <input type="checkbox" class="custom-reply-checkbox" data-index="${index}"> Custom reply
        </label>
        <textarea class="custom-reply-textarea hidden" data-index="${index}" rows="3" dir="rtl" placeholder="Custom reply message..."></textarea>
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

    const customReplyCheckbox = card.querySelector('.custom-reply-checkbox');
    const customReplyTextarea = card.querySelector('.custom-reply-textarea');
    customReplyCheckbox.addEventListener('change', () => {
      if (customReplyCheckbox.checked) {
        customReplyTextarea.classList.remove('hidden');
        if (!customReplyTextarea.value.trim()) {
          const days = daysSelect.value === 'custom'
            ? (parseInt(customInput.value, 10) || 3)
            : parseInt(daysSelect.value, 10);
          customReplyTextarea.value = getDefaultReplyMessage(request.studentName, days);
        }
      } else {
        customReplyTextarea.classList.add('hidden');
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

  const customReplyCheckbox = card.querySelector('.custom-reply-checkbox');
  const customReplyTextarea = card.querySelector('.custom-reply-textarea');
  const customMessage = (customReplyCheckbox?.checked && customReplyTextarea?.value.trim())
    ? customReplyTextarea.value.trim()
    : null;

  const timeVal = card.querySelector('.time-override-input')?.value;
  const customHour = timeVal ? parseInt(timeVal.split(':')[0], 10) : null;
  const customMin  = timeVal ? parseInt(timeVal.split(':')[1], 10) : null;

  request.requestedDays = finalDays;
  actionsContainer.innerHTML = '<span class="status-label processing">Applying extension...</span>';

  try {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const processRes = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: _pageGrantExtension,
      args: [request.studentName, request.assignmentName, finalDays, customHour, customMin]
    });

    const extensionResult = processRes[0]?.result;
    if (!extensionResult || !extensionResult.success) {
      throw new Error(extensionResult?.error || "Failed to process extension.");
    }

    actionsContainer.innerHTML = '<span class="status-label processing">Posting forum reply...</span>';
    
    const replyResult = await postForumReply(currentTab.id, request, finalDays, extensionResult.sesskey, customMessage);

    if (replyResult.success) {
      actionsContainer.innerHTML = `<span class="status-label approved">Approved for ${finalDays} days · Reply posted</span>`;
      await updateSavedRequestStatus(index, true, finalDays);
    } else {
      actionsContainer.innerHTML = `<span class="status-label processing">Reply failed. Rolling back extension...</span>`;
      
      // Rollback logic handling
      await chrome.scripting.executeScript({
         target: { tabId: currentTab.id },
         func: _pageRollbackExtension,
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

// Runs in page context — fetches current deadlines for multiple students in one shot
async function _pageFetchAllDeadlines(studentInfos) {
  const pad = n => String(n).padStart(2, '0');
  try {
    const navLinks = Array.from(document.querySelectorAll(
      '.breadcrumb a, nav[aria-label="Breadcrumb"] a, nav[aria-label="נתיב"] a, .breadcrumb-nav a'
    ));
    const courseLink = navLinks.find(a => a.href.includes('course/view.php'));
    if (!courseLink) return studentInfos.map(s => ({ index: s.index, error: 'Course URL not found' }));
    const courseUrl = courseLink.href;

    // On discuss.php there's no ?id=, so check breadcrumb for the forum view link
    let forumModuleId = new URLSearchParams(window.location.search).get('id');
    if (!forumModuleId) {
      const forumViewLink = navLinks.find(
        a => a.href.includes('/mod/forumng/view.php') || a.href.includes('/mod/forum/view.php')
      );
      if (forumViewLink) forumModuleId = new URL(forumViewLink.href).searchParams.get('id');
    }

    const courseResp = await fetch(courseUrl);
    const courseHtml = await courseResp.text();
    const courseDoc = new DOMParser().parseFromString(courseHtml, 'text/html');

    const firstAssignmentName = studentInfos[0]?.assignmentName;
    let assignUrl = null;
    if (forumModuleId) {
      const forumEl = courseDoc.querySelector(`#module-${forumModuleId}, [id*="module-${forumModuleId}"]`);
      if (forumEl) {
        const section = forumEl.closest('li[id^="section-"], div[id^="section-"], .section.main, [data-sectionid]');
        const link = section?.querySelector('a[href*="mod/assign/view.php"]');
        if (link) assignUrl = link.href;
      }
    }
    if (!assignUrl) {
      const links = Array.from(courseDoc.querySelectorAll('a[href*="mod/assign/view.php"]'));
      if (links.length > 0) {
        const searchName = firstAssignmentName?.toLowerCase();
        assignUrl = searchName && searchName !== 'null'
          ? (links.find(l => l.textContent.toLowerCase().includes(searchName))?.href || links[0].href)
          : links[0].href;
      }
    }
    if (!assignUrl) return studentInfos.map(s => ({ index: s.index, error: 'Assignment not found' }));

    const gradingUrl = new URL(assignUrl);
    gradingUrl.searchParams.set('action', 'grading');
    const gradingResp = await fetch(gradingUrl.toString());
    const gradingHtml = await gradingResp.text();
    const gradingDoc = new DOMParser().parseFromString(gradingHtml, 'text/html');

    const sesskey = gradingDoc.querySelector('input[name="sesskey"]')?.value;
    if (!sesskey) return studentInfos.map(s => ({ index: s.index, error: 'No sesskey found' }));

    const userIds = {};
    for (const { studentName, index } of studentInfos) {
      const normalized = studentName.toLowerCase().trim();
      for (const row of Array.from(gradingDoc.querySelectorAll('tr'))) {
        const nameEls = Array.from(row.querySelectorAll('td a, td .fullname'));
        if (nameEls.some(el => el.textContent.toLowerCase().includes(normalized))) {
          const m = row.innerHTML.match(/[?&]userid=(\d+)/) || row.innerHTML.match(/[?&]id=(\d+)/);
          if (m) { userIds[index] = m[1]; break; }
        }
      }
    }

    const results = await Promise.all(studentInfos.map(async ({ index }) => {
      const userid = userIds[index];
      if (!userid) return { index, error: 'Student not found' };
      try {
        const grantUrl = new URL(assignUrl);
        grantUrl.searchParams.set('action', 'grantextension');
        grantUrl.searchParams.set('userid', userid);
        grantUrl.searchParams.set('sesskey', sesskey);

        const grantResp = await fetch(grantUrl.toString());
        const grantHtml = await grantResp.text();
        const grantDoc = new DOMParser().parseFromString(grantHtml, 'text/html');

        const dayEl   = grantDoc.querySelector('#id_extensionduedate_day, [name="extensionduedate[day]"]');
        const monthEl = grantDoc.querySelector('#id_extensionduedate_month, [name="extensionduedate[month]"]');
        const yearEl  = grantDoc.querySelector('#id_extensionduedate_year, [name="extensionduedate[year]"]');
        const hourEl  = grantDoc.querySelector('#id_extensionduedate_hour, [name="extensionduedate[hour]"]');
        const minEl   = grantDoc.querySelector('#id_extensionduedate_minute, [name="extensionduedate[minute]"]');
        const enabledEl = grantDoc.querySelector('#id_extensionduedate_enabled, [name="extensionduedate[enabled]"]');

        if (!dayEl || !monthEl || !yearEl) return { index, error: 'Date fields not found' };

        const year  = parseInt(yearEl.value)  || 0;
        const month = parseInt(monthEl.value) || 0;
        const day   = parseInt(dayEl.value)   || 0;
        const hour  = parseInt(hourEl?.value) || 0;
        const min   = parseInt(minEl?.value)  || 0;
        const isExtension = enabledEl ? (enabledEl.checked || enabledEl.value === '1') : false;

        if (year < 2000 || day < 1) return { index, noDeadline: true };

        const formatted = `${pad(day)}/${pad(month)}/${year} ${pad(hour)}:${pad(min)}`;
        return { index, formatted, isExtension };
      } catch (err) {
        return { index, error: err.message };
      }
    }));

    return results;
  } catch (err) {
    return studentInfos.map(s => ({ index: s.index, error: err.message }));
  }
}

async function fetchAndDisplayDeadlines() {
  if (!currentTabId) return;

  const studentInfos = extensionRequests.reduce((acc, req, idx) => {
    if (req.wantsExtension && !req.isAnswered)
      acc.push({ studentName: req.studentName, assignmentName: req.assignmentName, index: idx });
    return acc;
  }, []);

  if (studentInfos.length === 0) return;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      func: _pageFetchAllDeadlines,
      args: [studentInfos]
    });

    for (const result of (results[0]?.result || [])) {
      const card = elements.requestsList.querySelector(`[data-index="${result.index}"]`);
      const deadlineEl = card?.querySelector('.deadline-info');
      if (deadlineEl) deadlineEl.textContent = renderDeadlineText(result);
    }
  } catch (_) {
    elements.requestsList.querySelectorAll('.deadline-info').forEach(el => {
      el.textContent = 'Deadline: N/A';
    });
  }
}

// Runs in page context via chrome.scripting.executeScript
async function _pageGrantExtension(studentName, assignmentName, daysToAdd, customHour = null, customMin = null) {
  try {
    const navLinks = Array.from(document.querySelectorAll('.breadcrumb a, nav[aria-label="Breadcrumb"] a, nav[aria-label="נתיב"] a, .breadcrumb-nav a'));
    const courseLink = navLinks.find(a => a.href.includes('course/view.php'));
    if (!courseLink) throw new Error("Course URL not found.");
    const courseUrl = courseLink.href;
    let forumModuleId = new URLSearchParams(window.location.search).get('id');
    if (!forumModuleId) {
      const forumViewLink = navLinks.find(
        a => a.href.includes('/mod/forumng/view.php') || a.href.includes('/mod/forum/view.php')
      );
      if (forumViewLink) forumModuleId = new URL(forumViewLink.href).searchParams.get('id');
    }

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
    if (!userid || !sesskey) throw new Error("Student not found in grading table.");

    const grantUrl = new URL(assignUrl);
    grantUrl.searchParams.set('action', 'grantextension');
    grantUrl.searchParams.set('userid', userid);
    grantUrl.searchParams.set('sesskey', sesskey);

    const grantResp = await fetch(grantUrl.toString());
    const grantHtml = await grantResp.text();
    const grantDoc = new DOMParser().parseFromString(grantHtml, 'text/html');

    const dayEl = grantDoc.querySelector('#id_extensionduedate_day, [name="extensionduedate[day]"]');
    const monthEl = grantDoc.querySelector('#id_extensionduedate_month, [name="extensionduedate[month]"]');
    const yearEl = grantDoc.querySelector('#id_extensionduedate_year, [name="extensionduedate[year]"]');

    if (!dayEl || !monthEl || !yearEl) throw new Error("Date fields not found in form.");

    const form = dayEl.closest('form');
    if (!form) throw new Error("Form wrapper not found for date fields.");

    const hourEl = grantDoc.querySelector('#id_extensionduedate_hour, [name="extensionduedate[hour]"]');
    const minEl = grantDoc.querySelector('#id_extensionduedate_minute, [name="extensionduedate[minute]"]');

    const formData = new FormData(form);

    const year = parseInt(yearEl.value);
    const month = parseInt(monthEl.value) - 1;
    const day = parseInt(dayEl.value);
    const hour = customHour !== null ? customHour : (hourEl ? parseInt(hourEl.value) : 23);
    const min  = customMin  !== null ? customMin  : (minEl  ? parseInt(minEl.value)  : 59);

    const target = new Date(year, month, day, hour, min);
    target.setDate(target.getDate() + daysToAdd);

    formData.set('extensionduedate[enabled]', '1');
    formData.set('extensionduedate[year]', target.getFullYear());
    formData.set('extensionduedate[month]', target.getMonth() + 1);
    formData.set('extensionduedate[day]', target.getDate());
    formData.set('extensionduedate[hour]', target.getHours());
    formData.set('extensionduedate[minute]', target.getMinutes());

    const submitBtn = form.querySelector('input[type="submit"], button[type="submit"], #id_submitbutton');
    if (submitBtn && submitBtn.name) formData.set(submitBtn.name, submitBtn.value || 'Save changes');
    else formData.set('submitbutton', 'Save changes');

    const urlEncodedData = new URLSearchParams();
    for (const [key, value] of formData.entries()) urlEncodedData.append(key, value);

    const actionUrl = new URL(form.getAttribute('action') || grantUrl.toString(), window.location.href);

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
}

// Runs in page context via chrome.scripting.executeScript
async function _pageRollbackExtension(grantUrlStr) {
  try {
    const resp = await fetch(grantUrlStr);
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const dayEl = doc.querySelector('#id_extensionduedate_day, [name="extensionduedate[day]"]');
    if (!dayEl) return;
    const form = dayEl.closest('form');
    if (!form) return;

    const fd = new FormData(form);
    fd.set('extensionduedate[enabled]', '0');
    const btn = form.querySelector('input[type="submit"], #id_submitbutton');
    if (btn && btn.name) fd.set(btn.name, btn.value || 'Save changes');
    else fd.set('submitbutton', 'Save changes');

    const params = new URLSearchParams();
    for (const [k, v] of fd.entries()) params.append(k, v);

    const actionUrl = new URL(form.getAttribute('action') || grantUrlStr, window.location.href);
    await fetch(actionUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
  } catch (e) {}
}

async function postForumReply(tabId, request, days, sesskey, customMessage = null) {
  try {
    if (!request.discussUrl) return { success: false, error: 'Discussion URL not found.' };

    const msgStr = customMessage || getDefaultReplyMessage(request.studentName, days);

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




async function handleDirectGrant() {
  if (!directStudentName) return;

  const daysSelect = elements.directDaysSelect;
  const finalDays = daysSelect.value === 'custom'
    ? (parseInt(elements.directCustomDays.value, 10) || 3)
    : parseInt(daysSelect.value, 10);

  const assignmentName = elements.directAssignmentName.value.trim() || null;
  const customMessage = (elements.directCustomReplyToggle.checked && elements.directCustomReplyText.value.trim())
    ? elements.directCustomReplyText.value.trim()
    : null;

  const timeVal = elements.directTimeOverride?.value;
  const customHour = timeVal ? parseInt(timeVal.split(':')[0], 10) : null;
  const customMin  = timeVal ? parseInt(timeVal.split(':')[1], 10) : null;

  elements.directGrantBtn.disabled = true;
  elements.directStatus.innerHTML = '<span class="status-label processing">Applying extension...</span>';

  try {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const processRes = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: _pageGrantExtension,
      args: [directStudentName, assignmentName, finalDays, customHour, customMin]
    });

    const extensionResult = processRes[0]?.result;
    if (!extensionResult || !extensionResult.success) {
      throw new Error(extensionResult?.error || "Failed to process extension.");
    }

    elements.directStatus.innerHTML = '<span class="status-label processing">Posting forum reply...</span>';

    const request = { studentName: directStudentName, assignmentName, discussUrl: currentTab.url };
    const replyResult = await postForumReply(currentTab.id, request, finalDays, extensionResult.sesskey, customMessage);

    if (replyResult.success) {
      elements.directStatus.innerHTML = `<span class="status-label approved">Granted for ${finalDays} days · Reply posted</span>`;
    } else {
      elements.directStatus.innerHTML = '<span class="status-label processing">Reply failed. Rolling back...</span>';
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: _pageRollbackExtension,
        args: [extensionResult.grantUrl]
      });
      elements.directStatus.innerHTML = `<span class="status-label rejected">Error: ${replyResult.error}. Extension cancelled.</span>`;
      elements.directGrantBtn.disabled = false;
    }
  } catch (err) {
    elements.directStatus.innerHTML = `<span class="status-label rejected">Error: ${err.message}</span>`;
    elements.directGrantBtn.disabled = false;
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