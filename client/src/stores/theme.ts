import { defineStore } from "pinia";
import { useColorMode } from "@vueuse/core";

// Theme is light / dark / system. useColorMode toggles the `dark` class on
// <html>, which Tailwind's class-based dark mode reads. Cycle order:
// dark → light → auto → dark.
export const useThemeStore = defineStore("theme", () => {
  const mode = useColorMode({
    storageKey: "switchyard.theme",
    attribute: "class",
    selector: "html",
    modes: { light: "", dark: "dark", auto: "" },
  });

  function cycle() {
    mode.value = mode.value === "dark" ? "light" : mode.value === "light" ? "auto" : "dark";
  }

  return { mode, cycle };
});
