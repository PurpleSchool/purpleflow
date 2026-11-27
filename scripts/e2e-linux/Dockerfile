# Linux для e2e окна — как ubuntu-latest в CI: Node из .nvmrc, Xvfb и библиотеки Electron.
# Собирается и запускается скриптом scripts/e2e-linux/run.sh.
FROM ubuntu:24.04
ARG NODE_VERSION=22.18.0
ENV DEBIAN_FRONTEND=noninteractive CI=1 SHELL=/bin/bash LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git python3 make g++ xvfb xauth \
      libgtk-3-0t64 libnss3 libasound2t64 libxss1 libgbm1 libxshmfence1 libdrm2 libxkbcommon0 \
      libatk-bridge2.0-0t64 libcups2t64 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libsecret-1-0 \
      fonts-dejavu-core fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" | tar -xJ -C /usr/local --strip-components=1
# Electron не запускается от root без --no-sandbox — работаем, как в CI, обычным пользователем.
RUN mkdir /repo && chown ubuntu:ubuntu /repo
USER ubuntu
WORKDIR /repo
# Сначала только манифесты: зависимости переустанавливаются, лишь когда меняется package-lock.json.
COPY --chown=ubuntu:ubuntu package.json package-lock.json ./
COPY --chown=ubuntu:ubuntu app/package.json app/
COPY --chown=ubuntu:ubuntu core/package.json core/
COPY --chown=ubuntu:ubuntu installer/package.json installer/
COPY --chown=ubuntu:ubuntu scripts/fix-node-pty.mjs scripts/
RUN npm ci --no-audit --no-fund
COPY --chown=ubuntu:ubuntu . .
RUN git init -q && git config --global user.email e2e@example.test && git config --global user.name E2E \
    && npm run build -w @purpleflow/core
WORKDIR /repo/app
