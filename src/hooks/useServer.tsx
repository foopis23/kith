import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as ServerService from "../services/server.service.js";

export function useServer(serverId: string) {
    const queryClient = useQueryClient();

    const serverQuery = useQuery({
        queryKey: ["servers", serverId],
        queryFn: () => ServerService.getServer(serverId),
    });

    // Same key as the server list's status queries, so navigating between
    // the two views shares the cache instead of refetching.
    const statusQuery = useQuery({
        queryKey: ["servers", serverId, "status"],
        queryFn: () => ServerService.getServerStatus(serverId),
        refetchInterval: 5000,
    });

    // After a start/stop, refresh the status immediately rather than waiting
    // for the next poll.
    const invalidateStatus = () =>
        queryClient.invalidateQueries({
            queryKey: ["servers", serverId, "status"],
        });

    const startServer = useMutation({
        mutationFn: () => ServerService.start(serverId),
        onSettled: invalidateStatus,
    });
    const stopServer = useMutation({
        mutationFn: () => ServerService.stop(serverId),
        onSettled: invalidateStatus,
    });

    return {
        server: serverQuery.data ?? null,
        status: statusQuery.data ?? null,
        startServer,
        stopServer,
    };
}
