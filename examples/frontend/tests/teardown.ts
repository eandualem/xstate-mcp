type Outcome<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: string };

async function observe<T>(
  operation: () => T | Promise<T>,
): Promise<Outcome<T>> {
  try {
    return { status: "fulfilled", value: await operation() };
  } catch (error) {
    return {
      status: "rejected",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface Teardown {
  cleanup: Record<"client" | "transport" | "vite", Outcome<void>>;
  portReleased: boolean;
  portProbe: Outcome<void>;
  sourceCommit: Outcome<string>;
}

export async function finishDemoRun(options: {
  closeClient: () => Promise<void>;
  closeTransport: () => Promise<void>;
  closeVite: () => Promise<void>;
  probePort: () => Promise<void>;
  sourceCommit: () => string;
  writeTranscript: (teardown: Teardown) => Promise<void>;
}): Promise<Teardown> {
  // Close the client before its transport, then still try the transport directly
  // if client shutdown fails. A Vite error cannot skip either child cleanup step.
  const cleanup = {
    client: await observe(options.closeClient),
    transport: await observe(options.closeTransport),
    vite: await observe(options.closeVite),
  };
  const portProbe = await observe(options.probePort);
  const teardown = {
    cleanup,
    portReleased: portProbe.status === "fulfilled",
    portProbe,
    sourceCommit: await observe(options.sourceCommit),
  };
  // Callers assert the recorded observations only after evidence is persisted.
  await options.writeTranscript(teardown);
  return teardown;
}
