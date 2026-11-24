// Fails fast with instructions when no Redis is reachable, instead of a suite full of connection errors.
import net from "node:net";

const url = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
const port = Number(url.port || 6379);
const open = await new Promise((resolve) => {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.setTimeout(1000);
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("timeout", () => {
    socket.destroy();
    resolve(false);
  });
  socket.once("error", () => resolve(false));
});
if (!open) {
  console.error(
    `No Redis is listening on 127.0.0.1:${port} (REDIS_URL=${url}). These tests write coordination hashes, ` +
      "so use a throwaway instance:\n" +
      "  C=$(docker run --rm -d -p 127.0.0.1::6379 redis:7.4-alpine redis-server --save '' --appendonly no)\n" +
      "  REDIS_URL=redis://127.0.0.1:$(docker port $C 6379 | cut -d: -f2) npm test\n" +
      "  docker rm -f $C",
  );
  process.exit(1);
}
