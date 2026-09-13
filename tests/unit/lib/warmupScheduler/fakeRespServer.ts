/**
 * Shared RESP command parser for tests that fake a Redis server with a raw
 * `net.Server`. ioredis may pipeline several commands (e.g. two
 * `CLIENT SETINFO` calls plus `INFO`) into a single TCP packet, so a `data`
 * handler that replies once per `data` event -- instead of once per parsed
 * RESP command -- leaves later queued commands without a matching reply and
 * hangs the client forever. Parse full commands out of the accumulated
 * buffer and let the caller reply once per command.
 */

export function parseRespCommands(buf: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (buf[offset] !== 0x2a /* '*' */) break;
    const arrEnd = buf.indexOf("\r\n", offset);
    if (arrEnd === -1) break;
    const argc = Number.parseInt(buf.subarray(offset + 1, arrEnd).toString(), 10);
    let pos = arrEnd + 2;
    const args: string[] = [];
    let complete = true;
    for (let i = 0; i < argc; i++) {
      if (buf[pos] !== 0x24 /* '$' */) {
        complete = false;
        break;
      }
      const lenEnd = buf.indexOf("\r\n", pos);
      if (lenEnd === -1) {
        complete = false;
        break;
      }
      const len = Number.parseInt(buf.subarray(pos + 1, lenEnd).toString(), 10);
      const dataStart = lenEnd + 2;
      const dataEnd = dataStart + len;
      if (dataEnd + 2 > buf.length) {
        complete = false;
        break;
      }
      args.push(buf.subarray(dataStart, dataEnd).toString());
      pos = dataEnd + 2;
    }
    if (!complete) break;
    commands.push(args);
    offset = pos;
  }
  return { commands, rest: buf.subarray(offset) };
}
