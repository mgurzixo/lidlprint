<template>
  <q-layout view="hHh LpR fFf">
    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
// Deliberately chrome-less: the app IS one screen (doc/SPEC.md §3).
// Version string injected at build time from package.json (single source).
</script>
