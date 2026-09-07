#!/usr/bin/env node
import {
	environmentManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { render } from "ink";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { ErrorQueueProvider } from "./components/Screen.js";
import { validateConfig } from "./lib/config.js";
import { acquireInstanceLock } from "./lib/lock.js";
import { CreateServer } from "./views/CreateServer.view.js";
import { ServerBackups } from "./views/ServerBackups.view.js";
import { ServerDetails } from "./views/ServerDetails.view.js";
import { ServerList } from "./views/ServerList.view.js";

// Bun has no `window`, so TanStack Query assumes a server environment and
// disables all timer-based behavior: refetchInterval never fires, retries
// default to 0 and the cache is never garbage collected. This is a
// long-lived TUI, not an SSR render — opt back into client behavior.
environmentManager.setIsServer(() => false);

// Validate env config and create (or verify access to) every directory
// it references before anything renders. Exits with an actionable
// message on failure.
validateConfig();

// One kith process per serversDir — a shared multi-user install must
// not have two instances racing on compose rewrites and port allocation.
acquireInstanceLock();

const queryClient = new QueryClient();

function Exit() {
	useEffect(() => {
		process.exit();
	}, []);

	return null;
}

const App = () => {
	return (
		<QueryClientProvider client={queryClient}>
			<ErrorQueueProvider>
				<MemoryRouter>
					<Routes>
						<Route index element={<ServerList />} />
						<Route path="/create" element={<CreateServer />} />
						<Route path="/servers/:id" element={<ServerDetails />} />
						<Route path="/servers/:id/backups" element={<ServerBackups />} />
						<Route path="/exit" element={<Exit />} />
					</Routes>
				</MemoryRouter>
			</ErrorQueueProvider>
		</QueryClientProvider>
	);
};

console.clear();

render(<App />);
