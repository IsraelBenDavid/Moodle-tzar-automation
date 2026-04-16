// ============================================
// Moodle Extension Tzar - Popup Script
// ============================================

import { MOODLE_HOST, DEFAULT_MODEL_CHOICE } from '../utils/constants.js';

document.addEventListener('DOMContentLoaded', init);

// State
let extensionRequests = [];

// DOM references
const elements = {};

// Constants for reply message
const REPLY_MESSAGE_TEMPLATE = "שלום {studentName}, הוזנה לך הארכה של {requestedDays} ימים לתרגיל.";

function init() {
  cacheElements();
  bindEvents();
  loadSavedApiKey();
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
  elements.modelOptions = document.querySelector('.model-options'); // Parent for radio buttons
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

// ---- Settings ----

function toggleSettings() {
  elements.settingsBody.classList.toggle('collapsed');
  elements.settingsIcon.classList.toggle('collapsed');
}

function toggleKeyVisibility() {
  const input = elements.apiKeyInput;
  input.type = input.type === 'password' ? 'text' : 'password';
}

async function loadSavedModelAndApiKey(isInit = false) {
  const { selectedModel = DEFAULT_MODEL_CHOICE, apiKey_anthropic, apiKey_openai, apiKey_gemini } = await chrome.storage.local.get(['selectedModel', 'apiKey_anthropic', 'apiKey_openai', 'apiKey_gemini']);

  // Set the selected model radio button
  if (elements.modelAnthropic) elements.modelAnthropic.checked = (selectedModel === 'anthropic');
  if (elements.modelOpenAI) elements.modelOpenAI.checked = (selectedModel === 'openai');
  if (elements.modelGemini) elements.modelGemini.checked = (selectedModel === 'gemini');

  // Update API key input based on the loaded model
  updateApiKeyInputForModel(selectedModel, { apiKey_anthropic, apiKey_openai, apiKey_gemini });

  // Collapse settings if a key for the selected model already exists
  if (isInit && elements.apiKeyInput.value.trim()) {
    elements.settingsBody.classList.add('collapsed');
    elements.settingsIcon.classList.add('collapsed');
  }
}

async function loadSavedApiKey() {
  await loadSavedModelAndApiKey(true);
}

function getSelectedModel() {
  if (elements.modelAnthropic && elements.modelAnthropic.checked) return 'anthropic';
  if (elements.modelOpenAI && elements.modelOpenAI.checked) return 'openai';
  if (elements.modelGemini && elements.modelGemini.checked) return 'gemini';
  return DEFAULT_MODEL_CHOICE; // Fallback
}

async function saveApiKey() {
  const key = elements.apiKeyInput.value.trim();
  const selectedModel = getSelectedModel();

  if (!key) {
    showStatus(elements.apiKeyStatus, 'Please enter a valid API key.', 'error');
    return;
  }

  // Store API key specific to the selected model
  const storageKey = `apiKey_${selectedModel}`;
  await chrome.storage.local.set({ [storageKey]: key, selectedModel: selectedModel });

  showStatus(elements.apiKeyStatus, 'API key saved successfully.', 'success');

  await loadSavedModelAndApiKey(false);
}

// ---- Forum Scanning ----

async function scanForum() {
  hideError();

  // Validate API key is saved
  const selectedModel = getSelectedModel();
  const storageKey = `apiKey_${selectedModel}`;
  const { [storageKey]: apiKey } = await chrome.storage.local.get(storageKey);
  if (!apiKey || apiKey.length === 0) {
    showError('Please save your API key in Settings before scanning.');
    return;
  }

  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    showError('No active tab found.');
    return;
  }

  // Verify the tab is a Moodle page
  if (!tab.url || !tab.url.includes('moodle.huji.ac.il')) {
    showError('Please navigate to a Moodle forum page on moodle.huji.ac.il before scanning.');
    return;
  }

  setScanLoading(true);
  showStatus(elements.scanStatus, 'Extracting forum posts...', 'info');

  try {
    // Inject content script and extract posts
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractForumPosts
    });

    console.log('[Tzar popup] executeScript raw results:', results);
    const posts = results[0]?.result;
    console.log('[Tzar popup] posts received:', posts);

    if (!posts || posts.length === 0) {
      showStatus(elements.scanStatus, 'No forum posts found on this page.', 'error');
      setScanLoading(false);
      return;
    }

    showStatus(elements.scanStatus, `Found ${posts.length} posts. Analyzing with AI...`, 'info');

    // Send posts to background script for AI analysis
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

async function handleModelChange(event) {
  const selectedModel = event.target.value;
  const { apiKey_anthropic, apiKey_openai, apiKey_gemini } = await chrome.storage.local.get(['apiKey_anthropic', 'apiKey_openai', 'apiKey_gemini']);
  updateApiKeyInputForModel(selectedModel, { apiKey_anthropic, apiKey_openai, apiKey_gemini });
  showStatus(elements.apiKeyStatus, '', ''); // Clear status when model changes
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

// This function is injected into the Moodle page to extract forum posts.
// It is async: when on a discussion-list page it fetches each discussion to get the real message body.
async function extractForumPosts() {
  console.log('[Tzar] extractForumPosts started, URL:', location.href);
  const posts = [];
  const seenKeys = new Set();

  try {

  const AUTHOR_SELECTORS = [
    'a[data-userid]',
    '.author-info a',
    '.author-info .d-flex a',
    '.postprofile .author a',
    '.forumng-author a',
    '.forumng-name a',
    '.author a',
    '.posting-author a',
    'a[href*="user/view.php"]',
    'h4 a',
    'a.d-inline-block',
  ];

  const CONTENT_SELECTORS = [
    '[data-region="post-content"]',
    '.post-content-container .text_to_html',
    '.forumng-message',
    '.forumng-post-content',
    '.text_to_html',
    '.posting',
    '.post-content',
    '.message',
    '.post-body',
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

  // Try reading posts directly from the current page (single-discussion view)
  for (const sel of [
    'article.forum-post-container', 'article[data-post-id]',
    '[data-region="post"]',
    'div.forumpost',
    '.forumng-post',
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

  // If nothing found on the current page, check for a discussion-list page
  // where each row is discrow_<id> — fetch each discussion to get the real post body.
  const discussionRows = document.querySelectorAll('tr[id^="discrow_"]');
  console.log('[Tzar] discrow rows found:', discussionRows.length, '| direct posts found:', posts.length);

  if (discussionRows.length > 0 && posts.length === 0) {
    const origin = window.location.origin;

    const fetchPromises = Array.from(discussionRows).map(async row => {
      const idMatch = row.id.match(/discrow_(\d+)/);
      if (!idMatch) return null;
      const discussionId = idMatch[1];

      const authorEl = row.querySelector('a[href*="user/view.php"], td.author a, .author a');
      const author = authorEl ? authorEl.textContent.trim() : null;

      // Get the discuss URL directly from the topic link in the row — handles
      // any module path (forumng vs forum) and any URL prefix (e.g. /2025-26/).
      const topicLinkEl = row.querySelector('a[href*="discuss.php"]');
      const discussUrl = topicLinkEl ? topicLinkEl.href : null;
      console.log(`[Tzar] Processing discrow ${discussionId}, author:`, author, '| discussUrl:', discussUrl);
      if (!author || !discussUrl) return null;

      try {
        const resp = await fetch(discussUrl);
        console.log(`[Tzar] fetch discuss.php?d=${discussionId} → status`, resp.status, resp.url);
        if (!resp.ok) return null;
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        let contentEl = null;
        for (const sel of CONTENT_SELECTORS) {
          contentEl = doc.querySelector(sel);
          if (contentEl) {
            console.log(`[Tzar] d=${discussionId} matched content selector: "${sel}"`);
            break;
          }
        }
        if (!contentEl) {
          console.log(`[Tzar] d=${discussionId} — no content selector matched. Body snippet:`, doc.body?.innerHTML?.substring(0, 300));
          return null;
        }

        const content = contentEl.textContent.trim();
        console.log(`[Tzar] d=${discussionId} content preview:`, content.substring(0, 100));
        if (!content) return null;

        return { author, content, postId: row.id };
      } catch (e) {
        console.error(`[Tzar] fetch error for discrow ${discussionId}:`, e);
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

    console.log('[Tzar] extractForumPosts final count:', posts.length);
    return posts;
  } catch (err) {
    console.error('[Tzar] UNCAUGHT ERROR in extractForumPosts:', err);
    return [];
  }
}

// This function is injected into the Moodle page to get the course URL
function getMoodleCourseUrl() {
  // Try to find the course link in the breadcrumbs
  const breadcrumbCourseLink = document.querySelector('.breadcrumb li:nth-child(3) a');
  if (breadcrumbCourseLink && breadcrumbCourseLink.href) {
    return breadcrumbCourseLink.href;
  }

  // Fallback: try to parse from current URL if it's a known Moodle module page
  const url = window.location.href;
  const courseIdMatch = url.match(/course\/view\.php\?id=(\d+)/);
  if (courseIdMatch) {
    return `${window.location.origin}/course/view.php?id=${courseIdMatch[1]}`;
  }

  // If not found via breadcrumbs or direct course ID in URL, return null.
  // More complex heuristics for finding course ID from module pages are prone to breaking.
  return null;
}

// This function is injected into a Moodle course page to find an assignment and navigate to its grading page
async function findAssignmentAndNavigateToGrading(assignmentName) {
  // Helper: wait for an element to appear in the DOM
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for element: ${selector}`));
      }, timeout);
    });
  }

  try {
    // Wait for the page to fully load (e.g., body element to be present)
    await waitForElement('body', 15000);

    const assignmentLinks = document.querySelectorAll('a[href*="mod/assign/view.php"]');
    let targetAssignmentLink = null;
    const normalizedAssignmentName = assignmentName ? assignmentName.toLowerCase().trim() : '';

    for (const link of assignmentLinks) {
      const linkText = link.textContent.toLowerCase().trim();
      // Check for exact match or if the link text contains the assignment name
      if (linkText === normalizedAssignmentName || (normalizedAssignmentName && linkText.includes(normalizedAssignmentName))) {
        targetAssignmentLink = link;
        break;
      }
    }

    if (!targetAssignmentLink) {
      return { success: false, error: `Could not find assignment link for "${assignmentName}".` };
    }

    // Navigate to the grading page for this assignment
    const gradingUrl = new URL(targetAssignmentLink.href);
    gradingUrl.searchParams.set('action', 'grading');
    window.location.href = gradingUrl.toString();

    // Wait for the navigation to complete and the grading table to appear
    await waitForElement('.gradingtable table, .generaltable', 15000);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// This function is injected into the Moodle forum page to reply to a student's post
async function automateForumReply(studentName, requestedDays, postId, replyMessageTemplate) {
  // Helper: wait for an element to appear in the DOM
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for element: ${selector}`));
      }, timeout);
    });
  }

  // Helper: wait a set amount of time
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  try {
    // 1. Find the student's post element using postId
    const postElement = await waitForElement(`[data-post-id="${postId}"], #${postId}`, 10000);
    if (!postElement) {
      return { success: false, error: `Could not find forum post with ID: ${postId}` };
    }

    // 2. Find and click the "Reply" button/link within that post
    const replyButton = postElement.querySelector('a[data-action="reply"], .reply-link, .forum-post-reply');
    if (!replyButton) {
      return { success: false, error: `Could not find reply button for post ID: ${postId}` };
    }

    replyButton.click();
    await delay(1500); // Give time for the reply form/editor to load

    // 3. Wait for the editor to load and insert the message
    let editorInput = null;
    try {
      // Try for Atto editor (textarea with specific class/id)
      editorInput = await waitForElement('textarea.editor_atto_content, textarea[id*="id_message"]', 3000);
    } catch (e) {
      // If Atto not found, try for TinyMCE iframe
      const iframe = await waitForElement('iframe.cke_wysiwyg_frame, iframe[id*="id_message_ifr"]', 3000).catch(() => null);
      if (iframe && iframe.contentDocument) {
        editorInput = iframe.contentDocument.querySelector('body.cke_editable');
      }
    }

    if (!editorInput) {
      return { success: false, error: 'Could not find the forum reply editor.' };
    }

    // Construct the reply message
    const replyMessage = replyMessageTemplate
      .replace('{studentName}', studentName)
      .replace('{requestedDays}', requestedDays);

    // Set the content based on editor type
    if (editorInput.tagName === 'TEXTAREA') {
      editorInput.value = replyMessage;
      editorInput.dispatchEvent(new Event('input', { bubbles: true }));
      editorInput.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (editorInput.isContentEditable) { // For TinyMCE body
      editorInput.innerHTML = `<p>${replyMessage}</p>`;
      editorInput.dispatchEvent(new Event('input', { bubbles: true }));
      editorInput.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      return { success: false, error: 'Unsupported editor type.' };
    }

    await delay(500);

    // 4. Find and click the "Post to forum" or "Submit" button
    const submitButton = document.querySelector(
      'input[type="submit"][value*="Post to forum"], ' +
      'button[type="submit"][name="submitbutton"], ' +
      'input[type="submit"][value*="שלח לפורום"]' // Hebrew translation for "Post to forum"
    );

    if (!submitButton) {
      return { success: false, error: 'Could not find the "Post to forum" button.' };
    }

    submitButton.click();
    await delay(2000); // Wait for submission to process

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
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

    const card = document.createElement('div');
    card.className = 'request-card';
    card.dataset.index = index;

    card.innerHTML = `
      <div class="student-name">${escapeHtml(request.studentName)}</div>
      ${request.assignmentName
        ? `<div class="assignment-name">Assignment: ${escapeHtml(request.assignmentName)}</div>`
        : '<div class="assignment-name">Assignment: Not specified</div>'
      }
      <span class="requested-days">${request.requestedDays} day(s) extension</span>
      <div class="actions" data-index="${index}">
        <button class="btn btn-approve" data-action="approve" data-index="${index}">Approve</button>
        <button class="btn btn-reject" data-action="reject" data-index="${index}">Reject</button>
      </div>
    `;

    // Bind action buttons
    card.querySelector('[data-action="approve"]').addEventListener('click', () => handleApprove(index));
    card.querySelector('[data-action="reject"]').addEventListener('click', () => handleReject(index));

    // Store postId in the request object for later use in reply automation
    request.postId = request.postId || card.dataset.postId; // Assuming postId is available from extractForumPosts
    elements.requestsList.appendChild(card);
  });

  // Update count to only show extension requests
  const extensionCount = extensionRequests.filter(r => r.wantsExtension).length;
  elements.requestCount.textContent = extensionCount;
}

// ---- Actions ----

async function handleApprove(index) {
  const request = extensionRequests[index];
  const card = elements.requestsList.querySelector(`[data-index="${index}"]`);
  const actionsDiv = card.querySelector('.actions');

  // Replace actions with processing status
  actionsDiv.innerHTML = '<span class="status-label processing">Processing...</span>';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Inject the automation script into the active Moodle tab
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: automateGrantExtension,
      args: [request.studentName, request.requestedDays, request.assignmentName]
    });

    const result = results[0]?.result;

    if (result && result.success) {
      actionsDiv.innerHTML = '<span class="status-label approved">Approved</span>';
    } else {
      const msg = result?.error || 'Automation failed.';
      actionsDiv.innerHTML = `<span class="status-label rejected">Failed: ${escapeHtml(msg)}</span>`;
    }
  } catch (err) {
    actionsDiv.innerHTML = `<span class="status-label rejected">Error: ${escapeHtml(err.message)}</span>`;
  }
}

function handleReject(index) {
  const card = elements.requestsList.querySelector(`[data-index="${index}"]`);
  const actionsDiv = card.querySelector('.actions');
  actionsDiv.innerHTML = '<span class="status-label rejected">Rejected</span>';
}

// This function is injected into the Moodle page to automate granting an extension
function automateGrantExtension(studentName, requestedDays, assignmentName) {
  // Helper: wait for an element to appear in the DOM
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for element: ${selector}`));
      }, timeout);
    });
  }

  // Helper: wait a set amount of time
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Helper: compute the target date from today + requestedDays
  function computeTargetDate(days) {
    const target = new Date();
    target.setDate(target.getDate() + days);
    return {
      day: target.getDate(),
      month: target.getMonth() + 1,
      year: target.getFullYear(),
      hour: 23,
      minute: 59
    };
  }

  // Main automation logic
  async function run() {
    try {
      // Step 1: Ensure we are on a grading page by waiting for the grading table
      // This function is injected after navigation to the grading page, so the table should exist.
      await waitForElement('.gradingtable table, .generaltable', 15000);

      // Step 2: Find the student row in the grading table
      const rows = document.querySelectorAll('tr');
      let studentRow = null;
      const normalizedTarget = studentName.toLowerCase().trim();

      for (const row of rows) {
        const nameCell = row.querySelector('td a, td .fullname');
        if (nameCell) {
          const rowName = nameCell.textContent.trim().toLowerCase();
          if (rowName.includes(normalizedTarget) || normalizedTarget.includes(rowName)) {
            studentRow = row;
            break;
          }
        }
      }

      if (!studentRow) {
        return { success: false, error: `Could not find student "${studentName}" in the grading table.` };
      }

      // Step 3: Find and click the "Edit" dropdown or link for this student
      const editLink = studentRow.querySelector('a[data-toggle="dropdown"], a.dropdown-toggle, .action-menu a');
      if (editLink) {
        editLink.click();
        await delay(500);
      }

      // Step 4: Look for "Grant extension" link
      const grantLinks = document.querySelectorAll('a[href*="grantext"], a[data-action="grantext"]');
      let grantLink = null;

      for (const link of grantLinks) {
        const text = link.textContent.toLowerCase();
        if (text.includes('grant extension') || text.includes('extension')) {
          grantLink = link;
          break;
        }
      }

      // Also try looking in the dropdown menu
      if (!grantLink) {
        const menuLinks = document.querySelectorAll('.dropdown-menu a, .action-menu-item a');
        for (const link of menuLinks) {
          const text = link.textContent.toLowerCase();
          if (text.includes('grant extension') || text.includes('extension')) {
            grantLink = link;
            break;
          }
        }
      }

      if (!grantLink) {
        return { success: false, error: 'Could not find "Grant extension" option. Make sure you are on the assignment grading page.' };
      }

      grantLink.click();
      await delay(1000);

      // Step 5: Fill in the extension date form
      const targetDate = computeTargetDate(requestedDays);

      // Try the date picker approach for Moodle's date selector
      // Moodle typically uses select dropdowns for day, month, year, hour, minute
      const dateSelectors = {
        day: document.querySelector('select[name*="extensionduedate[day]"], select[id*="extensionduedate_day"]'),
        month: document.querySelector('select[name*="extensionduedate[month]"], select[id*="extensionduedate_month"]'),
        year: document.querySelector('select[name*="extensionduedate[year]"], select[id*="extensionduedate_year"]'),
        hour: document.querySelector('select[name*="extensionduedate[hour]"], select[id*="extensionduedate_hour"]'),
        minute: document.querySelector('select[name*="extensionduedate[minute]"], select[id*="extensionduedate_minute"]')
      };

      // Check if Moodle uses the enable checkbox for extension date
      const enableCheckbox = document.querySelector(
        'input[name*="extensionduedate[enabled]"], input[id*="extensionduedate_enabled"]'
      );
      if (enableCheckbox && !enableCheckbox.checked) {
        enableCheckbox.click();
        await delay(300);
      }

      if (dateSelectors.day && dateSelectors.month && dateSelectors.year) {
        dateSelectors.day.value = targetDate.day;
        dateSelectors.day.dispatchEvent(new Event('change', { bubbles: true }));

        dateSelectors.month.value = targetDate.month;
        dateSelectors.month.dispatchEvent(new Event('change', { bubbles: true }));

        dateSelectors.year.value = targetDate.year;
        dateSelectors.year.dispatchEvent(new Event('change', { bubbles: true }));

        if (dateSelectors.hour) {
          dateSelectors.hour.value = targetDate.hour;
          dateSelectors.hour.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if (dateSelectors.minute) {
          dateSelectors.minute.value = targetDate.minute;
          dateSelectors.minute.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else {
        // Fallback: try a standard date input field
        const dateInput = await waitForElement(
          'input[name*="extensionduedate"], input[type="date"][id*="extension"]',
          5000
        ).catch(() => null);

        if (dateInput) {
          const dateStr = `${targetDate.year}-${String(targetDate.month).padStart(2, '0')}-${String(targetDate.day).padStart(2, '0')}`;
          dateInput.value = dateStr;
          dateInput.dispatchEvent(new Event('input', { bubbles: true }));
          dateInput.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          return { success: false, error: 'Could not find extension date fields.' };
        }
      }

      await delay(300);

      // Step 6: Click "Save changes"
      const submitButtons = document.querySelectorAll('input[type="submit"], button[type="submit"]');
      let saveButton = null;
      for (const btn of submitButtons) {
        const val = (btn.value || btn.textContent || '').toLowerCase();
        if (val.includes('save')) {
          saveButton = btn;
          break;
        }
      }

      if (!saveButton) {
        return { success: false, error: 'Could not find "Save changes" button.' };
      }

      saveButton.click();
      await delay(1000);

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return run();
}

// ---- UI Helpers ----

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
