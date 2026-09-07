import chalk from "chalk";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import {
	ComboboxFieldEditor,
	type FormField,
	NumberFieldEditor,
	TextFieldEditor,
} from "./Form.js";

/**
 * The gutter drawn down the left side of the wizard, in the style of
 * install wizards like create-vite (@clack/prompts).
 */
const BAR = chalk.gray("│");

/**
 * The gutter prefix drawn in front of every wizard row. Exported so views
 * can align messages outside the wizard with its gutter.
 */
export const GUTTER = `${BAR}  `;

/**
 * The answer shown under a completed step.
 */
function answerOf(field: FormField): string {
	switch (field.type) {
		case "text":
			return field.value;
		case "number":
			return field.value?.toString() ?? "";
		case "combobox":
			return field.value ? String(field.value[field.labelKey]) : "";
		case "action":
			return "";
	}
}

function CompletedStep({ field }: { readonly field: FormField }) {
	const answer = answerOf(field);
	const placeholder = "placeholder" in field ? field.placeholder : undefined;

	return (
		<Box flexDirection="column">
			<Text>{`${chalk.green("◆")}  ${field.label}:`}</Text>
			<Text>
				{GUTTER}
				<Text dimColor>{answer.length > 0 ? answer : (placeholder ?? "")}</Text>
			</Text>
		</Box>
	);
}

type ActiveStepProps = {
	readonly field: FormField;
	readonly onDone: () => void;
};

function ActiveStep({ field, onDone }: ActiveStepProps) {
	const header = `${chalk.cyan("◇")}  ${field.label}`;

	if (field.type === "action") {
		return (
			<Box flexDirection="column">
				<Text>{header}</Text>
				<Text dimColor>{`${GUTTER}press enter to confirm`}</Text>
			</Box>
		);
	}

	if (field.type === "combobox") {
		return (
			<Box flexDirection="column">
				<Text>{`${header}:`}</Text>
				<ComboboxFieldEditor
					field={field}
					onDone={onDone}
					linePrefix={GUTTER}
				/>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<Text>{`${header}:`}</Text>
			<Box>
				<Text>{GUTTER}</Text>
				{field.type === "text" ? (
					<TextFieldEditor field={field} onDone={onDone} />
				) : (
					<NumberFieldEditor field={field} onDone={onDone} />
				)}
			</Box>
		</Box>
	);
}

export type WizardProps = {
	/**
	 * The steps of the wizard, presented one at a time in order. Answering a
	 * step advances to the next one and keeps the answer on screen above.
	 * `Escape` returns to the previous step, preserving its answer.
	 */
	readonly fields: FormField[];

	/**
	 * Title rendered on the `┌` line above the steps.
	 */
	readonly intro?: string;

	/**
	 * Whether the wizard listens for keyboard input.
	 */
	readonly focus?: boolean; // eslint-disable-line react/boolean-prop-naming

	/**
	 * Called when `Escape` is pressed on the first step.
	 */
	readonly onCancel?: () => void;
};

export function Wizard({ fields, intro, focus = true, onCancel }: WizardProps) {
	const [step, setStep] = useState(0);

	// Steps can appear and disappear between renders (e.g. the fields for a
	// server type only exist once a type is picked), so clamp the position.
	const currentIndex = Math.min(step, fields.length - 1);
	const current = fields[currentIndex];

	useInput(
		(_input, key) => {
			if (key.escape) {
				if (currentIndex === 0) {
					onCancel?.();
				} else {
					setStep(currentIndex - 1);
				}
				return;
			}

			// Action steps have no editor of their own, so the wizard handles
			// Enter for them. Every other step is handled by its editor.
			if (key.return && current?.type === "action") {
				current.onSelect();
			}
		},
		{ isActive: focus },
	);

	// Deliberately unclamped: a step's `onSelect` may grow `fields` (picking
	// a server type reveals its form), and the clamp above settles the
	// position on the next render.
	const advance = () => setStep((index) => index + 1);

	return (
		<Box flexDirection="column">
			<Text>
				{intro ? `${chalk.gray("┌")}  ${chalk.cyan(intro)}` : chalk.gray("┌")}
			</Text>
			{fields.slice(0, currentIndex).map((field) => (
				<Box flexDirection="column" key={field.id}>
					<Text>{BAR}</Text>
					<CompletedStep field={field} />
				</Box>
			))}
			{current && (
				<Box flexDirection="column">
					<Text>{BAR}</Text>
					<ActiveStep field={current} onDone={advance} />
				</Box>
			)}
		</Box>
	);
}
