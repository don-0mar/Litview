import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, signUp } from "./helpers.js";

let ctx;
const RETURN = "http://allowed.test/oauth.html?popup=1";

before(async () => {
  ctx = await setup({
    env: {
      PUBLIC_API_URL: "https://api.test",
      GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "g-secret",
      X_CLIENT_ID: "x-id", X_CLIENT_SECRET: "x-secret",
      LINKEDIN_CLIENT_ID: "li-id", LINKEDIN_CLIENT_SECRET: "li-secret",
    },
    routes: [
      [u => u === "https://oauth2.googleapis.com/token", (_u, init) => {
        const b = new URLSearchParams(init.body);
        assert.equal(b.get("client_secret"), "g-secret");
        assert.ok(b.get("code_verifier"), "Google gets the PKCE verifier");
        assert.equal(b.get("redirect_uri"), "https://api.test/api/auth/oauth/google/callback");
        return b.get("code") === "good" ? { json: { access_token: "g-token" } } : { status: 400, json: { error: "invalid_grant" } };
      }],
      [u => u.startsWith("https://openidconnect.googleapis.com/"), () => ({ json: { sub: "g-123", name: "Omar Google", email: "Omar@Example.com", email_verified: true } })],
      [u => u === "https://api.x.com/2/oauth2/token", (_u, init) => {
        assert.match(init.headers.Authorization, /^Basic /, "X uses HTTP Basic client auth");
        return { json: { access_token: "x-token" } };
      }],
      [u => u.startsWith("https://api.x.com/2/users/me"), () => ({ json: { data: { id: "x-9", name: "Omar on X", username: "don0mar" } } })],
      [u => u === "https://www.linkedin.com/oauth/v2/accessToken", () => ({ json: { access_token: "li-token" } })],
      [u => u.startsWith("https://api.linkedin.com/v2/userinfo"), () => ({ json: { sub: "li-1", given_name: "Aisha", family_name: "Rahman", email: "aisha@example.com", email_verified: false } })],
    ],
  });
});
after(() => ctx.close());

/** Walk through start -> provider -> callback -> exchange, returning the final session. */
async function signInWith(provider, code = "good") {
  const start = await ctx.api.get(`/api/auth/oauth/${provider}/start`).query({ return: RETURN });
  assert.equal(start.status, 302, JSON.stringify(start.body));
  const auth = new URL(start.headers.location);
  const cookie = start.headers["set-cookie"][0].split(";")[0];
  const cb = await ctx.api.get(`/api/auth/oauth/${provider}/callback`).query({ code, state: auth.searchParams.get("state") }).set("Cookie", cookie);
  assert.equal(cb.status, 302);
  const loc = new URL(cb.headers.location);
  assert.equal(loc.origin + loc.pathname + loc.search, RETURN);
  const params = new URLSearchParams(loc.hash.slice(1));
  return { auth, params };
}

test("the sign-in options are listed", async () => {
  const r = await ctx.api.get("/api/sources");
  assert.deepEqual(r.body.oauth, ["google", "x", "linkedin"]);
});

test("Google sign-in links to the existing account with the same verified email", async () => {
  const existing = await signUp(ctx.api, "Omar", "omar@example.com");
  const { auth, params } = await signInWith("google");
  assert.equal(auth.origin + auth.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("scope"), "openid email profile");
  const code = params.get("code");
  assert.ok(code && !params.get("error"));
  const ex = await ctx.api.post("/api/auth/oauth/exchange").send({ code });
  assert.equal(ex.status, 200);
  assert.equal(ex.body.user.id, existing.user.id, "same Litview account");
  // The code only works once.
  assert.equal((await ctx.api.post("/api/auth/oauth/exchange").send({ code })).status, 400);
  // Signing in again finds the linked identity.
  const again = await signInWith("google");
  const ex2 = await ctx.api.post("/api/auth/oauth/exchange").send({ code: again.params.get("code") });
  assert.equal(ex2.body.user.id, existing.user.id);
});

test("X sign-in without an email creates a new account", async () => {
  const { params } = await signInWith("x");
  const ex = await ctx.api.post("/api/auth/oauth/exchange").send({ code: params.get("code") });
  assert.equal(ex.body.user.name, "Omar on X");
  assert.equal(ex.body.user.email, null);
  const me = await ctx.api.get("/api/auth/me").set({ Authorization: `Bearer ${ex.body.token}` });
  assert.equal(me.status, 200);
});

test("an unverified email is not used to take over an account", async () => {
  const aisha = await signUp(ctx.api, "Aisha", "aisha@example.com");
  const { params } = await signInWith("linkedin");
  const ex = await ctx.api.post("/api/auth/oauth/exchange").send({ code: params.get("code") });
  assert.notEqual(ex.body.user.id, aisha.user.id);
  assert.equal(ex.body.user.name, "Aisha Rahman");
});

test("password sign-up explains when an email already uses social sign-in", async () => {
  const r = await ctx.api.post("/api/auth/register").send({ name: "Z", email: "zed@example.com", password: "password123" });
  assert.equal(r.status, 201);
  // A Google-only account: create one by signing in with a fresh Google profile.
  const bare = await ctx.pool.query("INSERT INTO users (email, name) VALUES ('social@example.com', 'S') RETURNING id");
  await ctx.pool.query("INSERT INTO user_identities (provider, provider_user_id, user_id) VALUES ('google', 'g-999', $1)", [bare.rows[0].id]);
  const dup = await ctx.api.post("/api/auth/register").send({ name: "S", email: "social@example.com", password: "password123" });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /Google/);
  const login = await ctx.api.post("/api/auth/login").send({ email: "social@example.com", password: "password123" });
  assert.equal(login.status, 401, "accounts without a password can't be signed into with one");
});

test("rejects bad returns, tampered state, cancelled and failed sign-ins", async () => {
  assert.equal((await ctx.api.get("/api/auth/oauth/google/start").query({ return: "https://evil.test/steal" })).status, 400);
  assert.equal((await ctx.api.get("/api/auth/oauth/facebook/start").query({ return: RETURN })).status, 404, "not configured");

  const start = await ctx.api.get("/api/auth/oauth/google/start").query({ return: RETURN });
  const cookie = start.headers["set-cookie"][0].split(";")[0];
  const wrong = await ctx.api.get("/api/auth/oauth/google/callback").query({ code: "good", state: "forged" }).set("Cookie", cookie);
  assert.match(decodeURIComponent(wrong.headers.location), /error=The\+sign-in\+expired|error=The sign-in expired/);
  assert.equal((await ctx.api.get("/api/auth/oauth/google/callback").query({ code: "good", state: "x" })).status, 400, "no cookie");

  const cancelled = await signInWithError("google", { error: "access_denied" });
  assert.match(cancelled, /cancelled/);
  const failed = await signInWithError("google", { code: "bad" });
  assert.match(failed, /didn't accept/);
});

async function signInWithError(provider, query) {
  const start = await ctx.api.get(`/api/auth/oauth/${provider}/start`).query({ return: RETURN });
  const state = new URL(start.headers.location).searchParams.get("state");
  const cb = await ctx.api.get(`/api/auth/oauth/${provider}/callback`).query({ state, ...query }).set("Cookie", start.headers["set-cookie"][0].split(";")[0]);
  return new URLSearchParams(new URL(cb.headers.location).hash.slice(1)).get("error");
}
