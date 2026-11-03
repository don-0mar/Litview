import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { createApp } from "./app.js";

const config = loadConfig();
const pool = createPool(config);
await migrate(pool, console.log);

const app = createApp({ pool, config });
const server = app.listen(config.port, () => console.log(`Litview API listening on port ${config.port}`));

const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
