/**
 * 15D WINGS | MISSION CONTROL INTAKE v4.5
 * Optimized for Operational Console v4.5
 * Handles Multi-leg validation, 72h Doctrine, and System Handshakes.
 */

export default {
  async fetch(request, env, ctx) {
    // 1. Precise CORS for v4.5 Handshake
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Generate Global Identifier
    const missionId = "MW-" + crypto.randomUUID().split('-')[0].toUpperCase();
    const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
    const ua = request.headers.get("user-agent") || "Unknown";

    try {
      const payload = await request.json();

      /**
       * DATA MAPPING (Frontend v4.5 -> Backend Logic)
       * The UI sends: { name, email, pax, aircraft_class, legs: [{from, to, departure}] }
       */
      const clientName = payload.name || "Valued Client";
      const clientEmail = payload.email;
      const legs = payload.legs || [];

      if (!clientEmail || legs.length === 0) {
        return jsonResponse({ ok: false, error: "DATA_MISMATCH", message: "Identity or Route incomplete." }, 400, corsHeaders);
      }

      // 2. THE 72-HOUR DOCTRINE (Comprehensive Sweep)
      const now = Date.now();
      let status = "ACCEPTED";
      let message = "Mission Pre-Approved. FEASIBILITY: 100%";
      let shortestWindow = Infinity;

      for (const leg of legs) {
        // v4.5 sends 'departure' as a datetime-local string
        const departureTime = new Date(leg.departure).getTime();
        const hoursToDep = (departureTime - now) / 3600000;

        if (hoursToDep < shortestWindow) shortestWindow = hoursToDep;

        // If any flight segment is < 72h, the whole mission enters REVIEW state
        if (hoursToDep < 72) {
          status = "REVIEW";
          message = "High-Volatility Window Detected. Manual validation required.";
        }
      }

      // 3. Metadata for the Dispatch Matrix
      const meta = {
        name: clientName,
        email: clientEmail,
        pax: payload.pax || 1,
        aircraft_class: payload.aircraft_class || "HEAVY",
        leg_count: legs.length,
        shortest_window_hrs: Math.round(shortestWindow),
        estimated_price: payload.estimated_price || 0,
        version: "v4.5"
      };

      // 4. Background Side Effects (D1, Mail, ICC)
      // ctx.waitUntil prevents these from slowing down the user response
      ctx.waitUntil(executeSideEffects(env, missionId, status, meta, payload, ip, ua));

      // 5. Handshake Response
      return jsonResponse({
        ok: true,
        ref: missionId, // Mapped to frontend 'data.ref'
        status: status,
        message: message,
        client: clientName
      }, 200, corsHeaders);

    } catch (err) {
      console.error("Critical Intake Failure:", err);
      return jsonResponse({ ok: false, error: "INTAKE_ERROR", message: "Transmission Corrupted." }, 500, corsHeaders);
    }
  }
};

/**
 * Executes system events (Audit, ICC, Mail) in the background.
 */
async function executeSideEffects(env, missionId, status, meta, payload, ip, ua) {
  const timestamp = Date.now();

  // A. Audit Log (D1 Storage)
  const auditPromise = (async () => {
    try {
      if (env.audit_logs) {
        await env.audit_logs.prepare(`
          INSERT INTO intake_logs (mission_id, status, client_name, payload, metadata, ip_address, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          missionId, 
          status, 
          meta.name, 
          JSON.stringify(payload), 
          JSON.stringify(meta), 
          ip, 
          timestamp
        ).run();
      }
    } catch (e) { console.error("D1 Audit Fail:", e.message); }
  })();

  // B. Notify Control Center (ICC)
  const iccPromise = (async () => {
    try {
      await fetch("https://icc-gateway.15dwings.com.ng/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "MISSION_INTAKE",
          mission_id: missionId,
          status: status,
          data: { ...meta, legs: payload.legs }
        })
      });
    } catch (e) { console.error("ICC Push Fail:", e.message); }
  })();

  // C. Trigger Mail Worker (Service Binding)
  const mailPromise = (async () => {
    try {
      if (env["noreply-wings"]) {
        await env["noreply-wings"].fetch("http://internal/send", {
          method: "POST",
          body: JSON.stringify({
            request_id: missionId,
            email: meta.email,
            name: meta.name,
            status: status,
            metadata: meta
          })
        });
      }
    } catch (e) { console.error("Mail Dispatch Fail:", e.message); }
  })();

  return Promise.allSettled([auditPromise, iccPromise, mailPromise]);
}

/**
 * Response Utility
 */
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    }
  });
}

