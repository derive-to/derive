/** Remove wrappers that commonly surround a reference copied from prose. */
export const cleanPastedReference = (input: string): string => {
  let value = input.trim()
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim()
  let end = value.length
  while (end > 0 && ".,;:)]".includes(value[end - 1] ?? "")) end--
  return value.slice(0, end)
}
