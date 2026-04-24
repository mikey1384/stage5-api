type SseClient = {
  id: string;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
};

const encoder = new TextEncoder();
const HEARTBEAT_INTERVAL_MS = 25_000;

function encodeSseEvent(eventName: string, payload: unknown): Uint8Array {
  const safeEventName = eventName.replace(/[\r\n]/g, "") || "message";
  return encoder.encode(
    `event: ${safeEventName}\ndata: ${JSON.stringify(payload)}\n\n`
  );
}

export class PaymentEventsDurableObject {
  private clients = new Set<SseClient>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/stream") {
      return this.openStream(request);
    }

    if (request.method === "POST" && url.pathname === "/broadcast") {
      const payload = await request.json();
      await this.broadcast(payload);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  private openStream(request: Request): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const client: SseClient = {
      id: crypto.randomUUID(),
      writer,
      heartbeat: setInterval(() => {
        void writer
          .write(encoder.encode(`: heartbeat ${Date.now()}\n\n`))
          .catch(() => this.closeClient(client));
      }, HEARTBEAT_INTERVAL_MS),
    };

    this.clients.add(client);
    void writer
      .write(
        encodeSseEvent("ready", {
          type: "ready",
          connectedAt: new Date().toISOString(),
        })
      )
      .catch(() => this.closeClient(client));

    request.signal.addEventListener("abort", () => this.closeClient(client), {
      once: true,
    });

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  private async broadcast(payload: any): Promise<void> {
    const eventName = typeof payload?.type === "string" ? payload.type : "message";
    const encoded = encodeSseEvent(eventName, payload);
    const deadClients: SseClient[] = [];

    await Promise.all(
      [...this.clients].map(async client => {
        try {
          await client.writer.write(encoded);
        } catch {
          deadClients.push(client);
        }
      })
    );

    for (const client of deadClients) {
      this.closeClient(client);
    }
  }

  private closeClient(client: SseClient): void {
    if (!this.clients.delete(client)) {
      return;
    }
    clearInterval(client.heartbeat);
    try {
      void client.writer.close();
    } catch {
      // Ignore already-closed streams.
    }
  }
}
