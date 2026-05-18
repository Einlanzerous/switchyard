// URL-driven sort state for the tickets list endpoint.
//
// Kept separate from useTicketFilters because sort is "view preference"
// rather than "what tickets" — saved views capture filters but currently
// don't carry sort, and conflating them would invent shape on the saved
// view side that nobody asked for.

import { computed } from "vue";
import { useRoute, useRouter, type LocationQuery } from "vue-router";

export type TicketSortBy = "updated_at" | "due_date" | "created_at" | "priority";
export type TicketSortOrder = "asc" | "desc";

export type TicketSortState = {
  sort_by: TicketSortBy;
  sort_order: TicketSortOrder | undefined;
};

const VALID_BY: ReadonlySet<TicketSortBy> = new Set(["updated_at", "due_date", "created_at", "priority"]);
const VALID_ORDER: ReadonlySet<TicketSortOrder> = new Set(["asc", "desc"]);

// Natural direction when sort_order is unset. Matches the server's
// resolveTicketSort defaults (see server/src/routes/tickets.ts).
export const NATURAL_DIR: Record<TicketSortBy, TicketSortOrder> = {
  updated_at: "desc",
  due_date: "asc",
  created_at: "desc",
  priority: "desc",
};

function parseBy(v: LocationQuery[string] | undefined): TicketSortBy {
  if (typeof v === "string" && VALID_BY.has(v as TicketSortBy)) return v as TicketSortBy;
  return "updated_at";
}

function parseOrder(v: LocationQuery[string] | undefined): TicketSortOrder | undefined {
  if (typeof v === "string" && VALID_ORDER.has(v as TicketSortOrder)) return v as TicketSortOrder;
  return undefined;
}

export function useTicketSort() {
  const route = useRoute();
  const router = useRouter();

  const sort = computed<TicketSortState>(() => ({
    sort_by: parseBy(route.query.sort_by),
    sort_order: parseOrder(route.query.sort_order),
  }));

  function setBy(by: TicketSortBy) {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(route.query)) {
      if (k === "sort_by" || k === "sort_order") continue;
      if (typeof v === "string") query[k] = v;
    }
    if (by !== "updated_at") query.sort_by = by;
    // Direction stays whatever it was; if it's the natural default for the
    // new key, omit it to keep the URL clean.
    const order = sort.value.sort_order;
    if (order && order !== NATURAL_DIR[by]) query.sort_order = order;
    router.replace({ query });
  }

  function setOrder(order: TicketSortOrder) {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(route.query)) {
      if (k === "sort_order") continue;
      if (typeof v === "string") query[k] = v;
    }
    // Omit if matches the natural direction for the active key.
    if (order !== NATURAL_DIR[sort.value.sort_by]) query.sort_order = order;
    router.replace({ query });
  }

  const direction = computed<TicketSortOrder>(
    () => sort.value.sort_order ?? NATURAL_DIR[sort.value.sort_by],
  );

  return { sort, direction, setBy, setOrder };
}
