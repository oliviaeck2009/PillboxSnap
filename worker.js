const MAX_IMAGE_BYTES = 5000000;   // about 5 MB per photo
const DEFAULT_DAILY_LIMIT = 25;

const CLAUDE_MODEL = 'claude-sonnet-4-6';

const VALID_UNCERTAIN_IDS = [
  'field-group-name', 'field-group-generic-for', 'field-group-strength',
  'field-group-form', 'field-group-days', 'field-group-dailycount',
  'field-group-quantity', 'field-group-notes'
];

const EXTRACTION_SYSTEM_PROMPT = `You read one or more photographs of the same prescription medication bottle and extract structured information from its label. You are supporting a medication-management app used by families, including older adults managing their own medications — accuracy and honest uncertainty matter more than a confident-looking guess.

You may be given anywhere from one to four photos. When there is more than one, they are different angles of the exact same physical bottle — the label wraps around a curved surface, so no single angle may show the whole thing. Treat every photo together as one combined view of one label, describing one single medication — never as separate or additional medications. If a piece of text is cut off, distorted, or glare-covered in one photo but clearly readable in another, use the clear one; if no photo shows a given piece of text clearly, treat it as not visible at all rather than guessing from a partial or distorted view of it.

Respond with ONLY a single JSON object, no prose before or after it, matching exactly this shape:

{
  "readable": true or false,
  "name": string (the medication's brand or generic name as printed),
  "genericFor": string (if the label names a brand name this is generic for, or a generic name the label gives a brand for; empty string if not applicable or not stated),
  "strength": string (the numeric strength only, e.g. "600", "10"),
  "unit": "MG" or "Other",
  "unitOther": string (only if unit is "Other" — the actual unit as printed, e.g. "MCG", "ML"),
  "form": "Tablet" or "Capsule" or "Other",
  "formOther": string (only if form is "Other" — the actual form as printed, e.g. "Liquid", "Patch"),
  "quantity": string (how many of the form are taken per dose, e.g. "1", "2"),
  "howOften": "every-day" or "every-other-day" or "specific-days" or "as-needed",
  "dailyCount": number (how many times per day — use 1 if the label's instructions don't clearly state a daily frequency, such as for "as-needed"),
  "notes": string (the label's own instructions, in the label's own wording, e.g. "Take 1 tablet by mouth 3 times a day with food"),
  "uncertain": array of strings (zero or more of: ${VALID_UNCERTAIN_IDS.map(id => `"${id}"`).join(', ')} — include a field's id ONLY if you are genuinely not confident in that specific field, due to blur, glare, small print, or ambiguous wording; an empty array means you are confident in every field)
}

Rules:
- If "howOften" is not clearly "every-other-day", "specific-days", or "as-needed" from the label's own wording, default to "every-day" and add "field-group-days" to "uncertain" rather than guessing at a specific unusual schedule.
- If the photo is too blurry, too dark, at too sharp an angle, or otherwise genuinely unreadable as a whole — not just one field, but the label as a whole — set "readable" to false. When "readable" is false, all other fields may be empty strings or best guesses; the client will not use them.
- Never fabricate a value you cannot actually see on the label. An empty string or a conservative default plus an "uncertain" flag is always better than a confident wrong answer.
- Output ONLY the JSON object. No markdown code fences, no explanation.`;

async function readLabelWithClaude(images, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ readable: false, reason: 'not_configured' });
  }

  const imageBlocks = [];
  for (const img of images) {
    if (!img || !img.data) {
      return jsonResponse({ readable: false, reason: 'bad_request' }, 400);
    }
    imageBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.data }
    });
  }

  const promptText = images.length === 1
    ? 'Read this prescription label and return the JSON object described in your instructions.'
    : `These ${images.length} photos are different angles of the same bottle. Read the label across all of them together and return the JSON object described in your instructions.`;

  let claudeResponse;
  try {
    claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [...imageBlocks, { type: 'text', text: promptText }]
        }]
      })
    });
  } catch (err) {
    // Network-level failure reaching Claude at all — same safe fallback.
    return jsonResponse({ readable: false, reason: 'network_error' });
  }

  if (!claudeResponse.ok) {
    return jsonResponse({ readable: false, reason: 'api_error' });
  }

  let claudeData;
  try {
    claudeData = await claudeResponse.json();
  } catch (err) {
    return jsonResponse({ readable: false, reason: 'bad_api_response' });
  }

  const textBlock = (claudeData.content || []).find(b => b.type === 'text');
  if (!textBlock) {
    return jsonResponse({ readable: false, reason: 'bad_api_response' });
  }

  let parsed;
  try {

    const cleaned = textBlock.text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return jsonResponse({ readable: false, reason: 'unparseable' });
  }

  return jsonResponse(sanitizeResult(parsed));
}

function sanitizeResult(r){
  const str = v => (typeof v === 'string' ? v : '');
  const oneOf = (v, options, fallback) => options.includes(v) ? v : fallback;
  return {
    readable: r.readable !== false,
    name: str(r.name),
    genericFor: str(r.genericFor),
    strength: str(r.strength),
    unit: oneOf(r.unit, ['MG', 'Other'], 'MG'),
    unitOther: str(r.unitOther),
    form: oneOf(r.form, ['Tablet', 'Capsule', 'Other'], 'Tablet'),
    formOther: str(r.formOther),
    quantity: str(r.quantity) || '1',
    howOften: oneOf(r.howOften, ['every-day', 'every-other-day', 'specific-days', 'as-needed'], 'every-day'),
    dailyCount: (typeof r.dailyCount === 'number' && r.dailyCount > 0) ? Math.round(r.dailyCount) : 1,
    notes: str(r.notes),
    uncertain: Array.isArray(r.uncertain) ? r.uncertain.filter(id => VALID_UNCERTAIN_IDS.includes(id)) : []
  };
}

function jsonResponse(obj, status){
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function failure(reason) {
  return jsonResponse({ readable: false, reason: reason });
}

function tokenOk(request, env) {
  const expected = env.APP_TOKEN;
  const given = request.headers.get('X-App-Token');
  if (!expected || !given) return false;
  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

function isJpeg(buffer) {
  const b = new Uint8Array(buffer);
  return b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
}

function dailyLimit(env) {
  const n = parseInt(env.DAILY_LIMIT, 10);
  return (Number.isFinite(n) && n >= 0) ? n : DEFAULT_DAILY_LIMIT;
}

async function takeDailyUse(env) {
  if (!env.LABEL_PHOTOS) return null;
  const key = 'cap/' + new Date().toISOString().slice(0, 10);   // UTC day
  const used = parseInt(await env.LABEL_PHOTOS.get(key), 10) || 0;
  if (used >= dailyLimit(env)) return false;
  await env.LABEL_PHOTOS.put(key, String(used + 1), { expirationTtl: 172800 });
  return true;
}

async function readImageBody(request) {
  const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declared > MAX_IMAGE_BYTES) return { error: 'too_large' };
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return { error: 'empty' };
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { error: 'too_large' };
  if (!isJpeg(bytes)) return { error: 'invalid_image' };
  return { bytes: bytes };
}

// The app's real path: one photo in, structured medication JSON out.
async function handleReadOne(request, env) {
  if (!tokenOk(request, env)) return failure('unauthorized');
  const body = await readImageBody(request);
  if (body.error) return failure(body.error);
  if (!env.ANTHROPIC_API_KEY) return failure('not_configured');
  const allowed = await takeDailyUse(env);
  if (allowed === null) return failure('not_configured');
  if (!allowed) return failure('daily_limit');
  const images = [{ data: arrayBufferToBase64(body.bytes), mediaType: 'image/jpeg' }];
  return readLabelWithClaude(images, env);
}

// ---------------------------------------------------------------------
// Old four-photo. Not used by the app. Disabled unless the
// ENABLE_MULTI_PHOTO variable is exactly "true". Uses
// same token, size and daily-limit checks.
// ---------------------------------------------------------------------

function multiPhotoEnabled(env) {
  return env.ENABLE_MULTI_PHOTO === 'true';
}

function notFound() {
  return new Response('Not found.', { status: 404 });
}

async function handleUploadPhoto(request, env, session, position) {
  if (!tokenOk(request, env)) return failure('unauthorized');
  if (!env.LABEL_PHOTOS) return failure('not_configured');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(session || '')) return failure('bad_session');
  if (!['1', '2', '3', '4'].includes(position)) return failure('bad_position');
  const body = await readImageBody(request);
  if (body.error) return failure(body.error);
  await env.LABEL_PHOTOS.put(session + '/photo-' + position, body.bytes, { expirationTtl: 3600 });
  return jsonResponse({ received: true, bytes: body.bytes.byteLength });
}

async function handleReadFour(request, env, session) {
  if (!tokenOk(request, env)) return failure('unauthorized');
  if (!env.LABEL_PHOTOS) return failure('not_configured');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(session || '')) return failure('bad_session');
  const images = [];
  for (const n of ['1', '2', '3', '4']) {
    const photo = await env.LABEL_PHOTOS.get(session + '/photo-' + n, 'arrayBuffer');
    if (!photo) return failure('photos_missing');
    images.push({ data: arrayBufferToBase64(photo), mediaType: 'image/jpeg' });
  }
  if (!env.ANTHROPIC_API_KEY) return failure('not_configured');
  const allowed = await takeDailyUse(env);
  if (allowed === null) return failure('not_configured');
  if (!allowed) return failure('daily_limit');
  return readLabelWithClaude(images, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        return new Response('Label bridge is running.');
      }
      if (request.method === 'POST' && url.pathname === '/read-one-photo') {
        return await handleReadOne(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/upload-label-photo') {
        if (!multiPhotoEnabled(env)) return notFound();
        return await handleUploadPhoto(request, env, url.searchParams.get('session'), url.searchParams.get('position'));
      }
      if (request.method === 'POST' && url.pathname === '/read-label') {
        if (!multiPhotoEnabled(env)) return notFound();
        return await handleReadFour(request, env, url.searchParams.get('session'));
      }
      return notFound();
    } catch (error) {
      // Never expose internal error text to the app or a caller.
      return failure('server_error');
    }
  }
};

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize)
    );
  }

  return btoa(binary);
}
