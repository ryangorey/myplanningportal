// Customer authentication -- real accounts with email + password. Sign up
// once (confirming email ownership via a one-time link, same as before),
// then log in with a password every time after -- no more waiting on an
// email for routine sign-ins. Password hashing reuses the exact PBKDF2
// helpers auth.js already built for staff, so there's one implementation
// of "hash a password" in the whole app, not two.

import { hashPassword, verifyPassword } from "./auth.js";

const VERIFY_TTL_MINUTES = 60 * 24; // 24 hours -- this is a one-time signup
// confirmation, not a routine login link, so it can be more generous than
// the old magic link's window was.
const SESSION_TTL_DAYS = 30; // customers shouldn't get logged out mid-planning
const RESEND_COOLDOWN_SECONDS = 60; // don't let someone spam an inbox
const STAFF_LINK_TTL_YEARS = 50; // effectively no expiration -- see createStaffLoginLink

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

function yearsFromNow(years) {
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
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
// Only used at signup time now, for the one-time "confirm your email" step
// -- routine logins never touch this.
//
// Deliberately never throws: a Resend-side problem (revoked API key,
// domain verification lapsed, account suspended, rate limited, network
// blip) should never take down signup itself. The customer's account row
// is already committed to D1 by the time this runs, so if the email fails
// to send, the account still exists -- they can retry via "Didn't get a
// confirmation email?" once Resend is working again. Letting this throw
// used to mean a Resend outage turned into a hard failure on every signup
// and every resend-verification request, not just a missing email.
// ---------------------------------------------------------------------------
async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) {
    console.log(`[email not configured] would send to ${to}: ${subject}`);
    return { sent: false, reason: "not_configured" };
  }
  try {
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
      console.error(`Resend email send failed (${resp.status}) to ${to}: ${text}`);
      return { sent: false, reason: `resend_${resp.status}` };
    }
    return { sent: true };
  } catch (err) {
    // Network failure talking to Resend at all (DNS, timeout, etc.).
    console.error(`Resend email send threw for ${to}:`, err);
    return { sent: false, reason: "network_error" };
  }
}

function verifyEmailHtml(link) {
  return `<p>Tap the link below to confirm your email and finish creating your account. It expires in 24 hours and works once.</p>
<p><a href="${link}">${link}</a></p>
<p>If you didn't create an account, you can ignore this email.</p>`;
}

async function sendVerificationEmail(env, customerId, email, portalUrl) {
  const token = newToken();
  await env.DB.prepare(
    "INSERT INTO customer_login_tokens (token, customer_id, expires_at) VALUES (?, ?, ?)"
  )
    .bind(token, customerId, minutesFromNow(VERIFY_TTL_MINUTES))
    .run();

  const base = (portalUrl || "https://myplanningportal.com").replace(/\/$/, "");
  const link = `${base}/verify-email.html?token=${token}`;

  await sendEmail(env, {
    to: email,
    subject: "Confirm your account",
    html: verifyEmailHtml(link),
  });
}

// POST /api/auth/customer-signup  { email, password, first_name?, last_name?, phone?, portal_url }
// If a customer row already exists for this email (created earlier by a
// booking or by staff, never claimed with a password) this "claims" it
// instead of erroring -- that's the normal path for most real signups here,
// since a booking usually happens before someone bothers making an account.
async function signup(request, env, json) {
  const body = await request.json().catch(() => null);
  if (!body || !body.email || !body.password) {
    return json({ error: "Email and password are required." }, 400);
  }
  if (body.password.length < 8) {
    return json({ error: "Password needs to be at least 8 characters." }, 400);
  }

  const email = body.email.toLowerCase().trim();
  const passwordHash = await hashPassword(body.password);

  const existing = await env.DB.prepare(
    "SELECT id, password_hash FROM customers WHERE email = ?"
  )
    .bind(email)
    .first();

  let customerId;
  if (existing) {
    if (existing.password_hash) {
      return json({ error: "An account with that email already exists. Try signing in instead." }, 409);
    }
    await env.DB.prepare(
      `UPDATE customers SET password_hash = ?, email_verified = 0,
              first_name = COALESCE(first_name, ?), last_name = COALESCE(last_name, ?), phone = COALESCE(phone, ?)
       WHERE id = ?`
    )
      .bind(passwordHash, body.first_name ?? null, body.last_name ?? null, body.phone ?? null, existing.id)
      .run();
    customerId = existing.id;
  } else {
    const result = await env.DB.prepare(
      "INSERT INTO customers (email, password_hash, first_name, last_name, phone, email_verified) VALUES (?, ?, ?, ?, ?, 0)"
    )
      .bind(email, passwordHash, body.first_name ?? null, body.last_name ?? null, body.phone ?? null)
      .run();
    customerId = result.meta.last_row_id;
  }

  await sendVerificationEmail(env, customerId, email, body.portal_url);

  return json({ message: "Check your email to confirm your account, then you can sign in." }, 201);
}

// POST /api/auth/customer-verify-email  { token } -> { token: sessionToken, customer }
// Confirms the email AND logs the customer straight in -- clicking the link
// already proves they own the inbox, no reason to make them log in again
// right after.
async function verifyEmail(request, env, json) {
  const body = await request.json().catch(() => null);
  if (!body || !body.token) return json({ error: "Token is required." }, 400);

  const row = await env.DB.prepare(
    `SELECT clt.customer_id, clt.expires_at, clt.used, c.email, c.first_name, c.last_name
     FROM customer_login_tokens clt
     JOIN customers c ON c.id = clt.customer_id
     WHERE clt.token = ?`
  )
    .bind(body.token)
    .first();

  if (!row) return json({ error: "That link isn't valid. Request a new one." }, 401);
  if (row.used) return json({ error: "That link has already been used." }, 401);
  if (new Date(row.expires_at) < new Date()) {
    return json({ error: "That link has expired. Request a new one." }, 401);
  }

  await env.DB.prepare("UPDATE customer_login_tokens SET used = 1 WHERE token = ?").bind(body.token).run();
  await env.DB.prepare("UPDATE customers SET email_verified = 1 WHERE id = ?").bind(row.customer_id).run();

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

// POST /api/auth/customer-resend-verification  { email, portal_url }
// Always responds with a generic message, whether or not the email has a
// pending (unverified) account -- avoids leaking who's signed up.
async function resendVerification(request, env, json) {
  const body = await request.json().catch(() => null);
  if (!body || !body.email) return json({ error: "Email is required." }, 400);

  const email = body.email.toLowerCase().trim();
  const genericResponse = { message: "If that email has a pending account, a confirmation link is on its way." };

  const row = await env.DB.prepare(
    "SELECT id, email_verified FROM customers WHERE email = ? AND password_hash IS NOT NULL"
  )
    .bind(email)
    .first();
  if (!row || row.email_verified) return json(genericResponse);

  const recent = await env.DB.prepare(
    `SELECT token FROM customer_login_tokens
     WHERE customer_id = ? AND used = 0 AND created_at > datetime('now', ?)
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(row.id, `-${RESEND_COOLDOWN_SECONDS} seconds`)
    .first();
  if (recent) return json(genericResponse);

  await sendVerificationEmail(env, row.id, email, body.portal_url);
  return json(genericResponse);
}

// POST /api/customers/:id/login-link -- staff only (sales+, already gated
// by the "customers" resource block in worker-index.js before this ever
// runs). Generates a one-time sign-in link staff can copy and hand a
// customer directly -- a call, a text, whatever -- instead of the customer
// needing to know their password. Deliberately reuses the exact same
// customer_login_tokens table and /api/auth/customer-verify-email
// consumption path as the normal email-confirmation link: clicking it logs
// the customer straight in AND marks their email verified, which is what
// you want here too -- if staff trust this customer enough to hand them
// instant access, there's no reason to leave them stuck behind the "confirm
// your email first" wall on their next password login. The only real
// difference from a signup link is where the token comes from and how long
// it's good for: staff-issued links don't expire (pushed out 50 years,
// rather than making expires_at nullable for one edge case) since there's
// no inbox-delivery deadline to race against -- but they're still
// single-use once clicked, same as always.
async function createStaffLoginLink(request, env, customerId, json) {
  const customer = await env.DB.prepare(
    "SELECT id, email, first_name, last_name FROM customers WHERE id = ?"
  )
    .bind(customerId)
    .first();
  if (!customer) return json({ error: "Client not found." }, 404);

  const token = newToken();
  await env.DB.prepare(
    "INSERT INTO customer_login_tokens (token, customer_id, expires_at) VALUES (?, ?, ?)"
  )
    .bind(token, customerId, yearsFromNow(STAFF_LINK_TTL_YEARS))
    .run();

  return json(
    { token, customer: { id: customer.id, email: customer.email, first_name: customer.first_name, last_name: customer.last_name } },
    201
  );
}

// POST /api/auth/customer-login  { email, password } -> { token, customer }
async function login(request, env, json) {
  const body = await request.json().catch(() => null);
  if (!body || !body.email || !body.password) {
    return json({ error: "Email and password are required." }, 400);
  }
  const email = body.email.toLowerCase().trim();

  const row = await env.DB.prepare(
    "SELECT id, email, password_hash, first_name, last_name, email_verified FROM customers WHERE email = ?"
  )
    .bind(email)
    .first();

  // Same generic message whether the email doesn't exist, has no password
  // set yet (never signed up), or the password's just wrong -- don't leak
  // which case it is.
  if (!row || !row.password_hash) {
    return json({ error: "That email or password isn't right." }, 401);
  }
  const valid = await verifyPassword(body.password, row.password_hash);
  if (!valid) {
    return json({ error: "That email or password isn't right." }, 401);
  }
  if (!row.email_verified) {
    return json({ error: "Confirm your email before signing in -- check your inbox, or request a new link." }, 403);
  }

  const sessionToken = newToken();
  await env.DB.prepare(
    "INSERT INTO customer_sessions (token, customer_id, expires_at) VALUES (?, ?, ?)"
  )
    .bind(sessionToken, row.id, daysFromNow(SESSION_TTL_DAYS))
    .run();

  return json({
    token: sessionToken,
    customer: { id: row.id, email: row.email, first_name: row.first_name, last_name: row.last_name },
  });
}

// POST /api/auth/customer-logout
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
// Unchanged by the switch to password auth -- a session is a session
// regardless of how it was created.
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
    `SELECT b.id, b.event_date, b.event_type, b.status, b.package_total, b.deposit_paid, b.notes,
            b.allow_full_payment, b.allow_retainer_payment, b.allow_custom_payment,
            b.allow_backdrop_selection, b.allow_template_selection, b.booth_type,
            b.backdrop_choice, b.template_choice, b.contract_url,
            br.slug AS brand_slug, br.display_name AS brand_name, p.name AS package_name,
            v.name AS venue_name, v.address AS venue_address, v.city AS venue_city, v.state AS venue_state
     FROM bookings b
     JOIN brands br ON br.id = b.brand_id
     LEFT JOIN packages p ON p.id = b.package_id
     LEFT JOIN venues v ON v.id = b.venue_id
     WHERE b.customer_id = ?
     ORDER BY b.event_date DESC`
  )
    .bind(customer.id)
    .all();

  return json(results);
}

export {
  signup,
  login,
  verifyEmail,
  resendVerification,
  logoutCustomer,
  getSessionCustomer,
  getMe,
  getMyBookings,
  createStaffLoginLink,
};
