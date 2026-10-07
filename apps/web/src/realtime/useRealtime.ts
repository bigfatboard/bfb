// ABOUTME: Keeps the public realtime hook explicitly unavailable without socket or replay effects.
// ABOUTME: Pure protocol, resynchronization and presence algorithms remain separate from availability.

export interface RealtimeChannel {
  onmessage: ((data: string) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface RealtimeTransport {
  open(url: string, protocol: string): RealtimeChannel;
}

export interface RunRealtime {
  available: false;
}

export function useRunRealtime(_options: {
  workspaceId: string;
  taskId: string;
  runId: string | null;
  fetchImpl?: typeof fetch | undefined;
  transport?: RealtimeTransport | undefined;
  nowImpl?: (() => number) | undefined;
}): RunRealtime {
  return { available: false };
}
