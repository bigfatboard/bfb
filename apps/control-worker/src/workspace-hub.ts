// ABOUTME: Declares the WorkspaceHub Durable Object shell used by the control Worker.
// ABOUTME: F03 only proves the declarative SQLite export binding; C01 owns command behavior.

export class WorkspaceHub {
  constructor(private readonly state: DurableObjectState) {
    void this.state;
  }

  async fetch(request: Request): Promise<Response> {
    return new Response(
      JSON.stringify({
        ok: true,
        package: "F03",
        path: new URL(request.url).pathname,
        note: "WorkspaceHub command kernel is owned by C01",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
}
