#!/usr/bin/env bash
# Lantern one-shot installer for a fresh Ubuntu droplet.
# Run as root:  bash <(curl -fsSL https://raw.githubusercontent.com/imthatnat1/lantern/main/install.sh)
set -euo pipefail

say() { printf "\n\033[1;35m%s\033[0m\n" "$*"; }
ask() { local v; read -r -p "$1: " v </dev/tty; printf "%s" "$v"; }

say "1/5  Installing Node, git, sqlite, pm2"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
fi
apt-get install -y -qq nodejs git sqlite3 build-essential python3 >/dev/null
npm i -g pm2 >/dev/null 2>&1 || true

say "2/5  Getting Lantern"
mkdir -p /opt && cd /opt
if [ -d lantern/.git ]; then (cd lantern && git pull -q); else git clone -q https://github.com/imthatnat1/lantern.git; fi
cd lantern

say "3/5  Your keys (paste each one and press Enter)"
if [ -f .env ]; then
  echo "A .env already exists, keeping it. Edit /opt/lantern/.env if you need to change something."
else
  # Try to find keys from the old bot on this box so Nat doesn't have to hunt.
  OLD=$(grep -rhs "^HELIUS_API_KEY=" /root /opt /home 2>/dev/null | head -1 | cut -d= -f2- || true)
  [ -n "$OLD" ] && echo "Found a Helius key from the old bot, press Enter to reuse it."
  HELIUS=$(ask "Helius API key${OLD:+ [Enter = reuse]}"); HELIUS=${HELIUS:-$OLD}
  OLDR=$(grep -rhs "^RUGCHECK_API_KEY=" /root /opt /home 2>/dev/null | head -1 | cut -d= -f2- || true)
  [ -n "$OLDR" ] && echo "Found a RugCheck key too, press Enter to reuse it."
  RUG=$(ask "RugCheck API key (Enter to skip)${OLDR:+ [Enter = reuse]}"); RUG=${RUG:-$OLDR}
  WALLETS=$(ask "Your 3 trusted wallet addresses, separated by commas")
  TOKEN=$(ask "Dashboard token (the lnt_... value from Claude)")
  cat > .env <<EOF
HELIUS_API_KEY=$HELIUS
RUGCHECK_API_KEY=$RUG
X_BEARER_TOKEN=
ANTHROPIC_API_KEY=
TRUSTED_WALLETS=$WALLETS
STARTING_CAPITAL=300
LOG_LEVEL=info
DB_PATH=./data/lantern.db
DASHBOARD_TOKEN=$TOKEN
DASHBOARD_PORT=8787
EOF
  chmod 600 .env
fi

say "4/5  Building and testing"
echo "node $(node -v), npm $(npm -v)"
npm install --include=dev --no-audit --no-fund 2>&1 | tail -5
set +e
npm test 2>&1 | grep -vE "^\s*(duration_ms|type:|\.\.\.|---|location:|failureType:)" | tail -40
TEST_RC=${PIPESTATUS[0]}
set -e
if [ "$TEST_RC" != "0" ]; then
  echo
  echo "Tests failed. Send Claude a screenshot of the lines above. Not starting the bot."
  exit 1
fi
npm run build 2>&1 | tail -20

say "5/5  Starting"
set +e
pm2 delete lantern >/dev/null 2>&1
pm2 start dist/main.js --name lantern --time || { echo "pm2 start failed"; pm2 list; }
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1
command -v ufw >/dev/null && ufw allow 8787/tcp >/dev/null 2>&1
set -e

# Auto-update: every 10 minutes, pull from GitHub; rebuild and restart only if something changed.
cat > /opt/lantern/update.sh <<'EOS'
#!/usr/bin/env bash
cd /opt/lantern || exit 0
git fetch -q origin main || exit 0
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git pull -q origin main && npm install --include=dev --silent && npm run build --silent && pm2 restart lantern >/dev/null
  echo "$(date -u +%FT%TZ) updated to $(git rev-parse --short HEAD)" >> /opt/lantern/data/updates.log
fi
EOS
chmod +x /opt/lantern/update.sh
( crontab -l 2>/dev/null | grep -v lantern/update.sh; echo "*/10 * * * * /opt/lantern/update.sh" ) | crontab -
sleep 4
echo
pm2 logs lantern --lines 15 --nostream
echo
say "Done. Lantern is running. To see it later: pm2 logs lantern"
IP=$(curl -s -4 ifconfig.me || echo "<your droplet IP>")
echo "Dashboard BOT_URL for Vercel: http://$IP:8787"
