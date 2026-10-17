import { createClient } from "https://esm.sh/@supabase/supabase-js@2.87.1";

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

const PRODUCTION_ORIGIN = "https://donggeonha.github.io";
const ALLOWED_REQUEST_HEADERS = "authorization, apikey, content-type";

function statusFor(code: string): number {
  switch (code) {
    case "bad_request":
    case "validation_failed":
    case "import_failed":
      return 400;
    case "unauthorized":
      return 401;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseEnvelope(value: unknown): ApiEnvelope | null {
  if (!isRecord(value) || typeof value.action !== "string") return null;
  const payload = isRecord(value.payload)
    ? value.payload
    : {};
  return { action: value.action, payload };
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

Deno.serve(async (request: Request): Promise<Response> => {
  const origin = request.headers.get("Origin");

  if (request.method === "OPTIONS") {
    return options(origin);
  }

  if (request.method !== "POST") {
    return json(origin, { error: { code: "bad_request", message: "POST required" } }, 400);
  }

  const authorization = request.headers.get("Authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return json(origin, { error: { code: "unauthorized", message: "owner login required" } }, 401);
  }

  const parsed = parseEnvelope(await request.json().catch((): null => null));
  if (parsed === null) {
    return json(origin, { error: { code: "bad_request", message: "invalid action envelope" } }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (supabaseUrl === undefined || anonKey === undefined) {
    return json(origin, { error: { code: "internal_error", message: "server is not configured" } }, 500);
  }

  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });

  const { error: userError } = await client.auth.getUser();
  if (userError !== null) {
    return json(origin, { error: { code: "unauthorized", message: "owner login required" } }, 401);
  }

  const { data, error } = await client.rpc("daily_cs_owner_api", {
    action: parsed.action,
    payload: parsed.payload,
  });

  if (error !== null) {
    return json(origin, { error: { code: "internal_error", message: "owner action failed" } }, 500);
  }

  const envelope = parseRpcEnvelope(data);
  if ("error" in envelope) {
    return json(origin, envelope, statusFor(envelope.error.code));
  }

  return json(origin, envelope);
});
