// ABOUTME: Binds task-detail asynchronous work to a committed selection and its newest operation.
// ABOUTME: Invalidates retained callbacks on selection changes and unmount without changing server authority.

import { useCallback, useLayoutEffect, useRef } from "react";

export type PanelDeliveryCheck = () => boolean;

/** A follow-up read reuses its originating check instead of becoming a new operation. */
export function usePanelDelivery(selection: object) {
  const current = useRef<{ selection: object | null; operation: number }>({
    selection: null,
    operation: 0,
  });

  useLayoutEffect(() => {
    current.current.selection = selection;
    return () => {
      current.current.selection = null;
      current.current.operation += 1;
    };
  }, [selection]);

  return useCallback((): PanelDeliveryCheck | null => {
    if (current.current.selection !== selection) return null;
    const operation = ++current.current.operation;
    return () => current.current.selection === selection && current.current.operation === operation;
  }, [selection]);
}

export function isPanelAuthorityDenied(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as { status?: unknown; code?: unknown };
  return (
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.code === "not_found" ||
    error.code === "forbidden" ||
    error.code === "stale_authorization"
  );
}
