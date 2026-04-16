// ============================================
// Moodle Extension Tzar - Background Service Worker
// ============================================

// API Endpoints and Models
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o'; // Or gpt-3.5-turbo, gpt-4, etc.

const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `Analyze the following Moodle forum posts. Posts may be written in any language, including Hebrew (עברית). For each post, identify if the student is asking for an assignment extension (הארכה, דחייה, עוד זמן, יותר זמן, לדחות, להאריך, more time, delay, extension, etc.).

Return a JSON array with objects containing: 'studentName', 'wantsExtension' (boolean), 'requestedDays' (integer, default to 3 if unspecified), 'assignmentName' (string or null), and 'postId' (string or null).

Rules:
- Only return valid JSON, no markdown fences, no explanation.
- Be generous in detecting extension requests: if a student mentions difficulty submitting on time, needing more time, or asking to delay a deadline — set wantsExtension to true.
- If the number of days is not specified, default to 3.
- If the assignment name is not mentioned, set assignmentName to null.
- Parse ALL posts and include every post in the response array, even non-extension posts (set wantsExtension to false for those).
- Preserve the postId field from each post in the output.`;

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYZE_POSTS') {
    // The message should now include the chosen model and the corresponding API key
    analyzePosts(message.posts, message.modelChoice, message.apiKey)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    // Return true to indicate we will send a response asynchronously
    return true;
  }
});

async function analyzePosts(posts, modelChoice, apiKey) {
  if (!posts || posts.length === 0) {
    return { error: 'No posts to analyze.' };
  }

  if (!apiKey) {
    return { error: 'API key is missing. Please configure it in Settings.' };
  }

  if (!modelChoice) {
    return { error: 'AI model choice is missing.' };
  }

  // Format posts for the AI prompt
  const formattedPosts = posts.map((post, i) =>
    `Post ${i + 1}:\nAuthor: ${post.author}\nPostID: ${post.postId || 'none'}\nContent: ${post.content}`
  ).join('\n\n---\n\n');

  const userMessage = `Here are the forum posts to analyze:\n\n${formattedPosts}`;

  console.log('=== SYSTEM PROMPT ===');
  console.log(SYSTEM_PROMPT);
  console.log('=== USER MESSAGE ===');
  console.log(userMessage);
  console.log('=== END PROMPT ===');

  let apiUrl;
  let requestBody;
  let headers = {};
  let responseParser; // Function to extract the JSON string from the model's response

  switch (modelChoice) {
    case 'anthropic':
      apiUrl = ANTHROPIC_API_URL;
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      };
      requestBody = JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: userMessage }
        ]
      });
      responseParser = (data) => {
        const textContent = data.content?.find(block => block.type === 'text');
        if (!textContent) throw new Error('Unexpected Anthropic API response format.');
        const rawText = textContent.text.trim();
        // Anthropic might wrap JSON in markdown fences
        return rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      };
      break;

    case 'openai':
      apiUrl = OPENAI_API_URL;
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      };
      requestBody = JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage }
        ],
        max_tokens: 2048,
        response_format: { type: "json_object" } // Request JSON output
      });
      responseParser = (data) => {
        const content = data.choices[0]?.message?.content;
        if (!content) throw new Error('Unexpected OpenAI API response format.');
        return content;
      };
      break;

    case 'gemini':
      // Gemini API key is often passed as a query parameter for simple cases
      apiUrl = `${GEMINI_API_URL}?key=${apiKey}`;
      headers = {
        'Content-Type': 'application/json'
      };
      requestBody = JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: SYSTEM_PROMPT },
              { text: userMessage }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json", // Request JSON output
          maxOutputTokens: 2048
        }
      });
      responseParser = (data) => {
        const content = data.candidates[0]?.content?.parts[0]?.text;
        if (!content) throw new Error('Unexpected Gemini API response format.');
        return content;
      };
      break;

    default:
      return { error: `Unsupported AI model: ${modelChoice}` };
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: headers,
      body: requestBody
    });

    if (!response.ok) {
      const errBody = await response.text();
      if (response.status === 401) {
        return { error: `Invalid API key for ${modelChoice}. Please check your API key in Settings.` };
      }
      if (response.status === 429) {
        return { error: `API rate limit exceeded for ${modelChoice}. Please wait and try again.` };
      }
      return { error: `API request failed for ${modelChoice} (${response.status}): ${errBody}` };
    }

    const data = await response.json();
    const rawText = responseParser(data);
    console.log('=== AI RAW RESPONSE ===');
    console.log(rawText);
    console.log('=== END AI RESPONSE ===');
    const requests = JSON.parse(rawText); // Parse the extracted JSON string

    if (!Array.isArray(requests)) {
      return { error: 'AI response was not a valid JSON array.' };
    }

    // Validate and normalize each request object
    const validatedRequests = requests.map(req => ({
      studentName: String(req.studentName || 'Unknown'),
      wantsExtension: Boolean(req.wantsExtension),
      requestedDays: Number.isInteger(req.requestedDays) ? req.requestedDays : 3,
      assignmentName: req.assignmentName || null,
      postId: req.postId || null // Include postId from the original post if available
    }));

    return { requests: validatedRequests };
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { error: 'Failed to parse AI response as JSON. Please try scanning again.' };
    }
    return { error: `Analysis failed: ${err.message}` };
  }
}
