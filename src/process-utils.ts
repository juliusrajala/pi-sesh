export async function readStreamBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onChunk?: (chunk: Uint8Array) => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.(value);
      total += value.byteLength;
      if (total > maxBytes) throw new Error("process output exceeded limit");
      chunks.push(value);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  } finally {
    reader.releaseLock();
  }
}
