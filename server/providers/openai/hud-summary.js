import { keylessHudSummaryResponse } from '../../../src/hudSummaryResponse.js';
import { enforceOptInRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import { OPENAI_HUD_SUMMARY_MODEL_DEFAULT } from './constants.js';

function extractOpenAiResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

async function handleHudSummary(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // GEV_HUD_LLM_BASE_URL sends the summary to any OpenAI-compatible chat-completions
  // API with its own key. OPENAI_API_KEY then serves only OpenAI Realtime voice.
  const llmBaseUrl = process.env.GEV_HUD_LLM_BASE_URL;
  const apiKey = llmBaseUrl
    ? process.env.GEV_HUD_LLM_API_KEY
    : process.env.OPENAI_API_KEY;
  const keyless = keylessHudSummaryResponse(apiKey);
  if (keyless) {
    res.statusCode = keyless.statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(keyless.payload));
    return;
  }

  // Opt-in per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). Keyless HUD
  // fallback has no provider cost and resolves above without consuming a
  // paid-endpoint quota slot.
  if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

  try {
    const body = await readRequestBody(req, 64 * 1024);
    const context = JSON.parse(body || '{}');
    const model =
      process.env.OPENAI_HUD_SUMMARY_MODEL || OPENAI_HUD_SUMMARY_MODEL_DEFAULT;
    const instructions = [
      "Write one concise intelligence-HUD summary for God's Eye View.",
      'Use only the supplied place, street, nearby-place, and enabled-layer text labels.',
      'Prefer the clearest named place and include a relevant enabled layer only when useful.',
      'Do not infer from coordinates or invent a place.',
      'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
    ].join(' ');
    const response = llmBaseUrl
      ? await fetch(`${llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            // OpenCode Go refuses requests without a session id.
            'x-opencode-session': 'gods-eye-view',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: instructions },
              { role: 'user', content: JSON.stringify(context) },
            ],
            // Reasoning models spend tokens before the answer.
            max_tokens: 400,
          }),
        })
      : await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            instructions,
            input: JSON.stringify(context),
            reasoning: { effort: 'minimal' },
            max_output_tokens: 100,
          }),
        });
    const data = await response.json().catch(() => ({}));
    const summary = toFiveWordHudSummary(
      llmBaseUrl
        ? data?.choices?.[0]?.message?.content
        : extractOpenAiResponseText(data),
    );
    res.statusCode = response.ok && summary ? 200 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        summary: summary || null,
        error: response.ok
          ? null
          : data.error?.message || 'OpenAI HUD summary request failed',
      }),
    );
  } catch (error) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: error?.message || 'OpenAI HUD summary request failed',
      }),
    );
  }
}

export { handleHudSummary };
