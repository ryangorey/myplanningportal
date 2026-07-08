// One-time browser-based setup page for creating the first staff admin
// account -- no terminal/Node required. Visit /setup, fill out the form.
//
// Safety: this ONLY works while the staff table is completely empty. The
// moment one staff row exists (i.e. right after you use it), both routes
// permanently refuse to do anything else, so this can't be used to create
// extra admin accounts later or by anyone else who finds the URL.

import { hashPassword } from "./auth.js";

async function staffTableIsEmpty(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff").first();
  return row.n === 0;
}

function html(body) {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setup</title>
<style>
body{font-family:system-ui,sans-serif;max-width:420px;margin:60px auto;padding:0 20px;color:#0e1a2b;}
h1{font-size:20px;}
label{display:block;font-size:13px;font-weight:600;margin:16px 0 6px;}
input{width:100%;padding:10px 12px;border:1px solid #ccc;border-radius:6px;font-size:14px;box-sizing:border-box;}
button{margin-top:20px;padding:12px 20px;background:#bb9159;color:#0e1a2b;border:0;border-radius:6px;font-weight:600;cursor:pointer;}
p.note{color:#666;font-size:13px;}
</style></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html" } }
  );
}

// GET /setup
async function setupPage(env) {
  const empty = await staffTableIsEmpty(env);
  if (!empty) {
    return html("<h1>Setup already complete</h1><p>An admin account already exists, so this page is disabled.</p>");
  }
  return html(`
    <h1>Create your admin account</h1>
    <p class="note">This page only works once, right now, while no staff account exists yet.</p>
    <form method="POST" action="/setup">
      <label>Name</label>
      <input name="name" required>
      <label>Email</label>
      <input name="email" type="email" required>
      <label>Password</label>
      <input name="password" type="password" required minlength="8">
      <button type="submit">Create admin account</button>
    </form>
  `);
}

// POST /setup
async function submitSetup(request, env) {
  const empty = await staffTableIsEmpty(env);
  if (!empty) {
    return html("<h1>Setup already complete</h1><p>An admin account already exists, so this page is disabled.</p>");
  }

  const form = await request.formData();
  const email = (form.get("email") || "").toString().toLowerCase().trim();
  const password = (form.get("password") || "").toString();
  const name = (form.get("name") || "").toString().trim();

  if (!email || !password || password.length < 8) {
    return html("<h1>Something's missing</h1><p>Need a valid email and a password of at least 8 characters. <a href=\"/setup\">Go back</a></p>");
  }

  const [firstName, ...rest] = name.split(" ");
  const lastName = rest.join(" ");
  const passwordHash = await hashPassword(password);

  await env.DB.prepare(
    "INSERT INTO staff (email, password_hash, first_name, last_name, role) VALUES (?, ?, ?, ?, 'admin')"
  )
    .bind(email, passwordHash, firstName || "", lastName || "")
    .run();

  return html(`<h1>You're all set</h1><p>Admin account created for ${email}. You can log in now through the API with this email and password. This setup page is now permanently disabled.</p>`);
}

export { setupPage, submitSetup };
