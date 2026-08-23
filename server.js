const express = require('express');
const session = require('express-session');
const db = require('./db/database');

const VALID_TYPES = ['pto', 'equipment', 'onboarding', 'policy_question', 'other'];
const VALID_STATUSES = ['open', 'in_progress', 'resolved'];
const STATUS_LABELS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };
const VALID_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const PRIORITY_LABELS = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

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
  res.render('login', { title: 'Sign In' });
});

app.post('/login', (req, res) => {
  const { name, role, department, job_title } = req.body;

  if (!name || !name.trim() || !['employee', 'admin'].includes(role)) {
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
    return res.render('employee-dashboard', {
      title: 'My Requests',
      name: req.user.name,
      role: req.user.role,
      requests,
      STATUS_LABELS,
      PRIORITY_LABELS,
      stats: computeStats(statusCounts),
      flash,
    });
  }

  const adminUsers = db.prepare("SELECT id, name FROM users WHERE role = 'admin' ORDER BY name").all();
  const { where, params } = buildAdminFilters(req.query, adminUsers, req.user.id);
  const filterKeys = ['q', 'status', 'type', 'priority', 'assigned_to'];
  const hasActiveFilters = filterKeys.some((key) => req.query[key]);

  const requests = db
    .prepare(`
      SELECT requests.*, requester.department, requester.job_title, assignee.name AS assignee_name
      FROM requests
      LEFT JOIN users AS requester ON requester.id = requests.user_id
      LEFT JOIN users AS assignee ON assignee.id = requests.assigned_to
      ${where}
      ORDER BY
        CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
        created_at ASC
    `)
    .all(...params);
  // stats intentionally reflect the whole queue, not the filtered view —
  // they're meant as "overall queue health," not a summary of the search
  const statusCounts = db.prepare('SELECT status, COUNT(*) as count FROM requests GROUP BY status').all();
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
    stats: computeStats(statusCounts),
    flash,
  });
});

app.get('/requests/:id', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const request = db
    .prepare(
      `SELECT requests.*, requester.department, requester.job_title, assignee.name AS assignee_name
       FROM requests
       LEFT JOIN users AS requester ON requester.id = requests.user_id
       LEFT JOIN users AS assignee ON assignee.id = requests.assigned_to
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

app.get('/analytics', requireAdmin, (req, res) => {
  const statusCounts = db.prepare('SELECT status, COUNT(*) as count FROM requests GROUP BY status').all();
  const stats = computeStats(statusCounts);
  const resolutionRate = stats.total ? Math.round((stats.resolved / stats.total) * 100) : 0;

  const avgResolutionHours = db
    .prepare(
      "SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 24) as avg_hours FROM requests WHERE resolved_at IS NOT NULL"
    )
    .get().avg_hours;
  const avgResolutionLabel = formatDuration(avgResolutionHours) || 'No data yet';

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
