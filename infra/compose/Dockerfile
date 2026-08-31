# syntax=docker/dockerfile:1
# O build do web (vite/esbuild) roda UMA vez, na arquitetura da máquina que constrói
# ($BUILDPLATFORM): esbuild é um binário Go que quebra sob emulação qemu, e o resultado
# é JS estático — igual para qualquer arquitetura. Só o estágio final (pnpm install com
# os binários nativos: prisma, esbuild do runtime) é por plataforma.
FROM --platform=$BUILDPLATFORM node:26-bookworm@sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89 AS webbuild
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN corepack enable
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @quibt/web...
RUN mkdir -p packages/chat-ui/node_modules   && ln -s ../../../apps/web/node_modules/react packages/chat-ui/node_modules/react   && ln -s ../../../apps/web/node_modules/react-dom packages/chat-ui/node_modules/react-dom
RUN pnpm --filter @quibt/web build

FROM node:26-bookworm@sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89
# Set by the release workflow to the same version as the other two published
# images (see scripts/release-version.mjs's releaseManifest) — this image is
# tagged ghcr.io/quibt/quibt-stack:${RELEASE_VERSION}.
ARG RELEASE_VERSION=0.0.0-dev
LABEL org.opencontainers.image.version=${RELEASE_VERSION}
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN corepack enable
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile \
      --filter @quibt/api... \
      --filter @quibt/worker... \
      --filter @quibt/web...
RUN mkdir -p packages/chat-ui/node_modules   && ln -s ../../../apps/web/node_modules/react packages/chat-ui/node_modules/react   && ln -s ../../../apps/web/node_modules/react-dom packages/chat-ui/node_modules/react-dom
RUN pnpm --filter @quibt/db generate
COPY --from=webbuild /app/apps/web/dist /app/apps/web/dist
COPY --from=webbuild /app/apps/web/dist-server /app/apps/web/dist-server
COPY infra/compose/quibt-migrate /usr/local/bin/quibt-migrate
RUN chmod 755 /usr/local/bin/quibt-migrate
ENV NODE_ENV=production
EXPOSE 3100 5173 7091
CMD ["pnpm", "--filter", "@quibt/api", "start"]
