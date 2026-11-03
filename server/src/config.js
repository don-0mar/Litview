// All configuration comes from environment variables. See .env.example.
const list = v => (v || "").split(",").map(s => s.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  if (production && !env.JWT_SECRET) throw new Error("JWT_SECRET must be set in production");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
  return {
    port: Number(env.PORT) || 3000,
    production,
    databaseUrl: env.DATABASE_URL,
    databaseSsl: env.DATABASE_SSL === "true" || /sslmode=require/.test(env.DATABASE_URL),
    jwtSecret: env.JWT_SECRET || "dev-only-secret-change-me",
    jwtExpiresIn: env.JWT_EXPIRES_IN || "7d",
    // Front-end origins allowed to call the API, e.g. https://don-0mar.github.io
    allowedOrigins: list(env.ALLOWED_ORIGINS || "http://localhost:5173,http://localhost:8080"),
    // Sent to OpenAlex and Crossref so requests join their faster "polite pool"
    contactEmail: env.CONTACT_EMAIL || "",
    keys: {
      scopus: env.SCOPUS_API_KEY || "",
      scopusInstToken: env.SCOPUS_INST_TOKEN || "",
      ieee: env.IEEE_API_KEY || "",
      springer: env.SPRINGER_API_KEY || "",
      anthropic: env.ANTHROPIC_API_KEY || "",
    },
    // Public address of this API, used to build OAuth callback URLs. Render sets RENDER_EXTERNAL_URL.
    publicUrl: (env.PUBLIC_API_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/+$/, ""),
    oauth: Object.fromEntries(["google", "facebook", "x", "linkedin"].map(p => {
      const P = p.toUpperCase();
      return [p, { clientId: env[`${P}_CLIENT_ID`] || "", clientSecret: env[`${P}_CLIENT_SECRET`] || "" }];
    })),
    xRequestEmail: env.X_REQUEST_EMAIL === "true",
    aiModel: env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
    aiMaxStudies: Number(env.AI_MAX_STUDIES) || 120,
  };
}
