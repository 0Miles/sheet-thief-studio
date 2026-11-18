// First: the schemas the modules below build must already know (see the module).
import "@studio/contracts/without-eval";
import "@karyl-chan/ui/tokens.css";
import "./styles/app.css";
import "./icons";
// Before the router is made: it reads the address once, as the page starts.
import "./linkResult";

import { useColorScheme } from "@karyl-chan/ui";
import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import { router } from "./router";

useColorScheme(); // applies the remembered light/dark choice before the first paint of the app

createApp(App).use(createPinia()).use(router).mount("#app");
