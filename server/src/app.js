import express from "express";
import cors from "cors";
import helmet from "helmet";
import { HttpError } from "./lib/http.js";
import { authRoutes } from "./routes/auth.js";
import { reviewRoutes } from "./routes/reviews.js";
import { searchRoutes } from "./routes/search.js";

/**
 * Build the Express app. Dependencies are passed in so tests can use a test
 * database and a fake fetch for outside APIs.
 */
export function createApp({ pool, config, fetch = globalThis.fetch, log = console.log }) {
  const app = express();
  app.set("trust proxy", 1); // Render sits behind a proxy; needed for rate limiting by IP
  app.use(helmet());
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || config.allowedOrigins.includes(origin) || config.allowedOrigins.includes("*")),
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    maxAge: 86400,
  }));
  app.use(express.json({ limit: "15mb" }));

  app.get("/", (_req, res) => res.json({ name: "Litview API", status: "ok", docs: "https://github.com/don-0mar/Litview/tree/main/server" }));
  app.get("/api/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  });

  const deps = { pool, config, fetch, log };
  app.use("/api/auth", authRoutes(deps));
  app.use("/api/reviews", reviewRoutes(deps));
  app.use("/api", searchRoutes(deps));

  app.use((_req, _res, next) => next(new HttpError(404, "Not found")));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === "entity.too.large") return res.status(413).json({ error: "That upload is too large." });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "The request body isn't valid JSON." });
    const status = err.status || 500;
    if (status >= 500) log(err.stack || err);
    res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? "Something went wrong on the server." : err.message, details: err.details });
  });
  return app;
}
