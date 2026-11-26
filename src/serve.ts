import { once } from "node:events";
import type { Express } from "express";

export async function serve(app: Express, defaultPort: number, close: () => Promise<unknown> = async () => {}) {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? defaultPort);
  const server = app.listen(port, host);
  try {
    await once(server, "listening");
  } catch (error) {
    await close();
    throw error;
  }
  const address = server.address();
  if (address && typeof address === "object") {
    const hostname = address.family === "IPv6" ? `[${address.address}]` : address.address;
    console.log(`OrthDatabase listening on http://${hostname}:${address.port}`);
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      // A browser can leave an unused preconnect open during shutdown.
      const deadline = setTimeout(() => server.closeAllConnections(), 5_000).unref();
      server.close(() => {
        clearTimeout(deadline);
        void close().catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
      });
    });
  }
}
