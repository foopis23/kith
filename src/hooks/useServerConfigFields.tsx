import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { comboboxField, type FormField } from "../components/Form.js";
import {
	difficulties,
	flags,
	modes,
	type ServerConfig,
	type ServerConfigPatch,
	type ServerFlags,
} from "../models/server.model.js";
import * as JavaService from "../services/java.service.js";
import * as ModrinthService from "../services/modrinth.service.js";
import * as ServerService from "../services/server.service.js";
import * as VanillaService from "../services/vanilla.service.js";
import {
	LATEST_MODPACK_VERSION,
	renderModpackVersionOption,
	toModpackVersionOptions,
} from "./useModrinthServerFields.js";

const trueFalse: { label: string; value: boolean }[] = [
	{ label: "true", value: true },
	{ label: "false", value: false },
];

function booleanField(
	id: string,
	label: string,
	value: boolean | undefined,
	onSelect: (value: boolean) => void,
): FormField {
	return comboboxField({
		id,
		type: "combobox",
		label,
		items: trueFalse,
		labelKey: "label",
		maxVisibleItems: trueFalse.length,
		value: trueFalse.find((option) => option.value === value),
		onSelect: (option) => onSelect(option.value),
	});
}

function optionsField(
	id: string,
	label: string,
	options: string[],
	value: string | undefined,
	onSelect: (value: string) => void,
): FormField {
	const items = options.map((option) => ({ label: option }));

	return comboboxField({
		id,
		type: "combobox",
		label,
		items,
		labelKey: "label",
		maxVisibleItems: items.length,
		value: items.find((item) => item.label === value),
		onSelect: (item) => onSelect(item.label),
	});
}

/** Extracts the Java major from an image tag ("java21-graalvm" -> 21). */
function javaMajorOfTag(tag: string): number | undefined {
	const match = /^java(\d+)/.exec(tag);
	return match?.[1] ? Number(match[1]) : undefined;
}

/**
 * Owns the configuration of an existing server: loads it from the server's
 * compose file and exposes it as form field definitions. Editing a field
 * patches the compose file immediately; `undefined` (an emptied text field)
 * clears the setting's env var so itzg's default applies again — except the
 * port, which is reassigned to the next available one. Changes take effect
 * on the next server start.
 *
 * Nothing is loaded until `enabled` — the Server Details view only turns
 * it on when the Configure screen is actually opened, so browsing server
 * details never pays for the compose read or the version/tag fetches.
 */
export function useServerConfigFields(serverId: string, enabled: boolean) {
	const queryClient = useQueryClient();
	const queryKey = ["serverConfig", serverId];

	const configQuery = useQuery({
		queryKey,
		queryFn: () => ServerService.getServerConfig(serverId),
		enabled,
	});

	const imageTagsQuery = useQuery({
		queryKey: ["javaImageTags"],
		queryFn: () => JavaService.getJavaImageTags(),
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
	});

	const config: ServerConfig | undefined = configQuery.data;
	const isModrinth = config?.type === "MODRINTH";

	// Game versions for the version combobox (vanilla-style servers).
	const vanillaVersionsQuery = useQuery({
		queryKey: ["vanillaVersions"],
		queryFn: () => VanillaService.getVanillaVersions(),
		enabled: enabled && config !== undefined && !isModrinth,
		staleTime: Number.POSITIVE_INFINITY,
	});

	// Pack versions for the version combobox (MODRINTH servers).
	const modpackVersionsQuery = useQuery({
		queryKey: ["modrinthModpackVersions", config?.modpack],
		queryFn: () =>
			ModrinthService.getModpackVersions(
				// biome-ignore lint/style/noNonNullAssertion: guarded by `enabled`
				config!.modpack!,
			),
		enabled: enabled && isModrinth && !!config?.modpack,
		staleTime: Number.POSITIVE_INFINITY,
	});

	// For MODRINTH servers the Java requirement comes from the game
	// version the selected pack version targets — VERSION just tracks
	// "latest" there, so it says nothing. Resolved from the pack versions
	// the version combobox already fetched, costing no extra request.
	const modpackGameVersion = useMemo(() => {
		if (!isModrinth) {
			return null;
		}
		const wanted = config?.modpackVersion ?? "latest";
		const versions = modpackVersionsQuery.data ?? [];
		const match =
			wanted === "latest"
				? versions.find((version) => version.version_type === "release")
				: versions.find(
					(version) =>
						version.id === wanted || version.version_number === wanted,
				);
		return match?.game_versions
			? JavaService.getNewestGameVersion(match.game_versions)
			: null;
	}, [isModrinth, modpackVersionsQuery.data, config?.modpackVersion]);

	// The Java requirement of the server's current game version, used to
	// flag image tags that can't run it. For MODRINTH servers this waits
	// for the pack versions so the requirement reflects the pack's game
	// version rather than "latest".
	const javaRequirementQuery = useQuery({
		queryKey: [
			"javaRequirement",
			isModrinth ? modpackGameVersion : config?.version,
		],
		queryFn: () =>
			JavaService.getJavaVersionForMinecraftVersion(
				(isModrinth ? modpackGameVersion : config?.version) ?? "latest",
			),
		enabled:
			enabled &&
			(isModrinth ? modpackVersionsQuery.isSuccess : !!config?.version),
		staleTime: Number.POSITIVE_INFINITY,
	});

	const updateConfig = useMutation({
		mutationFn: (patch: ServerConfigPatch) =>
			ServerService.updateServerConfig(serverId, patch),
		onSuccess: (config) => {
			queryClient.setQueryData(queryKey, config);
			// The details view's info line shows the port from the server
			// query — refresh it so a port edit shows up there too.
			queryClient.invalidateQueries({ queryKey: ["servers", serverId] });
		},
	});

	// Stable across mutation state changes, so the memoized field list
	// (and with it the Form's Fuse index) survives re-renders triggered by
	// a save completing instead of being rebuilt on every edit.
	const patch = useCallback(
		(changes: ServerConfigPatch) => updateConfig.mutate(changes),
		[updateConfig.mutate],
	);

	// The server's current tag stays selectable even when it isn't one of
	// the tags Docker Hub advertises (ie. a pinned or removed tag).
	const imageTagItems = useMemo(() => {
		const tags = imageTagsQuery.data ?? [];
		const items = tags.map((tag) => ({ label: tag }));
		if (config?.imageTag && !tags.includes(config.imageTag)) {
			items.unshift({ label: config.imageTag });
		}
		return items;
	}, [imageTagsQuery.data, config?.imageTag]);

	// "latest" first, then every release id from Mojang's manifest.
	const gameVersionItems = useMemo(() => {
		const versions = vanillaVersionsQuery.data?.versions ?? [];
		return [
			{ id: "latest" },
			...versions.map((version) => ({ id: version.id })),
		];
	}, [vanillaVersionsQuery.data]);

	const modpackVersionOptions = useMemo(
		() => toModpackVersionOptions(modpackVersionsQuery.data ?? []),
		[modpackVersionsQuery.data],
	);

	// The stored modpack version can be a version id or a version number
	// (ie. when the server was created from a version url).
	const selectedModpackVersion = useMemo(
		() =>
			modpackVersionOptions.find(
				(option) =>
					option.id === config?.modpackVersion ||
					(option.id !== LATEST_MODPACK_VERSION &&
						option.label === config?.modpackVersion),
			),
		[modpackVersionOptions, config?.modpackVersion],
	);

	// Memoized on the data that actually feeds it, so the Form's Fuse index
	// and filter memo survive re-renders (mutation state, parent updates)
	// instead of being rebuilt on every keystroke.
	const fields: FormField[] = useMemo(() => {
		// An emptied text field clears the env var, restoring itzg's default.
		const textValue = (value: string) => {
			const trimmed = value.trim();
			return trimmed.length === 0 ? undefined : trimmed;
		};

		const versionField: FormField = isModrinth
			? comboboxField({
				id: "modpack_version",
				type: "combobox",
				label: "Modpack version",
				items: modpackVersionOptions,
				labelKey: "label",
				searchKeys: ["label"],
				loading: modpackVersionsQuery.isPending,
				loadingMessage: "Loading versions…",
				value: selectedModpackVersion,
				onSelect: (selected) => patch({ modpackVersion: selected.id }),
				renderItem: renderModpackVersionOption,
			})
			: comboboxField({
				id: "version",
				type: "combobox",
				label: "Version",
				items: gameVersionItems,
				labelKey: "id",
				searchKeys: ["id"],
				loading: vanillaVersionsQuery.isPending,
				loadingMessage: "Loading versions…",
				value: gameVersionItems.find(
					(item) => item.id.toLowerCase() === config?.version?.toLowerCase(),
				),
				onSelect: (item) => patch({ version: item.id }),
			});

		return [
			versionField,
			{
				id: "motd",
				type: "text",
				label: "MOTD",
				value: config?.motd ?? "",
				placeholder: "A Minecraft Server powered by Docker",
				onSubmit: (motd) => patch({ motd: textValue(motd) }),
			},
			optionsField(
				"difficulty",
				"Difficulty",
				difficulties,
				config?.difficulty,
				(difficulty) => patch({ difficulty }),
			),
			booleanField("hardcore", "Hardcore", config?.hardcore, (hardcore) =>
				patch({ hardcore }),
			),
			optionsField("mode", "Game mode", modes, config?.mode, (mode) =>
				patch({ mode }),
			),
			{
				id: "level",
				type: "text",
				label: "Level name",
				value: config?.level ?? "",
				placeholder: "world",
				onSubmit: (level) => patch({ level: textValue(level) }),
			},
			booleanField(
				"enable_whitelist",
				"Whitelist",
				config?.enableWhitelist,
				(enableWhitelist) => patch({ enableWhitelist }),
			),
			{
				id: "initial_enabled_packs",
				type: "text",
				label: "Initial enabled packs",
				value: config?.initialEnabledPacks ?? "",
				placeholder: "comma-separated datapack ids",
				onSubmit: (initialEnabledPacks) =>
					patch({ initialEnabledPacks: textValue(initialEnabledPacks) }),
			},
			{
				id: "seed",
				type: "text",
				label: "Seed",
				value: config?.seed ?? "",
				placeholder: "random",
				onSubmit: (seed) => patch({ seed: textValue(seed) }),
			},
			{
				id: "memory",
				type: "text",
				label: "Memory",
				value: config?.memory ?? "",
				placeholder: "1G",
				maxLength: 6,
				onSubmit: (memory) => patch({ memory: textValue(memory) }),
			},
			{
				id: "port",
				type: "number",
				label: "Port",
				value: config?.port,
				placeholder: "auto",
				onSubmit: (port) => patch({ port }),
			},
			comboboxField({
				id: "image_tag",
				type: "combobox",
				label: "Image tag (Java version)",
				items: imageTagItems,
				labelKey: "label",
				maxVisibleItems: 10,
				loading: imageTagsQuery.isPending,
				loadingMessage: "fetching tags from Docker Hub…",
				value: imageTagItems.find((item) => item.label === config?.imageTag),
				onSelect: (item) => patch({ imageTag: item.label }),
			}),
			optionsField("flags", "JVM flags", [...flags], config?.flags, (value) =>
				patch({ flags: value as ServerFlags }),
			),
		];
	}, [
		config,
		isModrinth,
		modpackVersionOptions,
		modpackVersionsQuery.isPending,
		selectedModpackVersion,
		gameVersionItems,
		vanillaVersionsQuery.isPending,
		imageTagItems,
		imageTagsQuery.isPending,
		patch,
	]);

	// A warning (never a block) when the chosen image tag's Java is older
	// than what the current game version needs — the server would fail to
	// start, but the user may know better (custom forks, backports).
	const imageTagWarning = useMemo(() => {
		const tag = config?.imageTag;
		const requiredTag = javaRequirementQuery.data;
		if (!tag || !requiredTag || tag === "latest" || requiredTag === "latest") {
			return null;
		}

		const tagMajor = javaMajorOfTag(tag);
		const requiredMajor = javaMajorOfTag(requiredTag);
		if (tagMajor === undefined || requiredMajor === undefined) {
			return null;
		}
		if (tagMajor >= requiredMajor) {
			return null;
		}

		// Name whatever actually dictates the requirement: the game
		// version for vanilla-style servers, the pack version (and the
		// game version it targets) for MODRINTH servers.
		const requirement = isModrinth
			? `modpack version "${config?.modpackVersion ?? "latest"}"${modpackGameVersion ? ` (Minecraft ${modpackGameVersion})` : ""
			}`
			: `Minecraft ${config?.version}`;

		return `Image tag "${tag}" is Java ${tagMajor}, but ${requirement} needs Java ${requiredMajor} ("${requiredTag}") — the server may fail to start.`;
	}, [
		config?.imageTag,
		config?.version,
		config?.modpackVersion,
		isModrinth,
		modpackGameVersion,
		javaRequirementQuery.data,
	]);

	const errorMessage = configQuery.error
		? configQuery.error.message
		: updateConfig.error
			? updateConfig.error.message
			: null;

	return {
		fields,
		isLoading: enabled && configQuery.isPending,
		isSaving: updateConfig.isPending,
		errorMessage,
		imageTagWarning,
	};
}
