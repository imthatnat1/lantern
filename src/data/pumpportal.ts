import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { log } from "../log.js";

export interface MigrationEvent { mint: string; at: number }
export interface NewTokenEvent { mint: string; symbol: string; name: string; at: number }

/**
 * PumpPortal websocket with automatic reconnect and exponential backoff.
 * v1 lost 4 hours overnight because it never reconnected. This one does,
 * and the bot keeps trading on DexScreener data while it's down.
 */
export class PumpPortal extends EventEmitter {
  private ws?: WebSocket;
  private backoff = 1000;
  private stopped = false;
  public lastMessageAt = 0;

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  get downForMs(): number {
    return this.lastMessageAt ? Date.now() - this.lastMessageAt : Infinity;
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket("wss://pumpportal.fun/api/data");
    this.ws = ws;
    ws.on("open", () => {
      this.backoff = 1000;
      log.info("pumpportal connected");
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
    });
    ws.on("message", (raw) => {
      this.lastMessageAt = Date.now();
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.txType === "create" && m.mint) {
        this.emit("new", { mint: m.mint, symbol: m.symbol ?? "", name: m.name ?? "", at: Date.now() } satisfies NewTokenEvent);
      } else if (m.txType === "migrate" && m.mint) {
        this.emit("migration", { mint: m.mint, at: Date.now() } satisfies MigrationEvent);
      }
    });
    ws.on("close", () => this.scheduleReconnect("close"));
    ws.on("error", (e) => { log.warn({ err: e.message }, "pumpportal error"); ws.close(); });
    // Idle watchdog: pump.fun never goes quiet for 2 min. If it does, the socket is dead.
    const watchdog = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN && this.lastMessageAt && Date.now() - this.lastMessageAt > 120_000) {
        log.warn("pumpportal idle, forcing reconnect");
        ws.terminate();
      }
    }, 30_000);
    ws.once("close", () => clearInterval(watchdog));
  }

  private scheduleReconnect(why: string) {
    if (this.stopped) return;
    log.warn({ why, inMs: this.backoff }, "pumpportal reconnecting");
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60_000);
  }
}
