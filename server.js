const express = require("express");
const cors = require("cors");

const app = express();


const {
  LOGIX_API_BASE_URL,
  LOGIX_API_KEY,
  ALLOWED_ORIGINS = "",
  PORT = 3000,
} = process.env;

/* ---------- Validação na inicialização ---------- */
if (!LOGIX_API_BASE_URL || !LOGIX_API_KEY) {
  console.error(
    "❌  Variáveis obrigatórias não definidas:\n" +
    "    LOGIX_API_BASE_URL = URL base da API Logix\n" +
    "    LOGIX_API_KEY      = Chave X-API-Key\n" +
    "Defina-as no painel do Railway e reinicie o serviço."
  );
  process.exit(1);
}


const origensPermitidas = ALLOWED_ORIGINS
  ? ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : null;

app.use(
  cors({
    origin: function (origin, callback) {
      // Permite requests sem origin (Postman, curl, health checks)
      if (!origin) return callback(null, true);
      if (!origensPermitidas) return callback(null, true);
      if (origensPermitidas.includes(origin)) return callback(null, true);
      callback(new Error("Origem não permitida: " + origin));
    },
    methods: ["GET", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
  })
);

/* ---------- Rate limiter simples (em memória) ----------
   Limita a 120 requests por minuto por IP.
   Para produção pesada, considere express-rate-limit com Redis. */
const rateMap = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;

function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  let entry = rateMap.get(ip);

  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    entry = { start: now, count: 0 };
    rateMap.set(ip, entry);
  }

  entry.count++;
  if (entry.count > RATE_MAX) {
    return res.status(429).json({ error: "Rate limit excedido. Tente novamente em breve." });
  }
  next();
}

// Limpa entradas antigas a cada 5 min
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, entry] of rateMap) {
    if (entry.start < cutoff) rateMap.delete(ip);
  }
}, 300_000);

/* ---------- Health check ---------- */
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/* ---------- Rotas permitidas ----------
   Somente os endpoints do Logix que o Guide precisa.
   Qualquer outro path retorna 404. */
const ROTAS_PERMITIDAS = [
  /^\/v1\/zendesk\/empresas$/,
  /^\/v1\/zendesk\/natureza-operacao$/,
  /^\/v1\/zendesk\/transportadoras$/,
  /^\/v1\/zendesk\/notas-fiscais\/[^/]+$/,
  /^\/v1\/zendesk\/items$/,
  /^\/v1\/zendesk\/items\/logix$/,
];

function rotaPermitida(path) {
  return ROTAS_PERMITIDAS.some((rx) => rx.test(path));
}

/* ---------- Proxy ---------- */
app.get("/v1/zendesk/*", rateLimiter, async (req, res) => {
  const apiPath = req.path; // Ex.: /v1/zendesk/empresas

  if (!rotaPermitida(apiPath)) {
    return res.status(404).json({ error: "Rota não permitida." });
  }

  // Repassa query string (ex.: ?DEN_ITEM=PNEU) para a API Logix
  const queryString = new URLSearchParams(req.query).toString();
  const targetUrl = LOGIX_API_BASE_URL + apiPath + (queryString ? "?" + queryString : "");

  try {
    const apiRes = await fetch(targetUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-API-Key": LOGIX_API_KEY,
      },
    });

    // Repassa o status code da API
    const contentType = apiRes.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const data = await apiRes.json();
      return res.status(apiRes.status).json(data);
    }

    // Se não for JSON, repassa como texto
    const text = await apiRes.text();
    res
      .status(apiRes.status)
      .set("Content-Type", contentType || "text/plain")
      .send(text);
  } catch (err) {
    console.error("Erro ao chamar API Logix:", err.message);
    res.status(502).json({
      error: "Não foi possível conectar à API Logix.",
      detail: err.message,
    });
  }
});

/* ---------- 404 genérico ---------- */
app.use((_req, res) => {
  res.status(404).json({ error: "Rota não encontrada." });
});

/* ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`✅  Proxy Logix rodando na porta ${PORT}`);
  console.log(`   API base: ${LOGIX_API_BASE_URL}`);
  console.log(`   Origens:  ${origensPermitidas ? origensPermitidas.join(", ") : "(todas)"}`);
});