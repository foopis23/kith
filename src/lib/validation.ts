import z from "zod";

/**
 * In terminal forms, empty strings mean "unset". Converts empty or
 * whitespace-only strings to undefined so schema defaults and optionals
 * apply; surrounding whitespace is trimmed off non-empty values too.
 */
export const emptyToUndefined = <T extends z.ZodType>(schema: T) =>
	z.preprocess((val) => {
		if (typeof val !== "string") {
			return val;
		}
		const trimmed = val.trim();
		return trimmed === "" ? undefined : trimmed;
	}, schema);
