# syntax=docker/dockerfile:1
# One image, several roles: `runtime` (api / worker) and `tools` (tests, dry-run, ops scripts).

FROM node:25-bookworm-slim AS base
# ffmpeg(+libass) renders and QA-analyses video; espeak-ng is the DRY-RUN-ONLY dev voice; fonts-dejavu is the caption font.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg espeak-ng fonts-dejavu-core ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
# Optional: Chromium for the Remotion renderer (RENDERER=remotion). Off by default — it adds ~400 MB and needs ~1 GB RAM per render.
ARG WITH_CHROMIUM=false
RUN if [ "$WITH_CHROMIUM" = "true" ]; then apt-get update && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*; fi
ENV CHROMIUM_PATH=${WITH_CHROMIUM:+/usr/bin/chromium}
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci
COPY dashboard/package.json dashboard/package-lock.json dashboard/
RUN npm --prefix dashboard ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src src
COPY dashboard dashboard
RUN npx tsc -p tsconfig.build.json && npm --prefix dashboard run build && npm prune --omit=dev

FROM base AS tools
ENV NODE_ENV=development
COPY --from=deps /app/node_modules node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts ./
COPY src src
COPY test test
COPY scripts scripts
COPY remotion remotion
COPY config config
COPY --from=build /app/dashboard/dist dashboard/dist
COPY dashboard/src dashboard/src
RUN mkdir -p data out reports && chown -R node:node /app
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "test"]

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/dashboard/dist dashboard/dist
COPY package.json ./
COPY remotion remotion
COPY config config
RUN mkdir -p data out reports && chown -R node:node /app
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
