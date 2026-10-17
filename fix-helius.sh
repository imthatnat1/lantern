#!/usr/bin/env bash
# Repairs a bad HELIUS_API_KEY in /opt/lantern/.env.
# 1) looks for a real key left by the old bot on this box; 2) otherwise asks for one.
# Never prints the key.
set -u
ENV=/opt/lantern/.env
cur=$(grep -oP '^HELIUS_API_KEY=\K.*' "$ENV" 2>/dev/null || true)
if [[ "$cur" =~ ^[0-9a-f-]{36}$ ]]; then echo "Helius key in .env already looks fine."; exit 0; fi
echo "Current Helius key is not valid (it is: '${cur:0:12}'). Searching this box for the real one..."
K=$(grep -rhsoE "HELIUS_API_KEY[=:]\s*['\"]?[0-9a-f-]{36}" /root /opt /home --exclude-dir=lantern --exclude-dir=node_modules 2>/dev/null | grep -oE "[0-9a-f-]{36}" | head -1 || true)
if [ -z "$K" ]; then
  K=$(grep -rhsoE "helius[^\"' ]*api-key=[0-9a-f-]{36}" /root /opt /home --exclude-dir=lantern --exclude-dir=node_modules 2>/dev/null | grep -oE "[0-9a-f-]{36}" | head -1 || true)
fi
if [ -z "$K" ]; then
  echo "No key found on this box. Get it from https://dashboard.helius.dev (your project > API key)."
  read -r -p "Paste Helius key: " K </dev/tty
fi
if ! [[ "$K" =~ ^[0-9a-f-]{36}$ ]]; then echo "That doesn't look like a Helius key. Nothing changed."; exit 1; fi
sed -i "s|^HELIUS_API_KEY=.*|HELIUS_API_KEY=$K|" "$ENV"
pm2 restart lantern >/dev/null 2>&1
echo "Helius key fixed and Lantern restarted."
