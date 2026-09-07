import { actorIdentity, actorIdentityOutputSchema } from "../actor-identity.js";
import { z } from "zod";
import type { ActorStore } from "../actor-store.js";
import { actorNotFoundResult, type ToolResult } from "../errors.js";
import { safeStringify } from "../safe-stringify.js";

export const getActorStateOutputSchema = {
  sessionId: z.string(),
  ...actorIdentityOutputSchema,
  name: z.string(),
  status: z.string(),
  value: z.unknown(),
  context: z.unknown(),
  parentId: z.string().nullable(),
  updatedAt: z.string(),
};

export interface GetActorStateOptions {
  excludeContext?: boolean;
  contextMaxChars?: number;
}

export function getActorState(
  store: ActorStore,
  sessionId: string,
  opts?: GetActorStateOptions,
): ToolResult {
  const actor = store.getActor(sessionId);

  if (!actor) {
    return actorNotFoundResult(sessionId, store);
  }

  let context: unknown = actor.currentSnapshot?.context ?? null;
  if (opts?.excludeContext) {
    context = "[excluded]";
  } else if (opts?.contextMaxChars != null && context !== null) {
    const serialized = safeStringify(context);
    if (serialized.length > opts.contextMaxChars) {
      context = `${serialized.slice(0, opts.contextMaxChars)}[truncated, full size: ${serialized.length}]`;
    }
  }

  const structuredContent = {
    sessionId: actor.sessionId,
    ...actorIdentity(actor),
    name: actor.name,
    status: actor.currentSnapshot?.status ?? "unknown",
    value: actor.currentSnapshot?.value ?? null,
    context,
    parentId: actor.parentId,
    updatedAt: actor.updatedAt,
  };

  return {
    content: [
      {
        type: "text" as const,
        text: safeStringify(structuredContent, 2),
      },
    ],
    structuredContent,
  };
}
