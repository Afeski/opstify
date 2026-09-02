// .env is optional (e.g. a fresh clone before GEMINI_API_KEY is set) — a
// missing file just means AI features stay disabled, not a startup crash.
try {
  process.loadEnvFile('.env');
} catch (err) {
  if (err.code !== 'ENOENT') {
    throw err;
  }
}

const express = require('express');
const session = require('express-session');
const db = require('./db/database');

const VALID_TYPES = ['pto', 'equipment', 'onboarding', 'policy_question', 'other'];
const VALID_STATUSES = ['open', 'in_progress', 'resolved'];
const STATUS_LABELS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };
const VALID_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const PRIORITY_LABELS = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

const VALID_ROLES = ['employee', 'admin', 'field_worker'];
const ROLE_LABELS = { employee: 'Employee', admin: 'PeopleOps admin', field_worker: 'Field worker' };
const VALID_PERSON_STATUSES = ['active', 'inactive', 'on_leave'];
const PERSON_STATUS_LABELS = { active: 'Active', inactive: 'Inactive', on_leave: 'On leave' };

// Maps a whitelisted ?sort= value to a literal ORDER BY clause — never
// built from raw user input, so this stays safe to interpolate directly.
// "longest_unresolved" is the historical default (non-resolved first,
// oldest of those first, resolved pushed to the bottom).
// Every column is qualified with "requests." — the query these get spliced
// into joins users (twice), and users now has its own status/created_at
// columns too (added for the people-records model), so a bare column name
// here is ambiguous and SQLite errors rather than guessing which table.
const SORT_OPTIONS = {
  longest_unresolved:
    "CASE requests.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, requests.created_at ASC",
  oldest: 'requests.created_at ASC',
  newest: 'requests.created_at DESC',
  priority:
    "CASE requests.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, requests.created_at ASC",
};
const SORT_LABELS = {
  longest_unresolved: 'Longest unresolved',
  oldest: 'Oldest first',
  newest: 'Newest first',
  priority: 'Highest priority',
};

function renderError(res, status, message) {
  res.status(status).render('error', { title: `${status} Error`, status, message });
}

function computeStats(statusCounts) {
  const stats = { open: 0, in_progress: 0, resolved: 0, total: 0 };
  for (const row of statusCounts) {
    stats[row.status] = row.count;
    stats.total += row.count;
  }
  return stats;
}

// Builds a parameterized WHERE clause for the admin dashboard from
// whitelisted query params only — an unrecognized/tampered value for any
// filter is silently ignored (that filter just doesn't apply), rather than
// crashing the query or matching everything.
function buildAdminFilters(query, adminUsers, currentUserId) {
  const conditions = [];
  const params = [];

  if (VALID_STATUSES.includes(query.status)) {
    conditions.push('requests.status = ?');
    params.push(query.status);
  }

  if (VALID_TYPES.includes(query.type)) {
    conditions.push('requests.type = ?');
    params.push(query.type);
  }

  if (VALID_PRIORITIES.includes(query.priority)) {
    conditions.push('requests.priority = ?');
    params.push(query.priority);
  }

  if (query.assigned_to === 'unassigned') {
    conditions.push('requests.assigned_to IS NULL');
  } else if (query.assigned_to === 'me') {
    conditions.push('requests.assigned_to = ?');
    params.push(currentUserId);
  } else if (query.assigned_to && adminUsers.some((u) => String(u.id) === query.assigned_to)) {
    conditions.push('requests.assigned_to = ?');
    params.push(Number(query.assigned_to));
  }

  const searchTerm = query.q && query.q.trim();
  if (searchTerm) {
    conditions.push('(requests.description LIKE ? OR requests.requester_name LIKE ?)');
    params.push(`%${searchTerm}%`, `%${searchTerm}%`);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

// Compares a request's old field values against the submitted new ones and
// returns one { action, detail } message per field that actually changed —
// nothing for fields resubmitted unchanged, so re-clicking "Update" with no
// real edits logs zero activity rows.
function buildActivityMessages(oldRow, newValues) {
  const messages = [];

  if (oldRow.status !== newValues.status) {
    messages.push({
      action: 'status_changed',
      detail: `Status changed from ${STATUS_LABELS[oldRow.status]} to ${STATUS_LABELS[newValues.status]}`,
    });
  }

  if (oldRow.priority !== newValues.priority) {
    messages.push({
      action: 'priority_changed',
      detail: `Priority changed from ${PRIORITY_LABELS[oldRow.priority]} to ${PRIORITY_LABELS[newValues.priority]}`,
    });
  }

  if (oldRow.assigned_to !== newValues.assignedTo) {
    const { oldAssigneeName, newAssigneeName } = newValues;
    let detail;
    if (!oldAssigneeName && newAssigneeName) {
      detail = `Assigned to ${newAssigneeName}`;
    } else if (oldAssigneeName && !newAssigneeName) {
      detail = `Unassigned (was ${oldAssigneeName})`;
    } else {
      detail = `Reassigned from ${oldAssigneeName} to ${newAssigneeName}`;
    }
    messages.push({ action: 'assignment_changed', detail });
  }

  if ((oldRow.admin_notes || null) !== newValues.adminNotes) {
    messages.push({ action: 'notes_updated', detail: 'Internal notes updated' });
  }

  return messages;
}

// Formats a duration given in hours the way a human would read it: under a
// day shows hours, a day or more shows days (one decimal place either way).
// Returns null when there's no data yet, so the caller decides the fallback
// text rather than this function inventing something like "0.0 hrs".
function formatDuration(hours) {
  if (hours === null || hours === undefined) {
    return null;
  }
  if (hours < 24) {
    return `${hours.toFixed(1)} hrs`;
  }
  return `${(hours / 24).toFixed(1)} days`;
}

// Turns a list of { key, count } rows into { key, count, pct } rows, where
// pct is the bar width/height relative to the largest count — so the bar
// list's own biggest bar is always full width, not scaled against some
// unrelated total.
function withBarPercentages(rows) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return rows.map((r) => ({ ...r, pct: Math.round((r.count / max) * 100) }));
}

// Wraps each whitespace-separated term in double quotes so FTS5 treats
// characters like -, ", or * in what someone types as literal text rather
// than query syntax — an unsanitized MATCH can throw a syntax error on an
// ordinary-looking search (e.g. a name with a hyphen in it).
// join defaults to implicit AND (FTS5's default when quoted terms are
// space-joined) — right for a deliberate short keyword search where every
// term is expected to matter. Natural-language questions need 'OR'
// instead: a question like "How many PTO days do employees get?" has to
// match on "PTO"/"days"/"employees", but AND-ing in filler words like
// "how"/"do"/"get" (which won't appear in the source text) returns
// nothing even when a document is obviously relevant — found and fixed
// this exact case while building /ask, not a hypothetical.
function sanitizeFtsQuery(raw, join = ' ') {
  return raw
    .trim()
    .split(/\s+/)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(join);
}

// SQLite's datetime('now') stores UTC as "YYYY-MM-DD HH:MM:SS" (no
// timezone marker). Node's Date constructor treats a space-separated
// string like that as *local* time, not UTC — replacing the space with
// "T" and appending "Z" is what actually makes it parse as UTC. Skipping
// this would silently misreport every duration by this machine's UTC
// offset.
function hoursSince(dateStr) {
  const then = new Date(dateStr.replace(' ', 'T') + 'Z');
  return (Date.now() - then.getTime()) / 3600000;
}

function timeAgo(dateStr) {
  const hours = hoursSince(dateStr);
  const minutes = Math.floor(hours * 60);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const wholeHours = Math.floor(hours);
  if (wholeHours < 24) {
    return `${wholeHours} hr${wholeHours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  const weeks = Math.floor(days / 7);
  return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
}

// whereClause is appended after "WHERE resolved_at IS NOT NULL" (e.g.
// "AND user_id = ?"), params are its bound values — lets the same query
// serve the queue-wide analytics stat and a single user's dashboard stat.
function getAvgResolutionLabel(whereClause, params) {
  const row = db
    .prepare(
      `SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 24) as avg_hours
       FROM requests WHERE resolved_at IS NOT NULL ${whereClause}`
    )
    .get(...params);
  return formatDuration(row.avg_hours) || 'No data yet';
}

const GEMINI_MODEL = 'gemini-3.6-flash';

// Calls the Gemini API for a priority suggestion on a request's description.
// generationConfig.responseSchema constrains the reply to valid JSON shaped
// like { priority, rationale } — but a model response is still untrusted
// input from outside this process, so the priority is re-checked against
// VALID_PRIORITIES before it's ever returned to a caller.
// Shared plumbing for both AI-suggestion features: builds the request,
// calls Gemini, and returns the parsed JSON object. Each caller still
// re-validates the parsed shape itself (a model response is untrusted
// input, same as anything else from outside this process) — this helper
// only handles the HTTP/JSON mechanics common to both.
async function callGeminiJson(promptText, responseSchema) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Gemini API responded with ${response.status}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Gemini API returned no content.');
  }

  return JSON.parse(text);
}

async function getAiPrioritySuggestion(description) {
  const parsed = await callGeminiJson(
    'You are triaging an internal PeopleOps request. Based only on the ' +
      'description below, suggest a priority and a one-sentence rationale.\n\n' +
      `Priority must be one of: ${VALID_PRIORITIES.join(', ')}.\n\n` +
      `Description:\n${description}`,
    {
      type: 'object',
      properties: {
        priority: { type: 'string', enum: VALID_PRIORITIES },
        rationale: { type: 'string' },
      },
      required: ['priority', 'rationale'],
    }
  );

  if (
    !VALID_PRIORITIES.includes(parsed.priority) ||
    typeof parsed.rationale !== 'string' ||
    !parsed.rationale.trim()
  ) {
    throw new Error('Gemini API returned an unexpected shape.');
  }

  return { priority: parsed.priority, rationale: parsed.rationale.trim() };
}

// admins: [{ id, name, department, job_title, openCount }]. The model picks
// an admin by id from exactly this list; the returned id is checked against
// the real list before being trusted (never assume a hallucinated id, or an
// id outside the set actually offered, is safe to store/use).
async function getAiAssigneeSuggestion(description, admins) {
  const adminList = admins
    .map((a) => {
      const specialty = [a.job_title, a.department].filter(Boolean).join(', ');
      return `- id ${a.id}: ${a.name}${specialty ? ` (${specialty})` : ' (no department/job title set)'}, currently has ${a.openCount} open/in-progress request(s) assigned`;
    })
    .join('\n');

  const parsed = await callGeminiJson(
    'You are triaging an internal PeopleOps request and choosing who on the team ' +
      'should handle it. Based on the description and the admins listed below ' +
      '(their department/job title when known, and their current workload), pick ' +
      'the single best-suited admin id and give a one-sentence rationale. When no ' +
      "admin's specialty clearly matches, prefer whoever has the lightest current " +
      'workload.\n\n' +
      `Admins:\n${adminList}\n\n` +
      `Description:\n${description}`,
    {
      type: 'object',
      properties: {
        assigneeId: { type: 'integer' },
        rationale: { type: 'string' },
      },
      required: ['assigneeId', 'rationale'],
    }
  );

  const matchedAdmin = admins.find((a) => a.id === parsed.assigneeId);
  if (!matchedAdmin || typeof parsed.rationale !== 'string' || !parsed.rationale.trim()) {
    throw new Error('Gemini API returned an unexpected shape.');
  }

  return { assigneeId: matchedAdmin.id, rationale: parsed.rationale.trim() };
}

// retrievedDocs: [{ id, title, content }] — exactly what FTS5 retrieval
// found for this question, and the only source of truth the model is
// given. citedDocumentIds coming back is filtered down to ids that were
// actually in this set — a citation for anything else is dropped, not
// trusted, same "never assume a hallucinated id is safe" rule as above.
// This filtering is the real enforcement of "no hallucinated answers,"
// not just an instruction in the prompt text.
async function getAiAnswer(question, retrievedDocs) {
  const docList = retrievedDocs
    .map((d) => `--- Document id ${d.id}: "${d.title}" ---\n${d.content}`)
    .join('\n\n');

  const parsed = await callGeminiJson(
    'You are answering a question for an internal team using only the documents ' +
      'provided below. Answer strictly from their content — do not use outside ' +
      "knowledge, and do not guess. If the documents don't actually answer the " +
      'question, set foundAnswer to false and say so plainly in the answer field ' +
      'rather than making something up. List the id of every document you ' +
      'actually used to answer in citedDocumentIds.\n\n' +
      `Documents:\n${docList}\n\n` +
      `Question: ${question}`,
    {
      type: 'object',
      properties: {
        answer: { type: 'string' },
        foundAnswer: { type: 'boolean' },
        citedDocumentIds: { type: 'array', items: { type: 'integer' } },
      },
      required: ['answer', 'foundAnswer', 'citedDocumentIds'],
    }
  );

  if (
    typeof parsed.answer !== 'string' ||
    !parsed.answer.trim() ||
    typeof parsed.foundAnswer !== 'boolean' ||
    !Array.isArray(parsed.citedDocumentIds)
  ) {
    throw new Error('Gemini API returned an unexpected shape.');
  }

  const retrievedIds = new Set(retrievedDocs.map((d) => d.id));
  const citedDocumentIds = parsed.citedDocumentIds.filter((id) => retrievedIds.has(id));

  return { answer: parsed.answer.trim(), foundAnswer: parsed.foundAnswer, citedDocumentIds };
}

const app = express();

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.static(__dirname + '/public'));

app.use(express.urlencoded({ extended: true }));

// falls back to a fixed dev-only value so local development needs no setup;
// set SESSION_SECRET in the environment for anything beyond local/demo use,
// since the fallback is public (it's in this repo's source).
app.use(session({
  secret: process.env.SESSION_SECRET || 'peopleops-dev-secret',
  resave: false,
  saveUninitialized: false,
}));

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});

// loads the full user row for the logged-in session (id, name, role,
// department, job_title) so routes read req.user instead of trusting
// whatever was typed into the login form for this session alone.
app.use((req, res, next) => {
  if (req.session.userId) {
    req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  }
  next();
});

app.get('/', (req, res) => {
  res.render('landing', { title: 'Welcome', loggedIn: !!req.user });
});

app.get('/login', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  // ?role=admin/field_worker from a landing page portal button pre-selects
  // that option; anything else (including no param) defaults to employee
  const preselectedRole = VALID_ROLES.includes(req.query.role) ? req.query.role : 'employee';
  res.render('login', { title: 'Sign In', preselectedRole });
});

app.post('/login', (req, res) => {
  const { name, role, department, job_title } = req.body;

  if (!name || !name.trim() || !VALID_ROLES.includes(role)) {
    return renderError(res, 400, 'Name and a valid role are required.');
  }

  const trimmedName = name.trim();
  const trimmedDepartment = department && department.trim() ? department.trim() : null;
  const trimmedJobTitle = job_title && job_title.trim() ? job_title.trim() : null;

  let user = db.prepare('SELECT * FROM users WHERE name = ? AND role = ?').get(trimmedName, role);

  if (!user) {
    const result = db
      .prepare('INSERT INTO users (name, role, department, job_title) VALUES (?, ?, ?, ?)')
      .run(trimmedName, role, trimmedDepartment, trimmedJobTitle);
    user = { id: result.lastInsertRowid };
  } else if (trimmedDepartment || trimmedJobTitle) {
    // only overwrite a field when a new non-empty value was actually given —
    // leaving the login fields blank on a later login must never erase a
    // department/job title someone already set
    db.prepare(
      'UPDATE users SET department = COALESCE(?, department), job_title = COALESCE(?, job_title) WHERE id = ?'
    ).run(trimmedDepartment, trimmedJobTitle, user.id);
  }

  req.session.userId = user.id;

  res.redirect('/dashboard');
});

function requireEmployee(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  if (req.user.role !== 'employee') {
    return renderError(res, 403, 'Only employees can submit requests.');
  }
  next();
}

app.get('/requests/new', requireEmployee, (req, res) => {
  res.render('new-request', { title: 'New Request', name: req.user.name, role: req.user.role });
});

app.post('/requests', requireEmployee, (req, res) => {
  const { type, description } = req.body;

  if (!VALID_TYPES.includes(type) || !description || !description.trim()) {
    return renderError(res, 400, 'A valid type and non-empty description are required.');
  }

  const result = db
    .prepare('INSERT INTO requests (requester_name, user_id, type, description) VALUES (?, ?, ?, ?)')
    .run(req.user.name, req.user.id, type, description.trim());

  db.prepare(
    'INSERT INTO request_activity (request_id, actor_user_id, actor_name, action, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(result.lastInsertRowid, req.user.id, req.user.name, 'submitted', 'Request submitted');

  res.redirect('/dashboard?flash=' + encodeURIComponent('Request submitted.'));
});

app.get('/dashboard', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const flash = req.query.flash || null;

  // field workers don't have a request/queue-based dashboard yet (that's
  // Phase 2 workflow territory) — their own people record is the honest
  // default view for now, not a placeholder pretending to be more
  if (req.user.role === 'field_worker') {
    return res.redirect(`/people/${req.user.id}`);
  }

  if (req.user.role === 'employee') {
    const requests = db
      .prepare(
        `SELECT requests.*, assignee.name AS assignee_name
         FROM requests
         LEFT JOIN users AS assignee ON assignee.id = requests.assigned_to
         WHERE requests.user_id = ?
         ORDER BY requests.created_at DESC`
      )
      .all(req.user.id);
    const statusCounts = db
      .prepare('SELECT status, COUNT(*) as count FROM requests WHERE user_id = ? GROUP BY status')
      .all(req.user.id);
    const stats = computeStats(statusCounts);
    stats.newThisWeek = db
      .prepare("SELECT COUNT(*) as c FROM requests WHERE user_id = ? AND created_at >= datetime('now', '-7 days')")
      .get(req.user.id).c;
    stats.openUnassigned = db
      .prepare("SELECT COUNT(*) as c FROM requests WHERE user_id = ? AND status = 'open' AND assigned_to IS NULL")
      .get(req.user.id).c;
    stats.avgResolutionLabel = getAvgResolutionLabel('AND user_id = ?', [req.user.id]);

    return res.render('employee-dashboard', {
      title: 'My Requests',
      name: req.user.name,
      role: req.user.role,
      requests,
      STATUS_LABELS,
      PRIORITY_LABELS,
      stats,
      timeAgo,
      hoursSince,
      formatDuration,
      flash,
    });
  }

  const adminUsers = db.prepare("SELECT id, name FROM users WHERE role = 'admin' ORDER BY name").all();
  const { where, params } = buildAdminFilters(req.query, adminUsers, req.user.id);
  const filterKeys = ['q', 'status', 'type', 'priority', 'assigned_to'];
  const hasActiveFilters = filterKeys.some((key) => req.query[key]);
  const sort = SORT_OPTIONS[req.query.sort] ? req.query.sort : 'longest_unresolved';

  const requests = db
    .prepare(`
      SELECT requests.*, requester.department, requester.job_title, assignee.name AS assignee_name
      FROM requests
      LEFT JOIN users AS requester ON requester.id = requests.user_id
      LEFT JOIN users AS assignee ON assignee.id = requests.assigned_to
      ${where}
      ORDER BY ${SORT_OPTIONS[sort]}
    `)
    .all(...params);
  // stats intentionally reflect the whole queue, not the filtered view —
  // they're meant as "overall queue health," not a summary of the search
  const statusCounts = db.prepare('SELECT status, COUNT(*) as count FROM requests GROUP BY status').all();
  const stats = computeStats(statusCounts);
  stats.newThisWeek = db
    .prepare("SELECT COUNT(*) as c FROM requests WHERE created_at >= datetime('now', '-7 days')")
    .get().c;
  stats.openUnassigned = db
    .prepare("SELECT COUNT(*) as c FROM requests WHERE status = 'open' AND assigned_to IS NULL")
    .get().c;
  stats.inProgressAssignedToMe = db
    .prepare("SELECT COUNT(*) as c FROM requests WHERE status = 'in_progress' AND assigned_to = ?")
    .get(req.user.id).c;
  stats.avgResolutionLabel = getAvgResolutionLabel('', []);

  const urgentCount = db
    .prepare("SELECT COUNT(*) as c FROM requests WHERE priority = 'urgent' AND status != 'resolved'")
    .get().c;

  res.render('admin-dashboard', {
    title: 'All Requests',
    name: req.user.name,
    role: req.user.role,
    currentUserId: req.user.id,
    requests,
    STATUS_LABELS,
    PRIORITY_LABELS,
    adminUsers,
    filters: req.query,
    hasActiveFilters,
    sort,
    SORT_LABELS,
    stats,
    urgentCount,
    timeAgo,
    hoursSince,
    formatDuration,
    flash,
  });
});

app.get('/requests/:id', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const request = db
    .prepare(
      `SELECT requests.*, requester.department, requester.job_title, assignee.name AS assignee_name,
              ai_assignee.name AS ai_suggested_assignee_name
       FROM requests
       LEFT JOIN users AS requester ON requester.id = requests.user_id
       LEFT JOIN users AS assignee ON assignee.id = requests.assigned_to
       LEFT JOIN users AS ai_assignee ON ai_assignee.id = requests.ai_suggested_assignee
       WHERE requests.id = ?`
    )
    .get(req.params.id);
  const canView = request && (req.user.role === 'admin' || request.user_id === req.user.id);

  if (!canView) {
    return renderError(res, 404, 'Request not found.');
  }

  const adminUsers =
    req.user.role === 'admin'
      ? db.prepare("SELECT id, name FROM users WHERE role = 'admin' ORDER BY name").all()
      : [];

  const activity = db
    .prepare('SELECT * FROM request_activity WHERE request_id = ? ORDER BY created_at DESC, id DESC')
    .all(request.id);

  res.render('request-detail', {
    title: `Request #${request.id}`,
    name: req.user.name,
    role: req.user.role,
    currentUserId: req.user.id,
    request,
    activity,
    STATUS_LABELS,
    PRIORITY_LABELS,
    adminUsers,
    geminiEnabled: !!process.env.GEMINI_API_KEY,
    timeAgo,
    hoursSince,
    formatDuration,
    flash: req.query.flash || null,
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  if (req.user.role !== 'admin') {
    return renderError(res, 403, 'Admins only.');
  }
  next();
}

// admins and employees browse the full directory (employees read-only);
// field workers only ever see their own record, via /people/:id directly
function requirePeopleDirectoryAccess(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  if (req.user.role === 'field_worker') {
    return renderError(res, 403, 'Field workers do not have access to the people directory.');
  }
  next();
}

app.get('/people', requirePeopleDirectoryAccess, (req, res) => {
  const q = (req.query.q || '').trim();
  const people = q
    ? db.prepare('SELECT * FROM users WHERE name LIKE ? ORDER BY name').all(`%${q}%`)
    : db.prepare('SELECT * FROM users ORDER BY name').all();

  res.render('people', {
    title: 'People',
    name: req.user.name,
    role: req.user.role,
    currentPath: req.path,
    people,
    q,
    canEdit: req.user.role === 'admin',
    VALID_ROLES,
    ROLE_LABELS,
    VALID_PERSON_STATUSES,
    PERSON_STATUS_LABELS,
    flash: req.query.flash || null,
  });
});

app.get('/people/:id', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const person = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  // same "404, not 403" convention as requests — don't leak whether a
  // record exists to someone who isn't allowed to see it
  const canView =
    person &&
    (req.user.role === 'admin' || req.user.role === 'employee' || person.id === req.user.id);

  if (!canView) {
    return renderError(res, 404, 'Person not found.');
  }

  const certifications = db
    .prepare('SELECT * FROM certifications WHERE user_id = ? ORDER BY expiry_date IS NULL, expiry_date ASC')
    .all(person.id);

  res.render('person-detail', {
    title: person.name,
    name: req.user.name,
    role: req.user.role,
    currentPath: req.path,
    person,
    certifications,
    canEdit: req.user.role === 'admin',
    VALID_ROLES,
    ROLE_LABELS,
    VALID_PERSON_STATUSES,
    PERSON_STATUS_LABELS,
    flash: req.query.flash || null,
  });
});

app.post('/people', requireAdmin, (req, res) => {
  const { name, role, department, job_title, status, phone, email, assigned_asset } = req.body;

  if (!name || !name.trim() || !VALID_ROLES.includes(role)) {
    return renderError(res, 400, 'Name and a valid role are required.');
  }
  if (!VALID_PERSON_STATUSES.includes(status)) {
    return renderError(res, 400, 'Invalid status.');
  }

  const trimmedName = name.trim();
  const existing = db.prepare('SELECT id FROM users WHERE name = ? AND role = ?').get(trimmedName, role);
  if (existing) {
    // matches the UNIQUE(name, role) constraint — surfacing it as a normal
    // validation error rather than letting the INSERT throw
    return renderError(res, 400, 'A person with this name and role already exists.');
  }

  const result = db
    .prepare(
      `INSERT INTO users (name, role, department, job_title, status, phone, email, assigned_asset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      trimmedName,
      role,
      department && department.trim() ? department.trim() : null,
      job_title && job_title.trim() ? job_title.trim() : null,
      status,
      phone && phone.trim() ? phone.trim() : null,
      email && email.trim() ? email.trim() : null,
      assigned_asset && assigned_asset.trim() ? assigned_asset.trim() : null
    );

  res.redirect(`/people/${result.lastInsertRowid}?flash=${encodeURIComponent('Person added.')}`);
});

// name and role are intentionally not editable here — changing them risks
// colliding with the UNIQUE(name, role) constraint and, more importantly,
// they're how login re-identifies a returning person; keeping them fixed
// after creation avoids identity confusion for a small feature-completeness
// cost (fixable later as its own deliberate decision, not an oversight)
app.post('/people/:id', requireAdmin, (req, res) => {
  const person = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!person) {
    return renderError(res, 404, 'Person not found.');
  }

  const { department, job_title, status, phone, email, assigned_asset } = req.body;

  if (!VALID_PERSON_STATUSES.includes(status)) {
    return renderError(res, 400, 'Invalid status.');
  }

  db.prepare(
    `UPDATE users SET department = ?, job_title = ?, status = ?, phone = ?, email = ?, assigned_asset = ?
     WHERE id = ?`
  ).run(
    department && department.trim() ? department.trim() : null,
    job_title && job_title.trim() ? job_title.trim() : null,
    status,
    phone && phone.trim() ? phone.trim() : null,
    email && email.trim() ? email.trim() : null,
    assigned_asset && assigned_asset.trim() ? assigned_asset.trim() : null,
    person.id
  );

  res.redirect(`/people/${person.id}?flash=${encodeURIComponent('Person updated.')}`);
});

app.post('/people/:id/certifications', requireAdmin, (req, res) => {
  const person = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!person) {
    return renderError(res, 404, 'Person not found.');
  }

  const { name, expiry_date } = req.body;
  if (!name || !name.trim()) {
    return renderError(res, 400, 'Certification name is required.');
  }

  db.prepare('INSERT INTO certifications (user_id, name, expiry_date) VALUES (?, ?, ?)').run(
    person.id,
    name.trim(),
    expiry_date && expiry_date.trim() ? expiry_date.trim() : null
  );

  res.redirect(`/people/${person.id}?flash=${encodeURIComponent('Certification added.')}`);
});

app.post('/certifications/:id/delete', requireAdmin, (req, res) => {
  const cert = db.prepare('SELECT id, user_id FROM certifications WHERE id = ?').get(req.params.id);
  if (!cert) {
    return renderError(res, 404, 'Certification not found.');
  }

  db.prepare('DELETE FROM certifications WHERE id = ?').run(cert.id);

  res.redirect(`/people/${cert.user_id}?flash=${encodeURIComponent('Certification removed.')}`);
});

// all three roles can browse/search — an SOP repository only helps if
// everyone can find answers in it; only admins can create/edit/delete
// (enforced on the write routes below via requireAdmin)
app.get('/documents', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  // built from real data, not a hardcoded list, so category names are
  // never baked into the code
  const categories = db
    .prepare('SELECT DISTINCT category FROM documents ORDER BY category')
    .all()
    .map((row) => row.category);
  const category = categories.includes(req.query.category) ? req.query.category : '';
  const q = (req.query.q || '').trim();

  let documents;
  if (q) {
    const params = [sanitizeFtsQuery(q)];
    let sql = `
      SELECT documents.*
      FROM documents_fts
      JOIN documents ON documents.id = documents_fts.rowid
      WHERE documents_fts MATCH ?
    `;
    if (category) {
      sql += ' AND documents.category = ?';
      params.push(category);
    }
    sql += ' ORDER BY rank';
    documents = db.prepare(sql).all(...params);
  } else {
    let sql = 'SELECT * FROM documents';
    const params = [];
    if (category) {
      sql += ' WHERE category = ?';
      params.push(category);
    }
    sql += ' ORDER BY title';
    documents = db.prepare(sql).all(...params);
  }

  res.render('documents', {
    title: 'Documents',
    name: req.user.name,
    role: req.user.role,
    currentPath: req.path,
    documents,
    categories,
    category,
    q,
    canEdit: req.user.role === 'admin',
    flash: req.query.flash || null,
  });
});

app.get('/documents/new', requireAdmin, (req, res) => {
  res.render('document-form', {
    title: 'New Document',
    name: req.user.name,
    role: req.user.role,
    currentPath: req.path,
    document: null,
    formAction: '/documents',
  });
});

app.post('/documents', requireAdmin, (req, res) => {
  const { title, category, content } = req.body;
  if (!title || !title.trim() || !category || !category.trim() || !content || !content.trim()) {
    return renderError(res, 400, 'Title, category, and content are required.');
  }

  const result = db
    .prepare('INSERT INTO documents (title, category, content, created_by) VALUES (?, ?, ?, ?)')
    .run(title.trim(), category.trim(), content.trim(), req.user.id);

  res.redirect(`/documents/${result.lastInsertRowid}?flash=${encodeURIComponent('Document created.')}`);
});

app.get('/documents/:id', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!document) {
    return renderError(res, 404, 'Document not found.');
  }

  const versions = db
    .prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY created_at DESC')
    .all(document.id);

  res.render('document-detail', {
    title: document.title,
    name: req.user.name,
    role: req.user.role,
    currentPath: req.path,
    document,
    versions,
    canEdit: req.user.role === 'admin',
    flash: req.query.flash || null,
  });
});

app.get('/documents/:id/versions/:versionId', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const document = db.prepare('SELECT id, title FROM documents WHERE id = ?').get(req.params.id);
  if (!document) {
    return renderError(res, 404, 'Document not found.');
  }

  const version = db
    .prepare('SELECT * FROM document_versions WHERE id = ? AND document_id = ?')
    .get(req.params.versionId, document.id);
  if (!version) {
    return renderError(res, 404, 'Version not found.');
  }

  res.render('document-version', {
    title: `${document.title} (previous version)`,
    name: req.user.name,
    role: req.user.role,
    currentPath: req.path,
    document,
    version,
  });
});

app.get('/documents/:id/edit', requireAdmin, (req, res) => {
  const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!document) {
    return renderError(res, 404, 'Document not found.');
  }

  res.render('document-form', {
    title: `Edit ${document.title}`,
    name: req.user.name,
    role: req.user.role,
    currentPath: req.path,
    document,
    formAction: `/documents/${document.id}`,
  });
});

app.post('/documents/:id', requireAdmin, (req, res) => {
  const { title, category, content } = req.body;
  if (!title || !title.trim() || !category || !category.trim() || !content || !content.trim()) {
    return renderError(res, 400, 'Title, category, and content are required.');
  }

  // snapshot-then-overwrite, atomically: if anything here throws, the
  // whole thing rolls back, so a document can never end up updated with
  // no matching version snapshot of what it used to be
  const updateAndSnapshot = db.transaction((docId) => {
    const oldDoc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
    if (!oldDoc) {
      return { changed: false };
    }

    db.prepare(
      'INSERT INTO document_versions (document_id, title, category, content, edited_by) VALUES (?, ?, ?, ?, ?)'
    ).run(oldDoc.id, oldDoc.title, oldDoc.category, oldDoc.content, req.user.id);

    db.prepare(
      "UPDATE documents SET title = ?, category = ?, content = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(title.trim(), category.trim(), content.trim(), docId);

    return { changed: true };
  });

  const result = updateAndSnapshot(req.params.id);
  if (!result.changed) {
    return renderError(res, 404, 'Document not found.');
  }

  res.redirect(`/documents/${req.params.id}?flash=${encodeURIComponent('Document updated.')}`);
});

app.post('/documents/:id/delete', requireAdmin, (req, res) => {
  const document = db.prepare('SELECT id FROM documents WHERE id = ?').get(req.params.id);
  if (!document) {
    return renderError(res, 404, 'Document not found.');
  }

  // version rows reference the document, so they have to go first —
  // foreign_keys enforcement (confirmed on elsewhere in this app) would
  // otherwise block deleting a document that still has version history
  const deleteDocAndVersions = db.transaction((docId) => {
    db.prepare('DELETE FROM document_versions WHERE document_id = ?').run(docId);
    db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
  });
  deleteDocAndVersions(document.id);

  res.redirect(`/documents?flash=${encodeURIComponent('Document deleted.')}`);
});

// all roles can ask — an SOP repository only helps if everyone can query
// it, same reasoning as read access to /documents itself
app.get('/ask', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  let answeredQuery = null;
  if (req.query.id) {
    // only the asker sees their own past answer here — this route has no
    // admin-sees-everything mode, that's what /ask/log is for
    const row = db.prepare('SELECT * FROM query_log WHERE id = ? AND user_id = ?').get(req.query.id, req.user.id);
    if (row) {
      const citedIds = row.cited_document_ids ? JSON.parse(row.cited_document_ids) : [];
      const citedDocs = citedIds.length
        ? db
            .prepare(`SELECT id, title FROM documents WHERE id IN (${citedIds.map(() => '?').join(',')})`)
            .all(...citedIds)
        : [];
      answeredQuery = { ...row, foundAnswer: !!row.found_answer, citedDocs };
    }
  }

  res.render('ask', {
    title: 'Ask',
    name: req.user.name,
    role: req.user.role,
    currentPath: req.path,
    answeredQuery,
    flash: req.query.flash || null,
  });
});

app.post('/ask', async (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const question = (req.body.question || '').trim();
  if (!question) {
    return renderError(res, 400, 'A question is required.');
  }

  try {
    const retrievedDocs = db
      .prepare(
        `SELECT documents.id, documents.title, documents.content
         FROM documents_fts
         JOIN documents ON documents.id = documents_fts.rowid
         WHERE documents_fts MATCH ?
         ORDER BY rank
         LIMIT 5`
      )
      .all(sanitizeFtsQuery(question, ' OR '));

    let answer;
    let foundAnswer;
    let citedDocumentIds;

    if (retrievedDocs.length === 0) {
      // never call Gemini with nothing to ground an answer in — a hard
      // guarantee against hallucination for the no-match case, not just
      // an instruction hoping the model reports it accurately itself
      answer = "I couldn't find any documents relevant to that question.";
      foundAnswer = false;
      citedDocumentIds = [];
    } else {
      const result = await getAiAnswer(question, retrievedDocs);
      answer = result.answer;
      foundAnswer = result.foundAnswer;
      citedDocumentIds = result.citedDocumentIds;
    }

    const logResult = db
      .prepare(
        'INSERT INTO query_log (user_id, question, answer, cited_document_ids, found_answer) VALUES (?, ?, ?, ?, ?)'
      )
      .run(req.user.id, question, answer, JSON.stringify(citedDocumentIds), foundAnswer ? 1 : 0);

    res.redirect(`/ask?id=${logResult.lastInsertRowid}`);
  } catch (err) {
    console.error('AI query failed:', err.message);
    res.redirect(`/ask?flash=${encodeURIComponent("Couldn't get an answer right now.")}`);
  }
});

app.get('/ask/log', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT query_log.*, users.name as asker_name
       FROM query_log
       LEFT JOIN users ON users.id = query_log.user_id
       ORDER BY query_log.created_at DESC`
    )
    .all();

  // resolve every cited document id to its title in one query rather than
  // one lookup per row — admin's real interest here is verifying the
  // answer actually used the right docs, so this needs to show titles,
  // not just IDs
  const allCitedIds = [
    ...new Set(rows.flatMap((r) => (r.cited_document_ids ? JSON.parse(r.cited_document_ids) : []))),
  ];
  const titleById = allCitedIds.length
    ? Object.fromEntries(
        db
          .prepare(`SELECT id, title FROM documents WHERE id IN (${allCitedIds.map(() => '?').join(',')})`)
          .all(...allCitedIds)
          .map((d) => [d.id, d.title])
      )
    : {};

  const queries = rows.map((r) => ({
    ...r,
    foundAnswer: !!r.found_answer,
    citedDocs: (r.cited_document_ids ? JSON.parse(r.cited_document_ids) : []).map((id) => ({
      id,
      title: titleById[id],
    })),
  }));

  res.render('query-log', {
    title: 'Query Log',
    name: req.user.name,
    role: req.user.role,
    currentPath: req.path,
    queries,
  });
});

app.post('/requests/:id/ai-suggest-priority', requireAdmin, async (req, res) => {
  const request = db.prepare('SELECT id, description FROM requests WHERE id = ?').get(req.params.id);
  if (!request) {
    return renderError(res, 404, 'Request not found.');
  }

  const detailPath = `/requests/${request.id}`;

  try {
    const { priority, rationale } = await getAiPrioritySuggestion(request.description);
    db.prepare(
      'UPDATE requests SET ai_suggested_priority = ?, ai_suggestion_rationale = ? WHERE id = ?'
    ).run(priority, rationale, request.id);
    res.redirect(`${detailPath}?flash=${encodeURIComponent('AI suggestion ready.')}`);
  } catch (err) {
    console.error('AI priority suggestion failed:', err.message);
    res.redirect(`${detailPath}?flash=${encodeURIComponent("Couldn't get an AI suggestion right now.")}`);
  }
});

app.post('/requests/:id/ai-suggest-assignee', requireAdmin, async (req, res) => {
  const request = db.prepare('SELECT id, description FROM requests WHERE id = ?').get(req.params.id);
  if (!request) {
    return renderError(res, 404, 'Request not found.');
  }

  const detailPath = `/requests/${request.id}`;

  try {
    const workloadRows = db
      .prepare(
        "SELECT assigned_to, COUNT(*) as count FROM requests WHERE assigned_to IS NOT NULL AND status != 'resolved' GROUP BY assigned_to"
      )
      .all();
    const workloadMap = Object.fromEntries(workloadRows.map((r) => [r.assigned_to, r.count]));
    const admins = db
      .prepare("SELECT id, name, department, job_title FROM users WHERE role = 'admin' ORDER BY name")
      .all()
      .map((a) => ({ ...a, openCount: workloadMap[a.id] || 0 }));

    if (admins.length === 0) {
      throw new Error('No admins available to suggest.');
    }

    const { assigneeId, rationale } = await getAiAssigneeSuggestion(request.description, admins);
    db.prepare(
      'UPDATE requests SET ai_suggested_assignee = ?, ai_suggestion_assignee_rationale = ? WHERE id = ?'
    ).run(assigneeId, rationale, request.id);
    res.redirect(`${detailPath}?flash=${encodeURIComponent('AI suggestion ready.')}`);
  } catch (err) {
    console.error('AI assignee suggestion failed:', err.message);
    res.redirect(`${detailPath}?flash=${encodeURIComponent("Couldn't get an AI suggestion right now.")}`);
  }
});

app.get('/analytics', requireAdmin, (req, res) => {
  const statusCounts = db.prepare('SELECT status, COUNT(*) as count FROM requests GROUP BY status').all();
  const stats = computeStats(statusCounts);
  const resolutionRate = stats.total ? Math.round((stats.resolved / stats.total) * 100) : 0;

  const avgResolutionLabel = getAvgResolutionLabel('', []);

  // grouped by VALID_TYPES/VALID_PRIORITIES (not just what SQL returns) so a
  // type or priority with zero requests still shows up as a zero-width bar
  // instead of silently disappearing from the chart
  const typeCounts = db.prepare('SELECT type, COUNT(*) as count FROM requests GROUP BY type').all();
  const typeCountMap = Object.fromEntries(typeCounts.map((r) => [r.type, r.count]));
  const typeBreakdown = withBarPercentages(VALID_TYPES.map((type) => ({ type, count: typeCountMap[type] || 0 })));

  const priorityCounts = db.prepare('SELECT priority, COUNT(*) as count FROM requests GROUP BY priority').all();
  const priorityCountMap = Object.fromEntries(priorityCounts.map((r) => [r.priority, r.count]));
  const priorityBreakdown = withBarPercentages(
    VALID_PRIORITIES.map((priority) => ({ priority, count: priorityCountMap[priority] || 0 }))
  );

  // last 14 days including today, computed in UTC to match SQLite's
  // datetime('now')/date('now') — gaps are filled with 0 so a quiet day
  // shows as an empty bar rather than vanishing from the trend entirely
  const volumeRows = db
    .prepare(
      "SELECT date(created_at) as day, COUNT(*) as count FROM requests WHERE date(created_at) >= date('now', '-13 days') GROUP BY day"
    )
    .all();
  const volumeMap = Object.fromEntries(volumeRows.map((r) => [r.day, r.count]));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    days.push({ day, count: volumeMap[day] || 0 });
  }
  const volumeTrend = withBarPercentages(days);

  // bar width reflects current open workload (the actionable "who's busy"
  // signal); resolvedCount rides along for context but doesn't affect it
  const adminWorkloadRows = db
    .prepare(
      `SELECT u.id, u.name, u.department, u.job_title,
              COALESCE(SUM(CASE WHEN r.status != 'resolved' THEN 1 ELSE 0 END), 0) as openCount,
              COALESCE(SUM(CASE WHEN r.status = 'resolved' THEN 1 ELSE 0 END), 0) as resolvedCount
       FROM users u
       LEFT JOIN requests r ON r.assigned_to = u.id
       WHERE u.role = 'admin'
       GROUP BY u.id
       ORDER BY openCount DESC, u.name`
    )
    .all();
  const adminWorkload = withBarPercentages(
    adminWorkloadRows.map((a) => ({ ...a, count: a.openCount }))
  );

  res.render('analytics', {
    title: 'Analytics',
    name: req.user.name,
    role: req.user.role,
    stats,
    resolutionRate,
    avgResolutionLabel,
    typeBreakdown,
    priorityBreakdown,
    volumeTrend,
    adminWorkload,
    PRIORITY_LABELS,
  });
});

app.post('/requests/:id/status', requireAdmin, (req, res) => {
  const { status, priority, admin_notes } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return renderError(res, 400, 'Invalid status.');
  }

  if (!VALID_PRIORITIES.includes(priority)) {
    return renderError(res, 400, 'Invalid priority.');
  }

  // empty string means "Unassigned" (-> NULL); anything else must resolve to
  // an actual admin user's id — not just any user id, and not an arbitrary
  // number a request could be tampered to submit
  let assignedTo = null;
  if (req.body.assigned_to) {
    const assignee = db
      .prepare("SELECT id FROM users WHERE id = ? AND role = 'admin'")
      .get(req.body.assigned_to);
    if (!assignee) {
      return renderError(res, 400, 'Invalid assignee.');
    }
    assignedTo = assignee.id;
  }

  const trimmedNotes = admin_notes ? admin_notes.trim() : null;

  // fetch-then-diff-then-log all happen atomically: if anything in here
  // throws, better-sqlite3 rolls the whole thing back, so a request can
  // never end up with its fields updated but no matching history entry
  const updateAndLog = db.transaction((requestId) => {
    const oldRow = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
    if (!oldRow) {
      return { changed: false };
    }

    // resolved_at: set the first time a request becomes 'resolved', cleared
    // if it's reopened, and left alone if it's already resolved and just
    // being re-saved (e.g. a notes edit) — so that doesn't reset the clock.
    db.prepare(
      `UPDATE requests
       SET status = ?, priority = ?, assigned_to = ?, admin_notes = ?, updated_at = datetime('now'),
           resolved_at = CASE
             WHEN ? = 'resolved' AND resolved_at IS NULL THEN datetime('now')
             WHEN ? != 'resolved' THEN NULL
             ELSE resolved_at
           END
       WHERE id = ?`
    ).run(status, priority, assignedTo, trimmedNotes, status, status, requestId);

    const lookupName = (id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name : null);
    const messages = buildActivityMessages(oldRow, {
      status,
      priority,
      assignedTo,
      adminNotes: trimmedNotes,
      oldAssigneeName: lookupName(oldRow.assigned_to),
      newAssigneeName: lookupName(assignedTo),
    });

    const insertActivity = db.prepare(
      'INSERT INTO request_activity (request_id, actor_user_id, actor_name, action, detail) VALUES (?, ?, ?, ?, ?)'
    );
    for (const message of messages) {
      insertActivity.run(requestId, req.user.id, req.user.name, message.action, message.detail);
    }

    return { changed: true };
  });

  const result = updateAndLog(req.params.id);

  if (!result.changed) {
    return renderError(res, 404, 'Request not found.');
  }

  // whitelist the redirect target so a submitted "next" value can only ever
  // send the admin back to the dashboard or to this same request's detail page
  const detailPath = `/requests/${req.params.id}`;
  const next = req.body.next === detailPath ? detailPath : '/dashboard';

  res.redirect(`${next}?flash=${encodeURIComponent('Status updated.')}`);
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
