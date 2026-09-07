import { z } from "zod";
import type { ActorRecord } from "./types.js";

export const actorIdentityOutputSchema = {
  connectionId: z.string().nullable(),
  localSessionId: z.string(),
  applicationName: z.string().nullable(),
};

export function actorIdentity(actor: ActorRecord) {
  return {
    connectionId: actor.connectionId,
    localSessionId: actor.localSessionId,
    applicationName: actor.applicationName,
  };
}
