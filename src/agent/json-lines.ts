// Bound protocol records before JSON.parse, including incomplete lines and UTF-8 text.
export const maxAgentRecordBytes = 1024 * 1024;
export const maxAgentFinalTextBytes = 256 * 1024;
const encoder = new TextEncoder();

export function assertFinalTextLimit(text: string) {
  if (encoder.encode(text).byteLength > maxAgentFinalTextBytes) {
    throw new Error("Agent final output limit exceeded");
  }
}

export class AgentJsonLines {
  private remainder = "";
  private remainderBytes = 0;

  *read(chunk: string): Generator<unknown> {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.slice(offset, end);
      const bytes = encoder.encode(part).byteLength;
      if (this.remainderBytes + bytes > maxAgentRecordBytes) {
        throw new Error("Agent JSONL record limit exceeded");
      }
      this.remainder += part;
      this.remainderBytes += bytes;
      if (newline === -1) return;
      const line = this.remainder.endsWith("\r") ? this.remainder.slice(0, -1) : this.remainder;
      this.remainder = "";
      this.remainderBytes = 0;
      offset = newline + 1;
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        throw new Error("Agent emitted malformed JSONL");
      }
    }
  }

  finish(): Generator<unknown> {
    return this.read("\n");
  }
}
