import { Text } from "ink";
import SelectInput, {
	type IndicatorProps,
	type ItemProps,
} from "ink-select-input";

function Indicator({ isSelected }: IndicatorProps) {
	return (
		<Text color={isSelected ? "cyan" : undefined}>
			{isSelected ? "❯ " : "  "}
		</Text>
	);
}

function Item({ isSelected, label }: ItemProps) {
	return (
		<Text color={isSelected ? "cyan" : undefined} dimColor={!isSelected}>
			{label}
		</Text>
	);
}

export type MenuProps<T extends { label: string; value: unknown }> = {
	readonly items: readonly T[];
	readonly onSelect: (item: T) => void;
	readonly isFocused?: boolean; // eslint-disable-line react/boolean-prop-naming
};

/**
 * A selectable menu styled to match the Combobox rows: cyan `❯` on the
 * highlighted row, dim everywhere else. Use this instead of a raw
 * SelectInput so every menu in the app looks the same.
 */
export function Menu<T extends { label: string; value: unknown }>({
	items,
	onSelect,
	isFocused = true,
}: MenuProps<T>) {
	return (
		<SelectInput
			items={items as unknown as { label: string; value: unknown }[]}
			isFocused={isFocused}
			indicatorComponent={Indicator}
			itemComponent={Item}
			// SelectInput passes the item objects through untouched, so the
			// cast back to T is safe.
			onSelect={(item) => onSelect(item as T)}
		/>
	);
}
