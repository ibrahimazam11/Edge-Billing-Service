# Build stage
FROM node:24-alpine AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Inject Sentry debug IDs into dist (.js + .js.map). This MUST happen inside
# the build stage so the running image and the sourcemaps uploaded to Sentry
# from CI carry the same debug IDs — otherwise stack frames in production
# won't resolve. `@sentry/cli` is a devDependency available here.
RUN pnpm exec sentry-cli sourcemaps inject ./dist || \
    echo "sentry-cli inject failed — sourcemap resolution may be degraded"

# Production stage
FROM node:24-alpine AS production

# Baked into the image so the running process knows its release tag without
# extra ECS plumbing. Pipelines pass --build-arg SENTRY_RELEASE=<short-sha>.
ARG SENTRY_RELEASE=""
ENV SENTRY_RELEASE=$SENTRY_RELEASE

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Remove bundled npm — runtime uses pnpm via corepack, and the npm shipped
# with node:24-alpine carries HIGH CVEs in minimatch/picomatch that fail the
# Trivy scan in CI.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle

EXPOSE 3000

CMD ["sh", "-c", "node dist/migrations/migrate.js && node dist/main.js"]
