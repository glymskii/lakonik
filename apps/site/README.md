# lakonik.app — статический сайт

Лендинг, `/privacy`, `/terms`, `/support`, `/join/<token>` (страница приглашения, Universal Link), `/.well-known/apple-app-site-association`.
Хостинг — Vercel (проект `lakonik-site`), DNS домена `lakonik.app` — тоже в Vercel (`api` → CNAME на Railway).

```bash
cd apps/site && vercel --prod
```
