import z from "zod";

export const vanillaVersionsSchema = z.object({
	latest: z.object({
		release: z.string(),
		snapshot: z.string(),
	}),
	versions: z.array(
		z.object({
			id: z.string(),
			type: z.enum(["release", "snapshot", "old_alpha", "old_beta"]),
			url: z.url(),
			time: z.string(),
			releaseTime: z.string(),
			sha1: z.string(),
			complianceLevel: z.number().optional(),
		}),
	),
});
export type VanillaVersions = z.infer<typeof vanillaVersionsSchema>;

export const savedVanillaVersionsSchema = vanillaVersionsSchema.extend({
	cachedAt: z.string(),
});
