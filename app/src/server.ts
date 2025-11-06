// Deno Deploy (Supabase Edge Functions)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.46.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

const WA_GATEWAY_URL = Deno.env.get("WA_GATEWAY_URL")!;
const WA_API_KEY = Deno.env.get("WA_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type ContactRow = {
  session_id: string;
  jid: string;
  phone_number: string | null;
  profile_name: string | null;
  profile_picture_url: string | null;
  is_business: boolean;
  is_enterprise: boolean;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { session_id, limit = 500 } = await req.json();
    if (!session_id) {
      return new Response(JSON.stringify({ error: "session_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // 1) Charger les contacts depuis le gateway
    const contactsRes = await fetch(`${WA_GATEWAY_URL}/sessions/${session_id}/contacts`, {
      headers: { "x-api-key": WA_API_KEY }
    });
    if (!contactsRes.ok) {
      const t = await contactsRes.text();
      throw new Error(`contacts fetch failed: ${contactsRes.status} ${t}`);
    }
    const contactsJson = await contactsRes.json();
    const contacts: any[] = Array.isArray(contactsJson.contacts) ? contactsJson.contacts.slice(0, limit) : [];

    // 2) Construire les lignes + récupérer la photo (HD si possible)
    const rows: ContactRow[] = [];
    for (const c of contacts) {
      const jid: string = c.jid;
      const phone = jid?.endsWith("@s.whatsapp.net") ? jid.replace("@s.whatsapp.net", "") : null;
      const name = c.name ?? c.notify ?? c.verifiedName ?? null;

      // Appel photo (peut être null selon la privacy)
      let avatar: string | null = null;
      try {
        const picRes = await fetch(
          `${WA_GATEWAY_URL}/sessions/${session_id}/profile-picture?jid=${encodeURIComponent(jid)}&full=true`,
          { headers: { "x-api-key": WA_API_KEY } }
        );
        if (picRes.ok) {
          const { url } = await picRes.json();
          avatar = url ?? null;
        }
      } catch {
        // ignore
      }

      rows.push({
        session_id,
        jid,
        phone_number: phone,
        profile_name: name,
        profile_picture_url: avatar,
        is_business: Boolean(c.isBusiness),
        is_enterprise: Boolean(c.isEnterprise)
      });
    }

    // 3) Upsert en base (assume table + unique (session_id, jid))
    if (rows.length) {
      const { error } = await supabase
        .from("whatsapp_contact_profiles")
        .upsert(rows, { onConflict: "session_id,jid" });

      if (error) throw error;
    }

    return new Response(JSON.stringify({ ok: true, count: rows.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
