import { createConnection } from "node:net";

/** A minimally parsed HTTP/1.1 response read from a raw socket; `status` is null when nothing arrived. */
export interface RawResponse {
  status: number | null;
  statusLine: string;
  headers: Map<string, string[]>;
  body: string;
  raw: string;
}

/**
 * Sends request bytes verbatim, so request forms a `fetch` client refuses to send (TRACE,
 * asterisk-form, absolute-form, Upgrade) can be exercised, and reads until the server closes the
 * connection or `settleMs` passes without any bytes.
 */
export function rawRequest(host: string, port: number, request: string, settleMs = 3000): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host, port });
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      socket.destroy();
      resolve(parseResponse(Buffer.concat(chunks).toString("latin1")));
    };
    socket.on("connect", () => {
      socket.write(request);
      timer = setTimeout(finish, settleMs);
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on("end", finish);
    socket.on("error", (error) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(error);
    });
  });
}

function decodeChunked(body: string): string {
  let rest = body;
  let decoded = "";
  for (;;) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd === -1) {
      return decoded;
    }
    const size = Number.parseInt(rest.slice(0, lineEnd), 16);
    if (Number.isNaN(size) || size === 0) {
      return decoded;
    }
    decoded += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
}

export function parseResponse(raw: string): RawResponse {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (raw === "" || headerEnd === -1) {
    return { status: null, statusLine: "", headers: new Map(), body: "", raw };
  }
  const [statusLine = "", ...headerLines] = raw.slice(0, headerEnd).split("\r\n");
  const headers = new Map<string, string[]>();
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(name, [...(headers.get(name) ?? []), value]);
  }
  const status = Number.parseInt(statusLine.split(" ")[1] ?? "", 10);
  const rawBody = raw.slice(headerEnd + 4);
  const body = headers.get("transfer-encoding")?.includes("chunked") ? decodeChunked(rawBody) : rawBody;
  return { status: Number.isNaN(status) ? null : status, statusLine, headers, body, raw };
}
