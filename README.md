# Opstify

**An internal PeopleOps operations tool** — a single workspace where employees submit and track requests, and PeopleOps triages, manages, and resolves them.

## The problem

Most internal PeopleOps work — PTO requests, equipment asks, onboarding tasks, policy questions — ends up scattered across email threads and Slack DMs. Nothing is searchable, nothing has a status, and there's no record of who handled what or when. Employees don't know if their request was seen; PeopleOps has no queue, no way to prioritize what's urgent, and no way to divide the work across the team.

Opstify replaces that with one shared system: a place to submit a request, a queue to work it, and a record of what happened.

## Core features

**For employees**
- Submit a request (PTO, equipment, onboarding, policy question, or other) in a couple of fields — no email thread required
- Track every request's status, priority, and who on PeopleOps is handling it
- See the full activity history on a request, including changes PeopleOps made

**For PeopleOps / admins**
- A shared dashboard of every request across the org, sorted with the oldest open requests first
- Search by keyword and filter by status, type, priority, or assignee — including "assigned to me" and "unassigned" views
- Update a request's status, set its priority, and assign it to a specific admin (with a one-click "assign to me")
- Leave internal notes on a request, visible only to PeopleOps
- A full activity/history log — every status change, priority change, reassignment, and note update is recorded automatically, with who did it and when

**Shared**
- Role-based experiences: employees and admins see different dashboards and different controls, built on the same request data
- A public landing page separate from the sign-in flow, so the product has an identity before you're logged in

## Product flow

```
Employee submits a request
        │
        ▼
PeopleOps reviews it on the shared dashboard
        │
        ▼
Request is triaged — status, priority, and assignee are set
        │
        ▼
PeopleOps works the request, leaving notes as it progresses
        │
        ▼
Request is marked resolved
        │
        ▼
Employee sees the resolution and the full history on their own dashboard
```

Every step in that flow is logged, so both sides can always see exactly where a request stands and how it got there.

## Tech stack

- **Node.js** + **Express** — server and routing
- **SQLite** (via `better-sqlite3`) — persistence, with idempotent startup migrations for schema changes
- **EJS** — server-rendered views (no client-side framework, no build step)
- **Vanilla JavaScript & CSS** — a small token-based design system (colors, spacing, typography) with no CSS framework dependency

The whole app runs as a single Node process with a local SQLite file — no external services, no separate frontend to deploy.

## Project structure

```
opstify/
├── server.js              # All routes: auth, requests, dashboards, admin actions
├── db/
│   ├── schema.sql          # Table definitions (users, requests, request_activity)
│   └── database.js         # Opens the SQLite file, applies schema + migrations on startup
├── views/
│   ├── landing.ejs          # Public marketing/landing page
│   ├── login.ejs            # Sign-in
│   ├── new-request.ejs      # Employee request submission form
│   ├── employee-dashboard.ejs
│   ├── admin-dashboard.ejs  # Search, filters, and the full request queue
│   ├── request-detail.ejs   # Single request: details, activity timeline, admin controls
│   ├── error.ejs            # Styled error page (400/403/404)
│   └── partials/            # Shared fragments: <head>, nav, flash messages, stat cards
├── public/
│   └── style.css            # Design tokens + all app styling
└── data/                   # SQLite database file (created automatically, gitignored)
```

`server.js` is intentionally a single file rather than split across a router/controller/service layer — the route count and logic are still small enough that the extra structure would add indirection without adding clarity. That's a deliberate scope call, not an oversight.

## Running locally

Requires Node.js (v18+) and npm.

```bash
git clone https://github.com/Afeski/opstify.git
cd opstify
npm install
npm start
```

Then open **http://localhost:3000**. The SQLite database is created automatically on first run — no separate setup step.

There's no real authentication yet (see Roadmap below): sign in with any name and pick a role (Employee or PeopleOps admin) to explore both sides of the product.

## Current status & roadmap

Opstify is an evolving MVP, built incrementally in stages. What's listed above is implemented and working today — this section is deliberately honest about what isn't.

**Not yet built:**
- Real authentication (the current sign-in is a lightweight name/role picker, not password-based accounts)
- Analytics — request volume, category breakdowns, and resolution-time trends
- An AI layer — automatic request classification, priority/routing suggestions, and knowledge-base-backed answers for low-risk questions

These are scoped as future phases, not implied features — Opstify is presented here as what it actually is today: a working internal tool with a clear, deliberate path to grow.

## Screenshots

_Coming soon._

| Landing page | Employee dashboard | Admin dashboard |
|---|---|---|
| _placeholder_ | _placeholder_ | _placeholder_ |

| Request detail & activity log |
|---|
| _placeholder_ |
