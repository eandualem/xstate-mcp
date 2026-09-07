import { z } from "zod";
import { actorIdentity } from "./actor-identity.js";
import type { ActorError, ActorRecord, ActorSnapshot } from "./types.js";

export const actorErrorSchema = z.object({
  message: z.string().max(4096),
  name: z.string().max(256).optional(),
  code: z.union([z.string().max(256), z.number().finite()]).optional(),
});

/** Retain bounded diagnostic fields, never stack/cause or arbitrary properties. */
function sanitizeError(error: unknown): ActorError | undefined {
  if (error === undefined || error === null) return undefined;
  if (
    typeof error === "string" ||
    typeof error === "number" ||
    typeof error === "boolean"
  ) {
    return { message: String(error).slice(0, 4096) };
  }

  const fields =
    typeof error === "object" ? (error as Record<string, unknown>) : {};
  const result: ActorError = {
    message:
      typeof fields.message === "string"
        ? fields.message.slice(0, 4096)
        : "Error details unavailable",
  };
  if (typeof fields.name === "string") result.name = fields.name.slice(0, 256);
  if (typeof fields.code === "string") result.code = fields.code.slice(0, 256);
  else if (typeof fields.code === "number" && Number.isFinite(fields.code)) {
    result.code = fields.code;
  }
  return result;
}

export function readSnapshot(
  snapshot: Record<string, unknown>,
  previous?: ActorSnapshot | null,
): ActorSnapshot {
  return {
    status:
      typeof snapshot.status === "string"
        ? snapshot.status
        : (previous?.status ?? "active"),
    // Missing value/context support partial snapshots; explicit null clears them.
    value: Object.hasOwn(snapshot, "value")
      ? (snapshot.value ?? null)
      : (previous?.value ?? null),
    context: Object.hasOwn(snapshot, "context")
      ? (snapshot.context ?? null)
      : (previous?.context ?? null),
    // Results belong to this snapshot. Omission clears previous results.
    output: snapshot.output,
    error: sanitizeError(snapshot.error),
  };
}

/** Shared, untruncated view for the state tool and snapshot resource. */
export function actorSnapshotData(actor: ActorRecord) {
  return {
    sessionId: actor.sessionId,
    ...actorIdentity(actor),
    name: actor.name,
    status: actor.currentSnapshot?.status ?? "unknown",
    value: actor.currentSnapshot?.value ?? null,
    context: actor.currentSnapshot?.context ?? null,
    output: actor.currentSnapshot?.output ?? null,
    error: actor.currentSnapshot?.error ?? null,
    parentId: actor.parentId,
    updatedAt: actor.updatedAt,
  };
}
