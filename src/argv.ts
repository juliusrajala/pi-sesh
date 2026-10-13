export function isLiteralArgv(
  value: unknown,
  options: {
    allowEmpty?: boolean;
    maxArguments?: number;
    maxArgumentLength?: number;
  } = {},
): value is string[] {
  const maxArguments = options.maxArguments ?? Infinity;
  const maxArgumentLength = options.maxArgumentLength ?? Infinity;
  return (
    Array.isArray(value) &&
    (options.allowEmpty === true || value.length > 0) &&
    value.length <= maxArguments &&
    value.every(
      (part) =>
        typeof part === "string" &&
        part.length > 0 &&
        part.length <= maxArgumentLength &&
        !part.includes("\0"),
    )
  );
}
