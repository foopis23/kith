import chalk from "chalk";
import Fuse from "fuse.js";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { type ReactNode, useMemo, useState } from "react";
import { Combobox } from "./Combobox.js";

type FieldBase = {
	/**
	 * Unique identifier for the field, used to track which row is being edited.
	 */
	readonly id: string;

	/**
	 * Label rendered in front of the field value.
	 */
	readonly label: string;
};

export type TextField = FieldBase & {
	readonly type: "text";
	readonly value: string;
	readonly placeholder?: string;
	/**
	 * Maximum number of characters the editor accepts. Longer input is
	 * truncated as it is typed.
	 */
	readonly maxLength?: number;
	readonly onSubmit: (value: string) => void;
};

export type NumberField = FieldBase & {
	readonly type: "number";
	readonly value: number | undefined;
	readonly placeholder?: string;
	readonly onSubmit: (value: number | undefined) => void;
};

export type ComboboxField<T extends Record<string, unknown>> = FieldBase & {
	readonly type: "combobox";
	readonly value: T | undefined;
	readonly items: T[];
	readonly labelKey: keyof T;
	readonly searchKeys?: (keyof T)[];
	readonly maxVisibleItems?: number;
	readonly loading?: boolean;
	readonly loadingMessage?: string;
	readonly onSelect: (item: T) => void;
	/**
	 * Custom row renderer, forwarded to the underlying `Combobox`. Use this
	 * to show extra item details (badges, dates) alongside the label.
	 */
	readonly renderItem?: (item: T, isSelected: boolean) => ReactNode;
};

export type ActionField = FieldBase & {
	readonly type: "action";
	readonly onSelect: () => void;
};

/**
 * A combobox field with its item type erased, so heterogeneous combobox
 * fields can live alongside other fields in the same array. Build combobox
 * fields with `comboboxField` to keep call-site type safety.
 */
type ErasedComboboxField = FieldBase & {
	readonly type: "combobox";
	readonly value: Record<string, unknown> | undefined;
	readonly items: Record<string, unknown>[];
	readonly labelKey: string;
	readonly searchKeys?: string[];
	readonly maxVisibleItems?: number;
	readonly loading?: boolean;
	readonly loadingMessage?: string;
	readonly onSelect: (item: Record<string, unknown>) => void;
	readonly renderItem?: (
		item: Record<string, unknown>,
		isSelected: boolean,
	) => ReactNode;
};

export type FormField =
	| TextField
	| NumberField
	| ErasedComboboxField
	| ActionField;

/**
 * Creates a combobox form field with full type safety on `items`, `value`
 * and `onSelect`, erasing the item type for storage in the field array.
 */
export function comboboxField<T extends Record<string, unknown>>(
	field: ComboboxField<T>,
): FormField {
	return field as unknown as FormField;
}

export type EditorProps<TField> = {
	readonly field: TField;
	readonly onDone: () => void;
};

export function TextFieldEditor({ field, onDone }: EditorProps<TextField>) {
	const [value, setValue] = useState(() =>
		field.maxLength ? field.value.slice(0, field.maxLength) : field.value,
	);

	return (
		<TextInput
			value={value}
			placeholder={field.placeholder}
			onChange={(next) =>
				setValue(field.maxLength ? next.slice(0, field.maxLength) : next)
			}
			onSubmit={(submitted) => {
				field.onSubmit(submitted);
				onDone();
			}}
		/>
	);
}

export function NumberFieldEditor({ field, onDone }: EditorProps<NumberField>) {
	const [text, setText] = useState(field.value?.toString() ?? "");

	return (
		<TextInput
			value={text}
			placeholder={field.placeholder}
			onChange={(next) => {
				if (/^\d*$/.test(next)) {
					setText(next);
				}
			}}
			onSubmit={(submitted) => {
				field.onSubmit(
					submitted === "" ? undefined : Number.parseInt(submitted, 10),
				);
				onDone();
			}}
		/>
	);
}

export function ComboboxFieldEditor({
	field,
	onDone,
	linePrefix,
}: EditorProps<ErasedComboboxField> & {
	/** Forwarded to the underlying `Combobox`, see its docs. */
	readonly linePrefix?: string;
}) {
	return (
		<Combobox
			items={field.items}
			labelKey={field.labelKey}
			searchKeys={field.searchKeys}
			maxVisibleItems={field.maxVisibleItems}
			loading={field.loading}
			loadingMessage={field.loadingMessage}
			value={field.value}
			linePrefix={linePrefix}
			renderItem={field.renderItem}
			onSelect={(item) => {
				field.onSelect(item);
				onDone();
			}}
		/>
	);
}

type FormRowProps = {
	readonly field: FormField;
	readonly selected: boolean;
	readonly editing: boolean;
	readonly onDone: () => void;
};

function FormRow({ field, selected, editing, onDone }: FormRowProps) {
	const indicator = selected ? chalk.cyan("❯") : " ";

	if (field.type === "action") {
		return <Text>{`${indicator} ${field.label}`}</Text>;
	}

	if (editing) {
		if (field.type === "combobox") {
			// The combobox renders its own dropdown list, so it gets the row
			// to itself with the label on top.
			return (
				<Box flexDirection="column">
					<Text>{`${indicator} ${field.label}:`}</Text>
					<ComboboxFieldEditor field={field} onDone={onDone} />
				</Box>
			);
		}

		return (
			<Box>
				<Text>{`${indicator} ${field.label}: `}</Text>
				{field.type === "text" ? (
					<TextFieldEditor field={field} onDone={onDone} />
				) : (
					<NumberFieldEditor field={field} onDone={onDone} />
				)}
			</Box>
		);
	}

	let display = "";
	let placeholder: string | undefined;

	switch (field.type) {
		case "text":
			display = field.value;
			placeholder = field.placeholder;
			break;
		case "number":
			display = field.value?.toString() ?? "";
			placeholder = field.placeholder;
			break;
		case "combobox":
			display = field.value ? String(field.value[field.labelKey]) : "";
			break;
	}

	return (
		<Text>
			{`${indicator} ${field.label}: `}
			{display.length > 0 ? (
				display
			) : (
				<Text dimColor>{placeholder ?? "unset"}</Text>
			)}
		</Text>
	);
}

export type FormProps = {
	/**
	 * The rows of the form, rendered top to bottom. Arrow keys move between
	 * rows, `Enter` starts editing a row (or triggers an action row), and
	 * submitting an editor returns to navigation. `Escape` cancels editing,
	 * or triggers `onEscape` when no row is being edited.
	 */
	readonly fields: FormField[];

	/**
	 * Whether the form listens for keyboard input.
	 */
	readonly focus?: boolean; // eslint-disable-line react/boolean-prop-naming

	/**
	 * When `true`, a filter input sits above the rows. Typing narrows the
	 * visible rows with a fuzzy match on their labels, so long forms stay
	 * navigable without scrolling. While the filter has text, `Escape`
	 * clears it instead of triggering `onEscape`.
	 */
	readonly filterable?: boolean; // eslint-disable-line react/boolean-prop-naming

	/**
	 * Placeholder shown in the filter input while it is empty.
	 */
	readonly filterPlaceholder?: string;

	/**
	 * Called when `Escape` is pressed while navigating between rows. While a
	 * row is being edited, `Escape` cancels the edit instead.
	 */
	readonly onEscape?: () => void;
};

export function Form({
	fields,
	focus = true,
	filterable = false,
	filterPlaceholder = "type to filter",
	onEscape,
}: FormProps) {
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [query, setQuery] = useState("");

	const fuse = useMemo(
		() => new Fuse(fields, { keys: ["label"], threshold: 0.4 }),
		[fields],
	);

	const filteredFields = useMemo(() => {
		const search = query.trim();

		if (!filterable || search.length === 0) {
			return fields;
		}

		return fuse.search(search).map((result) => result.item);
	}, [fields, fuse, filterable, query]);

	// Jump back to the first row whenever the filter text changes.
	const [previousQuery, setPreviousQuery] = useState(query);

	if (previousQuery !== query) {
		setPreviousQuery(query);
		setSelectedIndex(0);
	}

	// Fields can appear and disappear between renders (filtering shrinks
	// the list), so clamp the position instead of trusting the stored index.
	const currentIndex = Math.max(
		0,
		Math.min(selectedIndex, filteredFields.length - 1),
	);

	useInput(
		(_input, key) => {
			if (editingId !== null) {
				// The row's editor owns input while editing; Escape cancels.
				if (key.escape) {
					setEditingId(null);
				}

				return;
			}

			if (key.escape) {
				// A non-empty filter swallows the first Escape: clear the
				// filter before letting Escape leave the form.
				if (filterable && query.length > 0) {
					setQuery("");
				} else {
					onEscape?.();
				}
				return;
			}

			// Nothing to navigate or edit while the list is empty.
			if (filteredFields.length === 0) {
				return;
			}

			if (key.upArrow) {
				setSelectedIndex(Math.max(currentIndex - 1, 0));
				return;
			}

			if (key.downArrow) {
				setSelectedIndex(Math.min(currentIndex + 1, filteredFields.length - 1));
				return;
			}

			if (key.return) {
				const field = filteredFields[currentIndex];

				if (!field) {
					return;
				}

				if (field.type === "action") {
					field.onSelect();
				} else {
					setEditingId(field.id);
				}
			}
		},
		{ isActive: focus },
	);

	return (
		<Box flexDirection="column">
			{filterable && (
				<Box>
					<Text dimColor>{"Filter: "}</Text>
					<TextInput
						value={query}
						placeholder={filterPlaceholder}
						focus={focus && editingId === null}
						onChange={setQuery}
					/>
				</Box>
			)}
			{filteredFields.length === 0 ? (
				<Text dimColor>
					{query.trim().length > 0
						? `No rows match "${query.trim()}"`
						: "No rows"}
				</Text>
			) : (
				filteredFields.map((field, index) => (
					<FormRow
						key={field.id}
						field={field}
						selected={index === currentIndex}
						editing={editingId === field.id}
						onDone={() => setEditingId(null)}
					/>
				))
			)}
		</Box>
	);
}
