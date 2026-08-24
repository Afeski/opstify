const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', 'data', 'peopleops.db');
const db = new Database(dbPath);

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// One-time (but idempotent) migration: add requests.user_id if it's missing,
// then backfill it by finding-or-creating a users row for each distinct
// requester_name still without one. Safe to run on every startup — once a
// request has a user_id, it's never touched again.
function migrateUserIds(db) {
  const columns = db.prepare('PRAGMA table_info(requests)').all();
  const hasUserId = columns.some((col) => col.name === 'user_id');

  if (!hasUserId) {
    db.exec('ALTER TABLE requests ADD COLUMN user_id INTEGER REFERENCES users(id)');
  }

  const findUser = db.prepare('SELECT id FROM users WHERE name = ? AND role = ?');
  const insertUser = db.prepare("INSERT INTO users (name, role) VALUES (?, 'employee')");
  const backfillRequests = db.prepare(
    'UPDATE requests SET user_id = ? WHERE requester_name = ? AND user_id IS NULL'
  );

  const unmigrated = db
    .prepare('SELECT DISTINCT requester_name FROM requests WHERE user_id IS NULL')
    .all();

  for (const { requester_name } of unmigrated) {
    let user = findUser.get(requester_name, 'employee');
    if (!user) {
      const result = insertUser.run(requester_name);
      user = { id: result.lastInsertRowid };
    }
    backfillRequests.run(user.id, requester_name);
  }
}

migrateUserIds(db);

// Adds requests.priority and requests.assigned_to if missing. Both are safe
// to add with a plain ALTER TABLE (unlike user_id, no relational backfill is
// needed): priority's DEFAULT 'normal' satisfies its own CHECK constraint for
// every pre-existing row, and assigned_to is meant to start out NULL
// (unassigned) for old and new requests alike.
function migrateRequestFields(db) {
  const columns = db.prepare('PRAGMA table_info(requests)').all();
  const columnNames = columns.map((col) => col.name);

  if (!columnNames.includes('priority')) {
    db.exec(
      "ALTER TABLE requests ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent'))"
    );
  }

  if (!columnNames.includes('assigned_to')) {
    db.exec('ALTER TABLE requests ADD COLUMN assigned_to INTEGER REFERENCES users(id)');
  }
}

migrateRequestFields(db);

// Adds requests.resolved_at if missing. Unlike priority/assigned_to, this
// one has no useful default for existing rows: we have no record of when a
// pre-existing "resolved" request actually got resolved, so it's left NULL
// for all of them rather than guessing (e.g. backfilling with updated_at,
// which would silently overstate how fast old requests were resolved).
function migrateResolvedAt(db) {
  const columns = db.prepare('PRAGMA table_info(requests)').all();
  const hasResolvedAt = columns.some((col) => col.name === 'resolved_at');

  if (!hasResolvedAt) {
    db.exec('ALTER TABLE requests ADD COLUMN resolved_at TEXT');
  }
}

migrateResolvedAt(db);

// Adds the two columns that cache an AI priority suggestion for a request:
// the suggested value and a one-line rationale. Both are set together by a
// single request to the Gemini API, so there's no case where one is present
// without the other.
function migrateAiSuggestion(db) {
  const columns = db.prepare('PRAGMA table_info(requests)').all();
  const columnNames = columns.map((col) => col.name);

  if (!columnNames.includes('ai_suggested_priority')) {
    db.exec('ALTER TABLE requests ADD COLUMN ai_suggested_priority TEXT');
  }

  if (!columnNames.includes('ai_suggestion_rationale')) {
    db.exec('ALTER TABLE requests ADD COLUMN ai_suggestion_rationale TEXT');
  }
}

migrateAiSuggestion(db);

module.exports = db;
