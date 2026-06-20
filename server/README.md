# Book of Business — Server Edition (deploy on Render)

This is the **shared, multi-user** version of Book of Business. Unlike the
single `book-of-business.html` file (which runs entirely in one browser on one
computer), the server edition runs as a hosted application that several people
log into from different computers and work on the same live books.

It gives you the four things the single file can't:

- **Real login** — email + password, hashed; sessions; no bypass.
- **Multiple organisations (true multi-tenant)** — each client's books are a
  separate, isolated database; a user only sees the orgs they belong to.
- **Team invitations + roles** — an owner invites teammates by email and gives
  each a role (Adviser / Standard / Read Only / Invoice Only). Roles are
  **enforced** on the server: a Read-Only teammate can view everything but
  cannot change anything.
- **A REST API + OpenAPI docs** — a documented, programmable interface at
  `/docs` so other systems can integrate.

---

## What you need

- A **Render** account (https://render.com) — free to create.
- This repository pushed to **GitHub** (Render deploys from a Git repo).
- A credit card on Render **only if** you use the paid Starter plan (needed for
  a persistent disk — see below). You can trial on the free plan first.

You do **not** need to install anything on your own computer.

---

## Deploy in ~5 clicks (Blueprint)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, and select your repo.
3. Render reads `render.yaml` and proposes a **web service** + a **1 GB
   persistent disk** + a generated `COOKIE_SECRET`. Click **Apply**.
4. Wait for the first build (a few minutes — it compiles the native database
   module). When it's live, open the service URL Render gives you
   (e.g. `https://book-of-business.onrender.com`).
5. Back in Render → your service → **Environment**, set **`PUBLIC_URL`** to that
   exact URL and save (this makes invitation links point to the right place).
   The service restarts automatically.

That's it. Open the URL, click **Create account**, and you're the owner of your
first organisation.

---

## Important notes (please read once)

**The persistent disk is essential.** Render's web services have a *temporary*
filesystem by default — without the disk in `render.yaml`, your data would be
wiped on every restart or deploy. The blueprint attaches a disk mounted at
`/var/data`, where all the SQLite databases live. A persistent disk requires the
**Starter** plan (roughly **$7/month** for the web service at the time of
writing — check Render's current pricing).

**Free plan caveats** (if you trial without a disk first): the service **sleeps**
after inactivity (the first visit takes ~30–60s to wake), and **data does not
persist** across restarts. Fine for a quick look; not for real books.

**Backups.** Your books are the files under `/var/data`. Use **Settings →
Backup & data** inside the app to download a backup of the org you're in, and/or
enable Render disk snapshots. Treat backups seriously — this is real financial
data.

**Security.** This is now an internet-facing app holding financial records.
Only invite people you trust, use strong passwords, and keep the deployment
updated. Roles limit what a teammate can do, but an Adviser/owner can do
everything.

---

## Running it locally (optional, for testing)

```bash
npm ci
npm run build:server
DATA_DIR=./data PORT=3000 npm run start:server
# open http://localhost:3000/docs for the API explorer
```

## The API

- Interactive docs + OpenAPI spec: **`/docs`** (JSON at `/docs/json`).
- Auth: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me`.
- Everything in the accounting engine: `POST /api/rpc` with
  `{ "method": "reports.profitAndLoss", "args": [{ "from": "...", "to": "..." }] }`
  and an `x-tenant-id` header naming the organisation.
- Clean REST resources for integrations: `/api/v1/contacts`, `/api/v1/invoices`,
  `/api/v1/reports/{trial-balance,profit-and-loss,balance-sheet}`.

---

## The full visual app (not just the API)

Open the service URL in a browser and you get the **complete Book of Business
interface** — the same screens as the single-file edition — but multi-user:

1. **Sign in / create account** at the URL. The first account creates your
   organisation and you become its owner.
2. **Organisation switcher** sits in the top bar — flip between any orgs you
   belong to. Your name and role show beside it, with a **Sign out** button.
3. **Invite teammates** from **Settings → Team** (owners/advisers only): enter
   an email, pick a role, and share the invite link. They sign up (or in) with
   that email and land straight in your organisation with that role.
4. **Roles are enforced everywhere** — a Read-Only teammate sees every screen
   and report but every "save/approve/void" is refused by the server, with the
   read-only banner shown at the top.
5. **Backups** — Settings → Backup & data downloads the current organisation's
   database from the server.

The build pipeline produces this UI (`dist-server-ui/`) and the Docker image
serves it automatically — nothing extra to configure.

## Built & tested

Accounts, login/sessions, multi-tenant isolation, team invitations with
enforced roles, the full accounting engine over HTTP, REST resources, OpenAPI
docs, **and the complete web UI served from the server**. Covered by an
end-to-end server test suite plus the existing engine tests (82 in total).

**Invitation delivery:** invites are links you share (copy from Settings → Team).
Automatic emailing is an optional later add-on that needs an email provider
(e.g. Resend/SendGrid) and its API key.
