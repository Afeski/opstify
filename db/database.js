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

module.exports = db;
