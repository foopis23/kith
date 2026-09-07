import z from "zod";

/**
 * Java major versions with a matching itzg/minecraft-server image tag, in
 * ascending order. A required major version rounds up to the next
 * supported tag; anything newer than every tag falls back to "latest".
 */
export const SUPPORTED_JAVA_MAJORS = [8, 11, 16, 17, 21, 25];

/**
 * Image variants offered by itzg/minecraft-server, appended to the base
 * tag (ie. "java21-graalvm"). The standard variant has no suffix.
 */
export const JAVA_IMAGE_VARIANTS = ["standard", "graalvm", "alpine"] as const;
export type JavaImageVariant = (typeof JAVA_IMAGE_VARIANTS)[number];

/**
 * Builds the itzg/minecraft-server image tag for a Java major version and
 * variant (ie. 21 + "graalvm" -> "java21-graalvm").
 */
export function javaImageTag(
	major: number,
	variant: JavaImageVariant = "standard",
): string {
	return variant === "standard" ? `java${major}` : `java${major}-${variant}`;
}

/**
 * The subset of Mojang's version detail JSON (linked from the version
 * manifest) that declares the Java version a Minecraft version requires.
 */
export const versionDetailSchema = z.object({
	javaVersion: z.object({
		majorVersion: z.number(),
	}),
});
export type VersionDetail = z.infer<typeof versionDetailSchema>;

/**
 * On-disk cache mapping a Minecraft version id to the Java major version
 * it requires, so Mojang's version detail JSON only needs to be fetched
 * once per Minecraft version.
 */
export const javaVersionCacheSchema = z.record(z.string(), z.number());
export type JavaVersionCache = z.infer<typeof javaVersionCacheSchema>;

/**
 * The subset of a Docker Hub tags API page we care about — tag names
 * plus the cursor to the next page.
 */
export const dockerHubTagsPageSchema = z.object({
	next: z.string().nullable(),
	results: z.array(z.object({ name: z.string() })),
});
export type DockerHubTagsPage = z.infer<typeof dockerHubTagsPageSchema>;

/**
 * On-disk cache of the itzg/minecraft-server image tags offered for
 * selection, so Docker Hub only needs to be queried once per TTL.
 */
export const javaImageTagsCacheSchema = z.object({
	fetchedAt: z.number(),
	tags: z.array(z.string()),
});
export type JavaImageTagsCache = z.infer<typeof javaImageTagsCacheSchema>;
