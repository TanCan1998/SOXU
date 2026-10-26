<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 19 });
</script>
<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="name === 'plus'"><path d="M12 5v14M5 12h14"/></template>
    <template v-else-if="name === 'search'"><circle cx="10.8" cy="10.8" r="6.6"/><path d="m16 16 5 5"/></template>
    <template v-else-if="name === 'panel'"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></template>
    <template v-else-if="name === 'messages'"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H7l-4 2v-6a7.5 7.5 0 1 1 17-3.5Z"/></template>
    <template v-else-if="name === 'folder'"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z"/></template>
    <template v-else-if="name === 'activity'"><path d="M3 12h4l3-7 4 14 3-7h4"/></template>
    <template v-else-if="name === 'settings'"><circle cx="12" cy="12" r="3"/><path d="m19 12 2-1-2-4-2 1-2-1V5H9v2L7 8 5 7l-2 4 2 1-2 1 2 4 2-1 2 1v2h6v-2l2-1 2 1 2-4z"/></template>
    <template v-else-if="name === 'chevron'"><path d="m9 6 6 6-6 6"/></template>
    <template v-else-if="name === 'chevron-down'"><path d="m6 9 6 6 6-6"/></template>
    <template v-else-if="name === 'send'"><path d="m12 19 0-14m-5 5 5-5 5 5"/></template>
    <template v-else-if="name === 'sun'"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></template>
    <template v-else-if="name === 'moon'"><path d="M20.1 15.9A8.5 8.5 0 0 1 8.1 3.9 8.5 8.5 0 1 0 20.1 15.9Z"/></template>
    <template v-else-if="name === 'close'"><path d="M5 5 19 19M19 5 5 19"/></template>
    <template v-else-if="name === 'code'"><path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-12-2 16"/></template>
    <template v-else-if="name === 'sparkles'"><path d="m12 2 1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9zM20 16l.9 2.1L23 19l-2.1.9L20 22l-.9-2.1L17 19l2.1-.9z"/></template>
    <template v-else-if="name === 'clock'"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></template>
    <template v-else-if="name === 'info'"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-9h.01"/></template>
    <template v-else-if="name === 'check'"><path d="m4 12 5 5L20 6"/></template>
    <template v-else-if="name === 'bolt'"><path d="m13 2-9 12h7l-1 8 10-13h-7z"/></template>
    <template v-else-if="name === 'keyboard'"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16h8"/></template>
    <template v-else><circle cx="12" cy="12" r="8"/></template>
  </svg>
</template>
