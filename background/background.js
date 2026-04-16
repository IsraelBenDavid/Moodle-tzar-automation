// ============================================
// Moodle Extension Tzar - Background Service Worker
// ============================================

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = `Analyze the following Moodle forum posts. For each post, identify if the student is asking for an assignment extension. Return a JSON array with objects containing: 'studentName', 'wantsExtension' (boolean), 'requestedDays' (integer, default to 3 if unspecified), and 'assignmentName' (if mentioned).

Rules:
- Only return valid JSON, no markdown fences, no explanation.
- If a post is not related to requesting an extension, set wantsExtension to false.
- If the number of days is not specified, default to 3.
- If the assignment name is not mentioned, set assignmentName to null.
- Parse all posts even if some are not extension requests.`;

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYZE_POSTS') {
    analyzePosts(message.posts, message.apiKey)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    // Return true to indicate we will send a response asynchronously
    return true;
  }
});

async function analyzePosts(posts, apiKey) {
  if (!posts || posts.length === 0) {
    return { error: 'No posts to analyze.' };
  }

  if (!apiKey) {
    return { error: 'API key is missing. Please configure it in Settings.' };
  }

  // Format posts for the AI prompt
  const formattedPosts = posts.map((post, i) =>
    `Post ${i + 1}:\nAuthor: ${post.author}\nContent: ${post.content}`
  ).join('\n\n---\n\n');

  const userMessage = `Here are the forum posts to analyze:\n\n${formattedPosts}`;

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: userMessage }
        ]
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      if (response.status === 401) {
        return { error: 'Invalid API key. Please check your Anthropic API key in Settings.' };
      }
      if (response.status === 429) {
        return { error: 'API rate limit exceeded. Please wait and try again.' };
      }
      return { error: `API request failed (${response.status}): ${errBody}` };
    }

    const data = await response.json();

    // Extract the text content from the API response
    const textContent = data.content?.find(block => block.type === 'text');
    if (!textContent) {
      return { error: 'Unexpected API response format.' };
    }

    const rawText = textContent.text.trim();

    // Parse the JSON response, handling potential markdown code fences
    const jsonStr = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const requests = JSON.parse(jsonStr);

    if (!Array.isArray(requests)) {
      return { error: 'AI response was not a valid JSON array.' };
    }

    // Validate and normalize each request object
    const validatedRequests = requests.map(req => ({
      studentName: String(req.studentName || 'Unknown'),
      wantsExtension: Boolean(req.wantsExtension),
      requestedDays: Number.isInteger(req.requestedDays) ? req.requestedDays : 3,
      assignmentName: req.assignmentName || null
    }));

    return { requests: validatedRequests };
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { error: 'Failed to parse AI response as JSON. Please try scanning again.' };
    }
    return { error: `Analysis failed: ${err.message}` };
  }
}
