import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { z } from "zod";
import { comboboxField, type FormField } from "../components/Form.js";
import {
	type CreateVanillaServerArgs,
	createVanillaServerSchema,
	MAX_SERVER_LABEL_LENGTH,
} from "../models/server.model.js";
import { createVanillaServer } from "../services/server.service.js";
import * as VanillaService from "../services/vanilla.service.js";

/**
 * Owns the state, version query and create mutation for a vanilla server,
 * and exposes them as wizard/form field definitions.
 */
export function useVanillaServerFields(enabled: boolean) {
	const minecraftVersions = useQuery({
		queryKey: ["vanillaVersions"],
		queryFn: () => VanillaService.getVanillaVersions(),
		enabled,
	});

	const navigate = useNavigate();
	const [data, setData] = useState<Partial<CreateVanillaServerArgs>>({
		type: "VANILLA",
		version: "latest",
		memory: "2G",
	});

	const createServer = useMutation({
		mutationFn: async () => {
			const validatedData = createVanillaServerSchema.parse(data);
			return await createVanillaServer(validatedData);
		},
		onSuccess: (server) => {
			navigate(`/servers/${server.id}`);
		},
	});

	const versions = minecraftVersions.data?.versions ?? [];

	const fields: FormField[] = [
		{
			id: "label",
			type: "text",
			label: "Label",
			value: data.label ?? "",
			placeholder: "My Server",
			maxLength: MAX_SERVER_LABEL_LENGTH,
			onSubmit: (label) => setData((prev) => ({ ...prev, label })),
		},
		comboboxField({
			id: "version",
			type: "combobox",
			label: "Version",
			items: versions,
			labelKey: "id",
			searchKeys: ["id"],
			loading: minecraftVersions.isPending,
			loadingMessage: "Loading versions…",
			value: versions.find((version) => version.id === data.version),
			onSelect: (selected) =>
				setData((prev) => ({ ...prev, version: selected.id })),
		}),
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

	const errorMessage = createServer.error
		? createServer.error instanceof z.ZodError
			? z.prettifyError(createServer.error)
			: createServer.error.message
		: null;

	return { fields, errorMessage };
}
