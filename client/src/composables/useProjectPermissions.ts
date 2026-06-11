// Client-side mirror of the server's project-role gate (Phase 6.5 / 6.6).
//
// The server is the source of truth — every write still 403s if it shouldn't
// land (see docs/permissions.md). This composable exists only so the UI can
// HIDE affordances a user can't use, instead of letting a viewer click into a
// 403 toast. Effective rule:
//   - instance-wide actors (owner / agent) → write everywhere (no role lookup),
//   - a member → write only where their `my_role` is editor/admin.
// `my_role` rides along on the project detail payload (the same field the
// Members tab already gates on); we read it through the shared, cached
// `/v1/projects/{key}` query so there's no extra fetch per affordance.

import {
  computed, inject, provide, ref,
  type ComputedRef, type InjectionKey, type MaybeRefOrGetter, type Ref,
} from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useAuthStore } from "@/stores/auth";

export type ProjectRole = "admin" | "editor" | "viewer";

export type ProjectPermissions = {
  myRole: ComputedRef<ProjectRole | null>;
  canWrite: ComputedRef<boolean>;
  canManage: ComputedRef<boolean>;
  isReadOnly: ComputedRef<boolean>;
};

function resolveKey(src: MaybeRefOrGetter<string | null | undefined>): string {
  const v = typeof src === "function"
    ? (src as () => string | null | undefined)()
    : (src as Ref<string | null | undefined>).value ?? src;
  return (typeof v === "string" ? v : "") || "";
}

export function useProjectPermissions(
  projectKey: MaybeRefOrGetter<string | null | undefined>,
): ProjectPermissions {
  const auth = useAuthStore();
  const key = computed(() => resolveKey(projectKey));

  // Skip the fetch entirely for instance-wide actors — they bypass membership,
  // so `my_role` is irrelevant (and would be `null` anyway).
  const projectQuery = useQuery({
    queryKey: computed(() => queryKeys.project(key.value)),
    enabled: computed(() => key.value.length > 0 && !auth.isInstanceWide),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/projects/{key}", {
        params: { path: { key: key.value } },
      });
      if (error) throw error;
      return data;
    },
  });

  const myRole = computed<ProjectRole | null>(
    () => (projectQuery.data.value?.my_role as ProjectRole | null | undefined) ?? null,
  );
  const canWrite = computed(() => {
    if (auth.isInstanceWide) return true;
    // No single-project context (global list / all-projects board) → don't gate
    // the CTA; the create dialog picks the project and the server enforces.
    if (!key.value) return true;
    return myRole.value === "editor" || myRole.value === "admin";
  });
  const canManage = computed(
    () => auth.isInstanceWide || (!!key.value && myRole.value === "admin"),
  );
  // Banner only when we've positively loaded a project the member can see but
  // can't write — never while loading, and never on a 404 (a non-member project
  // has no data, so the not-found page stands alone without a viewer banner).
  const isReadOnly = computed(() => {
    if (auth.isInstanceWide || !key.value) return false;
    if (!projectQuery.data.value) return false;
    return !canWrite.value;
  });

  return { myRole, canWrite, canManage, isReadOnly };
}

// Ticket-scoped write capability, shared from TicketBody down to the inline
// editors / transition / comment composer via provide/inject so each doesn't
// re-fetch the project. Defaults to writable so any standalone usage (a card
// outside a ticket-detail context) keeps today's behavior.
export const TicketCanWriteKey: InjectionKey<Ref<boolean> | ComputedRef<boolean>> =
  Symbol("ticketCanWrite");

export function provideTicketCanWrite(canWrite: Ref<boolean> | ComputedRef<boolean>): void {
  provide(TicketCanWriteKey, canWrite);
}

export function useTicketCanWrite(): Ref<boolean> | ComputedRef<boolean> {
  return inject(TicketCanWriteKey, ref(true));
}
