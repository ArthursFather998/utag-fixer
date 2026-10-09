// UTAG control-center write path (Supabase Edge Function)
//
// The public site is read-only (anon key + RLS). Every write from the
// control center goes through this function, gated by a site password
// held in the SITE_PASSWORD function secret. Writes use the service role,
// which Supabase injects automatically as SUPABASE_SERVICE_ROLE_KEY.
//
// Deploy (dashboard): Edge Functions -> Create function "utag-control",
// paste this file, set the SITE_PASSWORD secret, deploy.
//
// Request: POST JSON { password, action, ... }
// Actions:
//   correct          { entity_type, entity_id, field, new_value, note? }
//                    -> inserts a corrections row (human ruling) and applies
//                       the field change to the entity. Corrections outrank AI.
//   set_confidence   { entity_type, entity_id, confidence }
//                    -> sets confidence (and status) on the entity.
//   resolve_verification { verification_id, status }
//                    -> marks a verification run verified / needs_review / conflicting.
// Response: JSON { ok: true, ... } or { ok: false, error }

import { createClient } from "jsr:@supabase/supabase-js@2";

const CONFIDENCE = ["verified", "high_confidence", "needs_review", "conflicting", "unknown"];
const ENTITY_TABLE: Record<string, string> = {
  artist: "artists",
  release: "releases",
  track: "tracks",
  artwork: "artwork",
};

// Fields a human ruling may change, per entity. Anything else is rejected.
const EDITABLE: Record<string, string[]> = {
  artist: ["canonical_name", "aliases", "genres", "image_url", "mbid", "spotify_id", "apple_id", "deezer_id", "discogs_id"],
  release: ["title", "release_type", "edition", "release_date", "release_year", "label", "catalog_number", "barcode", "country", "mbid", "spotify_id", "apple_id", "deezer_id", "discogs_id"],
  track: ["title", "track_number", "disc_number", "isrc", "duration_ms", "mbid", "spotify_id", "apple_id", "deezer_id"],
  artwork: ["role", "edition_label", "source_url"],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const sitePassword = Deno.env.get("SITE_PASSWORD") || "";
  if (!sitePassword || body.password !== sitePassword) {
    return json({ ok: false, error: "Wrong password" }, 401);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const action = String(body.action || "");

  try {
    if (action === "correct") {
      const entityType = String(body.entity_type || "");
      const table = ENTITY_TABLE[entityType];
      const field = String(body.field || "");
      if (!table) return json({ ok: false, error: "Unknown entity_type" }, 400);
      if (!EDITABLE[entityType].includes(field)) {
        return json({ ok: false, error: `Field not editable: ${field}` }, 400);
      }
      const entityId = String(body.entity_id || "");
      const { data: current, error: readErr } = await supabase
        .from(table).select(field).eq("id", entityId).single();
      if (readErr) throw readErr;

      const { error: corrErr } = await supabase.from("corrections").insert({
        entity_type: entityType,
        entity_id: entityId,
        field,
        old_value: current ? String((current as Record<string, unknown>)[field] ?? "") : null,
        new_value: String(body.new_value ?? ""),
        source: "manual",
        note: body.note ? String(body.note) : null,
      });
      if (corrErr) throw corrErr;

      const patch: Record<string, unknown> = { [field]: body.new_value };
      if (entityType !== "artwork") patch.updated_at = new Date().toISOString();
      const { error: updErr } = await supabase.from(table).update(patch).eq("id", entityId);
      if (updErr) throw updErr;
      return json({ ok: true, action, entity_id: entityId, field });
    }

    if (action === "set_confidence") {
      const entityType = String(body.entity_type || "");
      const table = ENTITY_TABLE[entityType];
      const confidence = String(body.confidence || "");
      if (!table) return json({ ok: false, error: "Unknown entity_type" }, 400);
      if (!CONFIDENCE.includes(confidence)) return json({ ok: false, error: "Unknown confidence" }, 400);
      const patch: Record<string, unknown> = { confidence, status: confidence };
      if (entityType !== "artwork") patch.updated_at = new Date().toISOString();
      const { error } = await supabase.from(table)
        .update(patch)
        .eq("id", String(body.entity_id || ""));
      if (error) throw error;
      return json({ ok: true, action, confidence });
    }

    if (action === "resolve_verification") {
      const status = String(body.status || "");
      if (!CONFIDENCE.includes(status)) return json({ ok: false, error: "Unknown status" }, 400);
      const { error } = await supabase.from("verifications")
        .update({ status })
        .eq("id", String(body.verification_id || ""));
      if (error) throw error;
      return json({ ok: true, action, status });
    }

    if (action === "chat_send") {
      const content = String(body.content || "").trim();
      if (!content) return json({ ok: false, error: "Empty message" }, 400);
      let sessionId = body.session_id ? String(body.session_id) : "";
      if (!sessionId) {
        const { data, error } = await supabase.from("chat_sessions")
          .insert({ title: content.slice(0, 60) }).select("id").single();
        if (error) throw error;
        sessionId = (data as { id: string }).id;
      }
      const { error } = await supabase.from("chat_messages")
        .insert({ session_id: sessionId, role: "user", content });
      if (error) throw error;
      return json({ ok: true, action, session_id: sessionId });
    }

    return json({ ok: false, error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
