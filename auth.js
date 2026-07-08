// Staff authentication: password hashing (PBKDF2-SHA256 via Web Crypto,
// works the same in Workers and in Node 18+) and session token handling.
// No external dependencies -- Web Crypto is built into the Workers runtime.

const SESSION_TTL_DAYS = 7;
const PBKDF2_ITERATIONS = 100000;

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function deriveHash(password, saltBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(derivedBits));
}

// Used by the setup script to create a staff account's initial password_hash.
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveHash(password, salt);
  return `${bytesToHex(salt)}:${hash}`;
}

// Used at login time to check an entered password against the stored hash.
async function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [saltHex, hashHex] = storedHash.split(":");
  const computed = await deriveHash(password, hexToBytes(saltHex));
  return computed === hashHex; // fine for a low-QPS admin login; not timing-attack hardened
}

function newSessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

function expiryDate() {
  const d = new Date();
  d.setDate(d.getDate() + SESSION_TTL_DAYS);
  return d.toISOString();
}

// POST /api/auth/login  { email, password } -> { token, staff }
async function login(request, env, json) {
  const body = await request.json().catch(() => null);
  if (!body || !body.email || !body.password) {
    return json({ error: "Email and password are required." }, 400);
  }

  const staffRow = await env.DB.prepare(
    "SELECT id, email, password_hash, first_name, last_name, role FROM staff WHERE email = ? AND is_active = 1"
  )
    .bind(body.email.toLowerCase().trim())
    .first();

  if (!staffRow) {
    return json({ error: "That email or password isn't right." }, 401);
  }

  const valid = await verifyPassword(body.password, staffRow.password_hash);
  if (!valid) {
    return json({ error: "That email or password isn't right." }, 401);
  }

  const token = newSessionToken();
  await env.DB.prepare("INSERT INTO staff_sessions (token, staff_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, staffRow.id, expiryDate())
    .run();

  return json({
    token,
    staff: {
      id: staffRow.id,
      email: staffRow.email,
      first_name: staffRow.first_name,
      last_name: staffRow.last_name,
      role: staffRow.role,
    },
  });
}

// POST /api/auth/logout  (Authorization: Bearer <token>)
async function logout(request, env, json) {
  const token = bearerToken(request);
  if (token) {
    await env.DB.prepare("DELETE FROM staff_sessions WHERE token = ?").bind(token).run();
  }
  return json({ ok: true });
}

function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer (.+)$/i);
  return match ? match[1] : null;
}

// Real replacement for the old stub -- looks up the session, checks
// expiry, and (optionally) a minimum role. Returns the staff row on
// success, or null. Caller is responsible for turning null into a 401.
async function getSessionStaff(request, env) {
  const token = bearerToken(request);
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT s.id, s.email, s.first_name, s.last_name, s.role, sess.expires_at
     FROM staff_sessions sess
     JOIN staff s ON s.id = sess.staff_id
     WHERE sess.token = ? AND s.is_active = 1`
  )
    .bind(token)
    .first();

  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    // Expired -- clean it up so it doesn't linger in the table.
    await env.DB.prepare("DELETE FROM staff_sessions WHERE token = ?").bind(token).run();
    return null;
  }
  return row;
}

export { hashPassword, verifyPassword, login, logout, getSessionStaff, bearerToken };
