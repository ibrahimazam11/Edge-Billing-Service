# Build stage
FROM node:24-alpine AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Production stage
FROM node:24-alpine AS production

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Remove bundled npm — runtime uses pnpm via corepack, and the npm shipped
# with node:24-alpine carries HIGH CVEs in minimatch/picomatch that fail the
# Trivy scan in CI.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle

EXPOSE 3000

CMD ["sh", "-c", "node dist/migrations/migrate.js && node dist/main.js"]
