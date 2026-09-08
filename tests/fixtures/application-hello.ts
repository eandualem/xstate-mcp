import { once } from "node:events";
import type { WebSocket } from "ws";

export function applicationHello(commands: string[] = ["send_event"]) {
  return {
    type: "xstate-mcp.hello",
    protocolVersion: 1,
    application: { name: "health-fixture" },
    adapter: { name: "test-adapter", version: "1.0.0" },
    capabilities: { commands },
  };
}

export async function negotiateApplication(ws: WebSocket): Promise<void> {
  const response = once(ws, "message", { signal: AbortSignal.timeout(2000) });
  ws.send(JSON.stringify(applicationHello()));
  const [raw] = await response;
  const reply = JSON.parse(raw.toString());
  if (reply.type !== "xstate-mcp.hello.response" || reply.success !== true)
    throw new Error("Application handshake failed");
}
