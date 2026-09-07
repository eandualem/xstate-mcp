import type { AnyActorRef, InspectionEvent } from "xstate";
import type { WebSocket } from "ws";

/** Test transport for native XState inspection events, with Error fields preserved. */
export function nativeInspectionForwarder(ws: WebSocket) {
  const sent: Record<string, unknown>[] = [];
  function send(event: unknown) {
    const raw = JSON.stringify(event, (_key, value: unknown) => {
      if (value instanceof Error) {
        const code = "code" in value ? value.code : undefined;
        return { name: value.name, message: value.message, code };
      }
      return value;
    });
    sent.push(JSON.parse(raw));
    ws.send(raw);
  }
  return {
    sent,
    inspect(event: InspectionEvent) {
      // Native actor refs' toJSON only retains the actor id, not the session id.
      // Add routing metadata while keeping the producer's snapshot/event intact.
      // Error properties are non-enumerable; plain JSON.stringify loses them.
      send({ ...event, sessionId: event.actorRef.sessionId });
    },
    // Sample the real snapshot from an error observer so callback failures remain
    // observable even when XState inspection does not emit @xstate.snapshot.
    captureSnapshot(actor: AnyActorRef) {
      send({
        type: "@xstate.snapshot",
        sessionId: actor.sessionId,
        snapshot: actor.getSnapshot(),
      });
    },
    async flush() {
      // A pong establishes that preceding frames have been processed by the server.
      await new Promise<void>((resolve, reject) => {
        ws.once("pong", () => resolve());
        ws.ping(undefined, undefined, (error) => {
          if (error) reject(error);
        });
      });
    },
  };
}
