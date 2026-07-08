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

export { updateBrand, uploadBrandLogo, serveUpload };
