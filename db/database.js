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

// Same shape as migrateAiSuggestion, but for the AI-suggested-assignee
// feature: which admin the AI suggests, and why.
function migrateAiAssigneeSuggestion(db) {
  const columns = db.prepare('PRAGMA table_info(requests)').all();
  const columnNames = columns.map((col) => col.name);

  if (!columnNames.includes('ai_suggested_assignee')) {
    db.exec('ALTER TABLE requests ADD COLUMN ai_suggested_assignee INTEGER REFERENCES users(id)');
  }

  if (!columnNames.includes('ai_suggestion_assignee_rationale')) {
    db.exec('ALTER TABLE requests ADD COLUMN ai_suggestion_assignee_rationale TEXT');
  }
}

migrateAiAssigneeSuggestion(db);

// Adds the field-worker role and the people-record fields (status, contact
// info, assigned asset). This one's different from every migration above:
// role's CHECK constraint needs 'field_worker' added to it, and SQLite has
// no ALTER TABLE for modifying a CHECK constraint. The standard SQLite
// procedure for this is to rebuild the table — create a new one with the
// updated definition, copy the data across (explicitly preserving id, so
// every existing foreign key in requests/request_activity still resolves
// to the same row), drop the old table, rename the new one into place.
// foreign_keys is turned off for the swap, per SQLite's own documented
// recommendation for schema changes on a table other tables reference.
function migratePeopleFields(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all();
  const hasStatus = columns.some((col) => col.name === 'status');

  if (hasStatus) {
    return;
  }

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('employee', 'admin', 'field_worker')),
      department TEXT,
      job_title TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'on_leave')),
      phone TEXT,
      email TEXT,
      assigned_asset TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (name, role)
    );

    INSERT INTO users_new (id, name, role, department, job_title, created_at)
      SELECT id, name, role, department, job_title, created_at FROM users;

    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
  `);
  db.exec('PRAGMA foreign_keys = ON');
}

migratePeopleFields(db);

module.exports = db;
