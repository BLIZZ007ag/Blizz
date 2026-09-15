# Blizz — real PostgreSQL web foundation

This package is a real deployable Blizz foundation, not a phone-test overlay.

## Included
- PostgreSQL-backed accounts and persistent sessions
- Login/logout/profile editing
- Profile pictures stored in PostgreSQL
- Real photo/video post upload and feed
- Following, likes and comments
- Search for users/posts
- Real account-to-account text messaging with polling
- Notifications for follows, likes, comments, messages and matches
- Gender-aware matching with persistent like/pass actions and mutual matches
- Game invite storage/API and working Games navigation
- Real camera + microphone permission flow, front/rear switching and gallery posting
- Feed tabs: Following / Friends / For You with horizontal swipe
- White-screen-safe startup/error UI

## Render
Keep the existing `DATABASE_URL`. Do not commit secrets. Set `NODE_ENV=production` for production.

Start command: `node server.js`

The database tables are created/migrated automatically on startup.
