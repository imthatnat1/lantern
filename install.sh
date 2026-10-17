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
apt-get install -y -qq nodejs git sqlite3 >/dev/null
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
npm install --silent
npm test 2>&1 | grep -E "^# (pass|fail)"
npm run build --silent

say "5/5  Starting"
pm2 delete lantern >/dev/null 2>&1 || true
pm2 start dist/main.js --name lantern >/dev/null
pm2 save >/dev/null
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
command -v ufw >/dev/null && ufw allow 8787/tcp >/dev/null 2>&1 || true
sleep 4
echo
pm2 logs lantern --lines 15 --nostream
echo
say "Done. Lantern is running. To see it later: pm2 logs lantern"
IP=$(curl -s -4 ifconfig.me || echo "<your droplet IP>")
echo "Dashboard BOT_URL for Vercel: http://$IP:8787"
