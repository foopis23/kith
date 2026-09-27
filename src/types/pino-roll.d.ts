// pino-roll ships no TypeScript types — declare the API surface we use.
declare module "pino-roll" {
	import type { SonicBoom, SonicBoomOpts } from "sonic-boom";

	export interface PinoRollLimitOptions {
		count?: number;
		removeOtherLogFiles?: boolean;
	}

	export interface PinoRollOptions extends SonicBoomOpts {
		file: string | (() => string);
		size?: string | number;
		frequency?: string | number;
		extension?: string;
		symlink?: boolean;
		dateFormat?: string;
		limit?: PinoRollLimitOptions;
	}

	export default function pinoRoll(
		options?: PinoRollOptions,
	): Promise<SonicBoom>;
}
