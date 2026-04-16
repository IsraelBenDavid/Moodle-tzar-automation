// ============================================
// Moodle Extension Tzar - Popup Script
// ============================================

document.addEventListener('DOMContentLoaded', init);

// State
let extensionRequests = [];

// DOM references
const elements = {};

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
  elements.requestsList = document.getElementById('requests-list');
  elements.requestCount = document.getElementById('request-count');
  elements.errorBanner = document.getElementById('error-banner');
}

function bindEvents() {
  elements.saveApiKeyBtn.addEventListener('click', saveApiKey);
  elements.toggleKeyBtn.addEventListener('click', toggleKeyVisibility);
  elements.settingsToggle.addEventListener('click', toggleSettings);
  elements.scanForumBtn.addEventListener('click', scanForum);
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

async function loadSavedApiKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (apiKey) {
    elements.apiKeyInput.value = apiKey;
    showStatus(elements.apiKeyStatus, 'API key loaded.', 'success');
    // Collapse settings if key already exists
    elements.settingsBody.classList.add('collapsed');
    elements.settingsIcon.classList.add('collapsed');
  }
}

async function saveApiKey() {
  const key = elements.apiKeyInput.value.trim();
  if (!key) {
    showStatus(elements.apiKeyStatus, 'Please enter a valid API key.', 'error');
    return;
  }
  await chrome.storage.local.set({ apiKey: key });
  showStatus(elements.apiKeyStatus, 'API key saved successfully.', 'success');
}

// ---- Forum Scanning ----

async function scanForum() {
  hideError();

  // Validate API key is saved
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
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

    const posts = results[0]?.result;
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
      apiKey: apiKey
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

// This function is injected into the Moodle page to extract forum posts
function extractForumPosts() {
  const posts = [];

  // Strategy 1: Modern Moodle forum post containers
  const articlePosts = document.querySelectorAll('article.forum-post-container');
  for (const article of articlePosts) {
    const authorEl = article.querySelector('.author-info .d-flex a, .postprofile .author a, a.d-inline-block');
    const contentEl = article.querySelector('.post-content-container .text_to_html, .posting, .text_to_html');
    if (authorEl && contentEl) {
      posts.push({
        author: authorEl.textContent.trim(),
        content: contentEl.textContent.trim(),
        postId: article.getAttribute('data-post-id') || article.id || null
      });
    }
  }

  // Strategy 2: Legacy Moodle forum post divs
  if (posts.length === 0) {
    const divPosts = document.querySelectorAll('div.forumpost');
    for (const div of divPosts) {
      const authorEl = div.querySelector('.author a, .posting-author a');
      const contentEl = div.querySelector('.posting, .text_to_html, .content .posting');
      if (authorEl && contentEl) {
        posts.push({
          author: authorEl.textContent.trim(),
          content: contentEl.textContent.trim(),
          postId: div.id || null
        });
      }
    }
  }

  // Strategy 3: Generic discussion posts
  if (posts.length === 0) {
    const genericPosts = document.querySelectorAll('[data-region="post"], .discussion-post');
    for (const post of genericPosts) {
      const authorEl = post.querySelector('a[data-userid], .author a, h4 a');
      const contentEl = post.querySelector('[data-region="post-content"], .post-content, .text_to_html');
      if (authorEl && contentEl) {
        posts.push({
          author: authorEl.textContent.trim(),
          content: contentEl.textContent.trim(),
          postId: post.getAttribute('data-post-id') || post.id || null
        });
      }
    }
  }

  return posts;
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
      // Step 1: Look for the grading table or participant list
      const gradingTable = document.querySelector('.gradingtable table, .generaltable');
      if (!gradingTable) {
        // Try to find the assignment link to navigate to the grading page
        const assignLinks = document.querySelectorAll('a[href*="mod/assign/view.php"]');
        if (assignLinks.length === 0) {
          return { success: false, error: 'Could not find grading table or assignment link on this page. Navigate to the assignment grading page first.' };
        }
      }

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
