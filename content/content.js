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

    // Strategy 1: Modern Moodle forum post containers (article elements)
    const articlePosts = document.querySelectorAll('article.forum-post-container');
    for (const article of articlePosts) {
      const post = extractFromArticle(article);
      if (post) posts.push(post);
    }

    // Strategy 2: Legacy Moodle forum post divs
    if (posts.length === 0) {
      const divPosts = document.querySelectorAll('div.forumpost');
      for (const div of divPosts) {
        const post = extractFromDiv(div);
        if (post) posts.push(post);
      }
    }

    // Strategy 3: Generic discussion posts with data attributes
    if (posts.length === 0) {
      const genericPosts = document.querySelectorAll('[data-region="post"], .discussion-post');
      for (const el of genericPosts) {
        const post = extractFromGeneric(el);
        if (post) posts.push(post);
      }
    }

    return posts;
  }

  function extractFromArticle(article) {
    const authorEl = article.querySelector(
      '.author-info .d-flex a, .postprofile .author a, a.d-inline-block'
    );
    const contentEl = article.querySelector(
      '.post-content-container .text_to_html, .posting, .text_to_html'
    );
    if (!authorEl || !contentEl) return null;
    return {
      author: authorEl.textContent.trim(),
      content: contentEl.textContent.trim(),
      postId: article.getAttribute('data-post-id') || article.id || null
    };
  }

  function extractFromDiv(div) {
    const authorEl = div.querySelector('.author a, .posting-author a');
    const contentEl = div.querySelector('.posting, .text_to_html, .content .posting');
    if (!authorEl || !contentEl) return null;
    return {
      author: authorEl.textContent.trim(),
      content: contentEl.textContent.trim(),
      postId: div.id || null
    };
  }

  function extractFromGeneric(el) {
    const authorEl = el.querySelector('a[data-userid], .author a, h4 a');
    const contentEl = el.querySelector(
      '[data-region="post-content"], .post-content, .text_to_html'
    );
    if (!authorEl || !contentEl) return null;
    return {
      author: authorEl.textContent.trim(),
      content: contentEl.textContent.trim(),
      postId: el.getAttribute('data-post-id') || el.id || null
    };
  }

  // Detect what type of Moodle page we are on
  function detectPageType() {
    const url = window.location.href;
    if (url.includes('/mod/forum/')) return 'forum';
    if (url.includes('/mod/assign/view.php')) return 'assignment';
    if (url.includes('/grade/')) return 'grading';
    if (url.includes('/course/view.php')) return 'course';
    return 'unknown';
  }
})();
