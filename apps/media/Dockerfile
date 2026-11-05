# The media service: ffmpeg, Remotion and Chrome Headless Shell, with the composition bundle built in.
# Build from the repo root: docker build -f apps/media/Dockerfile -t als-media .
# Cloudflare Containers run linux/amd64 (add --platform linux/amd64 on an Apple Silicon Mac).
FROM node:24-bookworm-slim

# ffmpeg for ingest and frames; Chrome Headless Shell's libraries per remotion.dev/docs/docker.
# The composition ships Arimo; Liberation Sans (Arial's metrics) is the fallback for anything else.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates fonts-liberation fontconfig \
    libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 \
    libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /app
# Manifests first, so dependencies are cached until one changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/media/package.json apps/media/
COPY packages/schema/package.json packages/schema/
COPY packages/composition/package.json packages/composition/
COPY packages/theme/package.json packages/theme/
RUN pnpm install --frozen-lockfile --filter @als/media...

# The browser goes into the image (under apps/media, the nearest package.json), so a render never waits for it.
WORKDIR /app/apps/media
RUN node -e "import('@remotion/renderer').then((r) => r.ensureBrowser())"

# Sources with their tsconfig files: the bundler takes the JSX runtime ("react-jsx") from them.
COPY tsconfig.base.json /app/
COPY packages/schema/tsconfig.json /app/packages/schema/
COPY packages/theme/tsconfig.json /app/packages/theme/
COPY packages/composition/tsconfig.json /app/packages/composition/
COPY packages/schema/src /app/packages/schema/src
COPY packages/theme/src /app/packages/theme/src
COPY packages/composition/src /app/packages/composition/src
COPY apps/media/src ./src
RUN node src/build-bundle.ts /app/bundle

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 MEDIA_BUNDLE_DIR=/app/bundle MEDIA_WORK_DIR=/tmp/als-media
EXPOSE 8080
CMD ["node", "src/index.ts"]
