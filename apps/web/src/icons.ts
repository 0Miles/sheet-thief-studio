// The icons of the interface, bundled: the page asks no other host for anything, which its
// Content Security Policy would refuse anyway (docs/spec/security.md, section 7). `@iconify/vue`
// is its offline build here and in @karyl-chan/ui (vite.config.ts), which draws only the icons
// registered below; tests/icons.test.ts checks that every icon either of them names is one.
//
// Material Symbols by Google, Apache License 2.0, as the Iconify icon set `material-symbols` has them.
import { addCollection } from "@iconify/vue/offline";

const path = (d: string) => ({ body: `<path fill="currentColor" d="${d}"/>` });

export const MATERIAL_SYMBOLS = {
  prefix: "material-symbols",
  width: 24,
  height: 24,
  icons: {
    "close-rounded": path(
      "m12 13.4l-4.9 4.9q-.275.275-.7.275t-.7-.275t-.275-.7t.275-.7l4.9-4.9l-4.9-4.9q-.275-.275-.275-.7t.275-.7t.7-.275t.7.275l4.9 4.9l4.9-4.9q.275-.275.7-.275t.7.275t.275.7t-.275.7L13.4 12l4.9 4.9q.275.275.275.7t-.275.7t-.7.275t-.7-.275z",
    ),
    "expand-less-rounded": path(
      "m12 10.775l-3.9 3.9q-.275.275-.7.275t-.7-.275t-.275-.7t.275-.7l4.6-4.6q.15-.15.325-.213T12 8.4t.375.063t.325.212l4.6 4.6q.275.275.275.7t-.275.7t-.7.275t-.7-.275z",
    ),
    "expand-more-rounded": path(
      "M12 14.95q-.2 0-.375-.062t-.325-.213l-4.6-4.6q-.275-.275-.275-.7t.275-.7t.7-.275t.7.275l3.9 3.9l3.9-3.9q.275-.275.7-.275t.7.275t.275.7t-.275.7l-4.6 4.6q-.15.15-.325.213T12 14.95",
    ),
    "progress-activity": path(
      "M8.125 21.213q-1.825-.788-3.187-2.15t-2.15-3.188T2 11.988t.788-3.875t2.15-3.175t3.187-2.15T12 2q.425 0 .713.288T13 3t-.288.713T12 4Q8.675 4 6.337 6.338T4 12t2.338 5.663T12 20t5.663-2.337T20 12q0-.425.288-.712T21 11t.713.288T22 12q0 2.05-.788 3.875t-2.15 3.188t-3.175 2.15t-3.875.787t-3.887-.787",
    ),
  },
};

addCollection(MATERIAL_SYMBOLS);
