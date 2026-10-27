#!/usr/bin/env node
import { ROOT } from "./config.mjs";
import { OBSERVER_PORT, createObserverServer, observerToken } from "./observer.mjs";

const token = observerToken();
const server = createObserverServer({ root: ROOT, token });
server.on("error", error => {
  console.error(`SOXU observer could not start: ${error.code ?? "unknown"}`);
  process.exitCode = 1;
});
server.listen(OBSERVER_PORT, "127.0.0.1", () => {
  console.log(`SOXU read-only observer: http://127.0.0.1:${OBSERVER_PORT}/v1/tasks`);
  console.log(`One-time observer token (enter in PiDeck plugin; never share): ${token}`);
  console.log("Checkpoint snapshots only. Ctrl+C stops this opt-in service.");
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close());
}
