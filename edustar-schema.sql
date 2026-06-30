-- EduStar Database Schema — edustar-schema.sql
--
-- Design Overview:
-- ────────────────
-- All tables use TEXT device_id as the primary (or foreign) key.
-- device_id is an opaque browser-generated string (see edustar-client-api.js).
-- This avoids any user account/authentication requirement — learners are
-- identified by their browser, not by a login credential.
--
-- No personal data beyond a first-name display name is stored.
-- No passwords, emails, or government IDs are collected or required.
--
-- WAL (Write-Ahead Logging) mode is enabled for better concurrent read
-- performance and crash safety on the local SQLite file.
-- SYNCHRONOUS = NORMAL balances durability and write speed for a
-- single-instance local server (full FULL is unnecessary here).

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- ── app_settings ──────────────────────────────────────────────────────────
-- Stores per-device learner preferences.
-- One row per device (device_id is PRIMARY KEY → UPSERT safe).
--
-- Columns:
--   device_id      — opaque browser identifier (from localStorage)
--   user_name      — optional display name (≤ 40 chars, default empty)
--   selected_grade — CBSE grade 1–12, defaulting to 1
--   updated_at     — last modification timestamp (ISO 8601 via SQLite)
CREATE TABLE IF NOT EXISTS app_settings (
  device_id     TEXT    PRIMARY KEY,
  user_name     TEXT    NOT NULL DEFAULT '',
  selected_grade INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── progress ──────────────────────────────────────────────────────────────
-- Tracks the learner's gamified learning progress.
-- One row per device; overwritten on each progress save (UPSERT).
--
-- Columns:
--   stars             — total stars earned across all lessons
--   level             — current learner level (starts at 1)
--   completed_lessons — cumulative count of finished lessons
CREATE TABLE IF NOT EXISTS progress (
  device_id         TEXT    PRIMARY KEY,
  stars             INTEGER NOT NULL DEFAULT 0,
  level             INTEGER NOT NULL DEFAULT 1,
  completed_lessons INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── notes ─────────────────────────────────────────────────────────────────
-- Personal notes scratchpad — single document per device (UPSERT overwrites).
-- Content is capped at 2000 chars in the route handler before reaching here.
CREATE TABLE IF NOT EXISTS notes (
  device_id TEXT NOT NULL PRIMARY KEY,
  note_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── journal_entries ────────────────────────────────────────────────────────
-- Append-only daily learning journal. Multiple entries per device are allowed.
-- Entries are never updated or deleted — the diary experience is preserved.
-- Content is capped at 1000 chars per entry in the route handler.
--
-- Index on (device_id, created_at DESC) supports the most common query:
-- "give me the N most recent entries for this device".
CREATE TABLE IF NOT EXISTS journal_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT    NOT NULL,
  entry_text TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── quiz_attempts ──────────────────────────────────────────────────────────
-- Records every quiz attempt with the subject pillar, score, and total.
-- Multiple attempts per device/pillar are allowed (progress history).
--
-- pillar  — subject area (e.g. "Mathematics", "AI & Technology")
-- score   — correct answers; validated server-side: 0 ≤ score ≤ total
-- total   — total questions in the attempt; minimum 1
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT    NOT NULL,
  pillar     TEXT    NOT NULL,
  score      INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── tutor_messages ────────────────────────────────────────────────────────
-- Conversation history for the AI tutor agent.
-- role is either 'user' (learner input) or 'assistant' (tutor reply).
-- The backend retrieves the 12 most recent messages per device to render
-- the chat history on the tutor page without unbounded growth.
CREATE TABLE IF NOT EXISTS tutor_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT NOT NULL,
  role       TEXT NOT NULL,    -- 'user' | 'assistant'
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── Indexes ────────────────────────────────────────────────────────────────
-- Composite indexes on (device_id, created_at DESC) for the three
-- append-only tables. These match the query patterns used in the backend:
--   SELECT … WHERE device_id = ? ORDER BY created_at DESC LIMIT N
CREATE INDEX IF NOT EXISTS idx_journal_entries_device_created
  ON journal_entries(device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quiz_attempts_device_created
  ON quiz_attempts(device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tutor_messages_device_created
  ON tutor_messages(device_id, created_at DESC);
