/** Bounded, ordered paging. Totals are deliberately advisory, never stop signals. */
export async function* parallelPages<T>(options: {
    pageSize: number; limit: number; maxParallelRequests: number; stopOnShortPage?: boolean;
    fetchPage: (offset: number, count: number, signal: AbortSignal) => Promise<T>;
    featureCount: (page: T) => number;
}): AsyncGenerator<{ page: T; offset: number; requested: number }> {
    const { pageSize, limit, maxParallelRequests, fetchPage, featureCount } = options;
    if (!Number.isSafeInteger(maxParallelRequests) || maxParallelRequests < 1 || maxParallelRequests > 100)
        throw Error('Maximum parallel requests must be a whole number from 1 to 100.');
    type Result = { page: T } | { error: unknown };
    const pending = new Map<number, { controller: AbortController; requested: number; stride: number; result: Promise<Result> }>();
    let offset = 0, next = 0, stride = pageSize, boundary = limit, generation = 0;
    const fill = (maximum: number) => {
        while (pending.size < maximum && next < limit && next <= boundary) {
            const at = next, requested = Math.min(pageSize, limit - at), step = Math.min(stride, limit - at);
            const controller = new AbortController(), epoch = generation;
            // Attach rejection handling at launch, including synchronous callback errors.
            const result: Promise<Result> = Promise.resolve().then(() => fetchPage(at, requested, controller.signal))
                .then(page => {
                    const count = featureCount(page);
                    if (epoch === generation && (!count || (options.stopOnShortPage && count < requested))) {
                        // A later page can reveal the end before earlier transfers finish.
                        // Keep those earlier pages, but stop launching/retain no later work.
                        boundary = Math.min(boundary, at);
                        for (const [offset, request] of pending) if (offset > boundary) request.controller.abort();
                    }
                    return { page };
                }).catch(error => ({ error }));
            pending.set(at, { controller, requested, stride: step, result });
            next += step;
        }
    };
    const discard = async () => {
        const requests = [...pending.values()];
        generation++; boundary = limit;
        pending.clear();
        for (const request of requests) request.controller.abort();
        // Drain aborted requests before starting replacement offsets, maintaining the cap.
        await Promise.all(requests.map(request => request.result));
    };
    try {
        // Establish the server's actual page size before speculating about offsets.
        fill(1);
        while (offset < limit) {
            const request = pending.get(offset)!;
            const response = await request.result;
            pending.delete(offset);
            if ('error' in response) throw response.error;
            const count = featureCount(response.page);
            if (!count) return;
            if (count > request.requested) throw Error('Server ignored the requested page count');
            const end = offset + count;
            const last = end === limit || (options.stopOnShortPage && count < request.requested);
            if (last) await discard();
            else {
                if (count !== request.stride) {
                    // A cap changed or a nonterminal page was short. Old speculative
                    // offsets would skip records or overlap them: rebuild from actual end.
                    await discard();
                    stride = count;
                    next = end;
                }
                fill(maxParallelRequests);
            }
            yield { page: response.page, offset, requested: request.requested };
            if (last) return;
            offset = end;
        }
    } finally {
        // Also runs when decoding/packing/duplicate checks in the consumer fail.
        await discard();
    }
}
