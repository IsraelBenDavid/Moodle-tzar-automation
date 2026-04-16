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

    const posts = results[0]?.result?.posts;
    const forumTitle = results[0]?.result?.forumTitle; // Try to grab the forum title to help with assignment matching

    if (!posts || posts.length === 0) {
      showStatus(elements.scanStatus, 'No forum posts found on this page.', 'error');
      setScanLoading(false);
      return;
    }

    showStatus(elements.scanStatus, `Found ${posts.length} posts. Analyzing with AI...`, 'info');

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
    
    // Inject the forum title into requests if AI didn't find an assignment name
    extensionRequests.forEach(req => {
        if (!req.assignmentName && forumTitle) {
            req.assignmentName = extractNumberOrNameFromTitle(forumTitle);
        }
    });

    // Save results to storage
    await chrome.storage.local.set({
        savedRequests: extensionRequests,
        savedForumUrl: currentForumUrl
    });

    renderRequests();
    showStatus(elements.scanStatus,
      `Analysis complete. Found ${extensionRequests.length} extension request(s).`,
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
  
  // Try to get the forum title to help figure out which assignment we are in
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
      posts.push({ author, content, postId });
      return true;
    }

    // Single page mode
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

    // Discussion list mode
    const discussionRows = document.querySelectorAll('tr[id^="discrow_"]');
    if (discussionRows.length > 0 && posts.length === 0) {
      const fetchPromises = Array.from(discussionRows).map(async row => {
        const idMatch = row.id.match(/discrow_(\d+)/);
        if (!idMatch) return null;
        const discussionId = idMatch[1];
        const authorEl = row.querySelector('a[href*="user/view.php"], td.author a, .author a');
        const author = authorEl ? authorEl.textContent.trim() : null;
        const topicLinkEl = row.querySelector('a[href*="discuss.php"]');
        const discussUrl = topicLinkEl ? topicLinkEl.href : null;
        if (!author || !discussUrl) return null;

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

          return { author, content, postId: row.id };
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
  elements.requestCount.textContent = extensionRequests.length;

  if (extensionRequests.length === 0) {
    elements.resultsSection.classList.add('hidden');
    return;
  }

  elements.resultsSection.classList.remove('hidden');

  extensionRequests.forEach((request, index) => {
    if (!request.wantsExtension) return;

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

  const extensionCount = extensionRequests.filter(r => r.wantsExtension).length;
  elements.requestCount.textContent = extensionCount;
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

async function handleApprove(index) {
  const request = extensionRequests[index];
  const card = elements.requestsList.querySelector(`[data-index="${index}"]`);
  const actionsContainer = card.querySelector('.actions');
  const actionControls = card.querySelector('.action-controls');
  
  const daysSelect = card.querySelector('.days-select');
  const customInput = card.querySelector('.custom-days-input');
  let finalDays = 3;
  
  if (daysSelect.value === 'custom') {
    finalDays = parseInt(customInput.value, 10) || 3;
  } else {
    finalDays = parseInt(daysSelect.value, 10);
  }

  request.requestedDays = finalDays;

  actionControls.classList.add('hidden');
  actionsContainer.innerHTML = '<span class="status-label processing">Navigating to grading page...</span>';

  let newTabId = null;

  try {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // 1. Get Course URL and the forum's module ID from the current page
    const courseUrlRes = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: () => {
        const navLinks = Array.from(document.querySelectorAll('.breadcrumb a, nav[aria-label="Breadcrumb"] a, nav[aria-label="נתיב"] a, .breadcrumb-nav a'));
        const courseLink = navLinks.find(a => a.href.includes('course/view.php'));
        // Also capture the forum's own module ID so we can locate its section on the course page
        const moduleId = new URLSearchParams(window.location.search).get('id');
        return { courseUrl: courseLink ? courseLink.href : null, moduleId };
      }
    });

    const { courseUrl, moduleId: forumModuleId } = courseUrlRes[0]?.result || {};
    if (!courseUrl) throw new Error("Could not find course URL. Please ensure you are on a page linked to the course.");

    // 2. Open new tab in background
    const newTab = await chrome.tabs.create({ url: courseUrl, active: false });
    newTabId = newTab.id;
    await waitForTabLoad(newTabId);

    actionsContainer.innerHTML = '<span class="status-label processing">Locating assignment...</span>';

    // 3. Find Assignment URL — first try section-aware matching using the forum's module ID,
    //    then fall back to text matching across the whole course page.
    const assignUrlRes = await chrome.scripting.executeScript({
      target: { tabId: newTabId },
      func: (assignName, forumModuleId) => {
        // Strategy 0: Find the section that contains the forum module, then pick the
        // assignment link inside that same section. This is the most reliable approach
        // because it uses DOM structure rather than text matching.
        if (forumModuleId) {
          const forumEl = document.querySelector(`#module-${forumModuleId}, [id*="module-${forumModuleId}"]`);
          if (forumEl) {
            const section = forumEl.closest('li[id^="section-"], div[id^="section-"], .section.main, [data-sectionid]');
            if (section) {
              const sectionAssignLink = section.querySelector('a[href*="mod/assign/view.php"]');
              if (sectionAssignLink) return sectionAssignLink.href;
            }
          }
        }

        // Fallback: text-based search across all assignment links on the page
        const links = Array.from(document.querySelectorAll('a[href*="mod/assign/view.php"]'));
        if (links.length === 0) return null;
        if (!assignName || assignName === "null") return links[0].href;

        const searchName = assignName.toLowerCase();

        // Strategy A: Exact or close text match
        for (const link of links) {
          const linkText = link.textContent.toLowerCase();
          if (linkText.includes(searchName)) {
            if (!isNaN(searchName)) {
              const regex = new RegExp(`\\b${searchName}\\b`);
              if (regex.test(linkText)) return link.href;
            } else {
              return link.href;
            }
          }
        }

        // Strategy B: match by number
        const matchNumber = assignName.match(/\d+/);
        if (matchNumber) {
          const num = matchNumber[0];
          const regex = new RegExp(`\\b${num}\\b`);
          for (const link of links) {
            if (regex.test(link.textContent) && /תרגיל|מטלה|הגשה|assignment/i.test(link.textContent)) {
              return link.href;
            }
          }
          for (const link of links) {
            if (regex.test(link.textContent)) return link.href;
          }
        }

        // Strategy C: partial word match
        const parts = searchName.split(' ');
        for (const link of links) {
          const linkText = link.textContent.toLowerCase();
          for (const part of parts) {
            if (part.length > 2 && linkText.includes(part)) return link.href;
          }
        }

        return links[0].href;
      },
      args: [request.assignmentName ? String(request.assignmentName) : null, forumModuleId || null]
    });

    const assignUrl = assignUrlRes[0]?.result;
    if (!assignUrl) throw new Error(`Could not find the assignment link on the course page.`);

    // 4. Navigate to Grading Page and extract sesskey + student userid
    actionsContainer.innerHTML = '<span class="status-label processing">Finding student...</span>';
    const gradingUrl = new URL(assignUrl);
    gradingUrl.searchParams.set('action', 'grading');
    await chrome.tabs.update(newTabId, { url: gradingUrl.toString() });
    await waitForTabLoad(newTabId);

    const studentInfoRes = await chrome.scripting.executeScript({
      target: { tabId: newTabId },
      func: (studentName) => {
        const sesskey = window.M?.cfg?.sesskey
          || document.querySelector('input[name="sesskey"]')?.value
          || (() => { const m = document.cookie.match(/MoodleSession\w*=(\w+)/); return m?.[1]; })();

        const normalized = studentName.toLowerCase().trim();
        const rows = Array.from(document.querySelectorAll('tr'));
        for (const row of rows) {
          const nameEls = Array.from(row.querySelectorAll('td a, td .fullname'));
          const matched = nameEls.find(el => {
            const t = el.textContent.trim().toLowerCase();
            return t.includes(normalized) || normalized.includes(t);
          });
          if (!matched) continue;

          // Look for userid in any link in this row
          for (const link of row.querySelectorAll('a[href]')) {
            const m = link.href.match(/[?&]userid=(\d+)/);
            if (m) return { sesskey, userid: m[1] };
          }
          // Fallback: profile link id
          for (const link of row.querySelectorAll('a[href*="user/view.php"]')) {
            const m = link.href.match(/[?&]id=(\d+)/);
            if (m) return { sesskey, userid: m[1] };
          }
          return { sesskey, userid: null, rowHtml: row.innerHTML.substring(0, 300) };
        }
        // No row matched — return first few names for debugging
        const names = rows.flatMap(r => Array.from(r.querySelectorAll('td a, td .fullname')).map(e => e.textContent.trim())).filter(Boolean).slice(0, 10);
        return { sesskey, userid: null, names };
      },
      args: [request.studentName]
    });

    const { sesskey, userid, names, rowHtml } = studentInfoRes[0]?.result || {};
    console.log('[Tzar] sesskey:', sesskey, 'userid:', userid, 'names:', names, 'rowHtml:', rowHtml);

    if (!userid) {
      throw new Error(`Student "${request.studentName}" not found in grading table. Names seen: ${(names || []).join(', ')}`);
    }
    if (!sesskey) {
      throw new Error('Could not extract sesskey from the grading page.');
    }

    // 5. Navigate directly to the grant extension page
    actionsContainer.innerHTML = '<span class="status-label processing">Applying extension...</span>';
    const grantUrl = new URL(assignUrl);
    grantUrl.searchParams.set('sesskey', sesskey);
    grantUrl.searchParams.set('page', '0');
    grantUrl.searchParams.set('userid', userid);
    grantUrl.searchParams.set('action', 'grantextension');
    console.log('[Tzar] navigating to grant URL:', grantUrl.toString());
    await chrome.tabs.update(newTabId, { url: grantUrl.toString() });
    await waitForTabLoad(newTabId);


    // 6. Fill in the extension date form
    const formResult = await chrome.scripting.executeScript({
      target: { tabId: newTabId },
      func: fillExtensionForm,
      args: [finalDays] // FIX: Changed from requestedDays to finalDays
    });

    // 7. Wait for form submission then close the background tab
    await waitForTabLoad(newTabId);
    chrome.tabs.remove(newTabId);

    const result = formResult[0]?.result;
    console.log('[Tzar] form result:', JSON.stringify(result));

    if (result && result.success) {
      actionsContainer.innerHTML = '<span class="status-label processing">Posting forum reply...</span>';
      const replyResult = await postForumReply(request, finalDays, sesskey);
      if (replyResult.success) {
        actionsContainer.innerHTML = `<span class="status-label approved">Approved for ${finalDays} days · Reply posted</span>`;
      } else {
        console.warn('[Tzar] Forum reply failed:', replyResult.error);
        actionsContainer.innerHTML = `<span class="status-label approved">Approved for ${finalDays} days · Reply failed: ${escapeHtml(replyResult.error)}</span>`;
      }
      await updateSavedRequestStatus(index, true, finalDays);
    } else {
      const msg = result?.error || 'Form fill failed.';
      const debugInfo = result?.log ? '\n\nDebug:\n' + result.log.join('\n') : '\n\n(result: ' + JSON.stringify(result) + ')';
      actionsContainer.innerHTML = `<span class="status-label rejected">Error: ${escapeHtml(msg)}${escapeHtml(debugInfo)}</span>`;
      actionControls.classList.remove('hidden');
    }
  } catch (err) {
    console.log('[Tzar] outer catch:', err.message, err.stack);
    if (newTabId) chrome.tabs.remove(newTabId).catch(() => {});
    actionsContainer.innerHTML = `<span class="status-label rejected">Error: ${escapeHtml(err.message)}</span>`;
    actionControls.classList.remove('hidden');
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

async function postForumReply(request, days, sesskey) {
  try {
    const urlObj = new URL(currentForumUrl);
    const basePath = urlObj.pathname.split('/mod/')[0];
    
    let discussionId = null;
    let discussUrl = null;

    const discrowMatch = request.postId && request.postId.match(/^discrow_(\d+)$/);
    if (discrowMatch) {
      discussionId = discrowMatch[1];
      discussUrl = `${urlObj.origin}${basePath}/mod/forumng/discuss.php?d=${discussionId}`;
    } else if (currentForumUrl.includes('discuss.php')) {
      discussionId = urlObj.searchParams.get('d');
      discussUrl = currentForumUrl;
    }

    if (!discussionId || !discussUrl) {
      return { success: false, error: 'Cannot determine forum discussion URL' };
    }

    const newTab = await chrome.tabs.create({ url: discussUrl, active: false });
    await waitForTabLoad(newTab.id);

    const msgStr = '\u05e9\u05dc\u05d5\u05dd ' + request.studentName + ', \u05d4\u05d5\u05d6\u05e0\u05d4 \u05dc\u05da \u05d4\u05d0\u05e8\u05db\u05d4 \u05e9\u05dc ' + days + ' \u05d9\u05de\u05d9\u05dd \u05dc\u05d4\u05d2\u05e9\u05ea \u05d4\u05ea\u05e8\u05d2\u05d9\u05dc. \u05d1\u05d4\u05e6\u05dc\u05d7\u05d4.';

    const replyResult = await chrome.scripting.executeScript({
      target: { tabId: newTab.id },
      func: async (studentName, messageText) => {
        try {
            const normalizedName = studentName.toLowerCase().trim();
            const posts = Array.from(document.querySelectorAll('.forumng-post'));
            
            let targetPost = posts.find(p => {
                const authorEl = p.querySelector('.forumng-author a');
                return authorEl && authorEl.textContent.trim().toLowerCase().includes(normalizedName);
            });
            
            if (!targetPost && posts.length > 0) {
                targetPost = posts[0];
            }
            
            if (!targetPost) {
                return { success: false, error: 'No posts found to reply to' };
            }
            
            const replyLinkEl = targetPost.querySelector('.forumng-replylink a');
            if (!replyLinkEl) {
                return { success: false, error: 'Reply link not found on post' };
            }
            
            const replyFormUrl = replyLinkEl.href;
            
            const formResp = await fetch(replyFormUrl);
            if (!formResp.ok) {
                return { success: false, error: 'HTTP ' + formResp.status + ' on fetching reply form' };
            }
            
            const html = await formResp.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const form = doc.querySelector('form.mform');
            
            if (!form) {
                return { success: false, error: 'Reply form element not found in HTML' };
            }
            
            const formData = new URLSearchParams(new FormData(form));
            formData.set('message[text]', '<p>' + messageText + '</p>');
            formData.set('message[format]', '1'); 
            
            const submitBtn = form.querySelector('input[type="submit"][name="submitbutton"]');
            if (submitBtn) {
                formData.append(submitBtn.name, submitBtn.value);
            } else {
                formData.append('submitbutton', '1');
            }

            const postResp = await fetch(form.action || replyFormUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: formData.toString()
            });

            if (postResp.ok) {
                return { success: true };
            }
            
            return { success: false, error: 'Submission failed HTTP ' + postResp.status };

        } catch (e) {
            return { success: false, error: e.message };
        }
      },
      args: [request.studentName, msgStr]
    });

    chrome.tabs.remove(newTab.id).catch(() => {});
    return replyResult[0]?.result || { success: false, error: 'Script execution failed' };
  } catch (err) {
    return { success: false, error: err.message };
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