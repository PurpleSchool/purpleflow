#!/bin/sh
# e2e окна на Linux в Docker — как в CI (ubuntu, Xvfb).
#   scripts/e2e-linux/run.sh                       — все тесты
#   scripts/e2e-linux/run.sh mcp.spec.ts chat.spec.ts:94   — выбранные (аргументы playwright test)
# PLATFORM=linux/amd64 — x64, как в CI (медленнее на Apple Silicon). Отчёт и скриншоты падений — в app/e2e-linux-results.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
platform=${PLATFORM:-}
tag=purpleflow-e2e-linux${platform:+-$(echo "$platform" | tr / -)}
docker build ${platform:+--platform "$platform"} -f "$root/scripts/e2e-linux/Dockerfile" -t "$tag" "$root"
rm -rf "$root/app/e2e-linux-results"
mkdir -p "$root/app/e2e-linux-results"
docker run --rm ${platform:+--platform "$platform"} --shm-size=1g \
  -v "$root/app/e2e-linux-results:/repo/app/e2e-results" \
  "$tag" sh -c 'npx electron-vite build >/dev/null && xvfb-run -a -s "-screen 0 1920x1080x24" npx playwright test "$@"' sh "$@"
