// ABOUTME: Pure path helpers for authenticated workspace URLs used by the SPA shell.
// ABOUTME: Workspace slug in the path is navigation only; authorization uses server membership.

export function parseWorkspaceSlugForTest(pathname: string): string | null {
  const match = pathname.match(/^\/w\/([^/]+)/);
  return match?.[1] ?? null;
}

export function workspacePath(slug: string): string {
  return `/w/${slug}`;
}
