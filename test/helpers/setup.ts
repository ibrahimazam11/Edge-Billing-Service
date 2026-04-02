import { config } from "dotenv";
import { resolve } from "path";

// Load .env.test before anything else
config({ path: resolve(__dirname, "../../.env.test"), quiet: true });
