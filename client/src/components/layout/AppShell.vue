<script setup lang="ts">
import { RouterView } from "vue-router";
import AppSidebar from "./AppSidebar.vue";
import AppTopbar from "./AppTopbar.vue";
import TicketDrawer from "@/components/tickets/TicketDrawer.vue";
</script>

<template>
  <div class="min-h-screen flex bg-background text-foreground">
    <AppSidebar />
    <div class="flex flex-1 flex-col min-w-0">
      <AppTopbar />
      <main class="flex-1 overflow-auto">
        <RouterView />
      </main>
    </div>
    <!-- Single global drawer instance. Any view that sets `?focus=KEY` in the
         URL pops the drawer open with that ticket. Lives at the shell level so
         we don't have to remember to mount it inside every list/board view. -->
    <TicketDrawer />
  </div>
</template>
