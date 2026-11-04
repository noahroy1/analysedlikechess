FROM node:24-bookworm-slim
# Chrome Headless Shell's libraries, per remotion.dev/docs/docker.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 \
    libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 ca-certificates fonts-liberation fontconfig \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
# The browser goes into the image, so a render never waits for a download.
RUN node -e "import('@remotion/renderer').then(r => r.ensureBrowser())"
COPY bundle ./bundle
COPY server.mjs ./
ENV WORK_DIR=/work
EXPOSE 8080
CMD ["node", "server.mjs"]
