/**
 * Shared numeric parsing. Every function here refuses rather than guesses: a
 * confident wrong number is worse than an error when the number sizes a swap.
 *
 * Lives in its own module so portfolio.ts and main.ts can both use it without
 * importing each other.
 */

export const BPS_DENOMINATOR = 10_000n;

/** Fixed-point scale for USD values and prices. 1e8 == 8 decimal places. */
export const E8_DECIMALS = 8;
export const E8_SCALE = 10n ** BigInt(E8_DECIMALS);

export type Range = { min: bigint; max: bigint };

export const asObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
};

/**
 * Parse a decimal string into a scaled bigint, truncating toward zero.
 *
 * Deliberately does NOT go via `Number`: "0.1" + "0.2" style float error is
 * unacceptable in a price, and a large raw balance would lose low-order digits.
 *
 * Exponent notation ("1e-8") is rejected rather than handled, because a price
 * feed emitting it signals a format we have not verified.
 */
export const parseDecimalToScaled = (
  raw: string,
  scaleDecimals: number,
  label: string,
): bigint => {
  const text = raw.trim();
  if (text === "") {
    throw new Error(`${label}: empty decimal string`);
  }
  if (/[eE]/.test(text)) {
    throw new Error(`${label}: exponent notation not supported, got "${raw}"`);
  }
  if (!/^-?\d*\.?\d*$/.test(text) || !/\d/.test(text)) {
    throw new Error(`${label}: not a decimal number, got "${raw}"`);
  }

  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [integerPart = "", fractionPart = ""] = unsigned.split(".");

  // Truncate (round toward zero) rather than round-half-even. Rounding a price
  // up would let a quote overstate output and make an on-chain swap revert
  // against a min_amount_out derived from it.
  const truncatedFraction = fractionPart.slice(0, scaleDecimals);
  const paddedFraction = truncatedFraction.padEnd(scaleDecimals, "0");

  const magnitude = BigInt(`${integerPart || "0"}${paddedFraction}`);
  return negative ? -magnitude : magnitude;
};

/** Parse an integer string into a bigint, refusing anything non-integral. */
export const parseIntegerString = (raw: string, label: string): bigint => {
  const text = raw.trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`${label}: not an integer`);
  }
  return BigInt(text);
};

/**
 * Parse a JSON value that must be an integer -- accepts 5000 or "5000", never
 * 0.5, which would be ambiguous between 0.5 bps and 50%.
 */
export const parseIntegerValue = (value: unknown, label: string): bigint => {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${label}: must be an integer`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    return parseIntegerString(value, label);
  }
  throw new Error(`${label}: expected an integer, got ${typeof value}`);
};

export const requireInRange = (value: bigint, range: Range, label: string): bigint => {
  // The offending value is deliberately omitted: an error that escapes the
  // enclave is a public log line, and these values come from secrets. The
  // range bounds are public constants and safe to show.
  if (value < range.min || value > range.max) {
    throw new Error(`${label}: outside accepted range [${range.min}, ${range.max}]`);
  }
  return value;
};
