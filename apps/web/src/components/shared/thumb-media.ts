/** Which media a Thumb renders: the static preview PNG when one exists and hasn't
 *  failed to load, otherwise the live iframe. Extracted as a pure function so the
 *  branch is unit-testable without a DOM (the web suite is pure-logic only). */
export const thumbMedia = (
  hasPreview: boolean | undefined,
  imgFailed: boolean,
): "img" | "iframe" => (hasPreview && !imgFailed ? "img" : "iframe")
