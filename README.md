# Blizz

Blizz web app plus Node.js authentication backend.

## Run

```bash
npm install
npm start
```

Then open `http://localhost:8080`.

## Current account features
- Create account with username, display name, email, password, date of birth and gender
- Password hashing with Node.js scrypt
- Login with username or email
- Server-issued bearer sessions
- Current-user endpoint
- Basic profile update
- Logout
- Blizz Games front end with the 5,000-question bank

## Production note
The JSON account store is suitable for a test/development deployment only. Before a public launch, migrate accounts/sessions to PostgreSQL or another production database, add email verification/password reset, rate limiting, abuse protection, HTTPS, backups, monitoring, secure secrets, and server-side admin/Founder authorization.

Do not commit `data/users.json`, `data/sessions.json`, `.env`, passwords, API keys, or other secrets.


## Creator Experience Update
This build adds a Blizz-original creator dock with a centered Create button, media selection/preview, sound selection, editing entry point, drafts, and post flow. It is intentionally an original Blizz interface rather than a copy of another app. Media publishing is currently a front-end test flow; production media storage/transcoding/moderation still requires backend services.
