/**
 * Diazara → Zoho CRM Webhook
 * ───────────────────────────
 * Receives a call payload from Diazara and upserts:
 *   1. Account  (matched on company name or phone)
 *   2. Contact  (matched on email or phone)
 *   3. Lead     (created only when no Account match exists)
 *
 * Deploy anywhere Node.js runs (Railway, Render, Fly.io, etc.)
 *
 * Required env vars:
 *   ZOHO_CLIENT_ID
 *   ZOHO_CLIENT_SECRET
 *   ZOHO_REFRESH_TOKEN
 *   ZOHO_BASE_URL        (e.g. https://www.zohoapis.com)
 *   WEBHOOK_SECRET       (optional — sent by Diazara as X-Webhook-Secret)
 *   PORT                 (default 3000)
 */

const http = require("http");

// ─── Token cache ────────────────────────────────────────────────────────────
let _accessToken = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry) return _accessToken;

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
  });

  const res = await fetch(
    `https://accounts.zoho.com/oauth/v2/token?${params}`,
    { method: "POST" }
  );
  const data = await res.json();

  if (!data.access_token) throw new Error("Failed to refresh Zoho token: " + JSON.stringify(data));

  _accessToken = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _accessToken;
}

// ─── Zoho API helpers ────────────────────────────────────────────────────────
const BASE = process.env.ZOHO_BASE_URL || "https://www.zohoapis.com";

async function zohoRequest(method, path, body) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/crm/v3${path}`, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function upsert(module, record, duplicateCheckFields) {
  return zohoRequest("POST", `/${module}/upsert`, {
    data: [record],
    duplicate_check_fields: duplicateCheckFields,
  });
}

// ─── Field mapping ───────────────────────────────────────────────────────────
/**
 * Adapt this section to match Diazara's actual webhook payload.
 * Diazara docs: https://docs.diazara.com  (check their webhook schema)
 *
 * Expected Diazara payload shape (adjust as needed):
 * {
 *   call_id, direction, duration_seconds, recording_url,
 *   caller: { name, phone, email },
 *   company: { name, website, phone },
 *   notes, tags, agent_name, started_at
 * }
 */
function mapAccount(payload) {
  const c = payload.company || {};
  return {
    Account_Name: c.name || payload.caller?.name || "Unknown",
    Phone: c.phone || payload.caller?.phone,
    Website: c.website,
    Description: payload.notes,
    // Zoho custom field example — add yours here:
    // Last_Diazara_Call: payload.started_at,
  };
}

function mapContact(payload, accountId) {
  const caller = payload.caller || {};
  const nameParts = (caller.name || "").split(" ");
  return {
    First_Name: nameParts[0] || "",
    Last_Name: nameParts.slice(1).join(" ") || nameParts[0] || "Unknown",
    Phone: caller.phone,
    Email: caller.email,
    Account_Name: accountId ? { id: accountId } : undefined,
    Description: payload.notes,
  };
}

function mapLead(payload) {
  const caller = payload.caller || {};
  const nameParts = (caller.name || "").split(" ");
  return {
    First_Name: nameParts[0] || "",
    Last_Name: nameParts.slice(1).join(" ") || nameParts[0] || "Unknown",
    Phone: caller.phone,
    Email: caller.email,
    Company: payload.company?.name || "Unknown",
    Lead_Source: "Phone Call",
    Description: payload.notes,
  };
}

// ─── Core sync logic ─────────────────────────────────────────────────────────
async function syncCallToZoho(payload) {
  const log = [];

  // 1. Upsert Account (match on Account_Name)
  let accountId = null;
  const companyName = payload.company?.name;

  if (companyName) {
    const acctResult = await upsert("Accounts", mapAccount(payload), ["Account_Name"]);
    const acctRecord = acctResult?.data?.[0];
    if (acctRecord?.details?.id) {
      accountId = acctRecord.details.id;
      log.push({ module: "Account", status: acctRecord.status, id: accountId });
    } else {
      log.push({ module: "Account", status: "error", detail: acctResult });
    }
  } else {
    log.push({ module: "Account", status: "skipped", reason: "no company name" });
  }

  // 2. Upsert Contact (match on Email, fallback to Phone)
  const callerEmail = payload.caller?.email;
  const callerPhone = payload.caller?.phone;
  const contactDupFields = callerEmail ? ["Email"] : ["Phone"];

  if (callerEmail || callerPhone) {
    const contactResult = await upsert("Contacts", mapContact(payload, accountId), contactDupFields);
    const contactRecord = contactResult?.data?.[0];
    log.push({
      module: "Contact",
      status: contactRecord?.status,
      id: contactRecord?.details?.id,
    });
  } else {
    log.push({ module: "Contact", status: "skipped", reason: "no email or phone" });
  }

  // 3. Create Lead only if no Account was matched/created
  if (!accountId) {
    const leadResult = await upsert("Leads", mapLead(payload), callerEmail ? ["Email"] : ["Phone"]);
    const leadRecord = leadResult?.data?.[0];
    log.push({
      module: "Lead",
      status: leadRecord?.status,
      id: leadRecord?.details?.id,
    });
  } else {
    log.push({ module: "Lead", status: "skipped", reason: "account exists" });
  }

  return log;
}

// ─── HTTP server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET;

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/webhook/diazara") {
    res.writeHead(404).end("Not found");
    return;
  }

  // Optional secret validation
  if (SECRET && req.headers["x-webhook-secret"] !== SECRET) {
    res.writeHead(401).end("Unauthorized");
    return;
  }

  // Read body
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400).end("Invalid JSON");
      return;
    }

    try {
      const log = await syncCallToZoho(payload);
      console.log("[diazara-webhook]", JSON.stringify({ ts: new Date().toISOString(), log }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, log }));
    } catch (err) {
      console.error("[diazara-webhook] error", err);
      res.writeHead(500).end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Diazara→Zoho webhook listening on :${PORT}`);
  console.log(`POST http://localhost:${PORT}/webhook/diazara`);
});
