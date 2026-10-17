# Lantern

Paper-trading bot for Solana memecoins. It runs while you sleep. Built 17 Oct 2026 to replace the 14-mode v1 after its first night lost $77, two thirds of it to junk price ticks.

## What's different from v1

| v1 problem (16-17 Oct) | v2 answer |
|---|---|
| STONK and DARK "stopped" at -99% on a bad tick, -$19 | `engine/price.ts`: any move over 40% needs a second source (Jupiter) or a matching next tick before a stop can fill |
| Irene's -20% tick stop filled at -52% on one wick | Stops are judged on 15m closes. The tick floor is a last resort, far below the close stop. Pools under $50k get half size |
| Good plays cut early by 15% / 40% stops | Stops sit under a structural low minus ATR. Trails only tighten |
| KURP (+2333%), Irene, OPTIMA skipped as "already 3x" | `strategies/pullback.ts` waits for the first retrace that holds and gets bought back |
| RUGRIOT bought because a trusted wallet did | Trusted buys are candidates. Our own score must be >= 50, mcap <= $150k, no buying into a 40% 5m pump, slop filter |
| PumpPortal dropped for 4h, no reconnect | Auto-reconnect with backoff and an idle watchdog. Bot keeps trading on DexScreener while it's down |
| 14 modes, 71 trades in 19h | 5 modes: dip, ultra, bounce, pullback, trusted |
| Core and Swing found good coins (ZCAT, PURR, Stonk.fun pairs) and bled them on a 15% tick stop | `strategies/dip.ts` keeps that universe (pinned + Stonk.fun ZEC/HYPE/xStock pairs + established trenders) with close-based stops |

Kept from v1: fee and slippage model, 50% profit vault, daily loss stop, drawdown halt, capital-at-risk cap, copycat filter, RugCheck safety gate, Jupiter test-sell.

## Layout

```
src/
  config.ts          every number lives here
  types.ts
  db.ts              SQLite: positions, fills, cooldowns, rejected ticks, signal log
  data/              dexscreener, geckoterminal, jupiter, rugcheck, pumpportal, helius
  engine/
    price.ts         two-source price sanity
    exits.ts         pure exit logic, tested
    broker.ts        paper fills, vault, kill switches
    filters.ts       copycat and slop
  strategies/        ultra, bounce, pullback, trusted (+ base.ts shared gate)
  main.ts            5s loop: exits first, then scans
test/exits.test.ts   replays STONK, DARK, Irene and a real rug against the engine
```

## Run

```
cp .env.example .env     # fill in keys on the server, never commit
npm install
npm test
npm run build
npm start
```

Deploy on the droplet with pm2 so it survives reboots:

```
npm i -g pm2
pm2 start dist/main.js --name lantern
pm2 save && pm2 startup
pm2 logs lantern
```

## Reading results

```
sqlite3 data/lantern.db "select mode, count(*), sum(net_usd) from fills where side='sell' group by mode"
sqlite3 data/lantern.db "select * from rejected_ticks order by at desc limit 20"
sqlite3 data/lantern.db "select mode, symbol, score, taken, reason from signals_log order by at desc limit 30"
```

`rejected_ticks` is the receipt for every junk price the sanity check refused. `signals_log` shows every signal and why it was or wasn't taken.

## Rules

- Nothing fills on an unconfirmed tick.
- Stops are judged on closes. The tick floor is a circuit breaker, not a stop.
- Trails only tighten.
- Every config change is a commit. Tag before you change anything you'd want to compare against.
