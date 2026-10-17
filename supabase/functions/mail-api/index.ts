import { createClient } from "https://esm.sh/@supabase/supabase-js@2.87.1";
import { renderMailFromSnapshot } from "../_shared/render.mjs";

type ApiEnvelope = {
  readonly action: string;
  readonly payload: Record<string, unknown>;
};

type ApiError = {
  readonly code: string;
  readonly message: string;
};

type RpcEnvelope =
  | { readonly data: unknown }
  | { readonly error: ApiError };

type SupabaseClient = ReturnType<typeof createClient>;

type RenderedMail = {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
};

const PRODUCTION_ORIGIN = "https://donggeonha.github.io";
const ALLOWED_REQUEST_HEADERS = "authorization, apikey, content-type, x-daily-cs-mail-key";
const PUBLIC_ACTIONS = new Set([
  "mail.claimDue",
  "mail.beginSending",
  "mail.resumeClaim",
  "mail.reconcileLegacyGuard",
  "mail.ackSent",
  "mail.markUncertain",
  "mail.preflight",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function statusFor(code: string): number {
  switch (code) {
    case "bad_request":
    case "validation_failed":
      return 400;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    default:
      return 500;
  }
}

function allowedOrigin(origin: string | null): string | null {
  if (origin === PRODUCTION_ORIGIN) return origin;
  if (origin === null || Deno.env.get("DAILY_CS_ALLOW_LOCAL_ORIGINS") !== "true") return null;
  try {
    const url = new URL(origin);
    if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && (url.protocol === "http:" || url.protocol === "https:")) {
      return origin;
    }
    return null;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function responseHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  const allowed = allowedOrigin(origin);
  if (allowed !== null) {
    headers.set("Access-Control-Allow-Origin", allowed);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", ALLOWED_REQUEST_HEADERS);
  }
  return headers;
}

function json(origin: string | null, body: RpcEnvelope, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(origin) });
}

function options(origin: string | null): Response {
  if (allowedOrigin(origin) === null) {
    return json(origin, { error: { code: "forbidden", message: "origin is not allowed" } }, 403);
  }
  return new Response(null, { status: 204, headers: responseHeaders(origin) });
}

function parseEnvelope(value: unknown): ApiEnvelope | null {
  if (!isRecord(value) || typeof value.action !== "string") return null;
  return { action: value.action, payload: isRecord(value.payload) ? value.payload : {} };
}

function parseRpcEnvelope(value: unknown): RpcEnvelope {
  if (!isRecord(value)) {
    return { error: { code: "internal_error", message: "invalid RPC response" } };
  }
  if (isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string") {
    return { error: { code: value.error.code, message: value.error.message } };
  }
  return { data: value.data };
}

function renderedMail(value: unknown): RenderedMail | null {
  if (!isRecord(value)) return null;
  if (typeof value.subject !== "string" || typeof value.html !== "string" || typeof value.text !== "string") return null;
  if (value.subject.trim().length === 0 || value.html.trim().length === 0 || value.text.trim().length === 0) return null;
  return { subject: value.subject, html: value.html, text: value.text };
}

async function callMailRpc(
  client: SupabaseClient,
  action: string,
  payload: Record<string, unknown>,
  token: string,
): Promise<RpcEnvelope> {
  const { data, error } = await client.rpc("daily_cs_mail_api", { action, payload, token });
  if (error !== null) {
    return { error: { code: "internal_error", message: "mail action failed" } };
  }
  return parseRpcEnvelope(data);
}

async function materializeDueMail(
  client: SupabaseClient,
  payload: Record<string, unknown>,
  token: string,
): Promise<RpcEnvelope | null> {
  const prepared = await callMailRpc(client, "mail.prepareDue", payload, token);
  if ("error" in prepared) return prepared;
  if (!isRecord(prepared.data) || !isRecord(prepared.data.candidate)) return null;

  const candidate = prepared.data.candidate;
  if (typeof candidate.id !== "string" || typeof candidate.contentHash !== "string" || !isRecord(candidate.lesson)) {
    return { error: { code: "internal_error", message: "mail render candidate is incomplete" } };
  }

  const snapshotForRender = {
    ...candidate.lesson,
    kind: candidate.kind,
    date: candidate.date,
    snapshotId: candidate.snapshotId,
  };
  const rendered = renderedMail(renderMailFromSnapshot(snapshotForRender));
  if (rendered === null) {
    return { error: { code: "internal_error", message: "mail renderer returned incomplete content" } };
  }

  return callMailRpc(client, "mail.materialize", {
    candidateId: candidate.id,
    contentHash: candidate.contentHash,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  }, token);
}

Deno.serve(async (request: Request): Promise<Response> => {
  const origin = request.headers.get("Origin");

  if (request.method === "OPTIONS") {
    return options(origin);
  }

  if (request.method !== "POST") {
    return json(origin, { error: { code: "bad_request", message: "POST required" } }, 400);
  }

  const token = request.headers.get("X-Daily-CS-Mail-Key");
  if (token === null || token.length < 24) {
    return json(origin, { error: { code: "forbidden", message: "valid mail credential required" } }, 403);
  }

  const parsed = parseEnvelope(await request.json().catch((): null => null));
  if (parsed === null) {
    return json(origin, { error: { code: "bad_request", message: "invalid action envelope" } }, 400);
  }
  if (!PUBLIC_ACTIONS.has(parsed.action)) {
    return json(origin, { error: { code: "bad_request", message: "unknown mail action" } }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (supabaseUrl === undefined || serviceRoleKey === undefined) {
    return json(origin, { error: { code: "internal_error", message: "server is not configured" } }, 500);
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (parsed.action === "mail.claimDue") {
    const materialized = await materializeDueMail(client, parsed.payload, token);
    if (materialized !== null && "error" in materialized) {
      return json(origin, materialized, statusFor(materialized.error.code));
    }
  }

  const envelope = await callMailRpc(client, parsed.action, parsed.payload, token);
  if ("error" in envelope) {
    return json(origin, envelope, statusFor(envelope.error.code));
  }

  return json(origin, envelope);
});
