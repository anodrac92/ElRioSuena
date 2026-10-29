import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { join } from "node:path";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const publicDirectory = join(import.meta.dirname, "public");
const projectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
const agentName = process.env.FOUNDRY_AGENT_NAME;
const loginPassword = process.env.CHAT_LOGIN_PASSWORD;
const sessionSecret = process.env.CHAT_SESSION_SECRET;
const sessionDurationSeconds = 8 * 60 * 60;
const loginFailureLimit = 5;
const loginBlockDurationMs = 15 * 60 * 1000;
const loginFailureWindowMs = 15 * 60 * 1000;
const sessionCookieName = "chat_session";
const loginFailures = new Map();
const authenticationConfigured =
  typeof loginPassword === "string" &&
  loginPassword.length >= 16 &&
  typeof sessionSecret === "string" &&
  sessionSecret.length >= 32;

let openaiClient;

app.set("trust proxy", process.env.WEBSITE_INSTANCE_ID ? 1 : false);
app.disable("x-powered-by");

app.use((request, response, next) => {
  response.set({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });

  if (request.secure) {
    response.set("Strict-Transport-Security", "max-age=31536000");
  }

  next();
});

if (!authenticationConfigured) {
  console.error(
    "Configura CHAT_LOGIN_PASSWORD (mínimo 16 caracteres) y CHAT_SESSION_SECRET (mínimo 32 caracteres); el acceso permanece cerrado.",
  );
}

if (projectEndpoint && agentName) {
  const projectClient = new AIProjectClient(
    projectEndpoint,
    new DefaultAzureCredential(),
  );
  openaiClient = projectClient.getOpenAIClient();
} else {
  console.error(
    "FOUNDRY_PROJECT_ENDPOINT y FOUNDRY_AGENT_NAME son necesarios para habilitar el chat.",
  );
}

app.use(express.json({ limit: "32kb" }));

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

function getSessionCookie(request) {
  const cookie = request.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${sessionCookieName}=`));

  return cookie?.slice(sessionCookieName.length + 1);
}

function isAuthenticated(request) {
  if (!authenticationConfigured) {
    return false;
  }

  const token = getSessionCookie(request);
  const [encodedPayload, providedSignature, extraPart] = token?.split(".") ?? [];

  if (!encodedPayload || !providedSignature || extraPart !== undefined) {
    return false;
  }

  const expectedSignature = createHmac("sha256", sessionSecret)
    .update(encodedPayload)
    .digest();
  const actualSignature = Buffer.from(providedSignature, "base64url");

  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return false;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
    return Number.isSafeInteger(payload.expiresAt) &&
      payload.expiresAt > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function createSessionToken() {
  const payload = Buffer.from(
    JSON.stringify({
      expiresAt: Math.floor(Date.now() / 1000) + sessionDurationSeconds,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", sessionSecret)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function setSessionCookie(response, request, value, maxAge) {
  const secure = request.secure ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`,
  );
}

function getLoginFailureState(ipAddress) {
  const now = Date.now();

  for (const [ip, state] of loginFailures) {
    if (
      state.blockedUntil <= now &&
      now - state.windowStartedAt > loginFailureWindowMs
    ) {
      loginFailures.delete(ip);
    }
  }

  let state = loginFailures.get(ipAddress);

  if (state && now - state.windowStartedAt > loginFailureWindowMs) {
    loginFailures.delete(ipAddress);
    state = undefined;
  }

  if (!state) {
    if (loginFailures.size >= 1000) {
      const oldestIp = loginFailures.keys().next().value;
      if (oldestIp !== undefined) {
        loginFailures.delete(oldestIp);
      }
    }

    state = { attempts: 0, windowStartedAt: now, blockedUntil: 0 };
    loginFailures.set(ipAddress, state);
  }

  return state;
}

function requireAuthentication(request, response, next) {
  if (!isAuthenticated(request)) {
    response.status(authenticationConfigured ? 401 : 503).json({
      error: authenticationConfigured
        ? "Inicia sesión para continuar."
        : "El acceso no está configurado.",
    });
    return;
  }

  next();
}

app.post("/api/login", (request, response) => {
  response.set("Cache-Control", "no-store");

  if (!authenticationConfigured) {
    response.status(503).json({ error: "El acceso no está configurado." });
    return;
  }

  const state = getLoginFailureState(request.ip);
  const now = Date.now();

  if (state.blockedUntil > now) {
    response.set(
      "Retry-After",
      String(Math.ceil((state.blockedUntil - now) / 1000)),
    );
    response.status(429).json({
      error: "Demasiados intentos. Espera antes de volver a intentar.",
    });
    return;
  }

  const providedPassword =
    typeof request.body?.password === "string" ? request.body.password : "";
  const expectedHash = createHmac("sha256", sessionSecret)
    .update(loginPassword)
    .digest();
  const providedHash = createHmac("sha256", sessionSecret)
    .update(providedPassword)
    .digest();

  if (!timingSafeEqual(providedHash, expectedHash)) {
    state.attempts += 1;

    if (state.attempts >= loginFailureLimit) {
      state.blockedUntil = now + loginBlockDurationMs;
      response.set(
        "Retry-After",
        String(Math.ceil(loginBlockDurationMs / 1000)),
      );
      response.status(429).json({
        error: "Demasiados intentos. Espera antes de volver a intentar.",
      });
      return;
    }

    response.status(401).json({ error: "La contraseña no es correcta." });
    return;
  }

  loginFailures.delete(request.ip);
  setSessionCookie(
    response,
    request,
    createSessionToken(),
    sessionDurationSeconds,
  );
  response.json({ authenticated: true });
});

app.get("/api/session", (request, response) => {
  response.set("Cache-Control", "no-store");
  response.json({ authenticated: isAuthenticated(request) });
});

app.post("/api/logout", (request, response) => {
  setSessionCookie(response, request, "", 0);
  response.status(204).end();
});

app.get("/login.css", (_request, response) => {
  response.sendFile(join(publicDirectory, "login.css"));
});

app.get("/login.js", (_request, response) => {
  response.sendFile(join(publicDirectory, "login.js"));
});

app.get("/", (request, response) => {
  response.set("Cache-Control", "no-store");
  response.sendFile(
    join(
      publicDirectory,
      isAuthenticated(request) ? "index.html" : "login.html",
    ),
  );
});

app.get("/styles.css", requireAuthentication, (_request, response) => {
  response.sendFile(join(publicDirectory, "styles.css"));
});

app.get("/app.js", requireAuthentication, (_request, response) => {
  response.sendFile(join(publicDirectory, "app.js"));
});

app.post("/api/chat", requireAuthentication, async (request, response) => {
  if (!openaiClient) {
    response.status(503).json({ error: "El servicio de chat no está configurado." });
    return;
  }

  const { message: rawMessage, conversation_id: requestedConversationId } =
    request.body ?? {};

  if (
    typeof rawMessage !== "string" ||
    rawMessage.trim().length === 0 ||
    rawMessage.trim().length > 2000 ||
    (requestedConversationId !== undefined &&
      requestedConversationId !== null &&
      (typeof requestedConversationId !== "string" ||
        requestedConversationId.trim().length === 0))
  ) {
    response.status(422).json({
      error: "El mensaje debe contener entre 1 y 2000 caracteres.",
    });
    return;
  }

  const message = rawMessage.trim();
  const agentReference = {
    body: {
      agent_reference: {
        name: agentName,
        type: "agent_reference",
      },
    },
  };

  try {
    const conversationId =
      requestedConversationId ??
      (await openaiClient.conversations.create()).id;
    const result = await openaiClient.responses.create(
      {
        conversation: conversationId,
        input: message,
      },
      agentReference,
    );
    const reply = result.output
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content)
      .filter((item) => item.type === "output_text")
      .map((item) => item.text)
      .join("\n")
      .trim();

    if (!reply) {
      throw new Error("Foundry devolvió una respuesta sin texto.");
    }

    response.json({ reply, conversation_id: conversationId });
  } catch (error) {
    console.error(
      "Falló la solicitud a Microsoft Foundry:",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
    response.status(502).json({
      error: "No se pudo obtener una respuesta del asistente.",
    });
  }
});

app.listen(port, () => {
  console.log(`Servidor disponible en el puerto ${port}.`);
});
