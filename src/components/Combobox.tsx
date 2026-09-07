import chalk from "chalk";
import Fuse from "fuse.js";
import { Box, Text, useInput } from "ink";
import { type ReactNode, useEffect, useMemo, useState } from "react";

export type ComboboxProps<T extends Record<string, unknown>> = {
	/**
	 * Text to display when nothing is selected.
	 */
	readonly placeholder?: string;

	/**
	 * Listen to user's input. Useful in case there are multiple input components
	 * at the same time and input must be "routed" to a specific component.
	 */
	readonly focus?: boolean; // eslint-disable-line react/boolean-prop-naming

	/**
	 * Replace all chars and mask the value. Useful for password inputs.
	 */
	readonly mask?: string;

	/**
	 * Whether to show cursor and allow navigation inside text input with arrow keys.
	 */
	readonly showCursor?: boolean; // eslint-disable-line react/boolean-prop-naming

	/**
	 * Highlight pasted text
	 */
	readonly highlightPastedText?: boolean; // eslint-disable-line react/boolean-prop-naming

	/**
	 * Currently selected item, if any. Its label is displayed in the input.
	 */
	readonly value?: T;

	/**
	 * Function to call when `Enter` is pressed with an item highlighted.
	 * The user can only ever submit one of the provided items.
	 */
	readonly onSelect: (item: T) => void;

	/**
	 * List of possible values for the combobox.
	 */
	readonly items: T[];

	/**
	 * Key of the item object to use as the label in the combobox.
	 */
	readonly labelKey: keyof T;

	/**
	 * Keys of the item object to search within when filtering items based on user input.
	 * Defaults to `[labelKey]`.
	 */
	readonly searchKeys?: (keyof T)[];

	/**
	 * Maximum number of items visible at once in the list.
	 */
	readonly maxVisibleItems?: number;

	/**
	 * Whether the items are still loading. While `true`, the list shows
	 * `loadingMessage` instead of items and selection is blocked.
	 */
	readonly loading?: boolean; // eslint-disable-line react/boolean-prop-naming

	/**
	 * Text displayed in the list area while `loading` is `true`.
	 */
	readonly loadingMessage?: string;

	/**
	 * Prepended to every rendered row (input and list items). Used by the
	 * wizard to draw its gutter.
	 */
	readonly linePrefix?: string;

	/**
	 * Custom row renderer. Receives the item and whether it is highlighted,
	 * and returns the row content (the selection indicator is still drawn by
	 * the combobox). Use this when parts of the row — like a status dot —
	 * should keep their own color instead of being dimmed with the rest.
	 */
	readonly renderItem?: (item: T, isSelected: boolean) => ReactNode;
};

export function Combobox<T extends Record<string, unknown>>({
	value,
	placeholder = "",
	focus = true,
	mask,
	highlightPastedText = false,
	showCursor = true,
	onSelect,
	items,
	labelKey,
	searchKeys,
	maxVisibleItems = 5,
	loading = false,
	loadingMessage = "Loading…",
	linePrefix = "",
	renderItem,
}: ComboboxProps<T>) {
	const getLabel = (item: T | undefined) =>
		item ? String(item[labelKey]) : "";

	const [query, setQuery] = useState(() => getLabel(value));
	const [state, setState] = useState(() => ({
		cursorOffset: getLabel(value).length,
		cursorWidth: 0,
	}));
	const [selectedIndex, setSelectedIndex] = useState(0);

	const { cursorOffset, cursorWidth } = state;

	const fuse = useMemo(
		() =>
			new Fuse(items, {
				keys: (searchKeys ?? [labelKey]).map(String),
				threshold: 0.4,
			}),
		[items, searchKeys, labelKey],
	);

	const selectedLabel = getLabel(value);

	const filteredItems = useMemo(() => {
		const search = query.trim();

		// An untouched input (empty, or still showing the selected item's
		// label) lists everything. Filtering kicks in once the user edits.
		if (search.length === 0 || search === selectedLabel) {
			return items;
		}

		return fuse.search(search).map((result) => result.item);
	}, [fuse, items, query, selectedLabel]);

	// Sync the input when the selected item changes from outside.
	const [previousValue, setPreviousValue] = useState(value);

	if (previousValue !== value) {
		setPreviousValue(value);
		const label = getLabel(value);
		setQuery(label);
		setSelectedIndex(0);
		setState({ cursorOffset: label.length, cursorWidth: 0 });
	}

	// Jump back to the top match whenever the filter text changes.
	const [previousQuery, setPreviousQuery] = useState(query);

	if (previousQuery !== query) {
		setPreviousQuery(query);
		setSelectedIndex(0);
	}

	useEffect(() => {
		setState((previousState) => {
			if (!focus || !showCursor) {
				return previousState;
			}

			if (previousState.cursorOffset > query.length - 1) {
				return {
					cursorOffset: query.length,
					cursorWidth: 0,
				};
			}

			return previousState;
		});
	}, [query, focus, showCursor]);

	const cursorActualWidth = highlightPastedText ? cursorWidth : 0;

	const displayValue = mask ? mask.repeat(query.length) : query;
	let renderedValue = displayValue;
	let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

	// Fake mouse cursor, because it's too inconvenient to deal with actual cursor and ansi escapes
	if (showCursor && focus) {
		renderedPlaceholder =
			placeholder.length > 0
				? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
				: chalk.inverse(" ");

		renderedValue = displayValue.length > 0 ? "" : chalk.inverse(" ");

		let i = 0;

		for (const char of displayValue) {
			renderedValue +=
				i >= cursorOffset - cursorActualWidth && i <= cursorOffset
					? chalk.inverse(char)
					: char;

			i++;
		}

		if (displayValue.length > 0 && cursorOffset === displayValue.length) {
			renderedValue += chalk.inverse(" ");
		}
	}

	useInput(
		(input, key) => {
			if (
				(key.ctrl && input === "c") ||
				key.escape ||
				key.tab ||
				(key.shift && key.tab)
			) {
				return;
			}

			// While loading (or with no matches) there are no items to
			// navigate or select.
			if (loading || filteredItems.length === 0) {
				if (key.upArrow || key.downArrow || key.return) {
					return;
				}
			} else if (key.upArrow) {
				// Wrap around: up from the first item lands on the last one.
				setSelectedIndex(
					(previous) =>
						(previous - 1 + filteredItems.length) % filteredItems.length,
				);
				return;
			}

			if (key.downArrow) {
				// Wrap around: down from the last item lands on the first one.
				setSelectedIndex((previous) => (previous + 1) % filteredItems.length);
				return;
			}
			if (key.return) {
				const selectedItem = filteredItems[selectedIndex];

				// Only an actual item can be submitted, never the raw filter text.
				if (selectedItem) {
					const label = getLabel(selectedItem);
					setQuery(label);
					setState({ cursorOffset: label.length, cursorWidth: 0 });
					onSelect(selectedItem);
				}

				return;
			}

			let nextCursorOffset = cursorOffset;
			let nextValue = query;
			let nextCursorWidth = 0;

			if (key.leftArrow) {
				if (showCursor) {
					nextCursorOffset--;
				}
			} else if (key.rightArrow) {
				if (showCursor) {
					nextCursorOffset++;
				}
			} else if (key.backspace || key.delete) {
				if (cursorOffset > 0) {
					nextValue =
						query.slice(0, cursorOffset - 1) +
						query.slice(cursorOffset, query.length);

					nextCursorOffset--;
				}
			} else {
				nextValue =
					query.slice(0, cursorOffset) +
					input +
					query.slice(cursorOffset, query.length);

				nextCursorOffset += input.length;

				if (input.length > 1) {
					nextCursorWidth = input.length;
				}
			}

			if (nextCursorOffset < 0) {
				nextCursorOffset = 0;
			}

			// Clamp against the value being written (not the pre-edit query),
			// otherwise typed characters would leave the cursor one behind.
			if (nextCursorOffset > nextValue.length) {
				nextCursorOffset = nextValue.length;
			}

			setState({
				cursorOffset: nextCursorOffset,
				cursorWidth: nextCursorWidth,
			});

			if (nextValue !== query) {
				setQuery(nextValue);
			}
		},
		{ isActive: focus },
	);

	// Keep the highlighted item inside a sliding window of visible rows.
	const windowStart = Math.max(
		Math.min(
			selectedIndex - Math.floor(maxVisibleItems / 2),
			filteredItems.length - maxVisibleItems,
		),
		0,
	);
	const visibleItems = filteredItems.slice(
		windowStart,
		windowStart + maxVisibleItems,
	);

	return (
		<Box flexDirection="column">
			<Text>
				{linePrefix}
				{placeholder
					? displayValue.length > 0
						? renderedValue
						: renderedPlaceholder
					: renderedValue}
			</Text>
			{!focus ? null : loading ? (
				<Text dimColor>{`${linePrefix} ${loadingMessage}`}</Text>
			) : filteredItems.length === 0 ? (
				<Text dimColor>{`${linePrefix} No matching items`}</Text>
			) : (
				visibleItems.map((item, index) => {
					const itemIndex = windowStart + index;
					const isSelected = itemIndex === selectedIndex;
					const label = getLabel(item);

					return (
						<Text key={`${itemIndex}-${label}`}>
							{linePrefix}
							{renderItem ? (
								<>
									<Text color={isSelected ? "cyan" : undefined}>
										{isSelected ? "❯ " : "  "}
									</Text>
									{renderItem(item, isSelected)}
								</>
							) : isSelected ? (
								chalk.cyan(`❯ ${label}`)
							) : (
								chalk.dim(`  ${label}`)
							)}
						</Text>
					);
				})
			)}
		</Box>
	);
}
