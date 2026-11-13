// What the page knows about the device it runs on.

let typeable: boolean | undefined;

/**
 * The device can be typed on (docs/spec/views.md, section 1): a fine pointer and a window at least
 * 1024 px wide. Measured the first time it is asked and kept until the page is loaded again, so
 * that resizing the window never switches the view in the middle of typing.
 */
export function canType(): boolean {
  typeable ??= window.matchMedia("(pointer: fine)").matches && window.innerWidth >= 1024;
  return typeable;
}
