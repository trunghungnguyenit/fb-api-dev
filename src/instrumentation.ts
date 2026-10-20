export async function register() {
  // The Node-only code must be imported inside this branch so the Edge bundle never sees it.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("./instrumentation-node");
    startScheduler();
  }
}
