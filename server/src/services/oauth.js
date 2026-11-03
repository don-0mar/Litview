// Social sign-in (OAuth 2.0 authorization code flow) for Google, Facebook, X and LinkedIn.
// Each provider describes where to send the user, how to swap the code for a token,
// and how to read the user's id, name and email.

import crypto from "node:crypto";
import { HttpError } from "../lib/http.js";

const b64url = buf => buf.toString("base64url");
export const randomToken = (bytes = 32) => b64url(crypto.randomBytes(bytes));
export const pkcePair = () => {
  const verifier = randomToken(48);
  return { verifier, challenge: b64url(crypto.createHash("sha256").update(verifier).digest()) };
};
export const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");

export const PROVIDERS = {
  google: {
    name: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    pkce: true,
    extraAuthParams: { prompt: "select_account" },
    async profile(token, f) {
      const p = await getJson(f, "https://openidconnect.googleapis.com/v1/userinfo", token);
      return { id: p.sub, name: p.name || p.given_name, email: p.email, emailVerified: p.email_verified === true };
    },
  },
  facebook: {
    name: "Facebook",
    authorizeUrl: "https://www.facebook.com/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/oauth/access_token",
    scope: "email,public_profile",
    pkce: false,
    async profile(token, f) {
      const p = await getJson(f, "https://graph.facebook.com/me?fields=id,name,email", token);
      // Facebook only returns an email that the person has confirmed.
      return { id: p.id, name: p.name, email: p.email, emailVerified: !!p.email };
    },
  },
  x: {
    name: "X",
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    // tweet.read is needed alongside users.read for the profile call to work.
    scope: cfg => `users.read tweet.read${cfg.xRequestEmail ? " users.email" : ""}`,
    pkce: true,
    basicAuth: true,
    async profile(token, f, cfg) {
      let p;
      if (cfg.xRequestEmail) {
        try { p = await getJson(f, "https://api.x.com/2/users/me?user.fields=confirmed_email", token); } catch { /* fall back below */ }
      }
      p = p || await getJson(f, "https://api.x.com/2/users/me", token);
      const u = p.data || {};
      return { id: u.id, name: u.name || u.username, email: u.confirmed_email, emailVerified: !!u.confirmed_email };
    },
  },
  linkedin: {
    name: "LinkedIn",
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scope: "openid profile email",
    pkce: false,
    async profile(token, f) {
      const p = await getJson(f, "https://api.linkedin.com/v2/userinfo", token);
      return { id: p.sub, name: p.name || [p.given_name, p.family_name].filter(Boolean).join(" "), email: p.email, emailVerified: p.email_verified === true };
    },
  },
};

async function getJson(fetchImpl, url, token) {
  const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) throw new HttpError(502, `Couldn't read your profile (HTTP ${r.status}).`);
  return r.json();
}

/** Providers whose client id and secret are configured. */
export function enabledProviders(config) {
  return Object.keys(PROVIDERS).filter(p => config.oauth[p]?.clientId && config.oauth[p]?.clientSecret);
}

export const callbackUrl = (config, provider) => `${config.publicUrl}/api/auth/oauth/${provider}/callback`;

export function authorizeUrl(config, provider, { state, challenge }) {
  const p = PROVIDERS[provider];
  const q = new URLSearchParams({
    response_type: "code",
    client_id: config.oauth[provider].clientId,
    redirect_uri: callbackUrl(config, provider),
    scope: typeof p.scope === "function" ? p.scope(config) : p.scope,
    state,
    ...(p.pkce ? { code_challenge: challenge, code_challenge_method: "S256" } : {}),
    ...(p.extraAuthParams || {}),
  });
  return `${p.authorizeUrl}?${q}`;
}

export async function exchangeCode(config, provider, code, verifier, fetchImpl) {
  const p = PROVIDERS[provider];
  const { clientId, clientSecret } = config.oauth[provider];
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callbackUrl(config, provider) });
  if (p.pkce) body.set("code_verifier", verifier);
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (p.basicAuth) headers.Authorization = "Basic " + Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64");
  else { body.set("client_id", clientId); body.set("client_secret", clientSecret); }
  const r = await fetchImpl(p.tokenUrl, { method: "POST", headers, body: body.toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new HttpError(502, `${p.name} didn't accept the sign-in. Try again.`);
  const profile = await p.profile(j.access_token, fetchImpl, config);
  if (!profile.id) throw new HttpError(502, `${p.name} didn't return an account id.`);
  return profile;
}
