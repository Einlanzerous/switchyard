<script setup lang="ts">
import { computed } from "vue";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

// One MarkdownIt instance is reused across all renders. Configured for the
// agentic ticket workflow: GFM tables on, autolinks on, html OFF (we never
// trust raw HTML in ticket bodies), single-newline → <br> for paragraph-light
// agent output, and external links default to opening in a new tab.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

const defaultLinkOpen = md.renderer.rules.link_open ?? function (tokens, idx, options, _env, self) {
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token) {
    const href = token.attrGet("href");
    if (href && /^https?:\/\//.test(href)) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer");
    }
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const props = defineProps<{
  body: string;
}>();

const html = computed(() => DOMPurify.sanitize(md.render(props.body ?? "")));
</script>

<template>
  <!-- prose-* utilities apply Tailwind's typography styles. The container is
       sized down with prose-sm and dark-mode flips with prose-invert. -->
  <div
    class="prose prose-sm dark:prose-invert max-w-none break-words
           prose-headings:font-semibold prose-headings:tracking-tight
           prose-pre:bg-muted prose-pre:text-foreground/90
           prose-code:before:content-none prose-code:after:content-none
           prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5
           prose-a:text-primary"
    v-html="html"
  />
</template>
