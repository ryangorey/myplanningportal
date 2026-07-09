// Leads pipeline -- a configurable set of stages (managed by admin+) that
// leads move through on their way to becoming a booking (or not). Day-to-day
// lead work (create/edit/move/delete) is sales+; configuring the pipeline
// itself (adding/renaming/reordering/deleting stages) is admin+ only, same
// bar as branding and other structural settings.

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

// GET /api/pipeline-stages -- sales+ (they need the column list to work the
// board at all). Ordered so the frontend can render columns left to right.
async function listPipelineStages(env, json) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, sort_order, color, is_won, is_lost FROM pipeline_stages ORDER BY sort_order"
  ).all();
  return json(results);
}

// POST /api/pipeline-stages  { name, color?, is_won?, is_lost? } -- admin+.
// New stages are appended at the end of the pipeline.
async function createPipelineStage(request, env, json) {
  const body = await request.json().catch(() => null);
  if (!body || !body.name || !body.name.trim()) {
    return json({ error: "Stage name is required." }, 400);
  }

  const maxRow = await env.DB.prepare("SELECT MAX(sort_order) AS m FROM pipeline_stages").first();
  const sortOrder = (maxRow && maxRow.m ? maxRow.m : 0) + 1;

  const result = await env.DB.prepare(
    "INSERT INTO pipeline_stages (name, sort_order, color, is_won, is_lost) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(body.name.trim(), sortOrder, body.color || "#3a4a60", body.is_won ? 1 : 0, body.is_lost ? 1 : 0)
    .run();

  return json(
    { id: result.meta.last_row_id, name: body.name.trim(), sort_order: sortOrder, color: body.color || "#3a4a60", is_won: body.is_won ? 1 : 0, is_lost: body.is_lost ? 1 : 0 },
    201
  );
}

// PATCH /api/pipeline-stages/:id  { name?, color?, is_won?, is_lost? } -- admin+.
// Reordering happens through the dedicated /move endpoint below, not here.
async function updatePipelineStage(request, env, id, json) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid request body." }, 400);

  const stage = await env.DB.prepare("SELECT id FROM pipeline_stages WHERE id = ?").bind(id).first();
  if (!stage) return json({ error: "Stage not found." }, 404);

  const fields = [];
  const values = [];
  if ("name" in body) {
    if (!body.name || !body.name.trim()) return json({ error: "Stage name can't be empty." }, 400);
    fields.push("name = ?");
    values.push(body.name.trim());
  }
  if ("color" in body) { fields.push("color = ?"); values.push(body.color); }
  if ("is_won" in body) { fields.push("is_won = ?"); values.push(body.is_won ? 1 : 0); }
  if ("is_lost" in body) { fields.push("is_lost = ?"); values.push(body.is_lost ? 1 : 0); }
  if (fields.length === 0) return json({ error: "Nothing to update." }, 400);

  values.push(id);
  await env.DB.prepare(`UPDATE pipeline_stages SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  return json({ ok: true });
}

// POST /api/pipeline-stages/:id/move  { direction: "up" | "down" } -- admin+.
// Swaps sort_order with the adjacent stage so reordering is atomic and the
// frontend never has to compute sort_order values itself.
async function movePipelineStage(request, env, id, json) {
  const body = await request.json().catch(() => null);
  if (!body || (body.direction !== "up" && body.direction !== "down")) {
    return json({ error: "direction must be 'up' or 'down'." }, 400);
  }

  const stage = await env.DB.prepare("SELECT id, sort_order FROM pipeline_stages WHERE id = ?").bind(id).first();
  if (!stage) return json({ error: "Stage not found." }, 404);

  const neighbor = await env.DB.prepare(
    body.direction === "up"
      ? "SELECT id, sort_order FROM pipeline_stages WHERE sort_order < ? ORDER BY sort_order DESC LIMIT 1"
      : "SELECT id, sort_order FROM pipeline_stages WHERE sort_order > ? ORDER BY sort_order ASC LIMIT 1"
  )
    .bind(stage.sort_order)
    .first();

  if (!neighbor) return json({ error: "That stage is already at the " + (body.direction === "up" ? "top" : "bottom") + "." }, 400);

  await env.DB.prepare("UPDATE pipeline_stages SET sort_order = ? WHERE id = ?").bind(neighbor.sort_order, stage.id).run();
  await env.DB.prepare("UPDATE pipeline_stages SET sort_order = ? WHERE id = ?").bind(stage.sort_order, neighbor.id).run();

  return json({ ok: true });
}

// DELETE /api/pipeline-stages/:id -- admin+. Blocked if any leads are still
// sitting in that stage, or if it's the only stage left (the board always
// needs at least one column to hold leads).
async function deletePipelineStage(env, id, json) {
  const stage = await env.DB.prepare("SELECT id FROM pipeline_stages WHERE id = ?").bind(id).first();
  if (!stage) return json({ error: "Stage not found." }, 404);

  const countRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM pipeline_stages").first();
  if (countRow.c <= 1) {
    return json({ error: "You need at least one pipeline stage." }, 409);
  }

  const inUse = await env.DB.prepare("SELECT COUNT(*) AS c FROM leads WHERE stage_id = ?").bind(id).first();
  if (inUse.c > 0) {
    return json(
      { error: `Can't delete this stage -- it still has ${inUse.c} lead(s) in it. Move them to another stage first.` },
      409
    );
  }

  await env.DB.prepare("DELETE FROM pipeline_stages WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

// GET /api/leads?stage_id=&brand_id=&search= -- sales+.
async function listLeads(env, url, json) {
  const stageId = url.searchParams.get("stage_id");
  const brandId = url.searchParams.get("brand_id");
  const search = (url.searchParams.get("search") || "").trim();

  let query = `SELECT l.id, l.brand_id, br.slug AS brand_slug, br.display_name AS brand_name,
                      l.customer_id, c.first_name AS customer_first_name, c.last_name AS customer_last_name,
                      l.stage_id, l.first_name, l.last_name, l.email, l.phone, l.organization,
                      l.event_date, l.estimated_value, l.source, l.notes, l.assigned_to,
                      s.first_name AS assignee_first_name, s.last_name AS assignee_last_name,
                      l.created_at, l.updated_at
               FROM leads l
               LEFT JOIN brands br ON br.id = l.brand_id
               LEFT JOIN customers c ON c.id = l.customer_id
               LEFT JOIN staff s ON s.id = l.assigned_to`;
  const conditions = [];
  const params = [];
  if (stageId) { conditions.push("l.stage_id = ?"); params.push(stageId); }
  if (brandId) { conditions.push("l.brand_id = ?"); params.push(brandId); }
  if (search) {
    conditions.push("(l.first_name LIKE ? OR l.last_name LIKE ? OR l.email LIKE ? OR l.phone LIKE ? OR l.organization LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }
  if (conditions.length) query += " WHERE " + conditions.join(" AND ");
  query += " ORDER BY l.created_at DESC";

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json(results);
}

// GET /api/leads/:id -- sales+.
async function getLead(env, id, json) {
  const lead = await env.DB.prepare(
    `SELECT l.*, br.display_name AS brand_name, c.first_name AS customer_first_name, c.last_name AS customer_last_name,
            s.first_name AS assignee_first_name, s.last_name AS assignee_last_name
     FROM leads l
     LEFT JOIN brands br ON br.id = l.brand_id
     LEFT JOIN customers c ON c.id = l.customer_id
     LEFT JOIN staff s ON s.id = l.assigned_to
     WHERE l.id = ?`
  )
    .bind(id)
    .first();
  if (!lead) return json({ error: "Lead not found." }, 404);
  return json(lead);
}

// POST /api/leads  { brand_id, first_name?, last_name?, email?, phone?,
//   organization?, event_date?, estimated_value?, source?, notes?,
//   customer_id?, assigned_to?, stage_id? }
// Needs a brand and at least one way to identify the prospect. Defaults to
// the first pipeline stage (lowest sort_order) if none is given.
async function createLead(request, env, json) {
  const body = await request.json().catch(() => null);
  if (!body || !body.brand_id) {
    return json({ error: "brand_id is required." }, 400);
  }
  if (!body.first_name && !body.last_name && !body.organization && !body.email) {
    return json({ error: "Give the lead a name, organization, or email so it can be identified." }, 400);
  }

  const brand = await env.DB.prepare("SELECT id FROM brands WHERE id = ?").bind(body.brand_id).first();
  if (!brand) return json({ error: "That brand doesn't exist." }, 400);

  let stageId = body.stage_id ? Number(body.stage_id) : null;
  if (stageId) {
    const stage = await env.DB.prepare("SELECT id FROM pipeline_stages WHERE id = ?").bind(stageId).first();
    if (!stage) return json({ error: "That pipeline stage doesn't exist." }, 400);
  } else {
    const firstStage = await env.DB.prepare("SELECT id FROM pipeline_stages ORDER BY sort_order LIMIT 1").first();
    if (!firstStage) return json({ error: "No pipeline stages exist yet." }, 400);
    stageId = firstStage.id;
  }

  let customerId = null;
  if (body.customer_id) {
    const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?").bind(body.customer_id).first();
    if (!customer) return json({ error: "That client doesn't exist." }, 400);
    customerId = Number(body.customer_id);
  }

  let assignedTo = null;
  if (body.assigned_to) {
    const staffRow = await env.DB.prepare("SELECT id FROM staff WHERE id = ? AND is_active = 1").bind(body.assigned_to).first();
    if (!staffRow) return json({ error: "That staff member doesn't exist." }, 400);
    assignedTo = Number(body.assigned_to);
  }

  const result = await env.DB.prepare(
    `INSERT INTO leads (brand_id, customer_id, stage_id, first_name, last_name, email, phone, organization,
                         event_date, estimated_value, source, notes, assigned_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      Number(body.brand_id),
      customerId,
      stageId,
      body.first_name ?? null,
      body.last_name ?? null,
      body.email ?? null,
      body.phone ?? null,
      body.organization ?? null,
      body.event_date ?? null,
      body.estimated_value ?? null,
      body.source ?? null,
      body.notes ?? null,
      assignedTo
    )
    .run();

  return json({ id: result.meta.last_row_id, brand_id: Number(body.brand_id), stage_id: stageId, customer_id: customerId, assigned_to: assignedTo }, 201);
}

// PATCH /api/leads/:id -- sales+. Used both for full edits and for moving a
// lead between pipeline stages (just { stage_id }).
async function updateLead(request, env, id, json) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid request body." }, 400);

  const lead = await env.DB.prepare("SELECT id FROM leads WHERE id = ?").bind(id).first();
  if (!lead) return json({ error: "Lead not found." }, 404);

  const fields = [];
  const values = [];

  if ("stage_id" in body) {
    const stage = await env.DB.prepare("SELECT id FROM pipeline_stages WHERE id = ?").bind(body.stage_id).first();
    if (!stage) return json({ error: "That pipeline stage doesn't exist." }, 400);
    fields.push("stage_id = ?");
    values.push(Number(body.stage_id));
  }
  if ("brand_id" in body) {
    const brand = await env.DB.prepare("SELECT id FROM brands WHERE id = ?").bind(body.brand_id).first();
    if (!brand) return json({ error: "That brand doesn't exist." }, 400);
    fields.push("brand_id = ?");
    values.push(Number(body.brand_id));
  }
  if ("customer_id" in body) {
    if (body.customer_id) {
      const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?").bind(body.customer_id).first();
      if (!customer) return json({ error: "That client doesn't exist." }, 400);
      fields.push("customer_id = ?");
      values.push(Number(body.customer_id));
    } else {
      fields.push("customer_id = ?");
      values.push(null);
    }
  }
  if ("assigned_to" in body) {
    if (body.assigned_to) {
      const staffRow = await env.DB.prepare("SELECT id FROM staff WHERE id = ? AND is_active = 1").bind(body.assigned_to).first();
      if (!staffRow) return json({ error: "That staff member doesn't exist." }, 400);
      fields.push("assigned_to = ?");
      values.push(Number(body.assigned_to));
    } else {
      fields.push("assigned_to = ?");
      values.push(null);
    }
  }
  for (const key of ["first_name", "last_name", "email", "phone", "organization", "event_date", "estimated_value", "source", "notes"]) {
    if (key in body) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if (fields.length === 0) return json({ error: "Nothing to update." }, 400);

  fields.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);

  await env.DB.prepare(`UPDATE leads SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  return json({ ok: true });
}

// DELETE /api/leads/:id -- sales+.
async function deleteLead(env, id, json) {
  const lead = await env.DB.prepare("SELECT id FROM leads WHERE id = ?").bind(id).first();
  if (!lead) return json({ error: "Lead not found." }, 404);
  await env.DB.prepare("DELETE FROM leads WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

export {
  listPipelineStages,
  createPipelineStage,
  updatePipelineStage,
  movePipelineStage,
  deletePipelineStage,
  listLeads,
  getLead,
  createLead,
  updateLead,
  deleteLead,
};
