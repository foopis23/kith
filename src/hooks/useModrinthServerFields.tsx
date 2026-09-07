import { useMutation, useQuery } from "@tanstack/react-query";
import { Text } from "ink";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { z } from "zod";
import { comboboxField, type FormField } from "../components/Form.js";
import {
	type CreateModrinthServerArgs,
	createModrinthServerSchema,
	MAX_SERVER_LABEL_LENGTH,
} from "../models/server.model.js";
import * as ModrinthService from "../services/modrinth.service.js";
import { createModrinthServer } from "../services/server.service.js";

/**
 * Sentinel version value meaning "always use the newest release of the
 * modpack". Passed through to the server so it auto-updates on restart.
 */
export const LATEST_MODPACK_VERSION = "latest";

export type ModpackVersionOption = {
	id: string;
	label: string;
	versionType?: "release" | "beta" | "alpha";
	loaders: string[];
	gameVersions: string[];
	datePublished?: string;
};

const latestVersionOption: ModpackVersionOption = {
	id: LATEST_MODPACK_VERSION,
	label: "Latest release (auto-update, excludes beta/alpha)",
	loaders: [],
	gameVersions: [],
};

type ModrinthVersions = Awaited<
	ReturnType<typeof ModrinthService.getModpackVersions>
>;

/**
 * Maps raw Modrinth versions to combobox options, with the "latest"
 * auto-update option first. Shared between server creation and the
 * config screen.
 */
export function toModpackVersionOptions(
	versions: ModrinthVersions,
): ModpackVersionOption[] {
	return [
		latestVersionOption,
		...versions.map((version) => ({
			id: version.id,
			label: version.version_number ?? version.name ?? version.id,
			versionType: version.version_type,
			loaders: version.loaders ?? [],
			gameVersions: version.game_versions ?? [],
			datePublished: version.date_published,
		})),
	];
}

const publishDateFormatter = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
});

function formatPublishDate(datePublished: string): string {
	const date = new Date(datePublished);
	return Number.isNaN(date.getTime())
		? datePublished
		: publishDateFormatter.format(date);
}

function versionTypeColor(
	versionType: NonNullable<ModpackVersionOption["versionType"]>,
) {
	switch (versionType) {
		case "release":
			return "green";
		case "beta":
			return "yellow";
		case "alpha":
			return "red";
	}
}

/**
 * Renders a version row as `1.42.2 release · fabric · MC 1.21.1 · Sep 3, 2026`,
 * with the release type color-coded and the rest dimmed.
 */
export function renderModpackVersionOption(
	item: ModpackVersionOption,
	isSelected: boolean,
) {
	const label = (
		<Text color={isSelected ? "cyan" : undefined} dimColor={!isSelected}>
			{item.label}
		</Text>
	);

	if (item.id === LATEST_MODPACK_VERSION) {
		return label;
	}

	const details = [
		item.loaders.length > 0 ? item.loaders.join(", ") : null,
		item.gameVersions.length > 0 ? `MC ${item.gameVersions.join(", ")}` : null,
		item.datePublished ? formatPublishDate(item.datePublished) : null,
	]
		.filter((part) => part !== null)
		.join(" · ");

	return (
		<>
			{label}
			{item.versionType && (
				<Text color={versionTypeColor(item.versionType)}>
					{` ${item.versionType}`}
				</Text>
			)}
			{details.length > 0 && <Text dimColor>{`  ${details}`}</Text>}
		</>
	);
}

/**
 * Owns the state, modpack validation, version query and create mutation for
 * a modrinth server, and exposes them as wizard/form field definitions.
 */
export function useModrinthServerFields(enabled: boolean) {
	const navigate = useNavigate();
	const [data, setData] = useState<Partial<CreateModrinthServerArgs>>({
		type: "MODRINTH",
		modrinth_modpack_version: LATEST_MODPACK_VERSION,
		memory: "2G",
	});

	// Resolves the modpack input (url, slug, id or version url) to a Modrinth
	// project, proving the input points at a real modpack.
	const modpack = useQuery({
		queryKey: ["modrinthModpack", data.modrinth_modpack],
		queryFn: async () => {
			const project = await ModrinthService.getProject(
				// biome-ignore lint/style/noNonNullAssertion: guarded by `enabled`
				data.modrinth_modpack!,
			);
			if (project.project_type !== "modpack") {
				throw new Error(
					`"${project.title}" is a ${project.project_type}, not a modpack.`,
				);
			}
			return project;
		},
		enabled: enabled && !!data.modrinth_modpack,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
	});

	// Default the label to the modpack title once validated, unless the
	// user has already entered one.
	const modpackTitle = modpack.data?.title;
	useEffect(() => {
		if (modpackTitle) {
			setData((prev) => ({
				...prev,
				label: prev.label ?? modpackTitle.slice(0, MAX_SERVER_LABEL_LENGTH),
			}));
		}
	}, [modpackTitle]);

	const modpackVersions = useQuery({
		queryKey: ["modrinthModpackVersions", modpack.data?.id],
		queryFn: () =>
			ModrinthService.getModpackVersions(
				// biome-ignore lint/style/noNonNullAssertion: guarded by `enabled`
				data.modrinth_modpack!,
			),
		enabled: enabled && modpack.isSuccess,
		staleTime: Number.POSITIVE_INFINITY,
	});

	const createServer = useMutation({
		mutationFn: async () => {
			const validatedData = createModrinthServerSchema.parse(data);

			// The wizard can't block advancing on an invalid answer, so
			// re-validate the modpack and version before creating anything.
			const project = await ModrinthService.getProject(
				validatedData.modrinth_modpack,
			);
			if (!(await ModrinthService.isModpack(project))) {
				throw new Error(
					`"${project.title}" is a ${project.project_type}, not a modpack.`,
				);
			}

			if (validatedData.modrinth_modpack_version !== LATEST_MODPACK_VERSION) {
				const versions = await ModrinthService.getModpackVersions(
					validatedData.modrinth_modpack,
				);
				const exists = versions.some(
					(version) =>
						version.id === validatedData.modrinth_modpack_version ||
						version.version_number === validatedData.modrinth_modpack_version,
				);
				if (!exists) {
					throw new Error(
						`Version "${validatedData.modrinth_modpack_version}" does not exist for modpack "${project.title}".`,
					);
				}
			}

			return await createModrinthServer(validatedData);
		},
		onSuccess: (server) => {
			navigate(`/servers/${server.id}`);
		},
	});

	const versionOptions = toModpackVersionOptions(modpackVersions.data ?? []);

	// A version url pre-fills the version number, which only matches an
	// option's label until the user picks one (then it becomes a version id).
	const selectedVersion = versionOptions.find(
		(option) =>
			option.id === data.modrinth_modpack_version ||
			(option.id !== LATEST_MODPACK_VERSION &&
				option.label === data.modrinth_modpack_version),
	);

	const fields: FormField[] = [
		{
			id: "modpack",
			type: "text",
			label: "Modpack",
			value: data.modrinth_modpack ?? "",
			placeholder:
				"url, slug or id (ie. https://modrinth.com/modpack/cobbleverse)",
			onSubmit: (modpackInput) => {
				const { version } = ModrinthService.parseModrinthModpack(modpackInput);
				setData((prev) => ({
					...prev,
					modrinth_modpack: modpackInput,
					modrinth_modpack_version: version ?? LATEST_MODPACK_VERSION,
				}));
			},
		},
		comboboxField({
			id: "modpack_version",
			type: "combobox",
			label: "Modpack version",
			items: versionOptions,
			labelKey: "label",
			searchKeys: ["label"],
			loading:
				(!!data.modrinth_modpack && modpack.isPending) ||
				modpackVersions.isPending,
			loadingMessage: modpack.isPending
				? "Validating modpack…"
				: "Loading versions…",
			value: selectedVersion,
			onSelect: (selected) =>
				setData((prev) => ({
					...prev,
					modrinth_modpack_version: selected.id,
				})),
			renderItem: renderModpackVersionOption,
		}),
		{
			id: "label",
			type: "text",
			label: "Label",
			value: data.label ?? "",
			placeholder: "My Server",
			maxLength: MAX_SERVER_LABEL_LENGTH,
			onSubmit: (label) => setData((prev) => ({ ...prev, label })),
		},
		{
			id: "server_port",
			type: "number",
			label: "Port",
			value: data.server_port,
			placeholder: "auto",
			onSubmit: (server_port) => setData((prev) => ({ ...prev, server_port })),
		},
		{
			id: "memory",
			type: "text",
			label: "Memory",
			value: data.memory ?? "",
			placeholder: "2G",
			maxLength: 6,
			onSubmit: (memory) => setData((prev) => ({ ...prev, memory })),
		},
		{
			id: "create",
			type: "action",
			label: createServer.isPending ? "Creating Server..." : "Create Server",
			onSelect: () => {
				createServer.mutate();
			},
		},
	];

	const errorMessage = modpack.error
		? modpack.error.message
		: createServer.error
			? createServer.error instanceof z.ZodError
				? z.prettifyError(createServer.error)
				: createServer.error.message
			: null;

	return { fields, errorMessage };
}
