# Blizz — PostgreSQL Foundation Upgrade

This version moves Blizz's persistent account and platform data from Render's temporary local JSON storage to PostgreSQL.

## Data moved to PostgreSQL
- Accounts and profiles
- Login sessions
- Password reset/OTP records
- Blizz Coin wallets
- Coin/gift/payment ledger
- Creator earnings and finalized periods
- Support tickets
- AI support event logs

The database schema is created automatically when the server starts. If legacy JSON user data is present during deployment, the server imports users once when the PostgreSQL users table is empty.

## Render setup
1. Create the Blizz PostgreSQL database in the same region as the Blizz web service.
2. On the database page, use **Connect** to obtain the database connection information.
3. In the existing Blizz Web Service: **Environment → Add Environment Variable**.
4. Add `DATABASE_URL` using Render's **internal database URL**. Do not paste the database password into GitHub or into the code.
5. Keep `DATABASE_SSL=true` unless Render specifically instructs otherwise.
6. Deploy the repository update.

## AI
Set `OPENAI_API_KEY` and `OPENAI_MODEL` in Render. The key stays server-side.

## Password recovery
The API supports email or SMS OTP recovery. Configure Resend for email and/or Termii for SMS. Until a provider is configured, password recovery cannot send a real code in production.

## Important testing note
Render's Free PostgreSQL is intended for testing and has an expiry date. Upgrade before public production launch so Blizz accounts and financial records remain permanently available.

## Security
- Never commit API keys, database URLs, passwords, payment secrets, or user data.
- Financial balances are server/database authoritative.
- Gift transfers and payment credits use database transactions to prevent partial updates.
- Payment references have a unique index to prevent duplicate coin credits.
- AI cannot change Founder authority and is not the source of financial truth.


## Blizz Creator & Media update
This version adds PostgreSQL-backed posts/media, a full-screen creator page, video/image upload (60 MB max), sound upload and original Blizz sound files, post captions/hashtags/mentions/visibility, real feed tabs (For You/Following/Friends), follow/unfollow storage, and profile video loading. Commercial music catalogs still require appropriate licensing/provider integration. Advanced video operations such as true transcoding/cutting are preview controls until a media-processing worker is connected.
