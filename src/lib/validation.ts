import z from "zod";

/**
 * Converts empty or whitespace string to undefined so that schema defaults apply.
 */
export const emptyToUndefined = <T extends z.ZodType>(schema: T) =>
	z.preprocess((val) => {
		if (typeof val !== "string") {
			return val;
		}
		const trimmed = val.trim();
		return trimmed === "" ? undefined : trimmed;
	}, schema);

/**
 * A valid port number is an integer between 0 and 65535 inclusive.
 */
export const ValidPortSchema = z.number().int().min(0).max(65535);

/**
 * A valid port range object has a `min` and `max` port, where `min` is less than or equal to `max`.
 */
export const PortRangeSchema = z
	.object({
		min: ValidPortSchema,
		max: ValidPortSchema,
	})
	.refine(({ min, max }) => min <= max, {
		message: "Port range must have min <= max",
	});
export type PortRange = z.infer<typeof PortRangeSchema>;

/**
 * A valid port range string has the format "min-max", where min and max are valid port numbers.
 */
export const PORT_RANGE_PATTERN = /^(\d+)-(\d+)$/;

/**
 * A valid port range string schema parses strings of the format "min-max" into a port range object.
 *
 * If you would like to use a default port range, you can use the `prefault` method on this schema.
 */
export const PortRangeStringSchema = z
	.string()
	.regex(PORT_RANGE_PATTERN)
	.transform((arg) => {
		// biome-ignore lint/style/noNonNullAssertion: This will never be null because this code path is unreachable if the regex validation above fails
		const result = PORT_RANGE_PATTERN.exec(arg)!;
		const [, minStr, maxStr] = result;

		return {
			min: Number(minStr),
			max: Number(maxStr),
		};
	})
	.pipe(PortRangeSchema);
