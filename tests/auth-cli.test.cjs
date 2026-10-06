const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function loadService(name, services, extra = {}) {
    const exports = {};
    const context = vm.createContext({
        exports,
        global: { appGlobal: { packageJson: { appConfig: { useSfCliCommands: true } } } },
        require: id => {
            if (id === '.') return services;
            if (id === '../models') return {
                StatusCode: { OK: 0, GeneralError: 1 },
                ForceOrgDisplayResult: class { constructor(init) { Object.assign(this, init); } }
            };
            if (id === '../common') return { ProgressEventType: { stdOutData: 'stdout', stdErrData: 'stderr' } };
            return extra[id] || {};
        }
    });
    vm.runInContext('String.prototype.replaceStrings = function (...pairs) { return pairs.reduce((s, p) => s.split(p.from).join(p.to), String(this)); };', context);
    vm.runInContext(fs.readFileSync(require.resolve(`../js/services/${name}.js`), 'utf8'), context);
    return { exports, context };
}

const log = { info() {}, warn() {} };
for (const legacy of [false, true]) {
    for (const token of [undefined, "[REDACTED] Use 'sf org auth show-access-token' to view", 'old-token']) {
        test(`org display token ${token ? token.split(' ')[0] : 'missing'}, legacy=${legacy}`, async () => {
            const calls = [];
            const { exports, context } = loadService('sfdmu-service', {
                LogService: log,
                BroadcastService: { broascastProgressUserMessage() {} },
                ConsoleService: { async runCommandAsync(...args) {
                    calls.push(args);
                    return { isError: false, commandOutput: JSON.stringify({ status: 0, result: calls.length === 1
                        ? { accessToken: token, instanceUrl: 'https://example.com', connectedStatus: 'Connected' }
                        : { accessToken: 'new-token' } }) };
                } }
            });
            context.global.appGlobal.packageJson.appConfig.useSfCliCommands = !legacy;
            const result = await exports.SfdmuService.execForceOrgDisplayAsync('user@example.com');
            assert.equal(result.accessToken, token === 'old-token' ? token : 'new-token');
            assert.equal(result.instanceUrl, 'https://example.com');
            assert.equal(result.commandOutput, '');
            assert.equal(calls.length, token === 'old-token' ? 1 : 2);
            assert.ok(calls.every(call => call[2] === true));
            if (calls.length === 2) assert.equal(calls[1][0], `${legacy ? 'sfdx org:auth:show-access-token' : 'sf org auth show-access-token'} --json --target-org user@example.com`);
        });
    }
}

for (const response of [
    { status: 1, result: { accessToken: 'bad-token' } },
    { status: 0, result: {} },
    { status: 0, result: { accessToken: '[REDACTED]' } },
    'not json'
]) {
    test(`token retrieval fails safely: ${JSON.stringify(response)}`, async () => {
        let calls = 0;
        const { exports } = loadService('sfdmu-service', {
            LogService: log,
            BroadcastService: { broascastProgressUserMessage() {} },
            ConsoleService: { async runCommandAsync() {
                const value = ++calls === 1 ? { status: 0, result: {} } : response;
                return { isError: false, commandOutput: typeof value === 'string' ? value : JSON.stringify(value) };
            } }
        });
        assert.equal((await exports.SfdmuService.execForceOrgDisplayAsync('user')).isError, true);
    });
}

test('sensitive console output is captured without broadcasting credentials', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const events = [];
    const { exports } = loadService('console-service', {
        LogService: log,
        BroadcastService: { broadcastProgress(...args) { events.push(args); } }
    }, { child_process: { exec() { return child; } } });
    const pending = exports.ConsoleService.runCommandAsync('sf org auth show-access-token --json', false, true);
    child.stdout.emit('data', 'secret-token');
    child.stderr.emit('data', 'sensitive-warning');
    child.emit('close', 0);
    assert.equal((await pending).commandOutput, 'secret-token');
    assert.ok(!JSON.stringify(events).includes('secret-token'));
    assert.ok(!JSON.stringify(events).includes('sensitive-warning'));
});
