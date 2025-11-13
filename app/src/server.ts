// server.ts - Gateway WhatsApp (Render)
// npm i express cors eventemitter3 uuid @whiskeysockets/baileys
import express from "express";
import cors from "cors";
import { EventEmitter } from "eventemitter3";
import { v4 as uuid } from "uuid";
// import { default: makeWASocket, useMultiFileAuthState, Browsers, DisconnectReason } from "@whiskeysockets/baileys";

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ALLOW_ORIGIN?.split(",") ?? ["*"] }));

// --- Sécurité simple entre Edge Function et Gateway ---
const EDGE_TOKEN = process.env.EDGE_TOKEN || "";
function requireEdgeToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  const t = req.header("x-edge-token");
  if (!EDGE_TOKEN || t === EDGE_TOKEN) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

// --- Mémoire: sessions, locks, bus SSE ---
type Session = {
  orgId: string;
  sessionId: string;
  status: "pending" | "qr" | "connected" | "error";
  events: EventEmitter;
  startedAt: number;
  // sock?: ReturnType<typeof makeWASocket>;
  starting: boolean;
};
const sessions = new Map<string, Session>();       // key: sessionId
const orgToSession = new Map<string, string>();    // key: orgId -> sessionId
const startingOrgs = new Set<string>();            // simple lock anti-doublon

// --- Helpers SSE ---
function sseHeaders() {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    // Optionnel: pour proxies
    "X-Accel-Buffering": "no",
  };
}
function sseWrite(res: express.Response, event: string, data: any) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// --- Boot / Reuse d'une session ---
async function startOrReuseSession(orgId: string): Promise<Session> {
  // Si on a déjà une session active pour cet org, on la renvoie
  const existingId = orgToSession.get(orgId);
  if (existingId) {
    const s = sessions.get(existingId);
    if (s) return s;
    orgToSession.delete(orgId);
  }

  // Lock anti-démarrage concurrent
  if (startingOrgs.has(orgId)) {
    // On attend que l'autre boucle finisse (polling soft)
    await new Promise((r) => setTimeout(r, 500));
    const again = orgToSession.get(orgId);
    if (again && sessions.get(again)) return sessions.get(again)!;
  }

  startingOrgs.add(orgId);
  try {
    const sessionId = `org_${orgId}__ephem_${Date.now()}_${uuid().slice(0, 8)}`;
    const events = new EventEmitter();

    const session: Session = {
      orgId, sessionId, events,
      status: "pending",
      startedAt: Date.now(),
      starting: true,
    };
    sessions.set(sessionId, session);
    orgToSession.set(orgId, sessionId);

    // --- Ici on boot Baileys (ex: en single-file auth en mémoire ou disque)
    // const { state, saveCreds } = await useMultiFileAuthState(`./auth/${sessionId}`);
    // const sock = makeWASocket({
    //   auth: state,
    //   browser: Browsers.macOS("Zuria.AI"),
    //   printQRInTerminal: false,
    //   syncFullHistory: false,
    // });
    // session.sock = sock;

    // sock.ev.on("creds.update", saveCreds);
    // sock.ev.on("connection.update", (u) => {
    //   const { connection, lastDisconnect, qr } = u;
    //   if (qr) {
    //     session.status = "qr";
    //     events.emit("qr", { qr });
    //   }
    //   if (connection === "open") {
    //     session.status = "connected";
    //     events.emit("status", { status: "connected" });
    //   }
    //   if (connection === "close") {
    //     const reason = (lastDisconnect?.error as any)?.output?.statusCode;
    //     events.emit("status", { status: "closed", reason });
    //   }
    // });

    // --- DEMO: sans Baileys branché, on simule un QR puis "connected"
    setTimeout(() => { session.status = "qr"; events.emit("qr", { qr: "qr-data-demo" }); }, 1200);
    setTimeout(() => { session.status = "connected"; events.emit("status", { status: "connected" }); }, 6000);

    session.starting = false;
    return session;
  } finally {
    startingOrgs.delete(orgId);
  }
}

// --- API: créer / récupérer une session depuis org_id ---
app.post("/sessions", requireEdgeToken, async (req, res) => {
  const orgId = String(req.query.org_id ?? req.body?.org_id ?? "").trim();
  if (!orgId) return res.status(400).json({ ok: false, error: "org_id_required" });

  try {
    const s = await startOrReuseSession(orgId);
    return res.json({ ok: true, session_id: s.sessionId });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: "session_start_failed", details: String(e?.message || e) });
  }
});

// --- SSE: stream des événements de la session ---
app.get("/sessions/:sessionId/events", requireEdgeToken, (req, res) => {
  const { sessionId } = req.params;
  const s = sessions.get(sessionId);
  if (!s) return res.status(404).send("session_not_found");

  res.writeHead(200, sseHeaders());

  // bootstrap: envoyer l'état courant
  sseWrite(res, "status", { status: s.status, sessionId });

  // listeners
  const onQR = (payload: any) => sseWrite(res, "qr", { ...payload, sessionId });
  const onStatus = (payload: any) => sseWrite(res, "status", { ...payload, sessionId });
  const onError = (payload: any) => sseWrite(res, "error", { ...payload, sessionId });

  s.events.on("qr", onQR);
  s.events.on("status", onStatus);
  s.events.on("error", onError);

  // keepalive every 25s
  const ka = setInterval(() => res.write(": keep-alive\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(ka);
    s.events.off("qr", onQR);
    s.events.off("status", onStatus);
    s.events.off("error", onError);
    res.end();
  });
});

// --- Santé & debug ---
app.get("/healthz", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`[gateway] listening on :${PORT}`);
});
