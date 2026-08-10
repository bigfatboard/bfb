// ABOUTME: Renders the pre-auth SPA shell for the F03 substrate package.
// ABOUTME: Does not invent board state; W01 owns the authenticated Work surface.

export function AppShell() {
  return (
    <main>
      <h1>BFB</h1>
      <p>Control plane substrate is ready. Sign-in and Work surface arrive in later packages.</p>
      <p data-testid="substrate-package">F03</p>
    </main>
  );
}
