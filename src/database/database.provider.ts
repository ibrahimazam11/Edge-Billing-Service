import { Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export const DRIZZLE_PROVIDER = "DRIZZLE_PROVIDER";

export const databaseProvider: Provider = {
  provide: DRIZZLE_PROVIDER,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const pool = new Pool({
      host: configService.get<string>("database.host"),
      port: configService.get<number>("database.port"),
      database: configService.get<string>("database.name"),
      user: configService.get<string>("database.user"),
      password: configService.get<string>("database.password"),
      ssl: configService.get<boolean>("database.ssl")
        ? { rejectUnauthorized: false }
        : undefined,
    });

    return drizzle(pool, { schema });
  },
};
