#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "→ Checking Railway login..."
railway whoami

if [ ! -f .railway/config.json ]; then
  echo "→ Linking project (creates new Railway project if needed)..."
  railway init
fi

echo "→ Deploying (upload only — ignore CLI timeout if upload reached 100%)..."
railway up --detach || true

echo ""
echo "→ Checking deploy status..."
sleep 5
railway status 2>/dev/null || true

echo ""
echo "✅ Deploy started. Next steps:"
echo "  1. Generate a public URL:"
echo "       railway domain"
echo "  2. Set env vars (replace values):"
echo "       railway variables set BOT_TOKEN=your_token"
echo "       railway variables set MINI_APP_URL=https://YOUR-APP.up.railway.app"
echo "       railway variables set NODE_ENV=production"
echo "  3. Redeploy after setting MINI_APP_URL:"
echo "       railway up --detach"
echo "  4. In @BotFather, set Mini App URL to the same MINI_APP_URL"
echo ""
echo "  ⚠️  IMPORTANT:"
echo "  - Stop local 'npm run dev' before using production (same bot token = split DB)"
echo "  - Add a Railway Volume mounted at /data so registrations survive redeploys"
