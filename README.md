# WAFLOW

A self-hosted WhatsApp automation panel, built on
[Baileys](https://github.com/WhiskeySockets/Baileys). Baileys talks to WhatsApp
directly over its WebSocket protocol, so there is no headless Chromium and each
session uses very little memory or CPU.

What it does:

- **Multi-user and multi-session.** Each user logs in with mobile number and
  password, then links one or more WhatsApp numbers by scanning a QR code.
- **Bulk sending.** Send manually, from a CSV upload, or from a saved CSV
  library. Messages support `{column}` placeholders and an optional image, and
  can be scheduled for later.
- **Public HTTP API** (`POST /send-message`), protected by a per-user API key,
  an IP allowlist and a rate limit.
- **Chatbot flows.** A visual flow builder with these node types: message,
  menu, question, AI reply, API call (CRM/ERP) and end. Flows are triggered by
  incoming messages. Voice notes are transcribed with OpenAI Whisper or Gemini.
- **AI providers** (OpenAI, Anthropic, Gemini, DeepSeek). Each user stores
  their own API keys on `/integrations`.
- **Webhooks** for message received, flow completed and delivery status.
- **Delivery tracking** (sent, delivered, read), a job queue dashboard, and
  retries.
- **Anti-ban safety:** a 7-day warm-up ramp, hourly and daily caps, business
  hours, a minimum delay of about 4 seconds with jitter, `STOP` opt-out with a
  blocklist, and a reply-ratio health check.
- **Number verification** (checks whether a number is on WhatsApp), message
  templates, and an admin page for managing users.

---

## Architecture at a glance

```
Browser ──HTTP/Socket.IO──► Express (src/index.js) ──► Baileys sockets (one per WhatsApp session, in memory)
                                   │                          ▲
                                   ▼                          │
                         BullMQ queue "send" ──► Worker (src/queue/worker.js)
                                   │
                                   ▼
                                 Redis  (auth creds, queue, counters, opt-outs, templates, delivery status)
                         + JSON files on disk (users, flows, settings, media)
```

| Path | Purpose |
|---|---|
| `src/index.js` | Entry point. Express, Socket.IO, routes, the queue worker and the flow-state sweeper |
| `src/config/` | `.env` loading, Redis client, Winston logger, path constants |
| `src/whatsapp/` | Baileys session lifecycle (`sessionManager.js`), Redis-backed auth state, sending |
| `src/queue/` | BullMQ queue, job options and scheduling, worker (safety gates, then send) |
| `src/routes/` | HTTP routes: auth, sessions, send/CSV/API, queue, flows, templates, safety, blocklist, admin, integrations |
| `src/sockets/` | Socket.IO handlers: create/join/delete session, live send, number verify |
| `src/flows/` | Flow engine, flow storage, per-contact conversation state, completed responses |
| `src/ai/` | AI provider adapters, transcription, per-user AI key storage |
| `src/safety/` | Warm-up, caps, business hours, health tracking |
| `src/moderation/` | `STOP` opt-out listener, blocklist |
| `src/delivery/` | Maps WhatsApp receipts to job delivery status |
| `src/webhooks/` | Outgoing webhook config and dispatch |
| `views/` | HTML pages (EJS rendered for a few) |
| `public/` | CSS, JS, uploaded images (`public/images`, `public/uploads`) |

### Where data lives

**Back these up.** They are not in git.

| Location | Contents |
|---|---|
| `.env` | Port, session secret, Redis connection, queue name |
| `users.json` | User accounts (bcrypt hashes, API keys, admin flag). Edited by the admin page |
| `allowedIPs.json` | IPs allowed to call `POST /send-message`. Re-read on every request, so you can edit it without a restart |
| `data/` | Flows, flow state, flow responses, flow media, CSV library, per-session safety settings, AI keys (**plain text**), webhooks |
| `public/images/` | Images attached to sends |
| `logs/` | `app-YYYY-MM.log` and `error-YYYY-MM-DD.log`, rotated automatically |
| **Redis** | WhatsApp login creds (`baileys:auth:*`), BullMQ queue, delivery status (`delivery:*`), opt-outs (`optout:*`), safety counters (`safety:*`), templates |

> If the Redis data is lost, every WhatsApp number has to be re-linked by
> scanning its QR code again. Turn on Redis persistence (see below).

---

## VPS setup (Ubuntu 22.04 / 24.04)

### 1. System packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl build-essential nginx redis-server ufw

# Node.js 20 LTS or newer (the code uses global fetch, FormData and Blob)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### 2. Redis

Redis must be running before the app starts. Keep it bound to localhost and
turn on persistence so WhatsApp logins survive a reboot:

```bash
sudo nano /etc/redis/redis.conf
#   bind 127.0.0.1 ::1
#   appendonly yes
#   supervised systemd
sudo systemctl enable --now redis-server
sudo systemctl restart redis-server
redis-cli ping            # -> PONG
```

### 3. Get the code

```bash
sudo mkdir -p /var/www && sudo chown $USER /var/www
cd /var/www
git clone <your-repo-url> waflow
cd waflow
npm ci --omit=dev
```

### 4. Configure

```bash
cp .env.example .env
cp users.example.json users.json
cp allowedIPs.example.json allowedIPs.json
```

Edit `.env`:

| Key | Value |
|---|---|
| `PORT` | Internal port, `3001` by default. nginx proxies to it |
| `NODE_ENV` | `production` **only after HTTPS works** (see step 6). In production the session cookie is HTTPS-only, so login silently fails over plain HTTP |
| `SESSION_SECRET` | A long random string: `openssl rand -hex 32` |
| `REDIS_HOST` / `REDIS_PORT` | `127.0.0.1` / `6379` |
| `QUEUE_NAME` | BullMQ queue name. Use a different value if another app shares this Redis |
| `LOG_LEVEL` | `info` (use `debug` for troubleshooting) |

**First admin user.** `users.example.json` has an admin with mobile
`3000000000` and password `changeme`. Change the mobile in `users.json`, then
log in, open `/admin`, create your real users, and remove or re-create the
placeholder. To set a password by hand:

```bash
node -e "console.log(require('bcryptjs').hashSync('YOUR_PASSWORD', 10))"
# paste the output as "passHash" in users.json
```

Fields per user: `mobile` is the login ID and also the prefix of that user's
session IDs. `country` is the default country code used to format numbers
(for example `92`). `apiKey` is used for the HTTP API; reset it from
`/api-settings` or `/admin`. Set `isAdmin: true` to give access to `/admin`.

**API allowlist.** Add every server IP that will call `POST /send-message`
to `allowedIPs.json`.

### 5. Start with PM2

```bash
pm2 start ecosystem.config.cjs     # process name: waflow
pm2 save
pm2 startup                         # run the command it prints, so it starts on boot
pm2 logs waflow
```

> **Run exactly one instance.** Live WhatsApp sockets are held in process
> memory, so never use PM2 cluster mode or `instances > 1`.

### 6. nginx + HTTPS

Socket.IO needs the WebSocket upgrade headers. Without them, QR codes and the
live send progress will not work.

```nginx
# /etc/nginx/sites-available/waflow
server {
    listen 80;
    server_name wa.example.com;

    client_max_body_size 25M;   # CSV / image / flow media uploads

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/waflow /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d wa.example.com
```

Once `https://` works, set `NODE_ENV=production` in `.env` and run
`pm2 restart waflow`.

`X-Forwarded-For` is required. The API IP allowlist reads the client IP from
it, and the app trusts one proxy hop.

### 7. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Do **not** open port 3001 or 6379 to the internet. The app listens on
`0.0.0.0`, so the firewall is what keeps 3001 private.

### 8. Updating

```bash
cd /var/www/waflow
git pull
npm ci --omit=dev
pm2 restart waflow
```

---

## Things to know before running it

**After a restart, sessions must be re-opened.** The WhatsApp creds stay in
Redis, but the list of live sessions is in memory and is **not** reconnected
automatically on boot. After a restart or deploy, each user opens the panel
and creates the session again with the **same session name**. It reconnects
from Redis without a QR scan. While a session is not open, the worker
**drops** queued jobs for it (`Session deleted, dropping job`). Avoid
restarting while a campaign is running.

**Session IDs** are `<userMobile>-<name>`, for example `3004194395-sales`.
API calls must use the full ID in `sessionId`.

**Sending limits and safety rules:**

- The minimum delay between messages is 4 s plus up to 3 s of random jitter.
- The worker's global limit is 5 sends per minute, with concurrency 2.
- Warm-up caps are 20/day on day 0–1, 50 on days 2–3, 100 on days 4–6, then
  200/day and 25/hour. You can override them per session on `/safety`.
- A message that hits a cap or falls outside business hours is **deferred**,
  not dropped.
- A CSV can have at most **200 rows**. Every column whose name starts with
  `phone` is treated as a number.
- Numbers that are opted out, or that are not on WhatsApp, are skipped.
- A contact who replies `STOP` is added to the blocklist.
- Times (business hours, daily caps) use the **server's timezone**. Set it
  with `sudo timedatectl set-timezone Asia/Karachi` (or your zone).

**Number formatting.** Digits are kept. If the number does not already start
with the user's country code, the last 10 digits are prefixed with it.

**Bans.** If WhatsApp returns forbidden or logged out, the session is torn
down and its pending jobs are removed. The number must be re-linked.

**Flow state** (a contact partway through a menu) expires after 24 hours of
silence.

**Security notes:**

- AI provider keys in `data/ai-settings/*.json` are stored in plain text.
  Restrict access with `chmod 700 data`.
- `/send-message` requires the `x-api-key` header **and** an allowlisted IP,
  and is limited to 10 requests per minute per user.
- Login has no rate limit or lockout. Use strong passwords, and consider
  adding nginx `limit_req` on `/login`.

### HTTP API example

```bash
curl -X POST https://wa.example.com/send-message \
  -H "x-api-key: WF_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"3004194395-sales","phone":"03001234567","msg":"Hello","scheduleAt":"2026-10-03T09:00:00"}'
```

Optional fields: `delay` in ms (minimum 4000) and `scheduleAt` as an ISO
datetime. Error responses include `session_not_ready`, `session_banned`,
`number_opted_out`, `invalid_number` and `ip not allowed`.

### Backups

```bash
# app files
tar czf waflow-backup-$(date +%F).tgz -C /var/www/waflow .env users.json allowedIPs.json data public/images
# redis (with appendonly yes, copy /var/lib/redis/)
redis-cli BGSAVE && sudo cp /var/lib/redis/dump.rdb ~/redis-$(date +%F).rdb
```

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Login form just reloads | `NODE_ENV=production` while serving plain HTTP. Use HTTPS or unset it |
| QR never appears | nginx is missing the WebSocket `Upgrade`/`Connection` headers |
| Jobs "complete" but nothing sent after a deploy | The session was not re-opened after restart (see above) |
| `ip not allowed` from the API | Add the caller IP to `allowedIPs.json`. Check that nginx sends `X-Forwarded-For` |
| `ECONNREFUSED 6379` in logs | Redis is not running: `sudo systemctl status redis-server` |
| Messages stuck as "delayed" | A cap or business-hours limit was hit. Check `/safety` |

## Local development

```bash
npm install
cp .env.example .env && cp users.example.json users.json && cp allowedIPs.example.json allowedIPs.json
npm run dev        # node --watch, http://localhost:3001
```

Requires a local Redis on `127.0.0.1:6379`.
