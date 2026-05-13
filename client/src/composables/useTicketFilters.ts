// URL-driven ticket filter state.
//
// The URL is the source of truth — refresh, share, deep-link all just work.
// `filters` is a computed that derives the typed shape from `route.query`.
// Setters write back through `router.replace()`, which retriggers the computed.
//
// Lists are comma-encoded ("type=bug,task") to match the API contract.

import { computed } from "vue";
import { useRoute, useRouter, type LocationQuery } from "vue-router";

export type TicketFilters = {
  project: string[];           // project keys, e.g. ["FLOW", "DEMO"]
  status: string[];            // canonical category names or status UUIDs
  type: string[];              // ticket types
  priority: string[];          // priorities
  assignee: string | undefined; // user UUID OR "unassigned"
  text: string | undefined;    // ILIKE search
  // Custom field equality filters: `metadata.<key> = <value>`. URL form
  // is `?cf.<key>=<value>`; multiple keys are independent ANDs. Last
  // write per key wins.
  customFields: Record<string, string>;
};

type FilterKey = keyof TicketFilters;

function parseList(v: LocationQuery[string] | undefined): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === "string" ? x.split(",") : [])).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function parseString(v: LocationQuery[string] | undefined): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

export function useTicketFilters() {
  const route = useRoute();
  const router = useRouter();

  const filters = computed<TicketFilters>(() => {
    const cf: Record<string, string> = {};
    for (const [k, v] of Object.entries(route.query)) {
      if (!k.startsWith("cf.")) continue;
      if (typeof v === "string" && v.length > 0) cf[k.slice(3)] = v;
    }
    return {
      project: parseList(route.query.project),
      status: parseList(route.query.status),
      type: parseList(route.query.type),
      priority: parseList(route.query.priority),
      assignee: parseString(route.query.assignee),
      text: parseString(route.query.text),
      customFields: cf,
    };
  });

  // Strip filter keys we manage so we can rebuild the query without dropping
  // the drawer's `focus` param or future ones. `cf.*` keys are also ours.
  const KEYS: FilterKey[] = ["project", "status", "type", "priority", "assignee", "text"];

  function writeQuery(next: TicketFilters) {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(route.query)) {
      if ((KEYS as string[]).includes(k)) continue;
      if (k.startsWith("cf.")) continue; // cf.* are rewritten below
      if (typeof v === "string") query[k] = v;
    }
    if (next.project.length > 0) query.project = next.project.join(",");
    if (next.status.length > 0) query.status = next.status.join(",");
    if (next.type.length > 0) query.type = next.type.join(",");
    if (next.priority.length > 0) query.priority = next.priority.join(",");
    if (next.assignee) query.assignee = next.assignee;
    if (next.text) query.text = next.text;
    for (const [k, v] of Object.entries(next.customFields)) {
      if (v.length > 0) query[`cf.${k}`] = v;
    }
    router.replace({ query });
  }

  function set<K extends FilterKey>(key: K, value: TicketFilters[K]) {
    writeQuery({ ...filters.value, [key]: value });
  }

  function toggle(key: "project" | "status" | "type" | "priority", value: string) {
    const current = filters.value[key];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    set(key, next);
  }

  function clear() {
    writeQuery({
      project: [], status: [], type: [], priority: [],
      assignee: undefined, text: undefined, customFields: {},
    });
  }

  const isAnySet = computed(() => {
    const f = filters.value;
    return f.project.length + f.status.length + f.type.length + f.priority.length > 0
      || !!f.assignee || !!f.text || Object.keys(f.customFields).length > 0;
  });

  // Replace the entire filter set in one router push. Used by saved views
  // to apply a stored filter combination — going through `set` per key
  // would trigger N router.replace calls back-to-back.
  function replaceAll(next: Partial<TicketFilters>) {
    writeQuery({
      project: next.project ?? [],
      status: next.status ?? [],
      type: next.type ?? [],
      priority: next.priority ?? [],
      assignee: next.assignee ?? undefined,
      text: next.text ?? undefined,
      customFields: next.customFields ?? {},
    });
  }

  return { filters, set, toggle, clear, replaceAll, isAnySet };
}
