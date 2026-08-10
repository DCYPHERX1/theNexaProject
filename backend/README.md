# NEXA Security API

This backend is intentionally separate from the static frontend so both can be hosted independently.

## What It Provides

- Supabase Auth login/session verification
- Role checks from `public.profiles`
- Super Admin-only security endpoints
- Helmet, CORS, rate limiting, and Zod validation
- Protected upload metadata in Supabase
- Local protected file storage at `uploads/protected`
- Audit logs and security alerts
- Lockdown / warning / maintenance status modes

## Setup

1. Copy `.env.example` to `.env`.
2. Add the Supabase service role key from the Supabase dashboard.
3. Install dependencies:

```bash
npm install
```

4. Run locally:

```bash
npm run dev
```

The frontend can point to this API by setting:

```html
<script>
  window.NEXA_API_BASE_URL = "http://localhost:4000";
</script>
```

or by storing `nexa-api-base-url` in browser localStorage.

## Important

Never expose `SUPABASE_SERVICE_ROLE_KEY` in frontend code. It belongs only on this backend.
