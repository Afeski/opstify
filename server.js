const express = require('express');
const session = require('express-session');
const db = require('./db/database');

const VALID_TYPES = ['pto', 'equipment', 'onboarding', 'policy_question', 'other'];
const VALID_STATUSES = ['open', 'in_progress', 'resolved'];
const STATUS_LABELS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };

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

app.get('/', (req, res) => {
  res.render('login', { title: 'Sign In' });
});

app.post('/login', (req, res) => {
  const { name, role } = req.body;

  if (!name || !name.trim() || !['employee', 'admin'].includes(role)) {
    return res.status(400).send('Name and a valid role are required.');
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
    return res.status(403).send('Only employees can submit requests.');
  }
  next();
}

app.get('/requests/new', requireEmployee, (req, res) => {
  res.render('new-request', { title: 'New Request', name: req.session.name, role: req.session.role });
});

app.post('/requests', requireEmployee, (req, res) => {
  const { type, description } = req.body;

  if (!VALID_TYPES.includes(type) || !description || !description.trim()) {
    return res.status(400).send('A valid type and non-empty description are required.');
  }

  db.prepare(
    'INSERT INTO requests (requester_name, type, description) VALUES (?, ?, ?)'
  ).run(req.session.name, type, description.trim());

  res.redirect('/dashboard');
});

app.get('/dashboard', (req, res) => {
  if (!req.session.name) {
    return res.redirect('/');
  }

  if (req.session.role === 'employee') {
    const requests = db
      .prepare('SELECT * FROM requests WHERE requester_name = ? ORDER BY created_at DESC')
      .all(req.session.name);
    return res.render('employee-dashboard', {
      title: 'My Requests',
      name: req.session.name,
      role: req.session.role,
      requests,
      STATUS_LABELS,
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
  res.render('admin-dashboard', {
    title: 'All Requests',
    name: req.session.name,
    role: req.session.role,
    requests,
    STATUS_LABELS,
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
    return res.status(403).send('Admins only.');
  }
  next();
}

app.post('/requests/:id/status', requireAdmin, (req, res) => {
  const { status, admin_notes } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).send('Invalid status.');
  }

  const result = db
    .prepare("UPDATE requests SET status = ?, admin_notes = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, admin_notes ? admin_notes.trim() : null, req.params.id);

  if (result.changes === 0) {
    return res.status(404).send('Request not found.');
  }

  res.redirect('/dashboard');
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
