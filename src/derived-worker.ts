import { joinDatasets, type JoinSnapshot } from './derived-datasets.ts';
const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = event => {
    const { leftPort, rightPort, options, timeField, save } = event.data;
    const read = (port: MessagePort) => new Promise<JoinSnapshot>((resolve, reject) => {
        port.onmessage = e => { port.close(); e.data.error ? reject(Error(e.data.error)) : resolve(e.data.snapshot); };
        port.onmessageerror = () => { port.close(); reject(Error('Could not read source snapshot. Reload the sources and retry.')); };
    });
    void Promise.all([read(leftPort), read(rightPort)]).then(([left, right]) => joinDatasets(left, right, options, timeField, save,
        () => false, message => ctx.postMessage({ progress: message }))).then(result => ctx.postMessage({ result })).catch(e => ctx.postMessage({ error: (e as Error).message }));
};
