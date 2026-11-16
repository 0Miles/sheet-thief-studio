// The icons of the interface, bundled: the page asks no other host for anything, which its
// Content Security Policy would refuse anyway (docs/spec/security.md, section 7). Every import of
// `@iconify/vue`, the ones of @karyl-chan/ui too, gets the `Icon` of this module (vite.config.ts):
// the offline component, which draws only the icons registered below. tests/icons.test.ts checks
// that every icon the sources name is one; a name made as the page runs is caught here instead.
//
// Material Symbols by Google, Apache License 2.0, as the Iconify icon set `material-symbols` has them.
import { addCollection, Icon as OfflineIcon } from "@iconify/vue/offline";
import { defineComponent, h } from "vue";

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

/** Whether an icon of this name, `prefix:name`, is bundled. */
export function isBundled(name: string): boolean {
  const [prefix, icon, ...rest] = name.split(":");
  return rest.length === 0 && prefix === MATERIAL_SYMBOLS.prefix && icon !== undefined && Object.hasOwn(MATERIAL_SYMBOLS.icons, icon);
}

const reported = new Set<string>();

/**
 * `@iconify/vue`'s `Icon`, without its fetching. An icon asked for by a name that is not bundled
 * would be drawn as nothing, silently: it is reported as an error, once, which the end-to-end
 * tests fail on.
 */
export const Icon = defineComponent({
  name: "BundledIcon",
  inheritAttrs: false,
  setup(_props, { attrs, slots }) {
    return () => {
      const { icon } = attrs;
      if (typeof icon === "string" && !isBundled(icon) && !reported.has(icon)) {
        reported.add(icon);
        console.error(`The icon "${icon}" is not bundled: add it to apps/web/src/icons.ts`);
      }
      return h(OfflineIcon, attrs as unknown as InstanceType<typeof OfflineIcon>["$props"], slots);
    };
  },
});
