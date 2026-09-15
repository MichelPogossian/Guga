/** Bus d'événements interne → flux SSE de l'interface (§9.1 GET /events). */
import { EventEmitter } from "node:events";

export type GugaEvent =
  | { type: "placement"; messageId: string; column: string; isUrgent: boolean }
  | { type: "sync"; mailbox: string; status: "start" | "done" | "error"; detail?: string }
  | { type: "backlog"; remaining: number }
  | { type: "action"; action: string; targetId?: string; result: string }
  | { type: "alert"; kind: string; count: number }
  | { type: "call.incoming"; caller?: string; phone?: string };

export class EventBus extends EventEmitter {
  publish(e: GugaEvent) { this.emit("event", e); }
  subscribe(fn: (e: GugaEvent) => void): () => void { this.on("event", fn); return () => this.off("event", fn); }
}
