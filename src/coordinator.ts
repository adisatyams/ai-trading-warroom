export class AccountCoordinator {
  state: DurableObjectState;
  constructor(state: DurableObjectState) { this.state = state; }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/state") {
      const paused = (await this.state.storage.get<boolean>("paused")) ?? true;
      const kill = (await this.state.storage.get<boolean>("kill_switch")) ?? false;
      return Response.json({ paused, kill_switch: kill, execution_enabled: false });
    }
    if (request.method === "POST" && url.pathname === "/pause") {
      await this.state.storage.put("paused", true);
      return Response.json({ ok: true, paused: true });
    }
    if (request.method === "POST" && url.pathname === "/resume") {
      // A latched kill switch must be cleared explicitly (/reset-kill) before
      // the account can be resumed; resuming never clears it implicitly.
      const kill = (await this.state.storage.get<boolean>("kill_switch")) ?? false;
      if (kill) {
        return Response.json({
          ok: false,
          error: "Kill switch is latched; reset it before resuming",
          kill_switch: true,
          paused: true
        }, { status: 409 });
      }
      await this.state.storage.put("paused", false);
      return Response.json({ ok: true, paused: false, kill_switch: false });
    }
    if (request.method === "POST" && url.pathname === "/kill") {
      await this.state.storage.put("kill_switch", true);
      await this.state.storage.put("paused", true);
      return Response.json({ ok: true, kill_switch: true, paused: true });
    }
    if (request.method === "POST" && url.pathname === "/reset-kill") {
      // Clears the latch but leaves the account paused; trading only restarts
      // after a separate, deliberate /resume.
      await this.state.storage.put("kill_switch", false);
      await this.state.storage.put("paused", true);
      return Response.json({ ok: true, kill_switch: false, paused: true });
    }
    return new Response("Not found", { status: 404 });
  }
}
