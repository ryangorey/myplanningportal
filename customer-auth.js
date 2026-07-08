// Customer authentication via magic link -- no passwords. A customer enters
// their email, gets a one-time link, clicking it logs them in. Simpler and
// safer than passwords for an app people open twice for one event.

const LINK_TTL_MINUTES = 15;
const SESSION_TTL_DAYS = 30; // longer than staff -- customers shouldn't get logged out mid-planning
const RESEND_COOLDOWN_SECONDS = 60; // don't let someone spam an inbox with links

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function newToken() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

function minutesFromNow(mins) {
  const d = new Date();
  d.setMinutes(d.getMinutes() + mins);
  return d.toISOString();
}

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer (.+)$/i);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Email sending. Uses Resend's REST API (https://resend.com) -- swap this
// one function out if you'd rather use Postmark/SendGrid/Mailgun, nothing
// else in this file needs to change. Needs env.RESEND_API_KEY (a secret)
// and env.EMAIL_FROM (e.g. "myplanningportal <login@myplanningportal.com>").
// ---------------------------------------------------------------------------
async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) {
    // Not configured yet -- log instead of throwing, so the rest of the
    // flow (token creation) still works and is testable before email is
    // wired up. Remove this fallback once RESEND_API_KEY is set.
    console.log(`[email not configured] would send to ${to}: ${subject}`);
    return { skipped: true };
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, html }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Email send failed (${resp.status}): ${text}`);
  }
  return { skipped: false };
}

function magicLinkEmailHtml(link) {
  return `<p>Tap the link below to sign in. It expires in ${LINK_TTL_MINUTES} minutes and works once.</p>
<p><a href="${link}">${link}</a></p>
<p>If you didn't request this, you can ignore this email.</p>`;
}

async function getOrCreateCustomerByEmail(env, email, extra = {}) {
  const normalized = email.toLowerCase().trim();
  const existing = await env.DB.prepare("SELECT id FROM customers WHERE email = ?").bind(normalized).first();
  if (existing) return existing.id;
  const result = await env.DB.prepare(
    "INSERT INTO customers (email, phone, first_name, last_name) VALUES (?, ?, ?, ?)"
  )
    .bind(normalized, extra.phone ?? null, extra.first_name ?? null, extra.last_name ?? null)
    .run();
  return result.meta.last_row_id;
}

// POST /api/auth/customer/request-link  { email, portal_url }
// Always responds with a generic success message, whether or not the email
// is one we recognize -- this avoids leaking which emails have accounts.
async function requestLink(request, env, json) {
  const body = await request.json().catch(() => null);
  if (!body || !body.email) {
    return json({ error: "Email is required." }, 400);
  }
  const email = body.email.toLowerCase().trim();
  const genericResponse = { message: "If that email has an account, a login link is on its way." };

  const customerId = await getOrCreateCustomerByEmail(env, email);

  // Cooldown: if there's a recent unused token, don't mint another / don't
  // send another email. Still return the generic success message either way.
  const recent = await env.DB.prepare(
    `SELECT token FROM customer_login_tokens
     WHERE customer_id = ? AND used = 0 AND created_at > datetime('now', ?)
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(customerId, `-${RESEND_COOLDOWN_SECONDS} seconds`)
    .first();
  if (recent) {
    return json(genericResponse);
  }

  const token = newToken();
  await env.DB.prepare(
    "INSERT INTO customer_login_tokens (token, customer_id, expires_at) VALUES (?, ?, ?)"
  )
    .bind(token, customerId, minutesFromNow(LINK_TTL_MINUTES))
    .run();

  const portalUrl = body.portal_url || "https://myplanningportal.com";
  const link = `${portalUrl.replace(/\/$/, "")}/auth/verify?token=${token}`;

  await sendEmail(env, {
    to: email,
    subject: "Your sign-in link",
    html: magicLinkEmailHtml(link),
  });

  return json(genericResponse);
}

// POST /api/auth/customer/verify  { token } -> { token: sessionToken, customer }
async function verifyLink(request, env, json) {
  const body = await request.json().catch(() => null);
  if (!body || !body.token) {
    return json({ error: "Token is required." }, 400);
  }

  const row = await env.DB.prepare(
    `SELECT clt.customer_id, clt.expires_at, clt.used, c.email, c.first_name, c.last_name
     FROM customer_login_tokens clt
     JOIN customers c ON c.id = clt.customer_id
     WHERE clt.token = ?`
  )
    .bind(body.token)
    .first();

  if (!row) return json({ error: "That link isn't valid. Request a new one." }, 401);
  if (row.used) return json({ error: "That link has already been used. Request a new one." }, 401);
  if (new Date(row.expires_at) < new Date()) {
    return json({ error: "That link has expired. Request a new one." }, 401);
  }

  await env.DB.prepare("UPDATE customer_login_tokens SET used = 1 WHERE token = ?").bind(body.token).run();

  const sessionToken = newToken();
  await env.DB.prepare(
    "INSERT INTO customer_sessions (token, customer_id, expires_at) VALUES (?, ?, ?)"
  )
    .bind(sessionToken, row.customer_id, daysFromNow(SESSION_TTL_DAYS))
    .run();

  return json({
    token: sessionToken,
    customer: { id: row.customer_id, email: row.email, first_name: row.first_name, last_name: row.last_name },
  });
}

// POST /api/auth/customer/logout
async function logoutCustomer(request, env, json) {
  const token = bearerToken(request);
  if (token) {
    await env.DB.prepare("DELETE FROM customer_sessions WHERE token = ?").bind(token).run();
  }
  return json({ ok: true });
}

// Looks up the logged-in customer for a request, or null. Mirrors
// getSessionStaff in auth.js but reads customer_sessions instead, so a
// customer token can never accidentally pass a staff check or vice versa.
async function getSessionCustomer(request, env) {
  const token = bearerToken(request);
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT c.id, c.email, c.first_name, c.last_name, c.phone, cs.expires_at
     FROM customer_sessions cs
     JOIN customers c ON c.id = cs.customer_id
     WHERE cs.token = ?`
  )
    .bind(token)
    .first();

  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    await env.DB.prepare("DELETE FROM customer_sessions WHERE token = ?").bind(token).run();
    return null;
  }
  return row;
}

// GET /api/me -- proves the session works and gives the app something to
// call right after login.
async function getMe(request, env, json) {
  const customer = await getSessionCustomer(request, env);
  if (!customer) return json({ error: "Sign in required." }, 401);
  return json(customer);
}

// GET /api/me/bookings -- the logged-in customer's own bookings only.
async function getMyBookings(request, env, json) {
  const customer = await getSessionCustomer(request, env);
  if (!customer) return json({ error: "Sign in required." }, 401);

  const { results } = await env.DB.prepare(
    `SELECT b.id, b.event_date, b.event_type, b.status, b.package_total, b.deposit_paid,
            b.allow_full_payment, b.allow_retainer_payment, b.allow_custom_payment,
            br.slug AS brand_slug, br.display_name AS brand_name, p.name AS package_name
     FROM bookings b
     JOIN brands br ON br.id = b.brand_id
     LEFT JOIN packages p ON p.id = b.package_id
     WHERE b.customer_id = ?
     ORDER BY b.event_date DESC`
  )
    .bind(customer.id)
    .all();

  return json(results);
}

export { requestLink, verifyLink, logoutCustomer, getSessionCustomer, getMe, getMyBookings };
