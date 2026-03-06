import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { buildPublicDataset, DATA_KEYS, normalizeStudents } from '../shared/data-model.mjs';

function parseArgs(argv) {
    const options = {
        binding: 'CLASS_MAP_DATA',
        env: null,
        dryRun: false,
        source: path.join(process.cwd(), 'js', 'data.js')
    };

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--dry-run') {
            options.dryRun = true;
        } else if (token === '--env' && argv[index + 1]) {
            options.env = argv[index + 1];
            index += 1;
        } else if (token.startsWith('--env=')) {
            options.env = token.split('=')[1];
        } else if (token === '--binding' && argv[index + 1]) {
            options.binding = argv[index + 1];
            index += 1;
        } else if (token.startsWith('--binding=')) {
            options.binding = token.split('=')[1];
        } else if (token === '--source' && argv[index + 1]) {
            options.source = path.resolve(argv[index + 1]);
            index += 1;
        } else if (token.startsWith('--source=')) {
            options.source = path.resolve(token.split('=')[1]);
        } else {
            throw new Error(`Unknown argument: ${token}`);
        }
    }

    return options;
}

function loadStudentsFromLegacyFile(sourcePath) {
    if (!existsSync(sourcePath)) {
        throw new Error(`Legacy data source not found: ${sourcePath}`);
    }

    const source = readFileSync(sourcePath, 'utf8');
    const context = {};
    vm.runInNewContext(`${source}\nglobalThis.__students = students;`, context, {
        filename: sourcePath
    });

    return context.__students;
}

function loadStudents(options) {
    if (process.env.STUDENTS_DATA) {
        return JSON.parse(process.env.STUDENTS_DATA);
    }

    return loadStudentsFromLegacyFile(options.source);
}

function buildBulkPayload(students) {
    const publicDataset = buildPublicDataset(students);
    return {
        publicDataset,
        bulkPayload: [
            {
                key: DATA_KEYS.raw,
                value: JSON.stringify(students)
            },
            {
                key: DATA_KEYS.public,
                value: JSON.stringify(publicDataset)
            }
        ]
    };
}

function findWranglerCliScript() {
    const candidates = [
        process.env.WRANGLER_CLI_JS ? path.resolve(process.env.WRANGLER_CLI_JS) : null,
        path.join(process.cwd(), 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js'),
        process.env.APPDATA
            ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js')
            : null,
        process.env.npm_config_prefix
            ? path.join(process.env.npm_config_prefix, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js')
            : null,
        process.env.HOME
            ? path.join(process.env.HOME, '.npm-global', 'lib', 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js')
            : null
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

function getWranglerInvocation() {
    const cliScript = findWranglerCliScript();
    if (cliScript) {
        return {
            command: process.execPath,
            argsPrefix: [cliScript]
        };
    }

    return {
        command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        argsPrefix: ['wrangler']
    };
}

function runBulkUpload(options, bulkPayload) {
    const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'class-map-kv-'));
    const tempPath = path.join(tempDirectory, 'bulk-put.json');
    writeFileSync(tempPath, JSON.stringify(bulkPayload, null, 2), 'utf8');

    try {
        const invocation = getWranglerInvocation();
        const args = [
            ...invocation.argsPrefix,
            'kv',
            'bulk',
            'put',
            tempPath,
            `--binding=${options.binding}`,
            '--remote'
        ];

        if (options.env) {
            args.push('--env', options.env);
        }

        console.log(`Uploading to Cloudflare KV via: ${[invocation.command, ...args].join(' ')}`);

        const result = spawnSync(invocation.command, args, {
            cwd: process.cwd(),
            env: process.env,
            stdio: 'inherit'
        });

        if (result.error) {
            throw new Error(`Failed to launch Wrangler: ${result.error.message}`);
        }

        if (result.signal) {
            throw new Error(`wrangler kv bulk put was terminated by signal ${result.signal}.`);
        }

        if (result.status !== 0) {
            throw new Error(`wrangler kv bulk put failed with exit code ${result.status}.`);
        }
    } finally {
        rmSync(tempDirectory, {
            recursive: true,
            force: true
        });
    }
}

try {
    const options = parseArgs(process.argv.slice(2));
    const students = normalizeStudents(loadStudents(options));
    const { publicDataset, bulkPayload } = buildBulkPayload(students);

    console.log(
        JSON.stringify(
            {
                binding: options.binding,
                env: options.env || 'production',
                keys: bulkPayload.map((entry) => entry.key),
                stats: publicDataset.stats
            },
            null,
            2
        )
    );

    if (!options.dryRun) {
        runBulkUpload(options, bulkPayload);
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
