// ABOUTME: Test-only DLQ collector that forwards dead-letter copies to the X05 harness server.
// ABOUTME: Never ships; the harness wires it as the consumer of the operations DLQ.

interface DlqEnv {
  HARNESS_URL: string;
}

interface QueueMessage {
  body: unknown;
  ack: () => void;
  retry: () => void;
}

export default {
  async fetch(): Promise<Response> {
    return new Response("x05-dlq-collector");
  },
  async queue(batch: { messages: QueueMessage[] }, env: DlqEnv): Promise<void> {
    for (const message of batch.messages) {
      try {
        await fetch(`${env.HARNESS_URL}/dlq`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message.body),
        });
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
};
