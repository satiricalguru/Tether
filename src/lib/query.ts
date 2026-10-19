import { QueryClient } from '@tanstack/react-query';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Local servers are cheap to ask but start and stop often.
        staleTime: 5_000,
        retry: false,
        refetchOnWindowFocus: true,
      },
    },
  });
}
