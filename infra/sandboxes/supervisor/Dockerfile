FROM node:22-bookworm-slim
# Set by the release workflow — tagged ghcr.io/quibt/quibt-supervisor:${RELEASE_VERSION},
# the same version as quibt-computer and quibt-stack (scripts/release-version.mjs).
ARG RELEASE_VERSION=0.0.0-dev
LABEL org.opencontainers.image.version=${RELEASE_VERSION}
WORKDIR /app
COPY . .
RUN corepack enable \
  && pnpm install --prod --frozen-lockfile=false --filter @quibt/sandbox-supervisor... \
  && rm -rf /root/.local/share/pnpm/store
CMD ["pnpm", "--filter", "@quibt/sandbox-supervisor", "start"]
