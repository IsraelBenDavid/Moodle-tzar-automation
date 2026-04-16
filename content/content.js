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

  // Extract forum posts from the current page
  function extractForumPosts() {
    const posts = [];

    // Select all potential post containers on the page
    const postContainers = document.querySelectorAll(
      '.forumng-post, .forumpost, article.forum-post-container, [data-region="post"], .discussion-post'
    );
    
    for (const postEl of postContainers) {
        const post = extractPostData(postEl);
        if (post) {
            posts.push(post);
        }
    }

    return posts;
  }

  // A robust extraction function that checks multiple possible CSS selectors
  function extractPostData(postEl) {
    // Try multiple selectors for the author name (Standard Moodle + ForumNG)
    const authorEl = postEl.querySelector(
      '.forumng-author a, .forumng-name a, .author-info a, .author a, .posting-author a, h4 a, a[data-userid], a.d-inline-block'
    );
    
    // Try multiple selectors for the actual text content
    const contentEl = postEl.querySelector(
      '.forumng-message, .forumng-post-content, .post-content-container, .posting, .text_to_html, [data-region="post-content"]'
    );

    if (!authorEl || !contentEl) {
      return null;
    }

    return {
      author: authorEl.textContent.trim(),
      content: contentEl.textContent.trim(),
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