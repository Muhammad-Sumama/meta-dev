/** Minimal server-sent-events reader for tests. */
export interface SseEvent {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions pick fields
  data: any;
}

export function readSse(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";
  let ended = false;
  let comments = 0;

  const pump = async () => {
    const { done, value } = await reader.read();
    if (done) {
      ended = true;
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) comments++;
        else if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      if (data.length) events.push({ event, data: JSON.parse(data.join("\n")) });
    }
  };

  return {
    events,
    get ended() {
      return ended;
    },
    get comments() {
      return comments;
    },
    /** Reads until `predicate` matches an event (returns it) or the timeout passes. */
    async until(predicate: (e: SseEvent) => boolean, timeoutMs = 60_000): Promise<SseEvent> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = events.find(predicate);
        if (hit) return hit;
        if (ended) throw new Error(`stream ended without a matching event (${events.length} events)`);
        if (Date.now() > deadline) throw new Error(`timed out waiting for event (${events.length} events)`);
        await Promise.race([pump(), new Promise((r) => setTimeout(r, Math.max(1, deadline - Date.now())))]);
      }
    },
    /** Client disconnect: cancels the response body. */
    cancel() {
      return reader.cancel();
    },
    /** Resolves once the server closes the stream. */
    async waitForEnd(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (!ended && Date.now() < deadline) await Promise.race([pump(), new Promise((r) => setTimeout(r, 50))]);
      return ended;
    },
  };
}
