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
const ALLOWED_REQUEST_HEADERS = "authorization, apikey, content-type, x-daily-cs-backup-key";
const BACKUP_RPC = "daily_cs_backup_api";
const EXPORT_PREFIX_BYTES = 64;
const FORBIDDEN = { error: { code: "forbidden", message: "valid backup credential required" } } as const;
const BACKUP_FAILED = { error: { code: "internal_error", message: "backup action failed" } } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function replayExport(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefixChunks: Uint8Array[],
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      const chunk = prefixChunks.shift();
      if (chunk !== undefined) {
        controller.enqueue(chunk);
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) {
          reader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        reader.releaseLock();
        throw error;
      }
    },
    async cancel(reason: unknown) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  }, { highWaterMark: 0 });
}

async function forwardExport(upstream: Response, origin: string | null): Promise<Response> {
  if (upstream.status !== 200 || upstream.body === null ||
    !/^application\/json(?:\s*;|$)/i.test(upstream.headers.get("Content-Type") ?? "")) {
    await upstream.body?.cancel();
    return json(origin, BACKUP_FAILED, 500);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const prefixChunks: Uint8Array[] = [];
  let prefix = "";
  let remaining = EXPORT_PREFIX_BYTES;
  let forwarding = false;
  try {
    while (remaining > 0) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (chunk.byteLength === 0) continue;
      prefixChunks.push(chunk);
      const head = chunk.subarray(0, remaining);
      remaining -= head.byteLength;
      prefix += decoder.decode(head, { stream: true });
      // The scalar JSONB RPC returns either {data: {export: {...}}} or a scoped credential error.
      if (/^\s*\{\s*"data"\s*:\s*\{\s*"export"\s*:\s*\{/.test(prefix)) {
        const response = new Response(replayExport(reader, prefixChunks), { headers: responseHeaders(origin) });
        forwarding = true;
        return response;
      }
      if (/^\s*\{\s*"error"\s*:\s*\{\s*"code"\s*:\s*"forbidden"\s*,/.test(prefix)) {
        return json(origin, FORBIDDEN, 403);
      }
    }
    return json(origin, BACKUP_FAILED, 500);
  } finally {
    if (!forwarding) {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  }
}

Deno.serve(async (request: Request): Promise<Response> => {
  const origin = request.headers.get("Origin");

  if (request.method === "OPTIONS") {
    return options(origin);
  }

  if (request.method !== "POST") {
    return json(origin, { error: { code: "bad_request", message: "POST required" } }, 400);
  }

  const token = request.headers.get("X-Daily-CS-Backup-Key");
  if (token === null || token.length < 24) {
    return json(origin, FORBIDDEN, 403);
  }

  const parsed = parseEnvelope(await request.json().catch((): null => null));
  if (parsed === null) {
    return json(origin, { error: { code: "bad_request", message: "invalid action envelope" } }, 400);
  }

  if (parsed.action !== "backup.export" && parsed.action !== "backup.report") {
    return json(origin, { error: { code: "bad_request", message: "unknown backup action" } }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (supabaseUrl === undefined || serviceRoleKey === undefined) {
    return json(origin, { error: { code: "internal_error", message: "server is not configured" } }, 500);
  }

  const args = { action: parsed.action, payload: parsed.payload, token };
  if (parsed.action === "backup.export") {
    // The SDK buffers and parses the whole RPC result. Relay the authenticated export instead.
    try {
      const upstream = await fetch(new URL(`/rest/v1/rpc/${BACKUP_RPC}`, supabaseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify(args),
        redirect: "error",
        signal: request.signal,
      });
      return await forwardExport(upstream, origin);
    } catch { // no-excuse-ok: catch
      return json(origin, BACKUP_FAILED, 500);
    }
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.rpc(BACKUP_RPC, args);

  if (error !== null) {
    return json(origin, BACKUP_FAILED, 500);
  }

  const envelope = parseRpcEnvelope(data);
  if ("error" in envelope) {
    const status = envelope.error.code === "forbidden" ? 403 : envelope.error.code === "conflict" ? 409 : 400;
    return json(origin, envelope, status);
  }

  return json(origin, envelope);
});
