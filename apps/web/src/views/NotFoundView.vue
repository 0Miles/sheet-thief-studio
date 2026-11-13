<script setup lang="ts">
import { RouterLink } from "vue-router";

import AppHeader from "../components/AppHeader.vue";
import { strings } from "../strings";
</script>

<template>
  <AppHeader />
  <main class="not-found">
    <h1>{{ strings.notFound.title }}</h1>
    <p>{{ strings.notFound.message }}</p>
    <RouterLink to="/">{{ strings.notFound.home }}</RouterLink>
  </main>
</template>

<style scoped>
.not-found {
  max-width: 40rem;
  margin: 0 auto;
  padding: 4rem 1.5rem;
}
</style>
