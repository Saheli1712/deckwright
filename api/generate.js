const MAX_PROMPT_LENGTH = 180_000;
const MAX_REQUEST_BYTES = 3_800_000;
const MAX_IMAGES = 5;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function respond(res, status, body) {
  res.status(status).json(body);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return respond(res, 405, { error: "Use POST to generate a deck." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return respond(res, 503, { error: "Deck generation is not configured yet. Add ANTHROPIC_API_KEY to the Vercel project." });
  }

  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host && new URL(origin).host !== host) {
    return respond(res, 403, { error: "Requests must come from the Deckwright site." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return respond(res, 400, { error: "The request body must be valid JSON." });
    }
  }

  const prompt = body?.prompt;
  const images = body?.images ?? [];
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) {
    return respond(res, 400, { error: "Add a prompt under 180,000 characters." });
  }
  if (!Array.isArray(images) || images.length > MAX_IMAGES) {
    return respond(res, 400, { error: `Attach no more than ${MAX_IMAGES} images.` });
  }
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_REQUEST_BYTES) {
    return respond(res, 413, { error: "The request is too large. Use fewer or smaller images." });
  }

  const content = [{ type: "text", text: prompt }];
  for (const image of images) {
    if (!IMAGE_TYPES.has(image?.mediaType) || typeof image.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
      return respond(res, 400, { error: "One of the attached images could not be read." });
    }
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data }
    });
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey
      },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        max_tokens: body.depth === "complex" ? 16_000 : 8_192,
        messages: [{ role: "user", content }]
      }),
      signal: AbortSignal.timeout(55_000)
    });
    const result = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      const status = upstream.status === 429 ? 429 : upstream.status === 529 ? 503 : 502;
      const error = upstream.status === 401
        ? "Anthropic did not accept this key. Use an API key from your Anthropic Console, not a Claude.ai login or subscription token."
        : upstream.status === 403
          ? "This Anthropic account or workspace is not allowed to use the API. Check API billing, credits, and project access in the Anthropic Console."
          : upstream.status === 429
          ? "The Claude API rate limit was reached. Wait a moment and try again."
          : "Claude could not complete this request. Try again in a moment.";
      return respond(res, status, { error });
    }

    const text = (result.content || []).filter(block => block.type === "text").map(block => block.text).join("\n");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) {
      return respond(res, 502, { error: "Claude returned an unreadable response. Please try again." });
    }

    const deckResponse = JSON.parse(text.slice(start, end + 1));
    if (!deckResponse || !["deck", "questions"].includes(deckResponse.mode)) {
      return respond(res, 502, { error: "Claude returned an unexpected response. Please try again." });
    }
    return respond(res, 200, deckResponse);
  } catch (error) {
    const message = error?.name === "TimeoutError"
      ? "Claude took too long to respond. Try a shorter brief or fewer slides."
      : "Could not reach the Claude API. Check the connection and try again.";
    return respond(res, 502, { error: message });
  }
};