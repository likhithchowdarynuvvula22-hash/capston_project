/**
 * EduStar Backend — edustar-backend.mjs
 *
 * Architecture Overview:
 * ─────────────────────
 * This is a zero-dependency Node.js HTTP server that:
 *   1. Serves all static frontend assets (HTML, CSS, JS) directly.
 *   2. Exposes a REST JSON API for learner data persistence.
 *   3. Handles a minimal AI-tutor chat endpoint using keyword heuristics.
 *   4. Persists all data to a local SQLite database via the built-in
 *      `node:sqlite` module (available from Node 22.5+, no npm package needed).
 *
 * Design Decisions:
 * ─────────────────
 * • No frameworks (Express, Fastify, etc.) — keeps the dependency footprint
 *   at zero and makes the server trivially auditable.
 * • Device-ID based identity — every browser generates its own opaque ID
 *   stored in localStorage. No login, no passwords, no PII collection.
 * • WAL mode SQLite — Write-Ahead Logging gives better concurrency and
 *   crash safety for a single-file embedded database.
 * • Static file path traversal protection — resolvedPath.startsWith(rootDir)
 *   prevents directory traversal attacks (e.g. GET /../../../etc/passwd).
 *
 * Agent / Tool-Use Notes:
 * ───────────────────────
 * The AI tutor endpoint (/api/tutor/chat) acts as a lightweight rule-based
 * agent. It receives a learner message, classifies it by topic keyword,
 * generates a contextually appropriate response, stores the full exchange in
 * tutor_messages, and returns the reply together with recent history.
 * This agent pattern demonstrates tool use: the "tool" is the keyword
 * classifier; future upgrades could swap it for a real LLM API call.
 *
 * Security Reminders:
 * ───────────────────
 * ⚠️  No API keys, tokens, or secrets are stored in this file.
 *     All configuration is via environment variables (PORT / EDUSTAR_PORT).
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// ── Resolve absolute paths relative to this file's location ────────────────
// Using import.meta.url instead of __dirname because this is an ES module.
const rootDir          = resolve(fileURLToPath(new URL('.', import.meta.url)));
const schemaPath       = join(rootDir, 'edustar-schema.sql');
const contentMapPath   = join(rootDir, 'edustar-content-map.json');
const quizQuestionsPath = join(rootDir, 'edustar-quiz-questions.json');
const databasePath     = join(rootDir, 'edustar-data.sqlite');

// ── Database initialisation ─────────────────────────────────────────────────
// DatabaseSync opens (or creates) the SQLite file synchronously.
// WAL mode and schema creation happen once at startup via exec().
const db = new DatabaseSync(databasePath);
db.exec(readFileSync(schemaPath, 'utf8'));

// ── Schema migration: add user_name if this is an older DB ─────────────────
// ALTER TABLE fails if the column already exists; we swallow that error
// safely so the server doesn't crash when restarting against existing data.
try {
  db.exec(`ALTER TABLE app_settings ADD COLUMN user_name TEXT NOT NULL DEFAULT ''`);
} catch (_) { /* column already exists — safe to ignore */ }

// ── Load static JSON data into memory at startup ────────────────────────────
// These files are read once and cached; they don't change at runtime.
const contentMap    = JSON.parse(readFileSync(contentMapPath, 'utf8'));
const quizQuestions = JSON.parse(readFileSync(quizQuestionsPath, 'utf8'));

// ── MIME type map for static file serving ───────────────────────────────────
// Only known safe extensions are served; anything unknown gets
// application/octet-stream (browsers won't execute it as code).
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt':  'text/plain; charset=utf-8',
};

// ── Response helpers ────────────────────────────────────────────────────────

/**
 * Sends a JSON response with correct headers and Content-Length.
 * Cache-Control: no-store ensures API responses are never cached by browsers.
 */
function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type':   'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control':  'no-store',
  });
  res.end(body);
}

/**
 * Sends a plain-text response. Used for errors and 4xx/5xx fallbacks.
 */
function text(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type':   contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control':  'no-store',
  });
  res.end(body);
}

// ── Request body parser ─────────────────────────────────────────────────────

/**
 * Reads the full request body and parses it as JSON.
 * On malformed JSON, resolves with {} so route handlers can return 400
 * themselves (rather than crashing with an unhandled promise rejection).
 *
 * Design: Promise-based streaming avoids buffering the entire body in memory
 * until the 'end' event fires.
 */
function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch {
        // Malformed JSON → resolve with empty object so route handlers
        // can validate missing fields and return a 400 themselves.
        resolveBody({});
      }
    });
    req.on('error', (err) => {
      console.error('[EduStar] request stream error:', err.message);
      rejectBody(err);
    });
  });
}

// ── Device ID helpers ───────────────────────────────────────────────────────

/**
 * Extracts deviceId from URL query params (used by GET routes).
 * Returns '' if not present — callers must validate with ensureDeviceId.
 */
function getDeviceIdFromUrl(url) {
  return url.searchParams.get('deviceId') || '';
}

/**
 * Normalises a raw deviceId: coerces to string, trims whitespace, caps at
 * 120 chars to prevent oversized SQL parameters.
 */
function normalizeDeviceId(rawValue) {
  return String(rawValue || '').trim().slice(0, 120);
}

/**
 * Validates and returns the normalised deviceId.
 * Throws a 400-tagged Error if the ID is missing or empty, so the top-level
 * catch block in handleRequest can respond with the correct HTTP status.
 */
function ensureDeviceId(rawValue) {
  // Accept null / undefined safely before normalising
  const normalized = normalizeDeviceId(rawValue ?? '');
  if (!normalized) {
    const error = new Error('deviceId is required');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

// ── Database write helpers ──────────────────────────────────────────────────
// All writes use UPSERT (INSERT … ON CONFLICT DO UPDATE) to keep the API
// idempotent — calling POST /api/settings twice is safe and predictable.

/**
 * Upserts learner app settings (grade, display name).
 * user_name is only overwritten if a non-empty value is provided —
 * this lets grade-only updates leave the name intact.
 */
function upsertSettings(deviceId, selectedGrade, userName) {
  db.prepare(
    `INSERT INTO app_settings (device_id, user_name, selected_grade, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(device_id) DO UPDATE SET
       user_name = CASE WHEN excluded.user_name != '' THEN excluded.user_name ELSE user_name END,
       selected_grade = excluded.selected_grade,
       updated_at = CURRENT_TIMESTAMP`
  ).run(deviceId, String(userName || '').trim().slice(0, 40), selectedGrade);
}

/**
 * Upserts only the display name for a device.
 * Used by the dedicated /api/name endpoint so pages can update names
 * independently of grade selection.
 */
function upsertUserName(deviceId, userName) {
  const name = String(userName || '').trim().slice(0, 40);
  db.prepare(
    `INSERT INTO app_settings (device_id, user_name, selected_grade, updated_at)
     VALUES (?, ?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(device_id) DO UPDATE SET
       user_name = excluded.user_name,
       updated_at = CURRENT_TIMESTAMP`
  ).run(deviceId, name);
}

/**
 * Upserts learner progress (stars, level, completed lessons).
 * Stars/level are clipped to sane minimums in the route handler before
 * reaching this function.
 */
function upsertProgress(deviceId, payload) {
  db.prepare(
    `INSERT INTO progress (device_id, stars, level, completed_lessons, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(device_id) DO UPDATE SET
       stars = excluded.stars,
       level = excluded.level,
       completed_lessons = excluded.completed_lessons,
       updated_at = CURRENT_TIMESTAMP`
  ).run(deviceId, payload.stars, payload.level, payload.completedLessons);
}

/**
 * Upserts the learner's personal notes (single document per device, max 2000 chars).
 */
function upsertNotes(deviceId, noteText) {
  db.prepare(
    `INSERT INTO notes (device_id, note_text, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(device_id) DO UPDATE SET
       note_text = excluded.note_text,
       updated_at = CURRENT_TIMESTAMP`
  ).run(deviceId, noteText);
}

/**
 * Appends a new journal entry for the device.
 * Journal entries are append-only (no update or delete) to preserve the
 * learning diary experience. Entries are capped at 1000 chars per entry
 * in the route handler.
 */
function insertJournalEntry(deviceId, entryText) {
  db.prepare('INSERT INTO journal_entries (device_id, entry_text) VALUES (?, ?)').run(deviceId, entryText);
}

/**
 * Records a single quiz attempt (pillar = subject area, score out of total).
 */
function insertQuizAttempt(deviceId, payload) {
  db.prepare('INSERT INTO quiz_attempts (device_id, pillar, score, total) VALUES (?, ?, ?, ?)').run(
    deviceId,
    payload.pillar,
    payload.score,
    payload.total,
  );
}

/**
 * Records a single AI tutor message (role: 'user' | 'assistant').
 */
function insertTutorMessage(deviceId, role, message) {
  db.prepare('INSERT INTO tutor_messages (device_id, role, message) VALUES (?, ?, ?)').run(deviceId, role, message);
}

// ── Database read helpers ───────────────────────────────────────────────────

/**
 * Returns a combined progress summary for the progress tracker page.
 * Fetches settings, progress, notes, the 7 most recent journal entries,
 * and the 10 most recent quiz attempts in a single call.
 * Missing rows are filled in with sensible defaults so the UI never
 * receives null for critical fields.
 */
function getProgressSummary(deviceId) {
  const progressRow  = db.prepare('SELECT * FROM progress WHERE device_id = ?').get(deviceId);
  const settingsRow  = db.prepare('SELECT * FROM app_settings WHERE device_id = ?').get(deviceId);
  const notesRow     = db.prepare('SELECT * FROM notes WHERE device_id = ?').get(deviceId);
  const journalRows  = db.prepare('SELECT entry_text, created_at FROM journal_entries WHERE device_id = ? ORDER BY created_at DESC LIMIT 7').all(deviceId);
  const quizRows     = db.prepare('SELECT pillar, score, total, created_at FROM quiz_attempts WHERE device_id = ? ORDER BY created_at DESC LIMIT 10').all(deviceId);
  return {
    settings:    settingsRow  || { device_id: deviceId, selected_grade: 1 },
    progress:    progressRow  || { device_id: deviceId, stars: 0, level: 1, completed_lessons: 0 },
    notes:       notesRow     || { device_id: deviceId, note_text: '' },
    journal:     journalRows,
    quizAttempts: quizRows,
  };
}

/**
 * Returns the 12 most recent tutor messages for a device, in chronological
 * order (DESC query reversed). Capping at 12 keeps the context window small
 * for client rendering and prevents unbounded memory growth.
 */
function getTutorHistory(deviceId) {
  return db.prepare(
    'SELECT role, message, created_at FROM tutor_messages WHERE device_id = ? ORDER BY created_at DESC LIMIT 12'
  ).all(deviceId).reverse();
}

/**
 * Admin helper: returns all data across all tables for a given deviceId,
 * or for every device if deviceId is omitted. Used only by the admin debug page.
 */
function buildAdminSummary(deviceId = '') {
  const filters    = deviceId ? 'WHERE device_id = ?' : '';
  const parameters = deviceId ? [deviceId] : [];

  return {
    settings:      db.prepare(`SELECT * FROM app_settings    ${filters} ORDER BY updated_at DESC`).all(...parameters),
    progress:      db.prepare(`SELECT * FROM progress        ${filters} ORDER BY updated_at DESC`).all(...parameters),
    notes:         db.prepare(`SELECT * FROM notes           ${filters} ORDER BY updated_at DESC`).all(...parameters),
    journalEntries: db.prepare(`SELECT * FROM journal_entries ${filters} ORDER BY created_at DESC`).all(...parameters),
    quizAttempts:  db.prepare(`SELECT * FROM quiz_attempts   ${filters} ORDER BY created_at DESC`).all(...parameters),
    tutorMessages: db.prepare(`SELECT * FROM tutor_messages  ${filters} ORDER BY created_at DESC`).all(...parameters),
  };
}

// ── AI Tutor Agent ─────────────────────────────────────────────────────────

/**
 * Keyword-based response classifier for the AI tutor agent.
 *
 * Agent Design:
 * ─────────────
 * This function acts as the "reasoning" step of a minimal rule-based agent.
 * It inspects the learner's message for topic keywords and returns a
 * pedagogically appropriate hint rather than a direct answer — encouraging
 * the learner to think rather than simply receive answers.
 *
 * The design is intentionally simple and auditable. A production upgrade
 * would replace this with an LLM API call (e.g. Gemini, GPT-4) while
 * keeping the same function signature and storage behaviour.
 *
 * Tool Use Pattern:
 * ─────────────────
 * The tutor endpoint demonstrates the agent loop:
 *   1. Receive user message (input)
 *   2. Classify intent (this function — the "tool")
 *   3. Generate response
 *   4. Store exchange in DB (memory)
 *   5. Return reply + history (output)
 *
 * @param {string} promptText - The learner's raw input message.
 * @returns {string} A contextual hint/response.
 */
function answerFromPrompt(promptText) {
  // Guard against non-string input (null / undefined safety)
  const safe = (typeof promptText === 'string' ? promptText : String(promptText ?? '')).toLowerCase();
  if (safe.includes('math') || safe.includes('number')) {
    return 'Let us break it into small steps and look for patterns.';
  }
  if (safe.includes('ai') || safe.includes('robot')) {
    return 'AI can help by finding patterns, but it still needs a human to check the answer.';
  }
  if (safe.includes('kind') || safe.includes('respect')) {
    return 'A kind action or respectful word can make a big difference.';
  }
  if (safe.includes('write') || safe.includes('prompt')) {
    return 'Try saying who it is for, what you want, and how long the answer should be.';
  }
  return 'Thanks for asking. I can help you turn that into a simple learning step.';
}

/**
 * Route handler: POST /api/tutor/chat
 *
 * Orchestrates the full agent loop:
 *   1. Parse and validate input (deviceId + message)
 *   2. Persist the user message to tutor_messages
 *   3. Generate a tutor reply via answerFromPrompt (the classifier tool)
 *   4. Persist the assistant reply to tutor_messages
 *   5. Return reply + recent history to the client
 */
async function handleTutorChat(req, res) {
  const body = await readBody(req);
  // Null-safe deviceId extraction
  const deviceId = ensureDeviceId(body.deviceId ?? null);
  // Strict null/undefined check before String conversion
  const promptText = (body.message !== null && body.message !== undefined)
    ? String(body.message).trim()
    : '';

  if (!promptText) {
    json(res, 400, { error: 'message is required' });
    return;
  }

  // Store what the learner said, then generate and store the reply
  insertTutorMessage(deviceId, 'user', promptText);
  const reply = answerFromPrompt(promptText);
  insertTutorMessage(deviceId, 'assistant', reply);

  // Return the reply alongside the recent conversation history
  json(res, 200, {
    reply,
    history: getTutorHistory(deviceId),
  });
}

// ── Main request router ─────────────────────────────────────────────────────

/**
 * Central request handler — routes all incoming HTTP requests.
 *
 * Routing strategy: simple if/else chain on method + pathname.
 * Chosen over a map/trie for clarity and zero overhead at this scale.
 *
 * Error handling: any thrown Error with a numeric .statusCode property
 * is returned to the client with that status code. All other errors
 * are treated as 500 Internal Server Errors; their details are logged
 * server-side only (never exposed to the client).
 */
async function handleRequest(req, res) {
  try {
    const url      = new URL(req.url, 'http://localhost');
    const pathname = normalize(url.pathname).replace(/\\/g, '/');

    // ── Health check ──────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/health') {
      json(res, 200, { ok: true, service: 'edustar-backend' });
      return;
    }

    // ── Curriculum content map (cached at startup) ─────────────────────
    if (req.method === 'GET' && pathname === '/api/content-map') {
      json(res, 200, contentMap);
      return;
    }

    // ── Quiz question bank (cached at startup) ─────────────────────────
    if (req.method === 'GET' && pathname === '/api/quiz-questions') {
      json(res, 200, quizQuestions);
      return;
    }

    // ── Admin summary (no auth — debug/demo only) ─────────────────────
    if (req.method === 'GET' && pathname === '/api/admin/summary') {
      const deviceId = normalizeDeviceId(url.searchParams.get('deviceId') || '');
      json(res, 200, buildAdminSummary(deviceId));
      return;
    }

    // ── Settings ─────────────────────────────────────────────────────────
    if (pathname === '/api/settings' && req.method === 'GET') {
      const deviceId = ensureDeviceId(getDeviceIdFromUrl(url));
      json(res, 200, { settings: db.prepare('SELECT * FROM app_settings WHERE device_id = ?').get(deviceId) || { device_id: deviceId, selected_grade: 1 } });
      return;
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      // Null-safe extraction before passing to ensureDeviceId
      const deviceId = ensureDeviceId(body.deviceId ?? null);
      // Clamp grade to valid CBSE range (1–12); default to 1 on invalid input
      const selectedGrade = Math.max(1, Math.min(12, Number.parseInt(String(body.selectedGrade ?? '1'), 10) || 1));
      // Strict null check — don't stringify undefined
      const userName = (body.userName !== null && body.userName !== undefined)
        ? String(body.userName).trim().slice(0, 40)
        : '';
      upsertSettings(deviceId, selectedGrade, userName);
      json(res, 200, { ok: true, settings: { device_id: deviceId, selected_grade: selectedGrade, user_name: userName } });
      return;
    }

    // ── Learner display name (separate endpoint for name-only updates) ──
    if (pathname === '/api/name' && req.method === 'GET') {
      const deviceId = ensureDeviceId(getDeviceIdFromUrl(url));
      const row = db.prepare('SELECT user_name FROM app_settings WHERE device_id = ?').get(deviceId);
      json(res, 200, { user_name: row ? row.user_name : '' });
      return;
    }

    if (pathname === '/api/name' && req.method === 'POST') {
      const body     = await readBody(req);
      const deviceId = ensureDeviceId(body.deviceId ?? null);
      // Strict null check for userName
      const userName = (body.userName !== null && body.userName !== undefined)
        ? String(body.userName).trim().slice(0, 40)
        : '';
      if (!userName || userName.length < 2) {
        json(res, 400, { error: 'userName must be at least 2 characters' });
        return;
      }
      upsertUserName(deviceId, userName);
      json(res, 200, { ok: true, user_name: userName });
      return;
    }

    // ── Progress ─────────────────────────────────────────────────────────
    if (pathname === '/api/progress' && req.method === 'GET') {
      const deviceId = ensureDeviceId(getDeviceIdFromUrl(url));
      json(res, 200, getProgressSummary(deviceId));
      return;
    }

    if (pathname === '/api/progress' && req.method === 'POST') {
      const body     = await readBody(req);
      const deviceId = ensureDeviceId(body.deviceId ?? null);
      // Coerce all numeric fields to safe integers with sane floor values
      const payload = {
        stars:            Math.max(0, Number.parseInt(String(body.stars            ?? '0'), 10) || 0),
        level:            Math.max(1, Number.parseInt(String(body.level            ?? '1'), 10) || 1),
        completedLessons: Math.max(0, Number.parseInt(String(body.completedLessons ?? '0'), 10) || 0),
      };
      upsertProgress(deviceId, payload);
      json(res, 200, { ok: true, progress: { device_id: deviceId, ...payload } });
      return;
    }

    // ── Notes ─────────────────────────────────────────────────────────────
    if (pathname === '/api/notes' && req.method === 'GET') {
      const deviceId = ensureDeviceId(getDeviceIdFromUrl(url));
      json(res, 200, db.prepare('SELECT * FROM notes WHERE device_id = ?').get(deviceId) || { device_id: deviceId, note_text: '' });
      return;
    }

    if (pathname === '/api/notes' && req.method === 'POST') {
      const body = await readBody(req);
      const deviceId = ensureDeviceId(body.deviceId ?? null);
      // Strict null/undefined check before String conversion; cap at 2000 chars
      const noteText = (body.noteText !== null && body.noteText !== undefined)
        ? String(body.noteText).slice(0, 2000)
        : '';
      upsertNotes(deviceId, noteText);
      json(res, 200, { ok: true, noteText });
      return;
    }

    // ── Journal ───────────────────────────────────────────────────────────
    if (pathname === '/api/journal' && req.method === 'GET') {
      const deviceId = ensureDeviceId(getDeviceIdFromUrl(url));
      json(res, 200, db.prepare('SELECT id, entry_text, created_at FROM journal_entries WHERE device_id = ? ORDER BY created_at DESC').all(deviceId));
      return;
    }

    if (pathname === '/api/journal' && req.method === 'POST') {
      const body     = await readBody(req);
      const deviceId = ensureDeviceId(body.deviceId ?? null);
      const entryText = (body.entryText !== null && body.entryText !== undefined)
        ? String(body.entryText).trim().slice(0, 1000)
        : '';
      if (!entryText) {
        json(res, 400, { error: 'entryText is required' });
        return;
      }
      insertJournalEntry(deviceId, entryText);
      json(res, 200, { ok: true });
      return;
    }

    // ── Quiz attempts ─────────────────────────────────────────────────────
    if (pathname === '/api/quiz-attempts' && req.method === 'GET') {
      const deviceId = ensureDeviceId(getDeviceIdFromUrl(url));
      json(res, 200, db.prepare('SELECT id, pillar, score, total, created_at FROM quiz_attempts WHERE device_id = ? ORDER BY created_at DESC').all(deviceId));
      return;
    }

    if (pathname === '/api/quiz-attempts' && req.method === 'POST') {
      const body     = await readBody(req);
      const deviceId = ensureDeviceId(body.deviceId ?? null);
      // Safe string coercion with explicit null guard
      const pillar = (body.pillar !== null && body.pillar !== undefined)
        ? String(body.pillar).slice(0, 80)
        : 'General';
      const score = Math.max(0, Number.parseInt(String(body.score  ?? '0'), 10) || 0);
      const total = Math.max(1, Number.parseInt(String(body.total  ?? '1'), 10) || 1);
      if (score > total) {
        json(res, 400, { error: 'score cannot exceed total' });
        return;
      }
      insertQuizAttempt(deviceId, { pillar, score, total });
      json(res, 200, { ok: true });
      return;
    }

    // ── AI Tutor chat (agent endpoint) ────────────────────────────────────
    if (pathname === '/api/tutor/chat' && req.method === 'POST') {
      await handleTutorChat(req, res);
      return;
    }

    // ── Static file serving ───────────────────────────────────────────────
    // Serves all HTML/CSS/JS files. The root path redirects to the home page.
    // Path traversal is prevented by checking resolvedPath starts with rootDir.
    if (req.method === 'GET') {
      const requestedPath = pathname === '/' ? '/edustar-home.html' : pathname;
      const safePath      = requestedPath.startsWith('/') ? requestedPath.slice(1) : requestedPath;
      const filePath      = join(rootDir, safePath);
      const resolvedPath  = resolve(filePath);

      // Security: reject any path that escapes the project root directory
      if (!resolvedPath.startsWith(rootDir)) {
        text(res, 403, 'Forbidden');
        return;
      }

      if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
        text(res, 404, 'Not Found');
        return;
      }

      const contentType = mimeTypes[extname(resolvedPath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type':  contentType,
        'Cache-Control': 'no-store',
      });
      // Stream the file to avoid loading large files entirely into memory
      createReadStream(resolvedPath).pipe(res);
      return;
    }

    text(res, 405, 'Method Not Allowed');
  } catch (error) {
    // Routes throw errors with .statusCode for known failures (e.g. 400, 404).
    // All other errors are 500; details are logged server-side only.
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    if (statusCode === 500) {
      console.error('[EduStar] unhandled error:', error.message, error.stack);
    }
    json(res, statusCode, {
      error: statusCode === 500 ? 'Internal Server Error' : error.message,
    });
  }
}

// ── Server startup ─────────────────────────────────────────────────────────
// Port resolution order: Railway's PORT env → custom EDUSTAR_PORT → 3000
// Binding to 0.0.0.0 allows external access (required for Railway deployment).
const port = Number.parseInt(process.env.PORT || process.env.EDUSTAR_PORT || '3000', 10);

const server = createServer((req, res) => {
  handleRequest(req, res);
});

server.on('error', (err) => {
  console.error('[EduStar] server error:', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error(`[EduStar] Port ${port} is already in use. Set PORT or EDUSTAR_PORT to a different value.`);
    process.exit(1);
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[EduStar] backend listening on http://0.0.0.0:${port}`);
  console.log(`[EduStar] open http://127.0.0.1:${port}/edustar-home.html`);
});
