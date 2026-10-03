import { readdirSync, mkdirSync, copyFileSync } from 'node:fs';
// Preserve crate manifests and bundled notices in the runtime image.
function collect(directory, output) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const source = directory + '/' + entry.name, target = output + '/' + entry.name;
        if (entry.isDirectory()) collect(source, target);
        else if (/^(licen[cs]e|copying|copyright|notice)/i.test(entry.name) || entry.name === 'Cargo.toml') {
            mkdirSync(output, { recursive: true }); copyFileSync(source, target);
        }
    }
}
collect('backend/vendor', 'backend/licenses');
