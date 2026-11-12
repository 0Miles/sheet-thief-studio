<script setup lang="ts">
import { AppButton } from "@karyl-chan/ui";

import { strings } from "../strings";
</script>

<template>
  <main class="home">
    <h1>{{ strings.app.name }}</h1>
    <p>{{ strings.app.tagline }}</p>
    <AppButton variant="primary" disabled>{{ strings.home.newScore }}</AppButton>
  </main>
</template>

<style scoped>
.home {
  max-width: 40rem;
  margin: 0 auto;
  padding: 4rem 1.5rem;
}
</style>
