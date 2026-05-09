import { defineStore } from "pinia";
import { computed } from "vue";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { api, getStoredToken, setStoredToken } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

// Auth derives identity from GET /v1/users/me. The query is enabled only when
// a token is present in localStorage; setting/clearing the token (via
// setStoredToken) controls whether the query runs and therefore whether the
// app considers the user logged in.
export const useAuthStore = defineStore("auth", () => {
  const queryClient = useQueryClient();
  const hasToken = computed(() => !!getStoredToken());

  const meQuery = useQuery({
    queryKey: queryKeys.usersMe(),
    enabled: hasToken,
    retry: false,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await api.GET("/v1/users/me");
      if (error) throw error;
      return data;
    },
  });

  function login(token: string) {
    setStoredToken(token);
    queryClient.invalidateQueries({ queryKey: queryKeys.usersMe() });
  }

  function logout() {
    setStoredToken(null);
    queryClient.clear();
  }

  const me = computed(() => meQuery.data.value);
  const loading = computed(() => meQuery.isLoading.value || meQuery.isFetching.value);
  const isAuthenticated = computed(() => hasToken.value && !!me.value);
  // Expose error as a top-level computed so consumers don't have to know about
  // the underlying Vue Query ref shape (which Pinia auto-unwraps awkwardly).
  const error = computed(() => meQuery.error.value);

  return { me, loading, isAuthenticated, hasToken, error, login, logout };
});
