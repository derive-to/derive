/** bytes → "1.2 GB". Display-only; billing surfaces (plan card, upgrade dialog)
 *  share it so the two can't round differently. */
export const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`
