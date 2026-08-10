# Nexaa Academic Archive

Nexaa is a local-first academic repository interface for student discovery, staff uploads, review workflows, and department archive management.

## Project Structure

```text
.
├─ index.html
├─ css/
│  └─ styles.css
├─ js/
│  ├─ app-config.js
│  └─ script.js
├─ images/
│  ├─ nexa-logo.png
│  ├─ login-banner-1.jpg
│  ├─ login-banner-2.jpg
│  └─ login-banner-3.jpg
├─ scripts/
│  ├─ dev-server.js
│  └─ dev-all.js
├─ start-nexaa-server.bat
└─ backend/
   ├─ src/server.js
   ├─ package.json
   ├─ package-lock.json
   └─ .env.example
```

## Requirements

- Node.js LTS, which includes `npm`
- Supabase project credentials in `backend/.env`

## Setup

Install backend dependencies:

```powershell
cd backend
npm install
```

The backend reads environment variables from `backend/.env`. Use `.env.example` as the safe template and never commit the real `.env`.

## Run Locally

From the project root:

```powershell
npm run dev
```

Or double-click:

```text
start-nexaa-server.bat
```

Open:

```text
http://localhost:5177/
```

The frontend and API share one browser host. API calls go through:

```text
http://localhost:5177/api/...
```

The web server proxies `/api/*` internally to the backend on port `4000`.

## Auth Flow

- Email/password signup creates a Supabase Auth user.
- Student/staff profile setup is saved to the `profiles` table through the backend.
- Login checks Supabase Auth credentials and returns the database profile role.
- Password reset and OTP flows must complete through the backend; failures are shown directly so they can be fixed.
- Staff/lecturer accounts start as `pending` and must be approved before lecturer tools unlock.
- Admin is an Operations Admin role promoted from an approved staff/lecturer account by Super Admin only.
- Super Admin is root-only through `/root`; it is separate from Admin and controls role promotion, root settings, and Sentinel/security.

## Realtime Setup

Run `supabase-schema.sql` in Supabase first. It adds the notification, maintenance, saved item, material, project, audit, and profile tables, then adds realtime tables to the `supabase_realtime` publication.

The local dev server reads `backend/.env` and exposes only the safe browser values through `/js/runtime-config.js`: `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. The service role key is never exposed to the browser.

With those values present, open browsers receive live notification and maintenance updates from Supabase.

## Staff Uploads

Staff uploads use the protected backend endpoint:

```text
POST /api/files
```

The request includes the Supabase access token and stores protected file metadata in Supabase.

## Production Deployment

Target layout:

- Frontend: Cloudflare Pages, publishing this project root as a static site.
- Backend: Render or another persistent Node host running `npm --prefix backend start`.
- Database/auth: Supabase.

Cloudflare Pages:

```powershell
npm run build
```

Set these public Cloudflare environment variables before building:

```text
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
RECAPTCHA_SITE_KEY
NEXA_API_BASE_URL=https://your-backend.example.com
ROOT_SUPER_ADMIN_EMAIL=your-admin-email@example.com
```

`npm run build` writes `js/runtime-config.js` with browser-safe values only. Do not put service role keys, Gmail app passwords, or root passwords in Cloudflare Pages.

Render backend:

```text
Root directory: backend
Build command: npm install
Start command: npm start
```

Set private Render environment variables:

```text
NODE_ENV=production
PORT=4000
FRONTEND_ORIGINS=https://your-cloudflare-pages-domain
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY
ROOT_SUPER_ADMIN_EMAIL
ROOT_SUPER_ADMIN_PASSWORD
ROOT_SUPER_ADMIN_SECRET_PHRASE
ROOT_SUPER_ADMIN_SESSION_PASSWORD
STAFF_VERIFICATION_PHRASE
GMAIL_USER
GMAIL_APP_PASSWORD
GMAIL_FROM
GMAIL_FROM_NAME
SUPPORT_ADMIN_EMAIL
RECAPTCHA_SECRET_KEY
```

Before first production smoke test, run `supabase-schema.sql` in Supabase.

## Useful Commands

```powershell
npm run dev
npm run web
npm run backend
npm run check
```
