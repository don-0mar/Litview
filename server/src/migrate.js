// Run with `npm run migrate`. The server also migrates on start-up.
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";

const pool = createPool(loadConfig());
await migrate(pool, console.log);
await pool.end();
console.log("Database is up to date.");
