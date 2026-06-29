# Diazara → Zoho CRM Webhook

Receives a webhook from Diazara after each call and automatically creates or updates:
- **Account** (matched on company name)
- **Contact** (matched on email, fallback to phone)
- **Lead** (only when no company/account is identified)

---

## Setup

### 1. Get your Zoho OAuth credentials

Go to https://api-console.zoho.com and create a **Server-based Application**.

- Scopes needed: `ZohoCRM.modules.ALL`
- Generate a **refresh token** using the OAuth flow once, then store it as an env var.

### 2. Set environment variables

```
ZOHO_CLIENT_ID=your_client_id
ZOHO_CLIENT_SECRET=your_client_secret
ZOHO_REFRESH_TOKEN=your_refresh_token
ZOHO_BASE_URL=https://www.zohoapis.com
WEBHOOK_SECRET=any_secret_string   # optional but recommended
PORT=3000
```

### 3. Deploy

**Local test:**
```bash
node server.js
```

**Railway / Render / Fly.io:**
Push the folder, set the env vars in the dashboard, and deploy. They'll give you a public URL like `https://your-app.railway.app`.

### 4. Point Diazara at your webhook

In Diazara → Settings → Webhooks, add:
```
URL:    https://your-app.railway.app/webhook/diazara
Method: POST
Secret: <your WEBHOOK_SECRET>
Event:  Call completed  (or whichever event fires after a call)
```

---

## Payload mapping

The `server.js` file has a `mapAccount`, `mapContact`, and `mapLead` function. Edit these to match whatever fields Diazara sends. Check your Diazara webhook docs or paste a sample payload and I can update the mapping for you.

---

## Logic flow

```
Diazara call ends
      │
      ▼
POST /webhook/diazara
      │
      ├─ company.name present?
      │       ├─ YES → Upsert Account (match: Account_Name)
      │       │         └─ Upsert Contact linked to that Account
      │       └─ NO  → Upsert Contact (no account link)
      │                 └─ Upsert Lead (company unknown)
      │
      └─ Returns JSON log of what was created/updated
```

---

## Health check

```
GET /health  →  {"ok":true}
```
