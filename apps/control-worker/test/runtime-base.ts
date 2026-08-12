// ABOUTME: Supplies the Cloudflare DurableObject base class when unit tests execute in Node.
// ABOUTME: Workerd acceptance uses the real cloudflare:workers module instead of this test double.

export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
