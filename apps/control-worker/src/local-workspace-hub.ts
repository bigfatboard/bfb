// ABOUTME: Emulates named Hub jurisdiction isolation in explicitly enabled local Workerd.
// ABOUTME: Retains real Durable Object dispatch and never asserts geographic placement.

import type { Jurisdiction } from "./env.js";

export function localWorkspaceHubNamespace(
  namespace: DurableObjectNamespace,
): DurableObjectNamespace {
  const scoped = new Map<string, DurableObjectNamespace>();
  return new Proxy(namespace, {
    get(target, property) {
      if (property === "jurisdiction") {
        return (jurisdiction: Jurisdiction) => {
          if (jurisdiction !== "eu" && jurisdiction !== "us")
            throw new Error("unsupported local Hub jurisdiction");
          let view = scoped.get(jurisdiction);
          if (view) return view;
          const issued = new Set<string>();
          const idFromName = (name: string) => {
            const id = target.idFromName(JSON.stringify(["bfb-local-hub", jurisdiction, name]));
            issued.add(id.toString());
            return id;
          };
          const get: DurableObjectNamespace["get"] = (id, options) => {
            if (!issued.has(id.toString())) throw new Error("local Hub ID scope mismatch");
            return target.get(id, options);
          };
          const unsupported = () => {
            throw new Error("local Hub emulation requires a named workspace ID");
          };
          view = {
            idFromName,
            get,
            getByName: (name: string, options?: DurableObjectNamespaceGetDurableObjectOptions) =>
              get(idFromName(name), options),
            idFromString: unsupported,
            newUniqueId: unsupported,
            jurisdiction: (next: Jurisdiction) => {
              if (next !== jurisdiction) throw new Error("local Hub ID scope mismatch");
              return view;
            },
          } as DurableObjectNamespace;
          scoped.set(jurisdiction, view);
          return view;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
