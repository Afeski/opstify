const express = require('express');
const session = require('express-session');
const db = require('./db/database');

const VALID_TYPES = ['pto', 'equipment', 'onboarding', 'policy_question', 'other'];
const VALID_STATUSES = ['open', 'in_progress', 'resolved'];
const STATUS_LABELS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };

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

app.get('/', (req, res) => {
  res.render('login', { title: 'Sign In' });
});

app.post('/login', (req, res) => {
  const { name, role } = req.body;

  if (!name || !name.trim() || !['employee', 'admin'].includes(role)) {
    return renderError(res, 400, 'Name and a valid role are required.');
  }

  req.session.name = name.trim();
  req.session.role = role;

  res.redirect('/dashboard');
});

function requireEmployee(req, res, next) {
  if (!req.session.name) {
    return res.redirect('/');
  }
  if (req.session.role !== 'employee') {
    return renderError(res, 403, 'Only employees can submit requests.');
  }
  next();
}

app.get('/requests/new', requireEmployee, (req, res) => {
  res.render('new-request', { title: 'New Request', name: req.session.name, role: req.session.role });
});

app.post('/requests', requireEmployee, (req, res) => {
  const { type, description } = req.body;

  if (!VALID_TYPES.includes(type) || !description || !description.trim()) {
    return renderError(res, 400, 'A valid type and non-empty description are required.');
  }

  db.prepare(
    'INSERT INTO requests (requester_name, type, description) VALUES (?, ?, ?)'
  ).run(req.session.name, type, description.trim());

  res.redirect('/dashboard?flash=' + encodeURIComponent('Request submitted.'));
});

app.get('/dashboard', (req, res) => {
  if (!req.session.name) {
    return res.redirect('/');
  }

  const flash = req.query.flash || null;

  if (req.session.role === 'employee') {
    const requests = db
      .prepare('SELECT * FROM requests WHERE requester_name = ? ORDER BY created_at DESC')
      .all(req.session.name);
    const statusCounts = db
      .prepare('SELECT status, COUNT(*) as count FROM requests WHERE requester_name = ? GROUP BY status')
      .all(req.session.name);
    return res.render('employee-dashboard', {
      title: 'My Requests',
      name: req.session.name,
      role: req.session.role,
      requests,
      STATUS_LABELS,
      stats: computeStats(statusCounts),
      flash,
    });
  }

  const requests = db
    .prepare(`
      SELECT * FROM requests
      ORDER BY
        CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
        created_at ASC
    `)
    .all();
  const statusCounts = db.prepare('SELECT status, COUNT(*) as count FROM requests GROUP BY status').all();
  res.render('admin-dashboard', {
    title: 'All Requests',
    name: req.session.name,
    role: req.session.role,
    requests,
    STATUS_LABELS,
    stats: computeStats(statusCounts),
    flash,
  });
});

app.get('/requests/:id', (req, res) => {
  if (!req.session.name) {
    return res.redirect('/');
  }

  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  const canView = request && (req.session.role === 'admin' || request.requester_name === req.session.name);

  if (!canView) {
    return renderError(res, 404, 'Request not found.');
  }

  res.render('request-detail', {
    title: `Request #${request.id}`,
    name: req.session.name,
    role: req.session.role,
    request,
    STATUS_LABELS,
    flash: req.query.flash || null,
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

function requireAdmin(req, res, next) {
  if (!req.session.name) {
    return res.redirect('/');
  }
  if (req.session.role !== 'admin') {
    return renderError(res, 403, 'Admins only.');
  }
  next();
}

app.post('/requests/:id/status', requireAdmin, (req, res) => {
  const { status, admin_notes } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return renderError(res, 400, 'Invalid status.');
  }

  const result = db
    .prepare("UPDATE requests SET status = ?, admin_notes = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, admin_notes ? admin_notes.trim() : null, req.params.id);

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
