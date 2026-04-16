// ============================================
// Moodle Extension Tzar - Content Script
// ============================================
// This content script runs on moodle.huji.ac.il pages.
// It provides utility functions for interacting with the Moodle DOM
// and listens for messages from the popup/background scripts.

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__moodleExtensionTzarLoaded) return;
  window.__moodleExtensionTzarLoaded = true;

  // Listen for messages from the extension
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'EXTRACT_POSTS':
        sendResponse({ posts: extractForumPosts() });
        break;

      case 'CHECK_PAGE_TYPE':
        sendResponse({ pageType: detectPageType() });
        break;

      case 'PING':
        sendResponse({ status: 'ok' });
        break;

      default:
        sendResponse({ error: 'Unknown message type.' });
    }
  });

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

  // Extract forum posts from the current page
  function extractForumPosts() {
    const posts = [];
    const seenKeys = new Set();

    const POST_CONTAINER_SELECTORS = [
      'article.forum-post-container',
      'article[data-post-id]',
      '[data-region="post"]',
      'div.forumpost',
      '.forumng-post',
      'li.post',
      'li.forumpost',
      'li.discussion-post',
    ];

    for (const containerSel of POST_CONTAINER_SELECTORS) {
      document.querySelectorAll(containerSel).forEach(postEl => {
        const post = extractPostData(postEl);
        if (!post) return;
        const key = post.postId || (post.author + '|' + post.content).substring(0, 100);
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        posts.push(post);
      });
    }

    // Fallback: elements with numeric post IDs like id="p12345"
    if (posts.length === 0) {
      document.querySelectorAll('div[id^="p"], article[id^="p"]').forEach(postEl => {
        if (!/^p\d+$/.test(postEl.id)) return;
        const post = extractPostData(postEl);
        if (!post) return;
        const key = post.postId || postEl.id;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        posts.push(post);
      });
    }

    return posts;
  }

  // A robust extraction function that checks multiple possible CSS selectors
  function extractPostData(postEl) {
    let authorEl = null;
    for (const sel of AUTHOR_SELECTORS) {
      try { authorEl = postEl.querySelector(sel); } catch (e) { continue; }
      if (authorEl) break;
    }

    let contentEl = null;
    for (const sel of CONTENT_SELECTORS) {
      try { contentEl = postEl.querySelector(sel); } catch (e) { continue; }
      if (contentEl) break;
    }

    if (!authorEl || !contentEl) return null;

    const author = authorEl.textContent.trim();
    const content = contentEl.textContent.trim();
    if (!author || !content) return null;

    return {
      author,
      content,
      postId: postEl.getAttribute('data-post-id') || postEl.id || null
    };
  }

  // Detect what type of Moodle page we are on
  function detectPageType() {
    const url = window.location.href;
    // Check for both standard forum and forumng
    if (url.includes('/mod/forum/') || url.includes('/mod/forumng/')) return 'forum';
    if (url.includes('/mod/assign/view.php')) return 'assignment';
    if (url.includes('/grade/')) return 'grading';
    if (url.includes('/course/view.php')) return 'course';
    return 'unknown';
  }
})();