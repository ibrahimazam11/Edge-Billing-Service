import { Pool } from "pg";
import { ConfigService } from "@nestjs/config";
import type { Provider } from "@nestjs/common";

export const MONOLITH_DB_PROVIDER = Symbol("MONOLITH_DB_PROVIDER");

export const monolithDatabaseProvider: Provider = {
  provide: MONOLITH_DB_PROVIDER,
  useFactory: (configService: ConfigService): Pool | null => {
    const host = configService.get<string>("monolithDatabase.host");
    if (!host) {
      return null;
    }

    return new Pool({
      host,
      port: configService.get<number>("monolithDatabase.port"),
      database: configService.get<string>("monolithDatabase.database"),
      user: configService.get<string>("monolithDatabase.user"),
      password: configService.get<string>("monolithDatabase.password"),
      max: 5,
    });
  },
  inject: [ConfigService],
};
