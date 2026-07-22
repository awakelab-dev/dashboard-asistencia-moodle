#!/bin/bash
# Update & redeploy asistencia-moodle (awk-itinerario)
set -euo pipefail
source ~/.nvm/nvm.sh

APP=/projects/awk-itinerario/dashboard-asistencia-moodle-main

cd /projects/awk-itinerario
echo "==> Pulling latest (rebase keeps local deploy fixes on top)..."
if ! git pull --rebase; then
  git rebase --abort 2>/dev/null || true
  echo "!! Rebase conflict: upstream touched the locally-fixed lines. Resolve manually in /projects/awk-itinerario." >&2
  exit 1
fi

# Safety nets in case the local-fixes commit ever gets lost
if grep -q 'http://localhost:${PORT}/api/proxy-img' "$APP/src/server.ts"; then
  echo "==> Re-applying relative proxy-img fix in src/server.ts"
  sed -i 's|http://localhost:${PORT}/api/proxy-img|/api/proxy-img|' "$APP/src/server.ts"
fi
if ! grep -q '"build"' "$APP/package.json"; then
  echo '!! package.json lost its build/start scripts. Re-add: "build": "tsc && cp -r src/assets dist/", "start": "node dist/server.js"' >&2
  exit 1
fi

echo "==> Building server..."
cd "$APP"
npm install --no-audit --no-fund
npm run build

echo "==> Building client..."
cd client
npm install --no-audit --no-fund
npm run build

echo "==> Restarting pm2..."
pm2 restart asistencia-moodle-api --update-env
sleep 2
curl -s -o /dev/null -w 'API ping (localhost:3006): %{http_code}\n' localhost:3006/api/ping
curl -s -o /dev/null -w 'Public (asistencia-moodle.awakelab.world): %{http_code}\n' https://asistencia-moodle.awakelab.world
echo "==> Deploy complete."
