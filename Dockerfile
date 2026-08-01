# syntax=docker/dockerfile:1.7
#
# Build context is this repository, plus ONE named context for the unpublished sibling packages:
#
#   docker build -t nda --build-context runtimepkgs=../runtime .
#
# Only `runtimepkgs`. This service depends on no @cloudsforge/contracts-* package — it moves no
# money, holds no chain state and publishes no cross-service schema of its own — so the
# `contractspkgs` context every money-touching service passes is not referenced here. The shared CI
# workflow passes it anyway, which is harmless; a context a Dockerfile does not COPY from is ignored.
#
# The context is temporary. Once the @cloudsforge/* packages are published (AD-02), package.json
# takes registry versions, the COPY lines below are deleted, the flag goes away, and this becomes an
# ordinary single-context build. Nothing else changes.
#
# It is named `runtimepkgs` rather than `runtime` because a build context and a build stage share
# one namespace, and the final stage below is called `runtime`.

# ----------------------------------------------------------------------------------- deps
FROM node:22-slim AS deps
# Pin pnpm in the image. The sibling workspaces are installed before this service's own
# package.json is copied, so corepack has no packageManager field to read at that point and
# would otherwise grab whatever is latest and then refuse to switch to the 11.9.0 the
# siblings pin.
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app

# Temporary: the link: dependencies resolve to ../runtime and ../contracts relative to this
# directory, so the packages must exist at those paths inside the image for the lockfile to stay
# frozen. `link:` in particular resolves at install time to the sibling's own node_modules, which
# is why the contracts context carries its packages' manifests as well as their sources.
COPY --from=runtimepkgs package.json pnpm-workspace.yaml pnpm-lock.yaml /runtime/
COPY --from=runtimepkgs packages /runtime/packages

# Install the sibling's OWN dependencies first. `link:` uses the sibling as-is and does not manage
# its dependency tree, so /runtime's node_modules must exist independently — both for `tsc` to
# resolve the sibling source it typechecks (jose, @opentelemetry/api) and for `node --import tsx` to
# load @cloudsforge/* at run time. Without this the image builds a set of @cloudsforge symlinks that
# point at source which cannot resolve its own imports.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm --dir /runtime install --frozen-lockfile --config.store-dir=/pnpm-store

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# `--frozen-lockfile` is the point of the step: a build that silently resolves a different
# dependency tree from the one CI tested is a build whose provenance means nothing.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --frozen-lockfile --config.store-dir=/pnpm-store

# ----------------------------------------------------------------------------------- build
# `tsc --noEmit` rather than an emit: tsx runs the TypeScript sources directly, exactly as every
# service in the estate already does. What this stage buys is that a type error fails the image
# build instead of the first request.
FROM deps AS build
COPY tsconfig.json tsconfig.base.json ./
COPY src ./src
RUN pnpm typecheck

# ----------------------------------------------------------------------------------- runtime
FROM node:22-slim AS runtime
WORKDIR /app

# No corepack, no pnpm, no build toolchain in the final image: fewer things an RCE can reach, and
# nothing at runtime needs them.
# The sibling comes across too: /app/node_modules holds @cloudsforge/* as symlinks into it, so
# without the target the links dangle and the first `import '@cloudsforge/db'` fails at run time.
COPY --from=build /runtime /runtime
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json /app/tsconfig.base.json ./
COPY --from=build /app/src ./src

# node:22-slim ships an unprivileged `node` user (uid 1000). Nothing is written to the filesystem
# at runtime, so read-only ownership of the image is sufficient.
USER node

# No secret is baked in, and none may be: every value in src/env.ts is supplied by the deploy at
# run time. There is no ENV line here on purpose beyond NODE_ENV.
ENV NODE_ENV=production
EXPOSE 4110

# The health endpoints are for the orchestrator, not for the image: the balancer probes /readyz and
# the restart policy probes /livez. A HEALTHCHECK here would duplicate that in a second place that
# then drifts.

# The migrator is a SEPARATE one-shot process — `node --import tsx src/migrator.ts` — run as an
# init container or a Kubernetes Job before this ever starts. It is deliberately not invoked here:
# below SCHEMA_VERSION the leased-job, outbox and idempotency tables may not exist, and neither may
# `players_world_user_uniq`, which is the only thing keeping one account to one survivor per world.
# A service that could create the schema at boot is a service that could start without it.
# `index.ts` asserts the schema version and refuses to serve below it.
#
# The ancestor ran its DDL from index.ts on every boot (db/migrate.ts), which is why it could never
# be told which schema a running container was serving.
CMD ["node", "--import", "tsx", "src/index.ts"]
