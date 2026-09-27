import net from "net";

/**
 * Checks if a given port is free on the host machine.
 *
 * @param port The port number to check.
 * @returns `true` if the port is free, `false` otherwise.
 */
export function isPortFree(port: number) {
	return new Promise<boolean>((resolve) => {
		const server = net.createServer();
		server.unref();
		server.on("error", () => resolve(false));
		server.listen({ port }, () => {
			server.close(() => resolve(true));
		});
	});
}
