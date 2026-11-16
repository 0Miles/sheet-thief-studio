<script setup lang="ts">
// Choosing a new password, typed twice (docs/spec/accounts.md, section 1): on /account after the
// current one; on /account/password without it, the temporary one having just been typed to log in.
import { AppButton, AppTextField, Stack } from "@karyl-chan/ui";
import { password } from "@studio/contracts";
import { ref } from "vue";

import { ApiError } from "../api";
import { errorText, strings } from "../strings";
import { useSessionStore } from "../stores/session";

const props = defineProps<{ askCurrent: boolean; submitLabel: string }>();
const emit = defineEmits<{ changed: [] }>();

const text = strings.account.password;
const session = useSessionStore();

const current = ref("");
const next = ref("");
const again = ref("");
const error = ref("");
const sending = ref(false);

async function submit(): Promise<void> {
  error.value = "";
  // What the server would refuse anyway, said before asking it.
  if (!password.safeParse(next.value).success) error.value = text.rule;
  else if (next.value !== again.value) error.value = text.mismatch;
  if (error.value) return;
  sending.value = true;
  try {
    await session.changePassword(props.askCurrent ? { currentPassword: current.value, newPassword: next.value } : { newPassword: next.value });
    current.value = next.value = again.value = "";
    emit("changed");
  } catch (failure) {
    error.value = failure instanceof ApiError ? errorText(failure.code) : strings.unknownError;
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <form @submit.prevent="submit">
    <Stack gap="3">
      <!-- Not the field's hint: that would be read as part of its name. -->
      <p class="password-form__rule">{{ text.rule }}</p>
      <AppTextField v-if="askCurrent" v-model="current" :label="text.current" name="current-password" type="password" autocomplete="current-password" required />
      <AppTextField v-model="next" :label="text.new" name="new-password" type="password" autocomplete="new-password" required />
      <AppTextField v-model="again" :label="text.again" name="new-password-again" type="password" autocomplete="new-password" required />
      <p v-if="error" class="password-form__error" role="alert">{{ error }}</p>
      <div><AppButton type="submit" variant="primary" :loading="sending">{{ submitLabel }}</AppButton></div>
    </Stack>
  </form>
</template>

<style scoped>
.password-form__rule {
  margin: 0;
  color: var(--text-muted);
}
.password-form__error {
  margin: 0;
  color: var(--danger);
}
</style>
