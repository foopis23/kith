import { Text } from "ink";
import { useState } from "react";
import { useNavigate } from "react-router";
import { comboboxField, type FormField } from "../components/Form.js";
import { Screen } from "../components/Screen.js";
import { GUTTER, Wizard } from "../components/Wizard.js";
import { useModrinthServerFields } from "../hooks/useModrinthServerFields.js";
import { useVanillaServerFields } from "../hooks/useVanillaServerFields.js";

type ServerType = "vanilla" | "modrinth";

const serverTypes: { label: string; value: ServerType }[] = [
	{ label: "Vanilla", value: "vanilla" },
	{ label: "Modrinth", value: "modrinth" },
];

export function CreateServer() {
	const navigate = useNavigate();
	const [serverType, setServerType] = useState<ServerType | null>(null);
	const vanilla = useVanillaServerFields(serverType === "vanilla");
	const modrinth = useModrinthServerFields(serverType === "modrinth");

	const selectedType = serverTypes.find((type) => type.value === serverType);

	// The first step picks the server type; the chosen type's fields follow.
	const fields: FormField[] = [
		comboboxField({
			id: "type",
			type: "combobox",
			label: "Server type",
			items: serverTypes,
			labelKey: "label",
			searchKeys: ["label"],
			maxVisibleItems: serverTypes.length,
			value: selectedType,
			onSelect: (item) => setServerType(item.value),
		}),
		...(serverType === "vanilla" ? vanilla.fields : []),
		...(serverType === "modrinth" ? modrinth.fields : []),
	];

	return (
		<Screen
			breadcrumbs={["Create Server"]}
			hints={[
				{ key: "enter", action: "confirm" },
				{ key: "esc", action: "back" },
			]}
		>
			<Wizard fields={fields} onCancel={() => navigate("/")} />
			{serverType === "vanilla" && vanilla.errorMessage && (
				<Text>
					{GUTTER}
					<Text color="red">{vanilla.errorMessage}</Text>
				</Text>
			)}
			{serverType === "modrinth" && modrinth.errorMessage && (
				<Text>
					{GUTTER}
					<Text color="red">{modrinth.errorMessage}</Text>
				</Text>
			)}
		</Screen>
	);
}
