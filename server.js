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

const app = express();

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.static(__dirname + '/public'));

app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: 'peopleops-dev-secret',
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

  db.prepare(
    'INSERT INTO requests (requester_name, user_id, type, description) VALUES (?, ?, ?, ?)'
  ).run(req.user.name, req.user.id, type, description.trim());

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

  res.render('request-detail', {
    title: `Request #${request.id}`,
    name: req.user.name,
    role: req.user.role,
    currentUserId: req.user.id,
    request,
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

  const result = db
    .prepare(
      "UPDATE requests SET status = ?, priority = ?, assigned_to = ?, admin_notes = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .run(status, priority, assignedTo, admin_notes ? admin_notes.trim() : null, req.params.id);

  if (result.changes === 0) {
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
