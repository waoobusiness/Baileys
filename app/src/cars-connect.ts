import type { Request, Response, NextFunction } from "express";
import express from "express";

const router = express.Router();

// ---------- Middlewares de parsing ROBUSTES ----------
/**
 * IMPORTANT : monte ces parsers AVANT d'attacher le routeur dans server.ts
 *   app.use(carsConnectParsers);
 *   app.use("/cars", carsConnectRouter);
 */
export const carsConnectParsers = [
  // Essayez d'abord à lire brut (pour reparse JSON si CT incorrect)
  express.text({ type: "*/*", limit: "2mb" }) as any,
  // Puis JSON permissif
  express.json({ strict: false, limit: "2mb", type: ["application/json", "application/ld+json", "application/csp-report"] }) as any,
  // Puis form urlencoded
  express.urlencoded({ extended: true, limit: "2mb" }) as any,
];

// ---------- Utils ----------
function maskHeaders(h: Record<string, any>) {
  const clone: Record<string, any> = {};
  for (const [k, v] of Object.entries(h || {})) {
    const lk = k.toLowerCase();
    if (lk === "authorization" || lk.startsWith("x-api-key") || lk.includes("token")) {
      clone[k] = "***";
    } else {
      clone[k] = v;
    }
  }
  return clone;
}

function isProbablyUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s) return false;
  try {
    // autorise schéma manquant
    const u = new URL(s.startsWith("http") ? s : `https://${s}`);
    return !!u.hostname && !!u.pathname;
  } catch {
    return false;
  }
}

function deepFindLink(obj: unknown, depth = 0): string | null {
  if (depth > 6 || obj == null) return null;
  if (typeof obj === "string") return isProbablyUrl(obj) ? obj.trim() : null;
  if (typeof obj !== "object") return null;

  const direct = (obj as any)["link"] || (obj as any)["url"] || (obj as any)["uri"];
  if (isProbablyUrl(direct)) return String(direct).trim();

  const candidates = ["data", "payload", "record", "input", "inputs", "args", "event", "body", "message"];
  for (const k of candidates) {
    const v = (obj as any)[k];
    const found = deepFindLink(v, depth + 1);
    if (found) return found;
  }

  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (["headers", "authorization"].includes(k.toLowerCase())) continue;
    const found = deepFindLink(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractLink(req: Request): { link: string | null; debug: any } {
  // 1) Header dédié
  const hLink = req.header("x-link");
  if (isProbablyUrl(hLink)) return { link: hLink!.trim(), debug: { via: "header" } };

  // 2) Query ?link=
  const q = req.query as Record<string, any>;
  const qLink = q?.link || q?.url || q?.uri;
  if (isProbablyUrl(qLink)) return { link: String(qLink).trim(), debug: { via: "query" } };

  // 3) Body JSON / form / texte
  const ct = (req.headers["content-type"] || "").toString().toLowerCase();
  let body: any = req.body;

  // Si text/plain ou mauvais CT, tenter JSON.parse
  if ((!ct || ct.includes("text/plain")) && typeof body === "string") {
    const text = (body as string).trim();
    if (isProbablyUrl(text)) return { link: text, debug: { via: "text_body" } };
    try {
      body = JSON.parse(text);
    } catch {
      // pas du json -> essayer form style a=b&link=...
      try {
        const sp = new URLSearchParams(text);
        const fLink = sp.get("link") || sp.get("url") || sp.get("uri");
        if (isProbablyUrl(fLink)) return { link: fLink!.trim(), debug: { via: "formish_text" } };
      } catch {/* noop */}
    }
  }

  // urlencoded déjà parsé par express.urlencoded
  if (ct.includes("application/x-www-form-urlencoded") && body && typeof body === "object") {
    const fLink = body.link || body.url || body.uri;
    if (isProbablyUrl(fLink)) return { link: String(fLink).trim(), debug: { via: "urlencoded" } };
  }

  // JSON permissif
  if (body != null) {
    const found = deepFindLink(body);
    if (found) return { link: found, debug: { via: "json_deep" } };
  }

  return {
    link: null,
    debug: {
      via: "none",
      ct,
      hasBody: body != null,
      bodyType: typeof body,
    },
  };
}

// ---------- Auth ----------
function authBearer(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.RESOLVER_BEARER;
  const got = req.header("authorization") || "";
  const token = got.startsWith("Bearer ") ? got.slice(7) : "";
  if (!expected) {
    return res.status(500).json({ ok: false, error: "server_misconfigured", details: "RESOLVER_BEARER missing" });
  }
  if (token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// ---------- Route ----------
router.post("/connect", authBearer, async (req: Request, res: Response) => {
  const { link, debug } = extractLink(req);

  if (!link) {
    return res.status(400).json({
      ok: false,
      error: "link required",
      debug: {
        ...debug,
        headers: maskHeaders(req.headers as any),
        query: req.query,
        // body condensé pour ne pas loguer trop
        bodyPreview:
          typeof req.body === "string"
            ? (req.body as string).slice(0, 300)
            : req.body && typeof req.body === "object"
            ? Object.keys(req.body).slice(0, 20)
            : typeof req.body,
      },
    });
  }

  // ——— À partir d’ici tu peux lancer ton pipeline d’import —
  // Exemple: juste echo pour débloquer Lovable immédiatemment.
  return res.json({
    ok: true,
    received: { link },
    note:
      "Lien détecté. Le pipeline d'import peut maintenant scraper le garage/voiture et insérer en DB.",
  });
});

export default router;
