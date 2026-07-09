// Brand branding: display name, primary color, and a logo image. The image
// itself lives in R2 (env.LOGOS, bound in wrangler.toml) -- brands.logo_url
// only ever stores a same-origin "/api/uploads/<key>" path, never talks to
// R2 directly from the browser, so no R2 CORS configuration is needed. The
// browser uploads to the Worker, the Worker writes to R2, and later serves
// it back on GET -- both admin+-gated and public respectively.

const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

// PATCH /api/brands/:id  { display_name?, primary_color? } -- admin+ only.
async function updateBrand(request, env, id, json) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid request body." }, 400);

  const fields = [];
  const values = [];
  if ("display_name" in body) {
    if (!body.display_name || !body.display_name.trim()) {
      return json({ error: "Display name can't be empty." }, 400);
    }
    fields.push("display_name = ?");
    values.push(body.display_name.trim());
  }
  if ("primary_color" in body) {
    const color = body.primary_color;
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return json({ error: "Primary color needs to be a hex code like #0e1a2b." }, 400);
    }
    fields.push("primary_color = ?");
    values.push(color || null);
  }

  if (fields.length === 0) return json({ error: "Nothing to update." }, 400);
  values.push(id);

  await env.DB.prepare(`UPDATE brands SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  const brand = await env.DB.prepare(
    "SELECT id, slug, display_name, portal_domain, logo_url, primary_color FROM brands WHERE id = ?"
  )
    .bind(id)
    .first();
  if (!brand) return json({ error: "Brand not found." }, 404);
  return json(brand);
}

// POST /api/brands  { slug, display_name, portal_domain? } -- super_admin
// only. slug gets normalized to lowercase letters/numbers/dashes so it's
// always safe to use in URLs and as the brand_slug bookings are created
// against.
async function createBrand(request, env, json) {
  const body = await request.json().catch(() => null);
  if (!body || !body.slug || !body.slug.trim() || !body.display_name || !body.display_name.trim()) {
    return json({ error: "Slug and display name are required." }, 400);
  }

  const slug = body.slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return json({ error: "That slug isn't valid -- use letters, numbers, and dashes." }, 400);

  const existing = await env.DB.prepare("SELECT id FROM brands WHERE slug = ?").bind(slug).first();
  if (existing) return json({ error: "A brand with that slug already exists." }, 409);

  const result = await env.DB.prepare(
    "INSERT INTO brands (slug, display_name, portal_domain) VALUES (?, ?, ?)"
  )
    .bind(slug, body.display_name.trim(), body.portal_domain || null)
    .run();

  const brand = await env.DB.prepare(
    "SELECT id, slug, display_name, portal_domain, logo_url, primary_color FROM brands WHERE id = ?"
  )
    .bind(result.meta.last_row_id)
    .first();
  return json(brand, 201);
}

// DELETE /api/brands/:id -- super_admin only. Refuses if any booking still
// points at this brand: several listing queries INNER JOIN bookings to
// brands, so an orphaned brand_id wouldn't error, it would just make those
// bookings silently vanish from every list. Safer to block the delete and
// make the admin deal with those bookings (reassign or remove) first.
//
// RGML Entertainment ('rgml') is the primary brand this whole system is
// built around and can never be deleted. Grin + Bear Booth and
// myplanningportal are deletable like any other brand -- deleting
// 'myplanningportal' specifically just means the admin topbar and customer
// portal login/dashboard fall back to their hardcoded default logo/colors
// until a new brand is set up (nothing crashes, it just stops being
// custom-branded).
async function deleteBrand(env, id, json) {
  const brand = await env.DB.prepare("SELECT id, slug FROM brands WHERE id = ?").bind(id).first();
  if (!brand) return json({ error: "Brand not found." }, 404);

  if (brand.slug === "rgml") {
    return json({ error: "RGML Entertainment is the primary brand this system runs on -- it can't be deleted." }, 400);
  }

  const bookingsInUse = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE brand_id = ?").bind(id).first();
  if (bookingsInUse && bookingsInUse.n > 0) {
    return json({ error: `Can't delete this brand -- it still has ${bookingsInUse.n} booking(s) on it.` }, 409);
  }

  // Packages reference brands too (brand_id), and the FK would otherwise
  // fail the DELETE outright with a raw SQL error instead of a clean
  // message. A brand almost always has at least its starter packages, so
  // this check matters in practice, not just in theory.
  const packagesInUse = await env.DB.prepare("SELECT COUNT(*) AS n FROM packages WHERE brand_id = ?").bind(id).first();
  if (packagesInUse && packagesInUse.n > 0) {
    return json({ error: `Can't delete this brand -- it still has ${packagesInUse.n} package(s) tied to it. Delete or reassign those first.` }, 409);
  }

  await env.DB.prepare("DELETE FROM brands WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// POST /api/brands/:id/logo -- admin+ only. Body is the raw image bytes;
// content-type header identifies the format. Not multipart/form-data --
// the browser sends the File object directly as the request body.
async function uploadBrandLogo(request, env, id, json) {
  if (!env.LOGOS) {
    return json({ error: "Logo storage isn't set up yet (missing the LOGOS R2 binding)." }, 500);
  }

  const brand = await env.DB.prepare("SELECT id FROM brands WHERE id = ?").bind(id).first();
  if (!brand) return json({ error: "Brand not found." }, 404);

  const contentType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = ALLOWED_TYPES[contentType];
  if (!ext) {
    return json({ error: "That doesn't look like a supported image type. Use PNG, JPEG, WEBP, or SVG." }, 400);
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) {
    return json({ error: "The uploaded file is empty." }, 400);
  }
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    return json({ error: "That image is too large -- keep it under 5MB." }, 400);
  }

  const key = `brand-logo-${id}-${Date.now()}.${ext}`;
  await env.LOGOS.put(key, bytes, { httpMetadata: { contentType } });

  const logoUrl = `/api/uploads/${key}`;
  await env.DB.prepare("UPDATE brands SET logo_url = ? WHERE id = ?").bind(logoUrl, id).run();

  return json({ id: Number(id), logo_url: logoUrl });
}

// GET /api/uploads/:key -- public (logos need to render on public-facing
// pages), read-only, serves straight out of R2 with long-lived caching
// since each upload gets a unique timestamped key.
async function serveUpload(env, key) {
  if (!env.LOGOS) {
    return new Response("Not found.", { status: 404 });
  }
  const object = await env.LOGOS.get(key);
  if (!object) {
    return new Response("Not found.", { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

export { createBrand, updateBrand, deleteBrand, uploadBrandLogo, serveUpload };
