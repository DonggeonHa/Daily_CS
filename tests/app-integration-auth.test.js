const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { build } = require("esbuild");

async function importAuthModule() {
  const outfile = path.join(os.tmpdir(), `daily-cs-auth-${Date.now()}-${Math.random()}.mjs`);
  await build({
    entryPoints: [path.join(__dirname, "..", "web", "assets", "auth.js")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    legalComments: "none",
    plugins: [{
      name: "supabase-stub",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "supabase-stub", namespace: "stub" }));
        buildApi.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          loader: "js",
          contents: `
            export const calls = [];
            export function createClient(url, key, options) {
              calls.push({ url, key, options });
              return { url, key, options, auth: {} };
            }
          `
        }));
      }
    }]
  });
  return import(`file://${outfile.replace(/\\/g, "/")}`);
}

test("safe return urls are same-origin and confined to Daily_CS", async () => {
  const { safeReturnUrl } = await importAuthModule();
  const location = { origin: "https://donggeonha.github.io" };

  assert.equal(
    safeReturnUrl("https://donggeonha.github.io/Daily_CS/?view=admin", location, "/Daily_CS/"),
    "https://donggeonha.github.io/Daily_CS/?view=admin"
  );
  assert.equal(
    safeReturnUrl("https://evil.example/Daily_CS/", location, "/Daily_CS/"),
    "https://donggeonha.github.io/Daily_CS/"
  );
  assert.equal(
    safeReturnUrl("/other/", location, "/Daily_CS/"),
    "https://donggeonha.github.io/Daily_CS/"
  );
});

test("auth clients use Supabase PKCE with caller-provided sessionStorage", async () => {
  const { createAuthClient, createCallbackClient } = await importAuthModule();
  const storage = { getItem() {}, setItem() {}, removeItem() {} };
  const config = { supabaseUrl: "https://project.supabase.co", supabaseAnonKey: "sb_publishable_test" };

  const client = createAuthClient(config, storage);
  const callbackClient = createCallbackClient(config, storage);

  assert.equal(client.options.auth.flowType, "pkce");
  assert.equal(client.options.auth.storage, storage);
  assert.equal(client.options.auth.detectSessionInUrl, false);
  assert.equal(client.options.auth.persistSession, true);
  assert.equal(callbackClient.options.auth.detectSessionInUrl, true);
});

test("missing production config fails before any content can load", async () => {
  const { createAuthClient, requireProductionConfig } = await importAuthModule();

  assert.throws(() => requireProductionConfig({}), /Supabase public configuration is missing/);
  assert.throws(() => createAuthClient({}, {}), /Supabase public configuration is missing/);
});

test("verified session authenticates the user after reading the stored session", async () => {
  const { getVerifiedSession } = await importAuthModule();
  const calls = [];
  const client = {
    auth: {
      getSession: async () => {
        calls.push("getSession");
        return { data: { session: { access_token: "token", user: { id: "stored" } } }, error: null };
      },
      getUser: async () => {
        calls.push("getUser");
        return { data: { user: { id: "verified" } }, error: null };
      }
    }
  };

  const session = await getVerifiedSession(client);

  assert.deepEqual(calls, ["getSession", "getUser"]);
  assert.equal(session.user.id, "verified");
});

test("Google sign-in uses account chooser without public owner email hint", async () => {
  const { signInWithGoogle } = await importAuthModule();
  const calls = [];
  const client = {
    auth: {
      signInWithOAuth: async (payload) => {
        calls.push(payload);
        return { data: {}, error: null };
      }
    }
  };

  await signInWithGoogle(client, "https://donggeonha.github.io/Daily_CS/auth/callback.html");

  assert.deepEqual(calls, [{
    provider: "google",
    options: {
      redirectTo: "https://donggeonha.github.io/Daily_CS/auth/callback.html",
      queryParams: { prompt: "select_account" }
    }
  }]);
  assert.equal(calls[0].options.queryParams.login_hint, undefined);
});
